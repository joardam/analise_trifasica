import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import os
import re
import shutil
import numpy as np
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, RedirectResponse
import uvicorn

from configs_analise import Config, executar_simulacao_protecao
from configs_analise.protection import (
    obter_taps_efetivos,
    estimar_taps_por_enrolamento,
    obter_limiar_operacao,
    _canais_diff_disponiveis,
)

# Rótulo amigável das fases internas ("a"/"b"/"c" -> "A"/"B"/"C")
_FASE_LABEL = {"a": "A", "b": "B", "c": "C"}

# Paleta por fase alinhada ao tema escuro do site (style.css).
_CORES_FASE = {"a": "#2f81f7", "b": "#3fb950", "c": "#d29922"}


def montar_resumo(resultados, cfg, df_raw):
    """Extrai veredito global + métricas por fase dos DataFrames do pipeline.

    Não recalcula nada: lê as colunas que o pipeline já produziu
    (diferencial + restrição) e condensa no ponto de maior Idiff de cada fase.
    """
    df_diff = resultados["diferencial"]
    df_restr = resultados["restricao"]
    df_fas = resultados["fasores"]

    tap_p, tap_s = obter_taps_efetivos(df_fas, df_raw, cfg)

    # Origem dos TAPs: manual (ambos informados) ou estimado por enrolamento.
    tap_manual = cfg.tap_p_a_por_pu is not None and cfg.tap_s_a_por_pu is not None
    tap_info = {
        "tap_p": round(float(tap_p), 3),
        "tap_s": round(float(tap_s), 3),
        "origem": "manual" if tap_manual else "estimado",
        "p_determinado": True,
        "s_determinado": True,
    }
    if not tap_manual:
        _, _, est_info = estimar_taps_por_enrolamento(df_fas, df_raw, cfg)
        tap_info["p_determinado"] = bool(est_info.get("p_determinado", False))
        tap_info["s_determinado"] = bool(est_info.get("s_determinado", False))

    fases_info = []
    houve_trip = houve_pedido = houve_bloqueio = False

    for fase in cfg.fases:
        idiff_pu = df_diff[f"Idiff_pu_{fase}"].to_numpy()
        idiff_a = df_diff[f"Idiff_{fase}"].to_numpy()
        ibias_pu = df_diff[f"Ibias_pu_{fase}"].to_numpy()
        razao = df_restr[f"Razao_H2_H1_{fase}"].to_numpy()

        # Ponto de operação representativo = instante de maior Idiff (pu)
        idx = int(np.argmax(idiff_pu))

        pediu_trip = bool(df_diff[f"Trip_Caracteristica_{fase}"].to_numpy().any())
        bloqueada = bool(df_restr[f"Bloqueio_{fase}"].to_numpy().any())
        disparou = bool(df_restr[f"Trip_Efetivo_{fase}"].to_numpy().any())

        houve_trip = houve_trip or disparou
        houve_pedido = houve_pedido or pediu_trip
        houve_bloqueio = houve_bloqueio or bloqueada

        if disparou:
            status = "TRIP"
        elif pediu_trip and bloqueada:
            status = "BLOQUEIO"
        else:
            status = "ESTAVEL"

        fases_info.append({
            "fase": _FASE_LABEL.get(fase, fase.upper()),
            "idiff_pu": round(float(idiff_pu[idx]), 3),
            "idiff_a": round(float(idiff_a[idx]), 2),
            "ibias_pu": round(float(ibias_pu[idx]), 3),
            "h2h1_pct": round(float(np.max(razao)) * 100.0, 1),
            "pediu_trip": pediu_trip,
            "bloqueada": bloqueada,
            "disparou": disparou,
            "status": status,
        })

    if houve_trip:
        veredito = {
            "status": "TRIP",
            "label": "TRIP — Operação do 87T",
            "detail": "A corrente diferencial cruzou a característica de "
                      "restrição e não houve bloqueio por 2ª harmônica.",
        }
    elif houve_pedido and houve_bloqueio:
        veredito = {
            "status": "BLOQUEIO",
            "label": "Bloqueio por 2ª Harmônica",
            "detail": "A característica pediu disparo, mas a restrição "
                      "harmônica (inrush) atuou e bloqueou o trip.",
        }
    else:
        veredito = {
            "status": "ESTAVEL",
            "label": "Sem Operação — Estável",
            "detail": "A corrente diferencial permaneceu abaixo da "
                      "característica de restrição durante todo o registro.",
        }

    return {
        "veredito": veredito,
        "fases": fases_info,
        "taps": tap_info,
        "config": {
            "vector_group": cfg.vector_group,
            "lado_estrela": cfg.lado_estrela,
            "limite_h2_pct": round(float(cfg.limite_bloqueio_h2) * 100.0, 1),
            "cross_blocking": bool(cfg.cross_blocking),
            "lado_h2h1": cfg.lado_h2h1,
        },
    }


