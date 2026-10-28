/* =========================================================================
   TELÃO — lógica do ranking ao vivo e da animação do medidor
   ========================================================================= */
"use strict";

(() => {
  const { fmt, fmtTime, escapeHtml, stateInfo, Sound, sleep } = MF;
  const $ = (id) => document.getElementById(id);

  const els = {
    statusPill: $("statusPill"), statusSub: $("statusSub"), clock: $("clock"),
    srvDot: $("srvDot"), ardDot: $("ardDot"), ardTxt: $("ardTxt"),
    player: $("playerName"), tube: $("tube"), ticks: $("ticks"), tiers: $("tiers"),
    striker: $("striker"), bell: $("bell"), score: $("score"), tierName: $("tierName"),
    speedMs: $("mSpeedMs"), speedKmh: $("mSpeedKmh"), force: $("mForce"), rankBanner: $("rankBanner"),
    podium: $("podium"), body: $("boardBody"), tableWrap: $("tableWrap"), empty: $("emptyBoard"),
    count: $("count"), hlSpeed: $("hlSpeed"), hlForce: $("hlForce"),
    recordOverlay: $("recordOverlay"), recordName: $("recordName"), recordScore: $("recordScore"),
    unlock: $("unlock"), btnMute: $("btnMute"), btnFull: $("btnFull"),
  };

  // Níveis exibidos ao lado do tubo (fração da pontuação máxima)
  const TIERS = [
    { min: 0.0, name: "CAFÉ COM LEITE", color: "#7fdcff" },
    { min: 0.2, name: "FRACOTE", color: "#39ff14" },
    { min: 0.4, name: "NA MÉDIA", color: "#c6ff00" },
    { min: 0.6, name: "FORTÃO", color: "#ffe600" },
    { min: 0.8, name: "MONSTRO", color: "#ff8a00" },
    { min: 0.95, name: "LENDÁRIO!", color: "#ff2a4d" },
  ];

  let maxScore = 1000;
  let animating = false;
  let pendingRanking = null;
  let resultQueue = Promise.resolve();
  let highlightId = null;
  let lastState = null;
  let bannerTimer = null;

  /* ---------------- Lâmpadas e relógio ---------------- */
  function bulbs(el, n) { el.innerHTML = "<span></span>".repeat(n); }
  bulbs($("bulbsTop"), 22);
  bulbs($("bulbsBottom"), 22);

  function tickClock() {
    els.clock.textContent = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  tickClock();
  setInterval(tickClock, 5000);

  /* ---------------- Escala do tubo ---------------- */
  function buildScale() {
    els.ticks.innerHTML = "";
    for (let i = 1; i < 20; i++) {
      const t = document.createElement("div");
      t.className = "tick" + (i % 2 === 0 ? " major" : "");
      t.style.bottom = (i * 5) + "%";
      els.ticks.appendChild(t);
    }
    els.tiers.innerHTML = TIERS.map((t, i) =>
      `<div class="tier" data-i="${i}" style="bottom:${t.min * 100}%;--tc:${t.color}">${escapeHtml(t.name)}` +
      `<small>${Math.round(t.min * maxScore)}</small></div>`).join("");
  }

  function tierFor(frac) {
    let idx = 0;
    TIERS.forEach((t, i) => { if (frac >= t.min) idx = i; });
    return idx;
  }

  function setLevel(frac) {
    frac = Math.max(0, Math.min(1, frac));
    els.tube.style.setProperty("--level", frac.toFixed(4));
    const idx = tierFor(frac);
    els.tiers.querySelectorAll(".tier").forEach((el, i) => el.classList.toggle("hit", frac > 0 && i <= idx));
  }

  const pad3 = (n) => String(Math.max(0, Math.round(n))).padStart(3, "0");

  /* ---------------- Status da máquina ---------------- */
  const SUBTEXT = {
    IDLE: "Aproxime-se da máquina para jogar!",
    PLAYER_DETECTED: "Informe seu nome ao responsável 📝",
    COUNTDOWN: "Prepare o martelo para a contagem! ⏳",
    READY: "VALENDO! Mande ver no alvo! 💥",
    RESULT: "Confira sua posição no ranking ➜",
  };

  function applyStatus(s, withSound) {
    const info = stateInfo(s);
    const key = String(s.state || "").toUpperCase();
    const labelTxt = key === "COUNTDOWN" && s.countdown
      ? `Prepare-se: ${s.countdown}…`
      : info.label;
    els.statusPill.className = "status-pill " + info.cls;
    els.statusPill.innerHTML = `<span class="icon">${info.icon}</span><span class="label">${escapeHtml(labelTxt)}</span>`;
    els.statusSub.textContent = SUBTEXT[key] || s.message || "";

    if (withSound) {
      if (key === "COUNTDOWN") {
        Sound.countdown(s.countdown);
      } else if (key !== lastState) {
        if (key === "PLAYER_DETECTED") Sound.detect();
        if (key === "READY") Sound.go();
      }
    }
    if (key === "COUNTDOWN" && !animating) {
      els.player.textContent = s.player || "—";
      els.score.textContent = s.countdown ? `00${s.countdown}` : "---";
      els.tierName.textContent = `PREPARE-SE: ${s.countdown || ""}...`;
      els.tierName.style.color = "#ffe600";
      els.tierName.style.textShadow = "0 0 14px #ffe600";
      els.speedMs.textContent = els.speedKmh.textContent = els.force.textContent = "—";
      hideBanner();
      setLevel(0);
      els.tube.classList.add("idle");
    }
    if (key === "READY" && !animating) {
      // Nova rodada: zera o medidor e mostra o jogador
      els.player.textContent = s.player || "—";
      els.score.textContent = "000";
      els.tierName.textContent = "VALENDO! BATA!";
      els.tierName.style.color = "#39ff14";
      els.tierName.style.textShadow = "0 0 14px #39ff14";
      els.speedMs.textContent = els.speedKmh.textContent = els.force.textContent = "—";
      hideBanner();
      setLevel(0);
      els.tube.classList.add("idle");
    }
    if (key === "IDLE" && (!animating || s.source === "operador")) {
      els.player.textContent = "—";
      els.score.textContent = "000";
      els.tierName.innerHTML = "&nbsp;";
      els.speedMs.textContent = els.speedKmh.textContent = els.force.textContent = "—";
      hideBanner();
      setLevel(0);
      els.tube.classList.add("idle");
      els.recordOverlay.classList.remove("show");
    }
    lastState = key;
  }

  function setArduino(info) {
    const on = !!(info && info.connected);
    els.ardDot.classList.toggle("on", on);
    els.ardTxt.textContent = on ? "Arduino" : "Arduino (off)";
    els.ardTxt.title = on ? `${info.port} @ ${info.baud}` : "Desconectado — modo simulação";
  }

  /* ---------------- Exibição estática de um resultado ---------------- */
  function showStatic(entry) {
    const frac = entry.score / maxScore;
    els.player.textContent = entry.player;
    els.score.textContent = pad3(entry.score);
    els.speedMs.textContent = fmt(entry.speed_ms, 2);
    els.speedKmh.textContent = fmt(entry.speed_kmh, 1);
    els.force.textContent = fmt(entry.force_kgf, 1);
    const t = TIERS[tierFor(frac)];
    els.tierName.textContent = t.name;
    els.tierName.style.color = t.color;
    els.tierName.style.textShadow = `0 0 14px ${t.color}`;
    setLevel(frac);
    els.tube.classList.remove("idle");
  }

  /* ---------------- Animação do resultado ---------------- */
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);

  /** requestAnimationFrame com "rede de segurança": se a aba estiver em segundo
      plano (rAF pausado), o setTimeout garante que a animação/fila não trave. */
  function nextFrame(cb) {
    let done = false;
    const run = () => { if (!done) { done = true; cb(performance.now()); } };
    requestAnimationFrame(run);
    setTimeout(run, 60);
  }

  function animate(duration, step) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      function frame(now) {
        const p = Math.min(1, (now - t0) / duration);
        step(p);
        if (p < 1) nextFrame(frame); else resolve();
      }
      nextFrame(frame);
    });
  }

  function countUp(el, to, digits, duration = 700) {
    return animate(duration, (p) => { el.textContent = fmt(to * easeOutCubic(p), digits); });
  }

  function showBanner(text, cls, ms = 7000) {
    clearTimeout(bannerTimer);
    els.rankBanner.className = "rank-banner show " + cls;
    els.rankBanner.textContent = text;
    bannerTimer = setTimeout(hideBanner, ms);
  }
  function hideBanner() { els.rankBanner.className = "rank-banner"; }

  async function playResult(r) {
    const { entry, rank, total, is_record } = r;
    animating = true;
    highlightId = entry.id;
    try {
      els.player.textContent = entry.player;
      els.tube.classList.remove("idle");
      els.tierName.innerHTML = "&nbsp;";
      els.speedMs.textContent = els.speedKmh.textContent = els.force.textContent = "—";
      hideBanner();
      setLevel(0);

      // 1) Pancada!
      Sound.impact();
      els.striker.classList.remove("shake");
      void els.striker.offsetWidth;
      els.striker.classList.add("shake");
      await sleep(250);

      // 2) Barra subindo
      const target = Math.max(0, Math.min(1, entry.score / maxScore));
      const dur = 1300 + target * 2200;
      Sound.rise(dur / 1000, target);
      await animate(dur, (p) => {
        const e = easeOutCubic(p);
        setLevel(target * e);
        els.score.textContent = pad3(entry.score * e);
      });
      els.score.textContent = pad3(entry.score);
      els.score.classList.remove("pop");
      void els.score.offsetWidth;
      els.score.classList.add("pop");

      // 3) Nível + métricas
      const tier = TIERS[tierFor(target)];
      els.tierName.textContent = tier.name;
      els.tierName.style.color = tier.color;
      els.tierName.style.textShadow = `0 0 14px ${tier.color}`;
      if (target >= 0.95) {
        els.bell.classList.remove("ring");
        void els.bell.offsetWidth;
        els.bell.classList.add("ring");
        Sound.bell();
      }
      els.speedKmh.textContent = fmt(entry.speed_kmh, 1);
      await Promise.all([
        countUp(els.speedMs, entry.speed_ms, 2),
        countUp(els.speedKmh, entry.speed_kmh, 1),
        countUp(els.force, entry.force_kgf, 1),
      ]);
      await sleep(350);

      // 4) Comemoração
      if (is_record) {
        els.recordName.textContent = entry.player;
        els.recordScore.textContent = `${fmt(entry.force_kgf, 2)} kgf (${entry.force_raw ?? 0})`;
        els.recordOverlay.classList.add("show");
        Sound.fanfare();
        Confetti.burst(5200, 260);
        showBanner(`🏆 1º LUGAR (MAIOR FORÇA)! 🏆`, "top3");
        await sleep(5200);
        els.recordOverlay.classList.remove("show");
      } else if (rank <= 3) {
        Sound.coin();
        Confetti.burst(2500, 90);
        showBanner(`${["", "🥇", "🥈", "🥉"][rank]} TOP 3 — ${rank}º LUGAR!`, "top3");
      } else if (target < 0.2) {
        Sound.womp();
        showBanner(`${rank}º de ${total} — bora tentar de novo? 😅`, "weak");
      } else {
        Sound.coin();
        showBanner(`${rank}º LUGAR de ${total}`, "normal");
      }
    } finally {
      animating = false;
      if (pendingRanking) {
        renderRanking(pendingRanking);
        pendingRanking = null;
      }
      scrollToHighlight();
    }
  }

  /* ---------------- Ranking ---------------- */
  function renderRanking(list) {
    list = Array.isArray(list) ? list : [];
    els.count.textContent = `${list.length} ${list.length === 1 ? "jogada" : "jogadas"}`;

    // Pódio (ordem visual 2 - 1 - 3)
    const medals = ["🥇", "🥈", "🥉"];
    els.podium.innerHTML = [1, 0, 2].map((i) => {
      const e = list[i];
      if (!e) {
        return `<div class="pod p${i + 1} empty"><div class="medal">${medals[i]}</div>` +
          `<div class="pname">—</div><div class="pscore">---</div><div class="pmeta">&nbsp;</div></div>`;
      }
      const flash = e.id === highlightId ? " flash" : "";
      return `<div class="pod p${i + 1}${flash}"><div class="medal">${medals[i]}</div>` +
        `<div class="pname" title="${escapeHtml(e.player)}">${escapeHtml(e.player)}</div>` +
        `<div class="pscore">${fmt(e.force_kgf, 2)} <small style="font-size:0.45em">kgf</small></div>` +
        `<div class="pmeta">Bruto: ${e.force_raw ?? 0} · ${e.score} pts · ${fmt(e.speed_kmh, 1)} km/h</div></div>`;
    }).join("");

    // Tabela completa
    els.body.innerHTML = list.map((e, i) => {
      const pos = i + 1;
      const cls = [pos <= 3 ? "r" + pos : "", e.id === highlightId ? "new" : ""].join(" ").trim();
      const posTxt = pos <= 3 ? medals[i] : pos + "º";
      const sim = e.source === "simulado" ? '<span class="sim-tag" title="Golpe simulado">TESTE</span>' : "";
      return `<tr class="${cls}" data-id="${e.id}">` +
        `<td class="pos">${posTxt}</td>` +
        `<td class="l name">${escapeHtml(e.player)}${sim}</td>` +
        `<td class="pts">${e.score}</td>` +
        `<td>${fmt(e.speed_ms, 2)} <small>m/s</small> · ${fmt(e.speed_kmh, 1)} <small>km/h</small></td>` +
        `<td><b>${fmt(e.force_kgf, 2)}</b> <small>kgf (${e.force_raw ?? 0})</small></td>` +
        `<td>${fmtTime(e.timestamp)}</td></tr>`;
    }).join("");
    els.empty.style.display = list.length ? "none" : "grid";

    // Destaques
    if (list.length) {
      const fastest = list.reduce((a, b) => (Number(b.speed_ms) > Number(a.speed_ms) ? b : a));
      const strongest = list.reduce((a, b) => (Number(b.force_raw ?? b.force_kgf) > Number(a.force_raw ?? a.force_kgf) ? b : a));
      els.hlSpeed.textContent = `${fmt(fastest.speed_kmh, 1)} km/h — ${fastest.player}`;
      els.hlForce.textContent = `${fmt(strongest.force_kgf, 2)} kgf (${strongest.force_raw ?? 0}) — ${strongest.player}`;
    } else {
      els.hlSpeed.textContent = els.hlForce.textContent = "—";
    }
  }

  /* Rolagem automática da tabela quando houver muitos jogadores */
  const scroller = { pauseUntil: performance.now() + 4000, pos: 0 };
  function scrollToHighlight() {
    const row = els.body.querySelector("tr.new");
    if (!row) return;
    const wrap = els.tableWrap;
    const target = row.offsetTop - wrap.clientHeight / 2;
    scroller.pos = Math.max(0, Math.min(target, wrap.scrollHeight - wrap.clientHeight));
    wrap.scrollTop = scroller.pos;
    scroller.pauseUntil = performance.now() + 9000;
  }
  function autoScroll(now) {
    const wrap = els.tableWrap;
    const max = wrap.scrollHeight - wrap.clientHeight;
    if (max > 4 && !animating && now > scroller.pauseUntil) {
      scroller.pos += 0.45;
      if (scroller.pos >= max) {
        scroller.pos = max;
        wrap.scrollTop = max;
        scroller.pauseUntil = now + 3500;
        setTimeout(() => { scroller.pos = 0; wrap.scrollTop = 0; scroller.pauseUntil = performance.now() + 4500; }, 3000);
      }
      wrap.scrollTop = scroller.pos;
    } else if (max <= 4) {
      scroller.pos = 0;
    }
    requestAnimationFrame(autoScroll);
  }
  requestAnimationFrame(autoScroll);

  /* ---------------- Confete (canvas) ---------------- */
  const Confetti = (() => {
    const cv = $("confetti");
    const cx = cv.getContext("2d");
    let parts = [];
    let running = false;
    let spawnUntil = 0;
    let rate = 0;
    const colors = ["#ff2bd6", "#00f0ff", "#ffe600", "#39ff14", "#ff8a00", "#a259ff", "#ffffff"];

    function resize() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; }
    addEventListener("resize", resize);
    resize();

    function spawn(n) {
      for (let i = 0; i < n; i++) {
        parts.push({
          x: Math.random() * cv.width,
          y: -20 * devicePixelRatio,
          vx: (Math.random() - 0.5) * 4 * devicePixelRatio,
          vy: (2 + Math.random() * 4) * devicePixelRatio,
          w: (6 + Math.random() * 8) * devicePixelRatio,
          h: (8 + Math.random() * 10) * devicePixelRatio,
          a: Math.random() * Math.PI,
          va: (Math.random() - 0.5) * 0.3,
          c: colors[(Math.random() * colors.length) | 0],
        });
      }
    }

    function frame() {
      cx.clearRect(0, 0, cv.width, cv.height);
      if (performance.now() < spawnUntil) spawn(rate);
      parts = parts.filter((p) => p.y < cv.height + 40);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.a += p.va; p.vx += Math.sin(p.y / 60) * 0.05;
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.a);
        cx.fillStyle = p.c;
        cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.a)));
        cx.restore();
      }
      if (parts.length || performance.now() < spawnUntil) requestAnimationFrame(frame);
      else { running = false; cx.clearRect(0, 0, cv.width, cv.height); }
    }

    return {
      burst(ms = 3000, total = 150) {
        spawn(Math.round(total / 3));
        rate = Math.max(1, Math.round(total / (ms / 16) * 2));
        spawnUntil = performance.now() + ms * 0.6;
        if (!running) { running = true; requestAnimationFrame(frame); }
      },
    };
  })();

  /* ---------------- Som / tela cheia / atalhos ---------------- */
  function refreshMuteBtn() { els.btnMute.textContent = Sound.isMuted() ? "🔇" : "🔊"; }
  refreshMuteBtn();

  els.unlock.addEventListener("click", () => {
    Sound.ensure();
    els.unlock.classList.add("hidden");
  });
  // Se o navegador já permitir áudio sem clique (ex.: Chromium com
  // --autoplay-policy=no-user-gesture-required), esconde o aviso sozinho.
  Sound.ensure();
  setTimeout(() => { if (Sound.isUnlocked()) els.unlock.classList.add("hidden"); }, 400);
  document.addEventListener("click", () => Sound.ensure(), { once: false });

  els.btnMute.addEventListener("click", (e) => {
    e.stopPropagation();
    Sound.setMuted(!Sound.isMuted());
    refreshMuteBtn();
  });
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  els.btnFull.addEventListener("click", (e) => { e.stopPropagation(); toggleFull(); });

  document.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === "f") toggleFull();
    if (k === "m") { Sound.setMuted(!Sound.isMuted()); refreshMuteBtn(); }
    if (k === "t") previewAnimation();
  });

  /** Prévia LOCAL da animação (não salva nada no ranking). Tecla T ou ?demo=1 */
  function previewAnimation(isRecord = false) {
    Sound.ensure();
    els.unlock.classList.add("hidden");
    const score = Math.round(150 + Math.random() * (maxScore - 150));
    const sp = 1 + Math.random() * 5;
    resultQueue = resultQueue.then(() => playResult({
      entry: { id: -1, player: "Prévia", score: isRecord ? maxScore : score, speed_ms: sp, speed_kmh: sp * 3.6,
        force_kgf: 3 + Math.random() * 20 },
      rank: isRecord ? 1 : 99, total: 99, is_record: isRecord,
    })).catch(console.error);
  }
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo) setTimeout(() => previewAnimation(demo === "recorde"), 800);

  /* ---------------- Tempo real ---------------- */
  buildScale();
  setLevel(0);

  MF.connectEvents({
    snapshot(d) {
      maxScore = (d.config && d.config.max_score) || 1000;
      buildScale();
      setArduino(d.serial);
      renderRanking(d.ranking);
      if (d.last_result && d.last_result.entry) {
        highlightId = d.last_result.entry.id;
        showStatic(d.last_result.entry);
        renderRanking(d.ranking);
      }
      applyStatus(d.state, false);
    },
    status(s) { applyStatus(s, true); },
    serial(info) { setArduino(info); },
    result(r) { resultQueue = resultQueue.then(() => playResult(r)).catch(console.error); },
    ranking(list) {
      if (animating) pendingRanking = list;
      else renderRanking(list);
    },
  }, (ok) => {
    els.srvDot.classList.toggle("on", ok);
  });
})();
