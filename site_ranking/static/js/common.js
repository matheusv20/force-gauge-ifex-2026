/* =========================================================================
   MEDIDOR DE FORÇA — utilidades comuns (Telão + Operador)
   - Conexão em tempo real (Server-Sent Events)
   - Chamadas à API
   - Formatação pt-BR
   - Motor de efeitos sonoros (Web Audio API, sem arquivos de áudio)
   ========================================================================= */
"use strict";

const MF = (() => {
  const STATES = {
    IDLE: { label: "Em Repouso", icon: "💤", cls: "st-idle" },
    PLAYER_DETECTED: { label: "Participante Detectado no PIR!", icon: "👀", cls: "st-detected" },
    COUNTDOWN: { label: "Prepare-se! Contagem Regressiva…", icon: "⏳", cls: "st-detected" },
    READY: { label: "Rodada Liberada — Bata no Alvo!", icon: "🔨", cls: "st-ready" },
    RESULT: { label: "Resultado Registrado!", icon: "🏆", cls: "st-result" },
  };

  function stateInfo(s) {
    const key = s && s.state ? String(s.state).toUpperCase() : "";
    return STATES[key] || { label: (s && (s.message || s.state)) || "—", icon: "❔", cls: "st-unknown" };
  }

  function escapeHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmt(n, digits = 0) {
    const v = Number(n);
    if (!isFinite(v)) return "—";
    return v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtTime(iso, withSeconds = false) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const opts = { hour: "2-digit", minute: "2-digit" };
    if (withSeconds) opts.second = "2-digit";
    const time = d.toLocaleTimeString("pt-BR", opts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return time;
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + time;
  }

  /** Mesmo tratamento do backend: sem acentos, até 15 caracteres (LCD 16x2). */
  function sanitizeLcd(name, max = 15) {
    return String(name || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9 ._\-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
      .trim();
  }

  async function api(path, body) {
    const opts = body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new Error("Servidor indisponível. O server.py está rodando?");
    }
    const data = await res.json().catch(() => ({ ok: false, error: "Resposta inválida do servidor" }));
    if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
    return data;
  }

  /** Abre o fluxo de eventos em tempo real; o navegador reconecta sozinho. */
  function connectEvents(handlers, onConnection) {
    // ?estatico=1 → carrega só um retrato do estado (útil para capturas/depuração)
    if (new URLSearchParams(location.search).has("estatico")) {
      api("/api/state").then((d) => { onConnection && onConnection(true); handlers.snapshot && handlers.snapshot(d); })
        .catch(() => onConnection && onConnection(false));
      return null;
    }
    const es = new EventSource("/api/events");
    es.onopen = () => onConnection && onConnection(true);
    es.onerror = () => onConnection && onConnection(false);
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const h = handlers[msg.type];
      if (h) {
        try { h(msg.data); } catch (err) { console.error("Erro no handler", msg.type, err); }
      }
    };
    return es;
  }

  function toast(text, kind = "info", ms = 3800) {
    let box = document.getElementById("toasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "toasts";
      document.body.appendChild(box);
    }
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .4s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 450);
    }, ms);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* -----------------------------------------------------------------------
     Motor de som (Web Audio API) — todos os sons são sintetizados
     ----------------------------------------------------------------------- */
  const Sound = (() => {
    let ctx = null;
    let master = null;
    let muted = localStorage.getItem("mf-muted") === "1";

    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.55;
        const comp = ctx.createDynamicsCompressor();
        master.connect(comp).connect(ctx.destination);
      }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }

    const ok = () => ctx && ctx.state === "running" && !muted;

    function tone(freq, start, dur, { type = "square", vol = 0.2, attack = 0.01, slideTo = null } = {}) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, start);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(vol, start + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g).connect(master);
      o.start(start);
      o.stop(start + dur + 0.05);
    }

    function noise(start, dur, vol = 0.5, freq = 900) {
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, start);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      src.connect(f).connect(g).connect(master);
      src.start(start);
    }

    function seq(notes, { type = "square", vol = 0.16, gap = 0 } = {}) {
      let t = ctx.currentTime + 0.02;
      for (const [f, d] of notes) {
        if (f) tone(f, t, d * 0.95, { type, vol });
        t += d + gap;
      }
    }

    return {
      ensure,
      isUnlocked: () => !!ctx && ctx.state === "running",
      isMuted: () => muted,
      setMuted(m) { muted = !!m; localStorage.setItem("mf-muted", muted ? "1" : "0"); },

      /** Pancada do martelo no alvo */
      impact() {
        if (!ok()) return;
        const t = ctx.currentTime;
        noise(t, 0.3, 0.9, 700);
        tone(140, t, 0.45, { type: "sine", vol: 0.9, slideTo: 38 });
      },

      /** Som subindo junto com a barra (curva easeOut) */
      rise(durationSec, level) {
        if (!ok()) return;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const f = ctx.createBiquadFilter();
        o.type = "sawtooth";
        f.type = "lowpass";
        f.frequency.value = 2200;
        const n = 64;
        const curve = new Float32Array(n);
        const top = 160 + 1250 * Math.max(0.05, level);
        for (let i = 0; i < n; i++) {
          const p = i / (n - 1);
          curve[i] = 160 + (top - 160) * (1 - Math.pow(1 - p, 3));
        }
        o.frequency.setValueCurveAtTime(curve, t, durationSec);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.05);
        g.gain.setValueAtTime(0.12, t + durationSec * 0.85);
        g.gain.exponentialRampToValueAtTime(0.0001, t + durationSec + 0.1);
        o.connect(f).connect(g).connect(master);
        o.start(t);
        o.stop(t + durationSec + 0.15);
      },

      /** Sino do topo (pontuação máxima) */
      bell() {
        if (!ok()) return;
        const t = ctx.currentTime;
        const base = 784;
        [[1, 0.5, 2.6], [2.76, 0.22, 1.6], [5.4, 0.12, 1.0], [8.93, 0.06, 0.6]].forEach(([m, v, d]) =>
          tone(base * m, t, d, { type: "sine", vol: v, attack: 0.002 }));
      },

      /** Fanfarra de NOVO RECORDE */
      fanfare() {
        if (!ok()) return;
        const q = 0.13;
        seq([[523, q], [659, q], [784, q], [1047, q * 2], [0, q * 0.5], [784, q], [1047, q * 4]],
          { type: "square", vol: 0.14 });
        seq([[262, q * 3], [330, q * 3], [392, q * 4.5]], { type: "triangle", vol: 0.2 });
      },

      /** Moedinha arcade (Top 3) */
      coin() {
        if (!ok()) return;
        const t = ctx.currentTime;
        tone(988, t, 0.09, { type: "square", vol: 0.15 });
        tone(1319, t + 0.09, 0.35, { type: "square", vol: 0.15 });
      },

      /** "Womp womp" para golpes fraquinhos */
      womp() {
        if (!ok()) return;
        seq([[392, 0.28], [370, 0.28], [349, 0.28], [330, 0.7]], { type: "triangle", vol: 0.22, gap: 0.04 });
      },

      /** PIR detectou alguém */
      detect() {
        if (!ok()) return;
        const t = ctx.currentTime;
        tone(880, t, 0.1, { vol: 0.12 });
        tone(880, t + 0.16, 0.1, { vol: 0.12 });
      },

      /** Contagem regressiva (3, 2, 1) */
      countdown(n) {
        if (!ok()) return;
        const freq = 660 + (3 - Math.min(3, Math.max(1, Number(n) || 1))) * 110;
        tone(freq, ctx.currentTime, 0.18, { type: "square", vol: 0.18 });
      },

      /** Rodada liberada */
      go() {
        if (!ok()) return;
        seq([[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.25]], { type: "square", vol: 0.18 });
      },

      click() {
        if (!ok()) return;
        tone(1200, ctx.currentTime, 0.04, { type: "square", vol: 0.05 });
      },
    };
  })();

  return { STATES, stateInfo, escapeHtml, fmt, fmtTime, sanitizeLcd, api, connectEvents, toast, sleep, Sound };
})();