def _serie(a, casas=4):
    """Converte um array numérico em lista JSON-segura (NaN/inf -> None)."""
    arr = np.asarray(a, dtype=float)
    return [None if not np.isfinite(v) else round(float(v), casas) for v in arr]


def _bits(a):
    """Converte uma série booleana em lista de 0/1 (para gráficos de estado)."""
    return [int(x) for x in np.asarray(a).astype(int)]


# Tokens que indicam OUTRAS proteções (não o diferencial) — usados para não
# confundir um trip de sobrecorrente/terra/tensão com operação do 87.
_TOKENS_OUTRAS_PROT = (
    "poc", "i>", "in>", "ef ", "ef1", "ef2", "ef3", "v<", "v>", "vn>",
    "v/hz", "vco", "z<", " 21", " 50", " 51", " 67", "ptoc", "ref",
)


def _fase_do_nome(nome: str):
    """Extrai a fase (a/b/c) de um nome de canal, se houver token isolado.

    Também aceita 1/2/3 ou L1/L2/L3 como A/B/C.
    Ex.: "Idiff Trip A" -> "a"; "Trip L3" -> "c"; "TRIP GERAL" -> None.
    """
    achados_abc = re.findall(r"(?i)(?<![a-z])([abc])(?![a-z])", nome)
    if achados_abc:
        return achados_abc[-1].lower()

    achados_123 = re.findall(r"(?i)(?<![a-z0-9])(?:l)?([123])(?![a-z0-9])", nome)
    if achados_123:
        mapa = {'1': 'a', '2': 'b', '3': 'c'}
        return mapa[achados_123[-1]]

    return None


def detectar_operacao_rele(df_raw, fases):
    """Procura nos canais digitais do registro as flags de TRIP do relé.

    Genérico: como o COMTRADE não padroniza nomes de canal, usa heurística por
    nome (contém 'trip'/'disp', exclui 'start'/'partida') somada à checagem de
    canal binário (só 0/1). Separa trip do DIFERENCIAL (nome com 'diff'/'87')
    de outras proteções e do TRIP GERAL. Quando o registro não traz canais de
    trip (ex.: um DFR só com analógicos), devolve ``tem_canais_trip=False`` e a
    comparação a jusante simplesmente não é feita.
    """
    vazio = {"tem_canais_trip": False, "diferencial": {}, "geral": None, "canais": []}
    if df_raw is None or "tempo" not in getattr(df_raw, "columns", []):
        return vazio

    tempo = df_raw["tempo"].to_numpy()
    tem_canais = False
    diff: dict = {}      # fase -> primeiro instante de asserção
    geral = None
    canais: list = []

    for col in df_raw.columns:
        if col == "tempo":
            continue
        low = col.lower()
        if not (("trip" in low) or ("disp" in low)):
            continue
        if any(x in low for x in ("start", "partida", "pickup", "pick-up", "pré")):
            continue

        vals = np.asarray(df_raw[col].to_numpy(), dtype=float)
        fin = vals[np.isfinite(vals)]
        if fin.size == 0 or not set(np.unique(fin).tolist()).issubset({0.0, 1.0}):
            continue  # não é um canal binário de estado -> não é flag de trip

        tem_canais = True
        if (vals > 0).sum() == 0:
            continue  # o canal existe, mas nunca assertou neste registro

        t0 = float(tempo[int(np.argmax(vals > 0))])
        eh_outra = any(x in low for x in _TOKENS_OUTRAS_PROT)
        eh_diff = ("diff" in low) or ("87" in low)

        if eh_diff and not eh_outra:
            fase = _fase_do_nome(col)
            if fase in fases:
                diff[fase] = min(t0, diff.get(fase, t0))
            else:
                geral = t0 if geral is None else min(geral, t0)
            canais.append(col)
        elif ("geral" in low) or ("general" in low):
            geral = t0 if geral is None else min(geral, t0)
            canais.append(col)

    return {"tem_canais_trip": tem_canais, "diferencial": diff,
            "geral": geral, "canais": canais}


