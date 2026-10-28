/* =========================================================================
   PAINEL DO OPERADOR — controle da rodada, serial, ranking e testes
   ========================================================================= */
"use strict";

(() => {
  const { api, toast, fmt, fmtTime, escapeHtml, stateInfo, sanitizeLcd, Sound } = MF;
  const $ = (id) => document.getElementById(id);

  const els = {
    srvDot: $("srvDot"), srvTxt: $("srvTxt"),
    ardDot: $("ardDot"), serialTxt: $("serialTxt"), portInput: $("portInput"), portList: $("portList"),
    portsHint: $("portsHint"), baud: $("baudSelect"), btnRefresh: $("btnRefresh"), btnConnect: $("btnConnect"),
    roundCard: $("roundCard"), statusPill: $("statusPill"), statusMsg: $("statusMsg"),
    name: $("nameInput"), lcd: $("lcdPreview"), lcdCount: $("lcdCount"), pendingInfo: $("pendingInfo"),
    btnStart: $("btnStart"), btnReset: $("btnReset"), btnTare: $("btnTare"),
    btnSimPir: $("btnSimPir"), btnSimHit: $("btnSimHit"), simLevel: $("simLevel"), lastResult: $("lastResult"),
    rankBody: $("rankBody"), rankEmpty: $("rankEmpty"), rankCount: $("rankCount"),
    btnClear: $("btnClear"), btnClearSim: $("btnClearSim"),
    log: $("log"), chkDebug: $("chkDebug"), chkAuto: $("chkAuto"), btnClearLog: $("btnClearLog"),
    rawInput: $("rawInput"), btnRaw: $("btnRaw"),
  };

  let serialInfo = { connected: false };
  let lcdMax = 15;
  let lastKey = null;
  let portsLoaded = false;
  const baseTitle = document.title;

  /* ---------------- helpers ---------------- */
  async function run(btn, fn) {
    Sound.ensure();
    if (btn) btn.classList.add("busy");
    try {
      return await fn();
    } catch (e) {
      toast("⚠️ " + e.message, "error", 6000);
    } finally {
      if (btn) btn.classList.remove("busy");
    }
  }

  /* ---------------- Serial ---------------- */
  function renderSerial() {
    const s = serialInfo || {};
    els.ardDot.classList.toggle("on", !!s.connected);
    if (!s.available) {
      els.serialTxt.innerHTML = "pyserial não instalado — somente simulação";
    } else if (s.connected) {
      els.serialTxt.textContent = `Conectado em ${s.port} @ ${s.baud}`;
    } else {
      els.serialTxt.innerHTML = "Desconectado (modo simulação)" +
        (s.error ? `<span class="err">${escapeHtml(s.error)}</span>` : "");
    }
    els.btnConnect.classList.toggle("connected", !!s.connected);
    els.btnConnect.textContent = s.connected ? "⏏️ Desconectar (liberar porta)" : "🔌 Conectar";
    els.portInput.disabled = !!s.connected;
    els.baud.disabled = !!s.connected;
    els.btnTare.disabled = !s.connected;
    els.btnTare.title = s.connected ? "Envia TARE ao Arduino" : "Conecte o Arduino para zerar a tara";
    if (s.connected && s.port) els.portInput.value = s.port;
  }

  async function refreshPorts(silent) {
    try {
      const r = await api("/api/ports");
      const ports = r.ports || [];
      els.portList.innerHTML = ports.map((p) =>
        `<option value="${escapeHtml(p.device)}">${escapeHtml(p.description)}${p.likely_arduino ? " ⭐" : ""}</option>`).join("");
      const likely = ports.filter((p) => p.likely_arduino);
      els.portsHint.textContent = ports.length
        ? `Portas encontradas: ${ports.map((p) => p.device + (p.likely_arduino ? " ⭐" : "")).join(", ")}`
        : "Nenhuma porta encontrada. Verifique o cabo USB (ou digite o caminho manualmente).";
      if (!els.portInput.value || !portsLoaded) {
        if (!serialInfo.connected) {
          els.portInput.value = (likely[0] || ports[0] || { device: localStorage.getItem("mf-port") || "/dev/ttyACM0" }).device;
        }
      }
      portsLoaded = true;
      if (!silent) toast(`🔄 ${ports.length} porta(s) encontrada(s)`, "info", 2000);
    } catch (e) {
      if (!silent) toast("⚠️ " + e.message, "error");
    }
  }

  els.btnRefresh.addEventListener("click", () => refreshPorts(false));

  els.btnConnect.addEventListener("click", () => run(els.btnConnect, async () => {
    if (serialInfo.connected) {
      const r = await api("/api/serial/disconnect", {});
      serialInfo = r.serial; renderSerial();
      toast("⏏️ Porta liberada. Pode gravar o Arduino pela IDE.", "warn");
    } else {
      const port = els.portInput.value.trim();
      const r = await api("/api/serial/connect", { port, baud: Number(els.baud.value) });
      localStorage.setItem("mf-port", port);
      serialInfo = r.serial; renderSerial();
      toast(`✅ Conectado em ${port}`, "ok");
    }
  }));

  /* ---------------- Estado / rodada ---------------- */
  function applyState(s) {
    const info = stateInfo(s);
    const key = String(s.state || "").toUpperCase();
    els.statusPill.className = "status-pill big " + info.cls;
    const labelTxt = key === "COUNTDOWN" && s.countdown
      ? `Prepare-se: ${s.countdown}…`
      : info.label;
    els.statusPill.innerHTML = `<span class="icon">${info.icon}</span><span class="label">${escapeHtml(labelTxt)}</span>`;
    const src = s.source === "simulado" ? " (simulado)" : s.source === "operador" ? " (operador)" : "";
    els.statusMsg.textContent = (s.message || "") + (s.player ? ` — ${s.player}` : "") + src;

    els.roundCard.classList.toggle("attention", key === "PLAYER_DETECTED" || key === "COUNTDOWN");
    els.roundCard.classList.toggle("ready", key === "READY");

    if (key === "COUNTDOWN") {
      Sound.countdown(s.countdown);
      document.title = `⏳ ${s.countdown}... — ${s.player || "Prepare-se"}`;
    } else if (key !== lastKey) {
      if (key === "PLAYER_DETECTED") {
        Sound.detect();
        els.name.focus();
        els.name.select();
        document.title = "👀 PARTICIPANTE DETECTADO!";
      } else if (key === "READY") {
        Sound.go();
        document.title = "🔨 VALENDO! BATA NO ALVO!";
      } else {
        document.title = baseTitle;
      }
    }
    if (key === "COUNTDOWN" && s.player) {
      els.pendingInfo.textContent = `⏳ Contagem regressiva para ${s.player}: ${s.countdown || ""}s…`;
    } else if (key === "READY" && s.player) {
      els.pendingInfo.textContent = `🔨 Rodada em andamento: ${s.player} — aguardando o golpe…`;
    } else {
      els.pendingInfo.textContent = "";
    }
    lastKey = key;
  }

  function updateLcdPreview() {
    const lcd = sanitizeLcd(els.name.value, lcdMax);
    els.lcd.textContent = (lcd || "").padEnd(16, " ").slice(0, 16) || " ".repeat(16);
    els.lcdCount.textContent = `${lcd.length}/${lcdMax}`;
    els.lcdCount.classList.toggle("full", lcd.length >= lcdMax);
  }
  els.name.addEventListener("input", updateLcdPreview);
  els.name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startRound(); } });
  updateLcdPreview();

  function startRound() {
    return run(els.btnStart, async () => {
      const name = els.name.value.trim();
      if (!name) {
        els.name.focus();
        throw new Error("Digite o nome do participante.");
      }
      const r = await api("/api/command", { cmd: "START", player: name });
      toast(r.simulated
        ? `🧪 Rodada liberada (simulação): ${r.display}`
        : `▶️ START:${r.lcd} enviado ao Arduino`, r.simulated ? "warn" : "ok");
      els.name.value = "";
      updateLcdPreview();
    });
  }
  els.btnStart.addEventListener("click", startRound);

  els.btnReset.addEventListener("click", () => run(els.btnReset, async () => {
    const r = await api("/api/command", { cmd: "RESET" });
    toast(r.sent ? "⛔ RESET enviado ao Arduino" : "⛔ Rodada cancelada (Arduino desconectado)", "warn");
  }));

  els.btnTare.addEventListener("click", () => run(els.btnTare, async () => {
    await api("/api/command", { cmd: "TARE" });
    toast("⚖️ TARE enviado — não toque no alvo durante a tara!", "ok");
  }));

  /* ---------------- Simulação ---------------- */
  els.btnSimPir.addEventListener("click", () => run(els.btnSimPir, () => api("/api/simulate/pir", {})));

  els.btnSimHit.addEventListener("click", () => run(els.btnSimHit, async () => {
    const typed = els.name.value.trim();
    await api("/api/simulate/hit", { player: typed || null, level: els.simLevel.value });
    if (typed) { els.name.value = ""; updateLcdPreview(); }
  }));

  function showLastResult(r) {
    if (!r || !r.entry) {
      els.lastResult.querySelector(".lr-body").textContent = "—";
      return;
    }
    const e = r.entry;
    els.lastResult.querySelector(".lr-body").innerHTML =
      `<div><b>${escapeHtml(e.player)}</b> ${e.source === "simulado" ? "🧪" : "🔌"} — ` +
      `${r.rank}º de ${r.total}${r.is_record ? " 🏆 <b>NOVO RECORDE!</b>" : ""}</div>` +
      `<div class="big-score">${e.score} pts</div>` +
      `<div>💨 ${fmt(e.speed_ms, 2)} m/s (${fmt(e.speed_kmh, 1)} km/h) · 💪 ${fmt(e.force_kgf, 2)} kgf · bruto ${e.force_raw}</div>`;
  }

  /* ---------------- Ranking ---------------- */
  function renderRanking(list) {
    list = Array.isArray(list) ? list : [];
    els.rankCount.textContent = `(${list.length})`;
    els.rankEmpty.style.display = list.length ? "none" : "block";
    els.rankBody.innerHTML = list.map((e, i) => {
      const sim = e.source === "simulado";
      return `<tr>` +
        `<td>${i + 1}º</td>` +
        `<td class="l" title="LCD: ${escapeHtml(e.player_lcd || "")}">${escapeHtml(e.player)}</td>` +
        `<td class="pts">${e.score}</td>` +
        `<td>${fmt(e.speed_ms, 2)}</td><td>${fmt(e.speed_kmh, 1)}</td><td>${fmt(e.force_kgf, 2)}</td>` +
        `<td>${e.force_raw ?? "—"}</td><td>${fmtTime(e.timestamp, true)}</td>` +
        `<td class="${sim ? "src-sim" : "src-ard"}">${sim ? "🧪 teste" : "🔌 Arduino"}</td>` +
        `<td><button class="del" data-id="${e.id}" data-name="${escapeHtml(e.player)}" title="Remover">🗑️</button></td>` +
        `</tr>`;
    }).join("");
  }

  els.rankBody.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".del");
    if (!btn) return;
    if (!confirm(`Remover o resultado de "${btn.dataset.name}" do ranking?`)) return;
    run(null, async () => {
      await api("/api/ranking/delete", { id: Number(btn.dataset.id) });
      toast("🗑️ Resultado removido", "warn");
    });
  });

  els.btnClear.addEventListener("click", () => {
    if (!confirm("Tem certeza que deseja APAGAR TODO o ranking?\n\nUm backup será salvo em data/backups/.")) return;
    if (!confirm("Confirma mesmo? Esta ação limpa o telão.")) return;
    run(els.btnClear, async () => {
      const r = await api("/api/ranking/clear", {});
      toast(`🗑️ Ranking zerado (${r.removed} registros). Backup salvo.`, "warn", 6000);
      showLastResult(null);
    });
  });

  els.btnClearSim.addEventListener("click", () => {
    if (!confirm("Remover todos os resultados SIMULADOS (testes) do ranking?")) return;
    run(els.btnClearSim, async () => {
      const r = await api("/api/ranking/clear", { only_simulated: true });
      toast(`🧹 ${r.removed} resultado(s) de teste removido(s).`, "ok");
    });
  });

  /* ---------------- Monitor serial ---------------- */
  const DIR = { rx: "RX ◀", tx: "TX ▶", sys: "SYS", sim: "SIM" };
  function addLog(e) {
    const div = document.createElement("div");
    div.className = `ln ${e.dir} k-${e.kind}`;
    div.innerHTML = `<span class="t">${escapeHtml(e.t)}</span><span class="d">${DIR[e.dir] || e.dir}</span> ` +
      `<span class="x">${escapeHtml(e.text)}</span>`;
    els.log.appendChild(div);
    while (els.log.childElementCount > 600) els.log.firstElementChild.remove();
    if (els.chkAuto.checked) els.log.scrollTop = els.log.scrollHeight;
  }
  els.chkDebug.addEventListener("change", () => els.log.classList.toggle("hide-debug", !els.chkDebug.checked));
  els.btnClearLog.addEventListener("click", () => { els.log.innerHTML = ""; });

  function sendRaw() {
    return run(els.btnRaw, async () => {
      const line = els.rawInput.value.trim();
      if (!line) return;
      await api("/api/serial/send", { line });
      els.rawInput.value = "";
    });
  }
  els.btnRaw.addEventListener("click", sendRaw);
  els.rawInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendRaw(); });

  document.addEventListener("click", () => Sound.ensure());

  /* ---------------- Tempo real ---------------- */
  MF.connectEvents({
    snapshot(d) {
      lcdMax = (d.config && d.config.lcd_name_max) || 15;
      serialInfo = d.serial || serialInfo;
      renderSerial();
      applyState(d.state);
      renderRanking(d.ranking);
      showLastResult(d.last_result);
      els.log.innerHTML = "";
      (d.logs || []).forEach(addLog);
      updateLcdPreview();
    },
    status: applyState,
    serial(info) { serialInfo = info; renderSerial(); },
    log: addLog,
    ranking: renderRanking,
    result(r) {
      showLastResult(r);
      toast(`🔨 ${r.entry.player}: ${r.entry.score} pts — ${r.rank}º lugar${r.is_record ? " 🏆 RECORDE!" : ""}`, "ok", 6000);
    },
  }, (ok) => {
    els.srvDot.classList.toggle("on", ok);
    els.srvTxt.textContent = ok ? "Servidor online" : "Servidor offline — reconectando…";
  });

  refreshPorts(true);
})();
