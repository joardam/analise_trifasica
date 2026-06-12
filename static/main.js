document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("analysis-form");
    const submitBtn = document.getElementById("submit-btn");
    const btnText = submitBtn.querySelector(".btn-text");
    const stageList = document.getElementById("stage-list");
    const stages = [...stageList.querySelectorAll(".stage")];
    const errorBanner = document.getElementById("error-banner");
    const emptyState = document.getElementById("empty-state");
    const resultBody = document.getElementById("result-body");

    // ── TAP manual toggle ───────────────────────────────────────
    const tapMode = document.getElementById("tap_mode");
    const tapManual = document.getElementById("tap_manual_fields");
    tapMode.addEventListener("change", () => {
        tapManual.classList.toggle("hidden", tapMode.value !== "manual");
    });

    // ── Dropzones (clique + drag-and-drop) ──────────────────────
    const setupDropzone = (inputId, dropId) => {
        const input = document.getElementById(inputId);
        const drop = document.getElementById(dropId);
        const nameEl = drop.querySelector(".dz-name");
        const def = nameEl.dataset.default;

        const sync = () => {
            if (input.files.length) {
                nameEl.textContent = input.files[0].name;
                drop.classList.add("is-set");
            } else {
                nameEl.textContent = def;
                drop.classList.remove("is-set");
            }
        };
        input.addEventListener("change", sync);

        ["dragenter", "dragover"].forEach(ev =>
            drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("is-dragover"); }));
        ["dragleave", "drop"].forEach(ev =>
            drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("is-dragover"); }));
        drop.addEventListener("drop", e => {
            if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; sync(); }
        });
    };
    setupDropzone("cfg_file", "cfg-drop");
    setupDropzone("dat_file", "dat-drop");

    // ── Loading em estágios (feedback do pipeline) ──────────────
    let stageTimer = null;
    const startStages = () => {
        stages.forEach(s => s.classList.remove("active", "done"));
        stageList.classList.remove("hidden");
        let i = 0;
        const advance = () => {
            stages.forEach((s, k) => {
                s.classList.toggle("done", k < i);
                s.classList.toggle("active", k === i);
            });
            i = Math.min(i + 1, stages.length - 1);
        };
        advance();
        stageTimer = setInterval(advance, 650);
    };
    const stopStages = (ok) => {
        clearInterval(stageTimer);
        if (ok) stages.forEach(s => { s.classList.remove("active"); s.classList.add("done"); });
        setTimeout(() => stageList.classList.add("hidden"), ok ? 400 : 0);
    };

    const showError = (msg) => {
        errorBanner.textContent = `⚠  ${msg}`;
        errorBanner.classList.remove("hidden");
    };

    // ── Submit ──────────────────────────────────────────────────
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorBanner.classList.add("hidden");

        submitBtn.disabled = true;
        btnText.textContent = "Processando…";
        startStages();

        try {
            const res = await fetch("/api/analisar", { method: "POST", body: new FormData(form) });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `Falha na análise (HTTP ${res.status})`);
            }
            const data = await res.json();
            stopStages(true);
            renderResults(data);
        } catch (err) {
            stopStages(false);
            showError(err.message);
            console.error(err);
        } finally {
            submitBtn.disabled = false;
            btnText.textContent = "Executar análise";
        }
    });

    // ── Render ──────────────────────────────────────────────────
    function renderResults(data) {
        const { resumo, series } = data;
        emptyState.classList.add("hidden");
        resultBody.classList.remove("hidden");

        renderVerdict(resumo.veredito);
        renderMeta(resumo);
        renderMetrics(resumo.fases);
        renderCharts(series);
        resultBody.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function renderVerdict(v) {
        const box = document.getElementById("verdict");
        const map = { TRIP: "is-trip", BLOQUEIO: "is-bloqueio", ESTAVEL: "is-estavel" };
        box.className = `verdict ${map[v.status] || ""}`;
        document.getElementById("verdict-status").textContent = v.status;
        document.getElementById("verdict-label").textContent = v.label;
        document.getElementById("verdict-detail").textContent = v.detail;
    }

    function renderMeta(r) {
        const chips = document.getElementById("meta-chips");
        const cb = r.config.cross_blocking ? "on" : "off";
        const t = r.taps;
        // Marca "?" no TAP de um enrolamento que não conduziu (estimativa indeterminada)
        const mark = (det) => (t.origem === "estimado" && !det) ? " ?" : "";
        const tapP = `${t.tap_p} A${mark(t.p_determinado)}`;
        const tapS = `${t.tap_s} A${mark(t.s_determinado)}`;
        chips.innerHTML = [
            ["Grupo", `YNd${r.config.vector_group}`],
            ["Y", r.config.lado_estrela],
            ["TAP", t.origem],
            ["TAP P", tapP],
            ["TAP S", tapS],
            ["Lim. H2", `${r.config.limite_h2_pct}%`],
            ["Cross-block", cb],
        ].map(([k, val]) => `<span class="meta-chip">${k} <b>${val}</b></span>`).join("");

        // Nota explicativa quando algum lado ficou indeterminado
        const indet = t.origem === "estimado" && (!t.p_determinado || !t.s_determinado);
        let nota = document.getElementById("tap-note");
        if (indet) {
            const lado = !t.p_determinado ? "primário (W1)" : "secundário (W2)";
            if (!nota) {
                nota = document.createElement("p");
                nota.id = "tap-note";
                nota.className = "tap-note";
                chips.insertAdjacentElement("afterend", nota);
            }
            nota.textContent = `TAP do ${lado} indeterminado — esse enrolamento não conduziu corrente significativa no registro; valor herdado do outro lado (não afeta Idiff/Ibias).`;
        } else if (nota) {
            nota.remove();
        }
    }

    function renderMetrics(fases) {
        const body = document.getElementById("metrics-body");
        body.innerHTML = fases.map(f => `
            <tr>
                <td class="fase-cell">${f.fase}</td>
                <td>${f.idiff_pu.toFixed(3)}</td>
                <td>${f.idiff_a.toFixed(2)}</td>
                <td>${f.ibias_pu.toFixed(3)}</td>
                <td>${f.h2h1_pct.toFixed(1)}</td>
                <td><span class="state-chip ${f.status}">${f.status}</span></td>
            </tr>`).join("");
    }

    // ════════════════════════════════════════════════════════════
    //  Gráficos interativos (Plotly) — zoom de caixa, pan, hover e
    //  export PNG nativos. As séries vêm cruas da API (todas as
    //  amostras), então o zoom desce até o nível de amostra.
    // ════════════════════════════════════════════════════════════
    const PCFG = {
        responsive: true, displaylogo: false, scrollZoom: true,
        modeBarButtonsToRemove: ["lasso2d", "select2d"],
        toImageButtonOptions: { format: "png", scale: 2, filename: "diagrama_87T" },
    };
    const T = { paper: "rgba(0,0,0,0)", font: "#8b949e", grid: "#21262d", zero: "#2a313c", danger: "#f85149", rele: "#8b949e" };

    const hexA = (hex, a) => {
        const n = parseInt(hex.replace("#", ""), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };

    // Coleta valores finitos de várias séries (ignora null/NaN).
    const finitos = (arrays) => {
        const v = [];
        arrays.forEach(a => a.forEach(x => { if (x != null && isFinite(x)) v.push(x); }));
        return v;
    };
    const percentil = (ordenado, p) => {
        if (!ordenado.length) return null;
        const i = (ordenado.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
        return lo === hi ? ordenado[lo] : ordenado[lo] + (ordenado[hi] - ordenado[lo]) * (i - lo);
    };
    // Limite superior robusto p/ a vista inicial: ignora picos extremos
    // (percentil), com um piso mínimo. Generaliza p/ qualquer registro;
    // o duplo-clique sempre restaura a autoescala completa.
    const topoRobusto = (arrays, p, piso) => {
        const v = finitos(arrays);
        if (!v.length) return piso;
        v.sort((a, b) => a - b);
        return Math.max(percentil(v, p) * 1.15, piso);
    };
    const maxFinito = (arrays) => {
        const v = finitos(arrays);
        return v.length ? v.reduce((a, b) => (a > b ? a : b)) : 0;
    };

    const axis = (title) => ({
        title: title ? { text: title, font: { size: 11, color: T.font } } : undefined,
        gridcolor: T.grid, zerolinecolor: T.zero, linecolor: T.zero,
        tickfont: { size: 10, color: T.font }, automargin: true,
    });

    const baseLayout = () => ({
        paper_bgcolor: T.paper, plot_bgcolor: T.paper,
        font: { color: T.font, family: "Inter, sans-serif", size: 11 },
        margin: { l: 60, r: 18, t: 16, b: 42 }, hovermode: "x unified",
        modebar: { color: T.font, activecolor: "#2f81f7", bgcolor: "rgba(0,0,0,0)" },
        legend: { orientation: "h", y: 1.08, x: 0, font: { size: 10 }, bgcolor: "rgba(0,0,0,0)" },
    });

    const line = (x, y, name, color, opts = {}) => Object.assign({
        x, y, name, type: "scatter", mode: "lines",
        line: Object.assign({ color, width: 1.6 }, opts.line || {}),
        hovertemplate: "%{y}<extra>" + name + "</extra>",
    }, opts.extra || {});

    const step = (x, y, name, color, opts = {}) => Object.assign({
        x, y, name, type: "scatter", mode: "lines",
        line: Object.assign({ color, width: 1.8, shape: "hv" }, opts.line || {}),
        hovertemplate: "%{y}<extra>" + name + "</extra>",
    }, opts.extra || {});

    function plotSingle(div, traces, xt, yt, opts = {}) {
        const lay = baseLayout();
        if (opts.hovermode) lay.hovermode = opts.hovermode;
        lay.xaxis = Object.assign(axis(xt), opts.xaxis || {});
        lay.yaxis = Object.assign(axis(yt), opts.yaxis || {});
        Plotly.newPlot(div, traces, Object.assign(lay, opts.layout || {}), PCFG);
    }

    // Subplots verticais com eixo X compartilhado (zoom acoplado).
    function stackedSubplots(div, panels, xTitle, opts = {}) {
        const n = panels.length, gap = 0.07;
        const h = (1 - gap * (n - 1)) / n;
        const data = [], lay = baseLayout();
        lay.hovermode = opts.hovermode || "x unified";
        lay.shapes = [];
        panels.forEach((p, i) => {
            const sfx = i === 0 ? "" : String(i + 1);
            const ya = "y" + sfx;
            const top = 1 - i * (h + gap), bot = Math.max(top - h, 0);
            p.traces.forEach(t => data.push(Object.assign({}, t, { xaxis: "x" + sfx, yaxis: ya })));
            lay["yaxis" + sfx] = Object.assign(axis(p.yTitle), { domain: [bot, top] }, p.yaxis || {});
            lay["xaxis" + sfx] = Object.assign(axis(i === n - 1 ? xTitle : ""), {
                domain: [0, 1], anchor: ya, showticklabels: i === n - 1,
            });
            if (i > 0) lay["xaxis" + sfx].matches = "x";
            // Faixas de fundo (retângulos verticais ao longo do tempo).
            (p.bands || []).forEach(b => lay.shapes.push({
                type: "rect", xref: "x", yref: ya + " domain",
                x0: b.x0, x1: b.x1, y0: 0, y1: 1,
                fillcolor: b.color, line: { width: 0 }, layer: "below",
            }));
            // Linhas horizontais de referência (limite, pickup...).
            (p.shapes || []).forEach(s => lay.shapes.push(Object.assign({
                type: "line", xref: "x domain", yref: ya, x0: 0, x1: 1,
            }, s)));
            // Anotações ancoradas ao subplot (rótulos das linhas).
            (p.annotations || []).forEach(a => {
                if (!lay.annotations) lay.annotations = [];
                lay.annotations.push(Object.assign({ xref: "x" + sfx + " domain", yref: ya, showarrow: false }, a));
            });
        });
        Plotly.newPlot(div, data, Object.assign(lay, opts.layout || {}), PCFG);
    }

    // ── Construtores de cada diagrama ──────────────────────────
    function chartSinais(div, S) {
        const mk = (lado) => {
            const tr = [];
            S.fases_key.forEach((f, i) => {
                tr.push(line(S.tempo, S.sinais[f][lado], `I${S.fases[i]} (${lado.toUpperCase()})`, S.cores[f], { extra: { legendgroup: f } }));
                tr.push(line(S.tempo, S.h1mag[f][lado], `|H1| ${S.fases[i]}`, S.cores[f], { line: { dash: "dot", width: 1 }, extra: { legendgroup: f, showlegend: false } }));
            });
            return tr;
        };
        stackedSubplots(div, [
            { traces: mk("p"), yTitle: "Primário (A)" },
            { traces: mk("s"), yTitle: "Secundário (A)" },
        ], "Tempo (s)", { hovermode: "closest" });
    }

    function chartDiff(div, S) {
        const tr = S.fases_key.map((f, i) => line(S.tempo, S.diff[f], `Idiff ${S.fases[i]}`, S.cores[f]));
        plotSingle(div, tr, "Tempo (s)", "Idiff (A)");
    }

    function chartPlano(div, S) {
        const c = S.caracteristica;
        const traces = [{
            x: c.bias, y: c.oper, name: "Característica (IED)", type: "scatter", mode: "lines",
            line: { color: T.danger, width: 2.4 }, fill: "tozeroy", fillcolor: "rgba(248,81,73,0.06)",
            hovertemplate: "Ibias %{x}<br>limiar %{y}<extra></extra>",
        }];
        S.fases_key.forEach((f, i) => traces.push({
            x: S.ibias_pu[f], y: S.idiff_pu[f], name: `Fase ${S.fases[i]}`, type: "scatter",
            mode: "markers", marker: { color: S.cores[f], size: 5, opacity: 0.7 },
            hovertemplate: "Ibias %{x}<br>Idiff %{y}<extra>" + S.fases[i] + "</extra>",
        }));
        // Vista inicial: enquadra as trajetórias (com piso) sem deixar a curva
        // de operação esticar o eixo. Adapta-se a qualquer registro.
        const yTop = Math.max(1.5, maxFinito(S.fases_key.map(f => S.idiff_pu[f])) * 1.1);
        plotSingle(div, traces, "Ibias (pu)", "Idiff (pu)", {
            hovermode: "closest",
            xaxis: { range: [0, c.max_bias] }, yaxis: { range: [0, yTop] },
        });
    }

    // Faixas de inspeção (verde/amarelo/vermelho) — preenchimento e legenda.
    const REG_FILL = { 1: "rgba(63,185,80,0.10)", 2: "rgba(210,153,34,0.16)", 3: "rgba(248,81,73,0.16)" };
    const REG_SWATCH = { 1: "#3fb950", 2: "#d29922", 3: "#f85149" };
    const REG_NOME = {
        1: "Queda <limite sem efeito (corrente < pickup)",
        2: "Cross-blocking necessário (outra fase ainda bloqueia)",
        3: "Restrição insuficiente (nenhuma fase bloqueia)",
    };
    // Legenda das faixas em HTML (chips horizontais no cabeçalho do card),
    // só para os estados presentes no registro.
    const escHTML = (s) => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    function regioesLegendHTML(S) {
        const presentes = [...new Set((S.regioes || []).filter(s => s > 0))].sort();
        if (!presentes.length) return "";
        const chips = presentes.map(s =>
            `<span class="reg-chip"><i style="background:${REG_SWATCH[s]}"></i>${escHTML(REG_NOME[s])}</span>`
        ).join("");
        return `<div class="reg-legend">${chips}</div>`;
    }

    // Converte a série de estados (0..3) em faixas {x0,x1,color}, por INSTANTE.
    // Cada bloco contíguo de mesmo estado vira uma faixa; o vão entre quedas
    // (onde a condição não vale) fica SEM cor — quedas separadas, e trips
    // separadas, aparecem como regiões distintas. Não há fusão entre blocos.
    // Padding de meia amostra só dá largura mínima visível a quedas de 1 amostra.
    function bandasDeEstado(tempo, estado) {
        const bands = [];
        if (!estado || estado.length < 2) return bands;
        const n = estado.length;
        const meia = ((tempo[n - 1] - tempo[0]) / (n - 1)) / 2;
        let i = 0;
        while (i < n) {
            const s = estado[i];
            if (s > 0) {
                let j = i;
                while (j + 1 < n && estado[j + 1] === s) j++;
                bands.push({ x0: tempo[i] - meia, x1: tempo[j] + meia, color: REG_FILL[s] });
                i = j + 1;
            } else i++;
        }
        return bands;
    }

    function chartHarmonica(div, S) {
        // Topo: H2/H1 por fase, com Idiff (pu) daquele instante no tooltip.
        const top = S.fases_key.map((f, i) => line(S.tempo, S.razao[f], `H2/H1 ${S.fases[i]}`, S.cores[f], {
            extra: {
                legendgroup: f, customdata: S.idiff_pu[f],
                hovertemplate: `H2/H1 %{y:.1%}<br>Idiff %{customdata:.3f} pu<extra>${S.fases[i]}</extra>`,
            },
        }));
        // As faixas (verde/amarelo/vermelho) têm legenda própria em HTML no
        // cabeçalho do card (regioesLegendHTML) — fora do plot, para não
        // empilhar rótulos longos sobre o gráfico.

        // Base: Idiff (pu) por fase + linha de pickup rotulada.
        const pk = S.pickup_pu;
        const bot = S.fases_key.map((f, i) => line(S.tempo, S.idiff_pu[f], `Idiff ${S.fases[i]}`, S.cores[f], {
            extra: { legendgroup: f, showlegend: false },
        }));

        const bands = bandasDeEstado(S.tempo, S.regioes);
        const yTop = topoRobusto(S.fases_key.map(f => S.razao[f]), 0.97, Math.max(0.4, S.limite_h2 * 3));
        const yTopI = Math.max(pk * 2, maxFinito(S.fases_key.map(f => S.idiff_pu[f])) * 1.1, 0.3);

        stackedSubplots(div, [
            {
                traces: top, yTitle: "H2 / H1", yaxis: { range: [0, yTop], tickformat: ".0%" }, bands,
                shapes: [{ y0: S.limite_h2, y1: S.limite_h2, line: { color: T.danger, dash: "dot", width: 1.2 } }],
                annotations: [{ x: 0.995, y: S.limite_h2, text: `limite ${(S.limite_h2 * 100).toFixed(0)}%`, font: { size: 9, color: T.danger }, xanchor: "right", yanchor: "bottom" }],
            },
            {
                traces: bot, yTitle: "Idiff (pu)", yaxis: { range: [0, yTopI] }, bands,
                shapes: [{ y0: pk, y1: pk, line: { color: "#d29922", dash: "dash", width: 1.2 } }],
                annotations: [{ x: 0.995, y: pk, text: `pickup ${pk.toFixed(2)} pu`, font: { size: 9, color: "#d29922" }, xanchor: "right", yanchor: "bottom" }],
            },
        ], "Tempo (s)");
    }

    function chartCross(div, S) {
        const panels = S.fases_key.map((f, i) => {
            const bloq = S.bloqueio_indiv[f], tc = S.trip_caract[f];
            const desp = tc.map((v, k) => (v && !bloq[k]) ? 1 : 0);
            const first = i === 0;
            return {
                yTitle: `Fase ${S.fases[i]}`, yaxis: { range: [-0.12, 1.18], tickvals: [0, 1], ticktext: ["OFF", "ON"] },
                traces: [
                    step(S.tempo, bloq, "Bloqueio H2", S.cores[f], { line: { width: 1.4 }, extra: { fill: "tozeroy", fillcolor: hexA(S.cores[f], 0.12), legendgroup: "bloq", showlegend: first } }),
                    step(S.tempo, tc, "Trip BIAS", "#8b949e", { line: { dash: "dot", width: 1.2 }, extra: { legendgroup: "tc", showlegend: first } }),
                    step(S.tempo, desp, "Trip desprotegido", T.danger, { line: { width: 2.2 }, extra: { legendgroup: "desp", showlegend: first } }),
                ],
            };
        });
        stackedSubplots(div, panels, "Tempo (s)", { hovermode: "x" });
    }

    function chartValidacao(div, S) {
        const V = S.validacao, esc = V.escala;
        const panels = S.fases_key.map((f, i) => {
            const calc = V.calc[f].map(v => v == null ? null : +(v * esc).toFixed(4));
            const first = i === 0;
            return {
                yTitle: `Fase ${S.fases[i]} (${V.unidade})`,
                traces: [
                    line(S.tempo, calc, "Calculada", S.cores[f], { line: { width: 1.8 }, extra: { legendgroup: "calc", showlegend: first } }),
                    line(S.tempo, V.rele[f], `Relé (${V.canais[f]})`, T.rele, { line: { dash: "dot", width: 1.2 }, extra: { legendgroup: "rele", showlegend: first } }),
                ],
            };
        });
        stackedSubplots(div, panels, "Tempo (s)");
    }

    // ── Coerência: selo do cross-blocking + banner relé × reconstrução ──────
    const CB_BADGE = {
        necessario:              { txt: "Cross-blocking NECESSÁRIO",               cls: "cb-bad" },
        nao_necessario_marginal: { txt: "Cross-blocking não necessário (marginal)", cls: "cb-warn" },
        nao_necessario_folgado:  { txt: "Cross-blocking não necessário",            cls: "cb-ok" },
    };

    function crossBadgeHTML(co) {
        if (!co || !co.cross) return "";
        const c = co.cross, b = CB_BADGE[c.classe] || CB_BADGE.nao_necessario_folgado;
        let margem = "";
        if (c.h2h1_min_sob_trip_pct != null)
            margem = ` <span class="cb-margin">menor H2/H1 sob pedido de trip: ${c.h2h1_min_sob_trip_pct}% (limite ${c.limite_pct}%)</span>`;
        return `<span class="cb-badge ${b.cls}">${b.txt}</span>${margem}`;
    }

    function coerenciaBannerHTML(co) {
        if (!co) return "";
        if (co.status === "sem_referencia")
            return `<div class="coer-banner coer-info">O registro não traz flags de trip do relé — sem referência para confrontar a recomendação. Veredito baseado apenas na reconstrução.</div>`;
        if (co.status === "coerente") {
            const r = co.rele.operou
                ? `o relé operou (${co.rele.fases.join(", ") || "geral"}) e a reconstrução também aponta operação.`
                : `o relé não operou e a reconstrução também não aponta operação.`;
            return `<div class="coer-banner coer-ok">Coerente — ${r}</div>`;
        }
        if (co.tipo_divergencia === "rele_operou_recon_nao") {
            const inst = co.rele.fases.map(f => co.rele.instantes[f] != null ? `${f} @ ${co.rele.instantes[f]} s` : f).join(", ");
            return `<div class="coer-banner coer-bad"><b>⚠️ Divergência</b> — o relé <b>registrou operação do diferencial</b> (${inst || "trip geral"}), mas a reconstrução não a reproduziu. Isso costuma indicar limite de fidelidade do registro (taxa de amostragem / janela de cálculo) num ponto de joelho. Interprete a recomendação com cautela.</div>`;
        }
        return `<div class="coer-banner coer-bad"><b>⚠️ Divergência</b> — a reconstrução indica operação (${co.reconstrucao.fases.join(", ")}), mas o relé não registrou trip do diferencial no oscilograma. Verifique TAP/ajustes e a fidelidade do registro.</div>`;
    }

    function renderCharts(series) {
        const host = document.getElementById("charts");
        host.innerHTML = "";
        if (!series || typeof Plotly === "undefined") {
            host.innerHTML = '<p class="charts-fallback">Não foi possível carregar a biblioteca de gráficos (Plotly). Verifique a conexão.</p>';
            return;
        }

        if (series.coerencia) host.insertAdjacentHTML("beforeend", coerenciaBannerHTML(series.coerencia));

        const defs = [
            ["Sinais instantâneos + |H1|", "Correntes de entrada por enrolamento; tracejado = magnitude do fundamental (H1).", chartSinais],
            ["Corrente diferencial", "Idiff por fase (A) ao longo do registro.", chartDiff],
            ["Plano de restrição — Idiff × Ibias", "Trajetória de cada fase sobre a característica de operação do relé.", chartPlano],
            ["Restrição harmônica — H2/H1", "H2/H1 por fase (linha = limite de bloqueio) e Idiff (pu) vs pickup. Faixas coloridas indicam relevância da queda; passe o mouse para ver o Idiff no instante.", chartHarmonica],
            ["Diagnóstico de cross-blocking", "Estados por fase: bloqueio por H2, pedido de trip por BIAS e trip desprotegido.", chartCross],
        ];
        if (series.validacao) {
            defs.push(["Validação vs registro do relé", `${series.validacao.info_tap} — Idiff calculada vs canais *-DIFF gravados.`, chartValidacao]);
        }

        defs.forEach(([title, sub, builder]) => {
            const card = document.createElement("div");
            card.className = "chart-card";
            const plotId = "plot-" + Math.random().toString(36).slice(2, 8);
            const badge = title.toLowerCase().includes("cross-blocking") ? crossBadgeHTML(series.coerencia) : "";
            const regLegend = title.toLowerCase().includes("restrição harmônica") ? regioesLegendHTML(series) : "";
            card.innerHTML = `
                <div class="chart-card__head">
                    <div class="chart-card__title">
                        <h3>${title}</h3>
                        <span>${sub}</span>
                        ${badge ? `<div class="chart-badge">${badge}</div>` : ""}
                        ${regLegend}
                    </div>
                    <button type="button" class="chart-expand" title="Ampliar / reduzir">⤢</button>
                </div>
                <div class="chart-plot" id="${plotId}"></div>`;
            host.appendChild(card);

            const div = card.querySelector(".chart-plot");
            try {
                builder(div, series);
            } catch (e) {
                div.innerHTML = '<p class="charts-fallback">Erro ao desenhar este diagrama.</p>';
                console.error(title, e);
            }
            card.querySelector(".chart-expand").addEventListener("click", () => {
                card.classList.toggle("chart-card--wide");
                if (typeof Plotly !== "undefined") Plotly.Plots.resize(div);
            });
        });
    }
});