def avaliar_coerencia(df_diff, df_restr, df_raw, cfg):
    """Confronta a recomendação da reconstrução com o que o relé registrou.

    Devolve três coisas: (1) o veredito de cross-blocking com a *margem* até o
    joelho (necessário / não necessário marginal / não necessário folgado),
    (2) se o relé operou (flags digitais) e (3) o status de coerência entre os
    dois — ``coerente`` / ``divergente`` / ``sem_referencia``.
    """
    fases = list(cfg.fases)
    limite = float(cfg.limite_bloqueio_h2)
    n = len(df_restr)

    inrush_ativo = np.zeros(n, dtype=bool)
    algum_desprot = np.zeros(n, dtype=bool)
    h2_sob_trip: list = []          # menor H2/H1 de cada fase sob pedido de trip
    recon_fases_trip: list = []

    for f in fases:
        bloq = df_restr[f"Bloqueio_individual_{f}"].to_numpy().astype(bool) \
            if f"Bloqueio_individual_{f}" in df_restr.columns else None
        tc = df_diff[f"Trip_Caracteristica_{f}"].to_numpy().astype(bool) \
            if f"Trip_Caracteristica_{f}" in df_diff.columns else None
        razao = df_restr[f"Razao_H2_H1_{f}"].to_numpy() \
            if f"Razao_H2_H1_{f}" in df_restr.columns else None

        if bloq is not None:
            inrush_ativo |= bloq
        if tc is not None and bloq is not None:
            algum_desprot |= (tc & ~bloq)
            if razao is not None and tc.any():
                h2_sob_trip.append(float(np.nanmin(razao[tc])))
        if f"Trip_Efetivo_{f}" in df_restr.columns and bool(df_restr[f"Trip_Efetivo_{f}"].to_numpy().any()):
            recon_fases_trip.append(_FASE_LABEL.get(f, f.upper()))

    cross_necessario = bool((inrush_ativo & algum_desprot).any())
    h2_min = min(h2_sob_trip) if h2_sob_trip else None
    if cross_necessario:
        classe = "necessario"
    elif h2_min is None:
        classe = "nao_necessario_folgado"   # nenhuma fase chegou a pedir trip
    elif (h2_min - limite) <= 0.05:
        classe = "nao_necessario_marginal"  # passou perto do joelho (≤ 5 pontos)
    else:
        classe = "nao_necessario_folgado"
    recon_operou = len(recon_fases_trip) > 0

    rele = detectar_operacao_rele(df_raw, fases)
    rele_diff = rele["diferencial"]
    rele_operou = len(rele_diff) > 0
    rele_fases = [_FASE_LABEL.get(f, f.upper()) for f in sorted(rele_diff.keys())]

    if not rele["tem_canais_trip"]:
        status, tipo = "sem_referencia", None
    elif rele_operou == recon_operou:
        status, tipo = "coerente", None
    elif rele_operou and not recon_operou:
        status, tipo = "divergente", "rele_operou_recon_nao"
    else:
        status, tipo = "divergente", "recon_operou_rele_nao"

    return {
        "status": status,
        "tipo_divergencia": tipo,
        "rele": {
            "tem_canais_trip": rele["tem_canais_trip"],
            "operou": rele_operou,
            "fases": rele_fases,
            "instantes": {_FASE_LABEL.get(f, f.upper()): round(v, 4) for f, v in rele_diff.items()},
            "geral": round(rele["geral"], 4) if rele["geral"] is not None else None,
            "canais": rele["canais"],
        },
        "reconstrucao": {"operou": recon_operou, "fases": recon_fases_trip},
        "cross": {
            "necessario": cross_necessario,
            "classe": classe,
            "h2h1_min_sob_trip_pct": round(h2_min * 100.0, 1) if h2_min is not None else None,
            "limite_pct": round(limite * 100.0, 1),
        },
    }


def _janela_causal_any(mascara, N):
    """True onde `mascara` foi True em alguma das últimas N amostras (inclusive).

    Lookback causal vetorizado via soma cumulativa: para cada índice i,
    verifica se houve algum True em [i-N+1, i]. Usado para detectar
    "liberação recente" do bloqueio harmônico dentro de um ciclo.
    """
    if N <= 1:
        return mascara.astype(bool)
    b = mascara.astype(int)
    csum = np.concatenate(([0], np.cumsum(b)))
    idx = np.arange(len(b))
    lo = np.maximum(0, idx - N + 1)
    return (csum[idx + 1] - csum[lo]) > 0


def _classificar_regioes(df_diff, df_restr, cfg):
    """Classifica cada amostra do registro em uma faixa de inspeção visual.

    Por prioridade (da pior para a menos grave), olhando todas as fases no
    mesmo instante:
      3 (vermelho) — alguma fase armada (Idiff > pickup) liberou o próprio
                     bloqueio (H2/H1 < limite) e NENHUMA fase bloqueia:
                     a restrição harmônica não segura — cross-blocking não
                     evitaria.
      2 (amarelo)  — alguma fase armada liberou o bloqueio, mas OUTRA fase
                     ainda bloqueia: cross-blocking seria necessário/eficaz.
      1 (verde)    — H2/H1 caiu abaixo do limite, porém a fase não está
                     armada (corrente abaixo do pickup): queda inofensiva.
                     Exige que o bloqueio harmônico tenha atuado no último
                     ciclo (liberação recente), para marcar a *liberação* e
                     não a cauda de decaimento pós-evento (H2/H1 ≡ 0 sem
                     nunca ter havido harmônica a restringir).
      0            — nada a destacar.
    Devolve uma lista de inteiros (0..3), uma por amostra.
    """
    fases = list(cfg.fases)
    limite = float(cfg.limite_bloqueio_h2)
    # Piso de corrente do verde, RELATIVO ao pickup (genérico: escala com o
    # ajuste de cada registro). Marca só quedas com corrente real mas abaixo
    # do pickup; exclui a cauda de ruído (Idiff -> 0), onde o H2/H1 é instável.
    piso = 0.2 * float(cfg.is1)
    N = int(cfg.N)  # amostras por ciclo: janela do lookback de "liberação recente"
    n = len(df_restr)

    armed_released = np.zeros(n, dtype=bool)
    blocking = np.zeros(n, dtype=bool)
    benigno = np.zeros(n, dtype=bool)

    for f in fases:
        razao = df_restr[f"Razao_H2_H1_{f}"].to_numpy()
        tc = df_diff[f"Trip_Caracteristica_{f}"].to_numpy().astype(bool)
        idiff = df_diff[f"Idiff_pu_{f}"].to_numpy()
        abaixo = razao < limite
        bloq_f = razao >= limite
        blocking |= bloq_f
        armed_released |= (tc & abaixo)
        # Liberação recente: houve bloqueio em alguma das últimas N amostras
        # (lookback causal de 1 ciclo). Distingue uma queda genuína da
        # harmônica (bloqueava e largou) da cauda de decaimento sem harmônica.
        release_recente = _janela_causal_any(bloq_f, N)
        benigno |= (abaixo & ~tc & (idiff >= piso) & release_recente)

    vermelho = armed_released & ~blocking
    amarelo = armed_released & blocking
    verde = benigno & ~armed_released
    estado = np.where(vermelho, 3, np.where(amarelo, 2, np.where(verde, 1, 0)))
    return [int(x) for x in estado]


def montar_series(resultados, cfg, df_raw):
    """Empacota as séries temporais do pipeline em JSON para gráficos interativos.

    Nada é recalculado além da curva de característica e da escala de validação:
    o front (Plotly) desenha tudo a partir destes vetores, permitindo zoom/pan
    nativos sobre as amostras brutas.
    """
    df_sin = resultados["sinais"]
    df_fas = resultados["fasores"]
    df_diff = resultados["diferencial"]
    df_restr = resultados["restricao"]
    fases = list(cfg.fases)

    # Característica de operação (plano Idiff × Ibias).
    max_bias = max(3.0, float(max(df_diff[f"Ibias_pu_{f}"].max() for f in fases)) * 1.1)
    bias_line = np.linspace(0.0, max_bias, 400)
    oper_line = obter_limiar_operacao(bias_line, cfg)

    out = {
        "fases_key": fases,
        "fases": [_FASE_LABEL.get(f, f.upper()) for f in fases],
        "cores": {f: _CORES_FASE.get(f, "#2f81f7") for f in fases},
        "limite_h2": float(cfg.limite_bloqueio_h2),
        "tempo": _serie(df_diff["tempo"], 5),
        "caracteristica": {
            "bias": _serie(bias_line, 4),
            "oper": _serie(oper_line, 4),
            "max_bias": round(float(max_bias), 3),
        },
        "sinais": {}, "h1mag": {}, "diff": {}, "idiff_pu": {}, "ibias_pu": {},
        "limiar_pu": {}, "razao": {}, "bloqueio_indiv": {}, "trip_caract": {},
        "idiff_operacao": {},
    }

    for f in fases:
        out["sinais"][f] = {"p": _serie(df_sin[f"I{f}_p"], 3), "s": _serie(df_sin[f"I{f}_s"], 3)}
        out["h1mag"][f] = {"p": _serie(df_fas[f"Mag_I{f}_p_H1"], 3), "s": _serie(df_fas[f"Mag_I{f}_s_H1"], 3)}
        out["diff"][f] = _serie(df_diff[f"Idiff_{f}"], 3)
        out["idiff_pu"][f] = _serie(df_diff[f"Idiff_pu_{f}"], 4)
        out["ibias_pu"][f] = _serie(df_diff[f"Ibias_pu_{f}"], 4)
        out["limiar_pu"][f] = _serie(df_diff[f"Idiff_Limiar_pu_{f}"], 4)
        out["razao"][f] = _serie(df_restr[f"Razao_H2_H1_{f}"], 4)
        out["bloqueio_indiv"][f] = _bits(df_restr[f"Bloqueio_individual_{f}"])
        out["trip_caract"][f] = _bits(df_diff[f"Trip_Caracteristica_{f}"])
        out["idiff_operacao"][f] = _serie(df_restr[f"Idiff_Operacao_{f}"], 3)

    # Validação vs registro do relé (só quando os canais *-DIFF existem).
    canais_diff = _canais_diff_disponiveis(df_raw, cfg) if df_raw is not None else []
    if len(canais_diff) == 3:
        _, tap_s = obter_taps_efetivos(df_fas, df_raw, cfg)
        escala = (1.0 / tap_s) if (tap_s and tap_s > 0) else 1.0
        info = (f"TAP {tap_s:.1f} A_sec/pu" if (tap_s and tap_s > 0)
                else "TAP indisponível — escalas distintas")
        val = {"escala": float(escala), "unidade": "pu", "info_tap": info,
               "calc": {}, "rele": {}, "canais": {}}
        for f, canal in zip(fases, canais_diff):
            val["calc"][f] = _serie(df_diff[f"Idiff_{f}"], 3)
            val["rele"][f] = _serie(df_raw[canal], 4)
            val["canais"][f] = canal
        out["validacao"] = val
    else:
        out["validacao"] = None

    # Coerência: confronta a recomendação com as flags de trip do relé.
    out["coerencia"] = avaliar_coerencia(df_diff, df_restr, df_raw, cfg)

    # Inspeção visual: pickup e faixas de classificação por amostra.
    out["pickup_pu"] = round(float(cfg.is1), 4)
    out["regioes"] = _classificar_regioes(df_diff, df_restr, cfg)

    return out


app = FastAPI(title="Análise de Proteção Diferencial (87T)")

# Garantir que a pasta static existe
os.makedirs("static", exist_ok=True)

# Montar arquivos estáticos
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def redirect_to_static():
    return RedirectResponse(url="/static/index.html")


@app.post("/api/analisar")
async def analisar_caso(
    vector_group: int = Form(...),
    lado_estrela: str = Form(...),
    tap_mode: str = Form("estimar"),
    tap_p: str | None = Form(None),
    tap_s: str | None = Form(None),
    cfg_file: UploadFile = File(...),
    dat_file: UploadFile = File(...)
):
    scratch_dir = Path("scratch_api")
    scratch_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Salvar arquivos temporariamente
        cfg_path = scratch_dir / cfg_file.filename
        dat_path = scratch_dir / dat_file.filename

        with open(cfg_path, "wb") as buffer:
            shutil.copyfileobj(cfg_file.file, buffer)
        with open(dat_path, "wb") as buffer:
            shutil.copyfileobj(dat_file.file, buffer)

        # Tratar TAP
        tap_p_val = None
        tap_s_val = None
        if tap_mode == "manual":
            if tap_p and tap_p.strip():
                tap_p_val = float(tap_p)
            if tap_s and tap_s.strip():
                tap_s_val = float(tap_s)

        # Instanciar a Configuração
        cfg = Config(
            fonte="comtrade",
            caminho_comtrade=cfg_path,
            vector_group=vector_group,
            lado_estrela=lado_estrela,
            tap_p_a_por_pu=tap_p_val,
            tap_s_a_por_pu=tap_s_val,
            pasta=scratch_dir
        )

        # Executar a simulação
        resultados, cfg_efetivo, meta, df_raw = executar_simulacao_protecao(cfg)

        # Condensar veredito + métricas por fase
        resumo = montar_resumo(resultados, cfg_efetivo, df_raw)

        # Empacotar séries para os gráficos interativos (Plotly no front)
        series = montar_series(resultados, cfg_efetivo, df_raw)

        return JSONResponse(content={
            "status": "success",
            "resumo": resumo,
            "series": series,
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Limpeza
        if 'cfg_path' in locals() and cfg_path.exists():
            cfg_path.unlink()
        if 'dat_path' in locals() and dat_path.exists():
            dat_path.unlink()


if __name__ == "__main__":
    uvicorn.run("api:app", host="127.0.0.1", port=8000, reload=True)
