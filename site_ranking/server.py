#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MEDIDOR DE FORÇA — Backend do Site de Ranking ao Vivo + Painel do Operador
===========================================================================

Projeto Integrador — máquina "High Striker" (martelo + alvo acolchoado)
controlada por um Arduino Uno conectado via USB Serial (115200 baud).

Este servidor usa SOMENTE a biblioteca padrão do Python + pyserial:
  * Servidor HTTP (arquivos estáticos + API JSON)
  * Server-Sent Events (/api/events) para empurrar eventos em tempo real
    para o Telão e para o Painel do Operador
  * Thread de leitura da porta Serial (linhas que começam com "{" são JSON,
    o resto é tratado como debug e apenas exibido no monitor serial)
  * Ranking salvo automaticamente em data/ranking.json (gravação atômica)

Protocolo (115200 baud, linhas terminadas em \n):
  Arduino -> Notebook
    {"event":"status","state":"IDLE","message":"Em repouso"}
    {"event":"status","state":"PLAYER_DETECTED","message":"Jogador detectado pelo PIR!"}
    {"event":"status","state":"READY","player":"Matheus","message":"Valendo! Bata no alvo!"}
    {"event":"result","player":"Matheus","speed_ms":4.20,"speed_kmh":15.1,
     "force_raw":145000,"force_kgf":14.5,"score":785}
  Notebook -> Arduino
    START:<nome sem acentos, máx. 15 caracteres>
    RESET
    TARE

Uso:
  ../.venv/bin/python server.py                 # http://127.0.0.1:8000
  ../.venv/bin/python server.py --auto-connect  # já abre a porta serial
  ../.venv/bin/python server.py --host 0.0.0.0  # acessível por outros PCs da rede
"""

import argparse
import csv
import io
import json
import mimetypes
import os
import queue
import random
import re
import signal
import sys
import threading
import time
import unicodedata
import webbrowser
from collections import deque
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

try:
    import serial  # pyserial
    import serial.tools.list_ports
    HAS_SERIAL = True
except ImportError:  # pragma: no cover - permite rodar em modo simulação sem pyserial
    serial = None
    HAS_SERIAL = False

# ---------------------------------------------------------------------------
# Caminhos e constantes
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
RANKING_FILE = os.path.join(DATA_DIR, "ranking.json")

DEFAULT_BAUD = 115200
LCD_NAME_MAX = 15          # LCD 16x2: 15 caracteres para o nome
DISPLAY_NAME_MAX = 40      # nome "bonito" (com acentos) exibido no telão

# Peso da tábua de MDF (25x25 cm) que fica apoiada sobre as células de carga:
BOARD_WEIGHT_G = 755
BOARD_WEIGHT_KGF = 0.755
# Calibração real de impacto (marretada com as 2 mãos dá média de ~11.000 bruto):
MAX_FORCE_RAW_REF = 12000.0        # 12.000 bruto = 1000 pontos (11.000 bruto = ~917 pontos)
CALIBRATION_RAW_PER_KGF = 600.0    # 11.000 bruto ~= 18.3 kgf de pico dinâmico
BOARD_WEIGHT_RAW = 450             # Desconto residual caso não tenha feito tara na rodada

DEFAULT_MESSAGES = {
    "IDLE": "Em repouso",
    "PLAYER_DETECTED": "Jogador detectado pelo PIR!",
    "COUNTDOWN": "Prepare-se! Contagem regressiva...",
    "READY": "Valendo! Bata no alvo!",
    "RESULT": "Resultado registrado!",
}

# Faixas usadas pelo "Simular Golpe de Teste": (velocidade m/s, força bruta)
SIM_LEVELS = {
    "fraco": ((1.0, 2.5), (2000, 4500)),
    "medio": ((2.5, 4.5), (5000, 8200)),
    "forte": ((4.5, 6.0), (9200, 11800)),
}


def calcular_score_por_forca(force_raw, max_score=1000):
    if force_raw <= 0:
        return 0
    pts = int(round((float(force_raw) / MAX_FORCE_RAW_REF) * max_score))
    return max(10, min(int(max_score), pts))


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def clock():
    return datetime.now().strftime("%H:%M:%S")


def sanitize_lcd_name(name):
    """Remove acentos/caracteres especiais e limita a 15 caracteres (LCD 16x2)."""
    if not name:
        return ""
    text = unicodedata.normalize("NFKD", str(name))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.encode("ascii", "ignore").decode("ascii")
    # ":" é separador do protocolo e quebras de linha encerram o comando
    text = re.sub(r"[^A-Za-z0-9 ._\-]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:LCD_NAME_MAX].strip()


def clean_display_name(name):
    text = re.sub(r"[\r\n\t]+", " ", str(name or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:DISPLAY_NAME_MAX]


def to_float(value, default=0.0):
    try:
        f = float(value)
        if f != f or f in (float("inf"), float("-inf")):  # NaN / inf
            return default
        return f
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Barramento de eventos (Server-Sent Events)
# ---------------------------------------------------------------------------
class EventBus:
    def __init__(self):
        self._clients = set()
        self._lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue(maxsize=1000)
        with self._lock:
            self._clients.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._clients.discard(q)

    def publish(self, type_, data):
        msg = json.dumps({"type": type_, "data": data}, ensure_ascii=False)
        with self._lock:
            clients = list(self._clients)
        for q in clients:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass  # cliente lento/travado: descarta

    @property
    def client_count(self):
        with self._lock:
            return len(self._clients)


# ---------------------------------------------------------------------------
# Armazenamento do ranking (data/ranking.json)
# ---------------------------------------------------------------------------
class RankingStore:
    def __init__(self, path):
        self.path = path
        self._lock = threading.RLock()
        self.entries = []
        self._next_id = 1
        self.load()

    def load(self):
        entries = []
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            entries = data.get("entries", []) if isinstance(data, dict) else data
        except FileNotFoundError:
            entries = []
        except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
            # Arquivo corrompido: guarda uma cópia e começa do zero
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            bad = self.path + f".corrompido_{stamp}"
            try:
                os.replace(self.path, bad)
            except OSError:
                pass
            print(f"[AVISO] ranking.json inválido ({exc}). Cópia salva em {bad}")
            entries = []
        with self._lock:
            # Remove apenas simulações antigas fora da nova escala (> 25.000 bruto) e recalcula score justo nas reais:
            cleaned = []
            for e in entries:
                if not isinstance(e, dict):
                    continue
                if to_float(e.get("force_raw")) > 30000:
                    continue
                f_raw = int(to_float(e.get("force_raw")))
                e["force_raw"] = f_raw
                e["force_kgf"] = round(f_raw / CALIBRATION_RAW_PER_KGF, 2)
                e["score"] = calcular_score_por_forca(f_raw, 1000)
                cleaned.append(e)
            self.entries = cleaned
            ids = [int(e.get("id", 0)) for e in self.entries if str(e.get("id", "")).isdigit()]
            self._next_id = (max(ids) + 1) if ids else 1
            for e in self.entries:  # garante id em entradas antigas/importadas
                if not str(e.get("id", "")).isdigit():
                    e["id"] = self._next_id
                    self._next_id += 1
            self._save()

    def _save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        payload = {"version": 1, "updated_at": now_iso(), "entries": self.entries}
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)  # gravação atômica: nunca deixa o arquivo pela metade

    @staticmethod
    def _sort_key(e):
        # Ranking ordenado EXCLUSIVAMENTE pela força bruta da porrada (force_raw / force_kgf)
        return (
            -to_float(e.get("force_raw")),
            -to_float(e.get("force_kgf")),
            -to_float(e.get("score")),
            str(e.get("timestamp", "")),
        )

    def sorted(self):
        with self._lock:
            return [dict(e) for e in sorted(self.entries, key=self._sort_key)]

    def best_score(self):
        with self._lock:
            return max((to_float(e.get("score")) for e in self.entries), default=0)

    def best_force_raw(self):
        with self._lock:
            return max((to_float(e.get("force_raw")) for e in self.entries), default=0)

    def add(self, record):
        with self._lock:
            entry = dict(record)
            entry["id"] = self._next_id
            self._next_id += 1
            self.entries.append(entry)
            self._save()
            ordered = sorted(self.entries, key=self._sort_key)
            rank = next(i for i, e in enumerate(ordered, 1) if e["id"] == entry["id"])
            return dict(entry), rank, len(ordered)

    def delete(self, entry_id):
        with self._lock:
            before = len(self.entries)
            self.entries = [e for e in self.entries if int(e.get("id", -1)) != int(entry_id)]
            if len(self.entries) == before:
                return False
            self._save()
            return True

    def clear(self, only_simulated=False):
        with self._lock:
            backup = None
            if self.entries:
                os.makedirs(BACKUP_DIR, exist_ok=True)
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                backup = os.path.join(BACKUP_DIR, f"ranking_{stamp}.json")
                with open(backup, "w", encoding="utf-8") as f:
                    json.dump({"version": 1, "saved_at": now_iso(), "entries": self.entries},
                              f, ensure_ascii=False, indent=2)
            before = len(self.entries)
            if only_simulated:
                self.entries = [e for e in self.entries if e.get("source") != "simulado"]
            else:
                self.entries = []
            removed = before - len(self.entries)
            self._save()
            return removed, backup


# ---------------------------------------------------------------------------
# Gerenciador da porta Serial
# ---------------------------------------------------------------------------
class SerialManager:
    """Abre/fecha a porta sob demanda. Nunca segura a porta quando desconectado,
    para permitir gravar código no Arduino pela Arduino IDE."""

    def __init__(self, app):
        self.app = app
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._stop = threading.Event()
        self._reader = None
        self.ser = None
        self.port = None
        self.baud = DEFAULT_BAUD
        self.connected_since = None
        self.last_error = None

    @property
    def connected(self):
        with self._lock:
            return self.ser is not None

    def info(self):
        with self._lock:
            return {
                "available": HAS_SERIAL,
                "connected": self.ser is not None,
                "port": self.port,
                "baud": self.baud,
                "since": self.connected_since,
                "error": self.last_error,
            }

    @staticmethod
    def list_ports():
        if not HAS_SERIAL:
            return []
        ports = []
        for p in serial.tools.list_ports.comports():
            desc = f"{p.description or ''} {p.manufacturer or ''} {p.hwid or ''}".lower()
            likely = bool(re.search(r"ttyusb|ttyacm|usbmodem|usbserial", p.device.lower())) or any(
                k in desc for k in ("arduino", "ch340", "ch341", "ftdi", "cp210", "usb serial", "2341:", "1a86:"))
            ports.append({
                "device": p.device,
                "description": p.description or "",
                "hwid": p.hwid or "",
                "likely_arduino": likely,
            })
        ports.sort(key=lambda x: (not x["likely_arduino"], x["device"]))
        return ports

    def connect(self, port, baud=DEFAULT_BAUD):
        if not HAS_SERIAL:
            raise RuntimeError("pyserial não está instalado neste Python. Use o .venv do projeto.")
        port = (port or "").strip()
        if not port:
            raise ValueError("Informe a porta serial (ex.: /dev/ttyACM0 ou /dev/ttyUSB0).")
        self.disconnect(quiet=True)
        # serial_for_url aceita caminhos (/dev/ttyACM0) e URLs de teste (loop://, socket://host:porta)
        try:
            ser = serial.serial_for_url(port, do_not_open=True)
            ser.baudrate = int(baud)
            ser.timeout = 0.25
            ser.write_timeout = 1.0
            ser.open()
        except Exception as exc:
            msg = str(exc)
            if "Permission denied" in msg or "Errno 13" in msg:
                msg += "  → Adicione seu usuário ao grupo 'dialout' (sudo usermod -aG dialout $USER) e reinicie a sessão."
            elif "Device or resource busy" in msg or "Errno 16" in msg:
                msg += "  → A porta está em uso (Monitor Serial da Arduino IDE aberto?)."
            with self._lock:
                self.last_error = msg
            self.app.log("sys", f"Falha ao abrir {port}: {msg}", "error")
            self.app.publish_serial()
            raise RuntimeError(msg)
        with self._lock:
            self.ser = ser
            self.port = port
            self.baud = int(baud)
            self.connected_since = now_iso()
            self.last_error = None
            self._stop = threading.Event()  # um evento por conexão
            self._reader = threading.Thread(target=self._read_loop, args=(ser, self._stop),
                                            name="serial-reader", daemon=True)
            self._reader.start()
        self.app.log("sys", f"Porta {port} aberta a {baud} baud. (O Arduino Uno reinicia ao conectar, aguarde ~2 s.)", "ok")
        self.app.publish_serial()

    def disconnect(self, quiet=False, reason=None):
        with self._lock:
            ser = self.ser
            reader = self._reader
            self.ser = None
            self._reader = None
            self._stop.set()
            self.connected_since = None
        if ser is None:
            return False
        try:
            if hasattr(ser, "cancel_read"):
                ser.cancel_read()
        except Exception:
            pass
        try:
            ser.close()
        except Exception:
            pass
        if reader and reader is not threading.current_thread():
            reader.join(timeout=2.0)
        if not quiet:
            self.app.log("sys", reason or f"Porta {self.port} fechada. Liberada para a Arduino IDE.", "warn")
        self.app.publish_serial()
        return True

    def _handle_lost(self, ser, exc):
        with self._lock:
            if self.ser is not ser:
                return
            self.last_error = f"Conexão perdida: {exc}"
        self.disconnect(reason=f"Conexão com {self.port} perdida ({exc}). Cabo desconectado?")

    def _read_loop(self, ser, stop):
        buf = bytearray()
        while not stop.is_set():
            try:
                chunk = ser.read(ser.in_waiting or 1)
            except Exception as exc:  # cabo removido, porta fechada, etc.
                if not stop.is_set():
                    self._handle_lost(ser, exc)
                break
            if not chunk:
                continue
            buf.extend(chunk)
            while b"\n" in buf:
                raw, _, rest = bytes(buf).partition(b"\n")
                buf = bytearray(rest)
                text = raw.decode("utf-8", errors="replace").strip(" \r\t\x00")
                if text:
                    try:
                        self.app.handle_serial_line(text)
                    except Exception as exc:  # nunca derrubar a thread de leitura
                        self.app.log("sys", f"Erro ao processar linha: {exc}", "error")
            if len(buf) > 8192:  # lixo sem \n (baud errado?)
                buf.clear()
                self.app.log("sys", "Buffer serial descartado (verifique se o baud é 115200).", "warn")

    def write_line(self, line):
        with self._lock:
            ser = self.ser
        if ser is None:
            raise RuntimeError("Arduino desconectado. Conecte a porta serial primeiro.")
        data = (line.strip() + "\n").encode("ascii", errors="ignore")
        try:
            with self._write_lock:
                ser.write(data)
                ser.flush()
        except Exception as exc:
            self._handle_lost(ser, exc)
            raise RuntimeError(f"Falha ao enviar para o Arduino: {exc}")


# ---------------------------------------------------------------------------
# Lógica da aplicação
# ---------------------------------------------------------------------------
class App:
    def __init__(self, args):
        self.args = args
        self.max_score = int(args.max_score)
        self.result_hold = float(args.result_hold)
        self.bus = EventBus()
        self.ranking = RankingStore(RANKING_FILE)
        self.serial = SerialManager(self)
        self._lock = threading.RLock()
        self.logs = deque(maxlen=400)
        self.state = {"state": "IDLE", "message": DEFAULT_MESSAGES["IDLE"], "player": None,
                      "source": "init", "since": time.time()}
        self.pending_player = None   # {"display": "Matheus Ávila", "lcd": "Matheus Avila"}
        self.last_result = None
        self._idle_timer = None
        self.ignore_pir_until = 0.0
        self.shutting_down = threading.Event()

    # ----- utilidades ----------------------------------------------------
    def snapshot(self):
        with self._lock:
            return {
                "state": dict(self.state),
                "pending_player": self.pending_player,
                "last_result": self.last_result,
                "serial": self.serial.info(),
                "ranking": self.ranking.sorted(),
                "logs": list(self.logs)[-200:],
                "config": {"max_score": self.max_score, "lcd_name_max": LCD_NAME_MAX,
                           "default_baud": DEFAULT_BAUD, "result_hold": self.result_hold},
            }

    def log(self, direction, text, kind="info"):
        entry = {"t": clock(), "dir": direction, "text": text, "kind": kind}
        self.logs.append(entry)
        self.bus.publish("log", entry)

    def publish_serial(self):
        self.bus.publish("serial", self.serial.info())

    def publish_ranking(self):
        self.bus.publish("ranking", self.ranking.sorted())

    # ----- máquina de estados -------------------------------------------
    def set_state(self, state, message=None, player=None, source="arduino", countdown=None):
        with self._lock:
            self.state = {
                "state": state,
                "message": message or DEFAULT_MESSAGES.get(state, state),
                "player": player,
                "source": source,
                "countdown": countdown,
                "since": time.time(),
            }
            snap = dict(self.state)
            if self._idle_timer:
                self._idle_timer.cancel()
                self._idle_timer = None
            if state == "RESULT":
                # Mantém "Resultado Registrado!" no telão por alguns segundos
                self._idle_timer = threading.Timer(self.result_hold, self._auto_idle)
                self._idle_timer.daemon = True
                self._idle_timer.start()
            elif state == "PLAYER_DETECTED":
                # Nunca deixa travado em "Participante Detectado": volta ao repouso após 8s se não iniciar rodada
                self._idle_timer = threading.Timer(8.0, self._auto_idle_pir)
                self._idle_timer.daemon = True
                self._idle_timer.start()
        self.bus.publish("status", snap)

    def _auto_idle(self):
        with self._lock:
            if self.state.get("state") != "RESULT":
                return
            self.ignore_pir_until = max(self.ignore_pir_until, time.time() + 5.0)
        self.set_state("IDLE", DEFAULT_MESSAGES["IDLE"], None, "auto")

    def _auto_idle_pir(self):
        with self._lock:
            if self.state.get("state") != "PLAYER_DETECTED":
                return
            self.ignore_pir_until = max(self.ignore_pir_until, time.time() + 5.0)
        self.set_state("IDLE", DEFAULT_MESSAGES["IDLE"], None, "auto")

    def _resolve_display_name(self, lcd_player):
        """Recupera o nome com acentos digitado pelo operador a partir do nome curto do LCD."""
        pend = self.pending_player
        short = sanitize_lcd_name(lcd_player or "").lower()
        if pend:
            p_lcd = pend["lcd"].lower()
            if not short or short == p_lcd or p_lcd.startswith(short) or short.startswith(p_lcd):
                return pend["display"]
        return clean_display_name(lcd_player) or "Anônimo"

    # ----- entrada vinda do Arduino ---------------------------------------
    def handle_serial_line(self, text):
        if text.startswith("{"):
            try:
                obj = json.loads(text)
            except json.JSONDecodeError:
                self.log("rx", text, "bad_json")
                return
            if not isinstance(obj, dict):
                self.log("rx", text, "bad_json")
                return
            self.log("rx", text, "json")
            self.handle_event(obj, source="arduino")
        else:
            self.log("rx", text, "debug")

    def handle_event(self, obj, source="arduino", display_override=None):
        ev = str(obj.get("event", "")).lower()
        if ev == "status":
            st = str(obj.get("state", "")).upper() or "IDLE"
            msg = obj.get("message") or DEFAULT_MESSAGES.get(st, st)
            player = obj.get("player")
            countdown = obj.get("countdown")
            with self._lock:
                cur = self.state
                if st == "PLAYER_DETECTED":
                    if time.time() < self.ignore_pir_until:
                        return
                    if cur.get("state") in ("COUNTDOWN", "READY", "RESULT"):
                        return
                if st == "IDLE":
                    self.pending_player = None
                    # Se o Arduino voltar a IDLE muito antes do fim da animação (< 6s), segura até o timer:
                    if cur.get("state") == "RESULT" and time.time() - cur.get("since", 0) < 6.0:
                        return
                display = self._resolve_display_name(player) if (player or st in ("READY", "COUNTDOWN")) else None
            self.set_state(st, msg, display, source, countdown=countdown)
        elif ev == "result":
            self.register_result(obj, source, display_override)
        else:
            self.log("sys", f"Evento desconhecido ignorado: {obj}", "warn")

    def register_result(self, obj, source="arduino", display_override=None):
        with self._lock:
            display = clean_display_name(display_override) if display_override else \
                self._resolve_display_name(obj.get("player"))
            speed_ms = round(to_float(obj.get("speed_ms")), 2)
            speed_kmh = obj.get("speed_kmh")
            speed_kmh = round(to_float(speed_kmh), 1) if speed_kmh is not None else round(speed_ms * 3.6, 1)

            raw_in = int(to_float(obj.get("force_raw")))
            if source == "arduino" and not obj.get("board_discounted"):
                force_raw = max(0, raw_in - BOARD_WEIGHT_RAW)
            else:
                force_raw = max(0, raw_in)

            force_kgf = round(force_raw / CALIBRATION_RAW_PER_KGF, 2)
            score = calcular_score_por_forca(force_raw, self.max_score)
            record = {
                "player": display or "Anônimo",
                "player_lcd": str(obj.get("player") or ""),
                "score": score,
                "speed_ms": speed_ms,
                "speed_kmh": speed_kmh,
                "force_kgf": force_kgf,
                "force_raw": force_raw,
                "timestamp": now_iso(),
                "source": source,
            }
            prev_best_force = self.ranking.best_force_raw()
            had_entries = bool(self.ranking.entries)
            entry, rank, total = self.ranking.add(record)
            is_record = rank == 1 and (not had_entries or force_raw > prev_best_force)
            self.pending_player = None
            self.ignore_pir_until = time.time() + self.result_hold + 5.0
            self.last_result = {"entry": entry, "rank": rank, "total": total, "is_record": is_record}
            result_payload = dict(self.last_result)
        self.set_state("RESULT", DEFAULT_MESSAGES["RESULT"], entry["player"], source)
        self.bus.publish("result", result_payload)
        self.publish_ranking()
        flag = "  *** NOVO RECORDE! ***" if is_record else ""
        self.log(
            "sys",
            f"Resultado salvo: {entry['player']} = Força Bruta {force_raw} ({force_kgf} kgf) | {score} pts (#{rank} de {total}){flag}",
            "ok",
        )
        return result_payload

    # ----- comandos do operador -----------------------------------------
    def _ensure_serial(self):
        if self.serial.connected or not HAS_SERIAL:
            return self.serial.connected
        likely = [p["device"] for p in SerialManager.list_ports() if p["likely_arduino"]]
        port = self.serial.port if (self.serial.port in likely) else (likely[0] if likely else "")
        if port:
            try:
                self.serial.connect(port, self.serial.baud or DEFAULT_BAUD)
                return True
            except Exception:
                return False
        return False

    def send_line(self, line):
        self.serial.write_line(line)
        self.log("tx", line, "cmd")

    def cmd_start(self, name):
        display = clean_display_name(name)
        if not display:
            raise ValueError("Digite o nome do participante.")
        lcd = sanitize_lcd_name(display) or "Jogador"
        with self._lock:
            self.pending_player = {"display": display, "lcd": lcd}
            self.ignore_pir_until = 0.0
        if self._ensure_serial():
            self.send_line(f"START:{lcd}")
            return {"display": display, "lcd": lcd, "simulated": False}
        self.log("sys", f"Arduino desconectado — rodada de '{display}' liberada em MODO SIMULAÇÃO (com contagem 3s).", "warn")

        def _sim_countdown():
            for sec in (3, 2, 1):
                with self._lock:
                    if not self.pending_player or self.pending_player.get("display") != display:
                        return
                self.set_state("COUNTDOWN", f"Prepare-se: {sec}...", display, "simulado", countdown=sec)
                time.sleep(1.0)
            with self._lock:
                if not self.pending_player or self.pending_player.get("display") != display:
                    return
            self.set_state("READY", DEFAULT_MESSAGES["READY"], display, "simulado")

        threading.Thread(target=_sim_countdown, daemon=True).start()
        return {"display": display, "lcd": lcd, "simulated": True}

    def cmd_reset(self):
        sent = False
        with self._lock:
            self.pending_player = None
            self.ignore_pir_until = time.time() + 6.0
        if self._ensure_serial():
            try:
                self.send_line("RESET")
                sent = True
            except Exception:
                sent = False
        self.set_state("IDLE", DEFAULT_MESSAGES["IDLE"], None, "operador")
        return {"sent": sent}

    def cmd_tare(self):
        if not self._ensure_serial():
            raise RuntimeError("Arduino desconectado: não é possível zerar a tara do HX711.")
        self.send_line("TARE")
        return {"sent": True}

    def cmd_raw(self, line):
        line = re.sub(r"[\r\n]+", " ", str(line or "")).strip()
        if not line:
            raise ValueError("Linha vazia.")
        self.send_line(line)
        return {"sent": True}

    def simulate_pir(self):
        self.log("sim", '{"event":"status","state":"PLAYER_DETECTED"} (simulado)', "json")
        self.set_state("PLAYER_DETECTED", DEFAULT_MESSAGES["PLAYER_DETECTED"], None, "simulado")
        return {}

    def simulate_hit(self, player=None, level="aleatorio"):
        with self._lock:
            name = clean_display_name(player) or (self.pending_player or {}).get("display") \
                or (self.state.get("player") if self.state.get("state") == "READY" else None) or "Teste"
        level = (level or "aleatorio").lower()
        lvl = level if level in SIM_LEVELS or level == "recorde" else random.choice(list(SIM_LEVELS))
        speed_rng, raw_rng = SIM_LEVELS["forte" if lvl == "recorde" else lvl]
        speed = round(random.uniform(*speed_rng), 2)
        force_raw = int(random.uniform(*raw_rng))
        if lvl == "recorde":
            force_raw = max(force_raw, int(self.ranking.best_force_raw()) + random.randint(250, 900))
        kgf = round(force_raw / CALIBRATION_RAW_PER_KGF, 2)
        score = calcular_score_por_forca(force_raw, self.max_score)
        obj = {"event": "result", "player": sanitize_lcd_name(name) or "Teste", "speed_ms": speed,
               "speed_kmh": round(speed * 3.6, 1), "force_raw": force_raw, "force_kgf": kgf,
               "score": score, "board_discounted": True}
        self.log("sim", json.dumps(obj, ensure_ascii=False), "json")
        return self.register_result(obj, source="simulado", display_override=name)

    def shutdown(self):
        self.shutting_down.set()
        try:
            self.serial.disconnect(quiet=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
APP = None  # instância global de App (definida em main)

ROUTES_HTML = {
    "/": "index.html",
    "/telao": "index.html",
    "/operador": "operador.html",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "MedidorDeForca/1.0"
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):  # silencia o log padrão (muito verboso)
        if APP and APP.args.verbose:
            sys.stderr.write("[http] " + (fmt % args) + "\n")

    # ----- respostas -----
    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, status=HTTPStatus.OK):
        self._send(status, json.dumps(data, ensure_ascii=False))

    def _ok(self, **data):
        self._json({"ok": True, **data})

    def _err(self, message, status=HTTPStatus.BAD_REQUEST):
        self._json({"ok": False, "error": str(message)}, status)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(min(length, 1_000_000))
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def _static(self, rel):
        rel = rel.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            return self._send(HTTPStatus.NOT_FOUND, "404 - Não encontrado", "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self._send(HTTPStatus.OK, f.read(), ctype)

    # ----- SSE -----
    def _events(self):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = APP.bus.subscribe()
        try:
            self.wfile.write(b"retry: 2000\n\n")
            self._sse(json.dumps({"type": "snapshot", "data": APP.snapshot()}, ensure_ascii=False))
            while not APP.shutting_down.is_set():
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self._sse(msg)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            APP.bus.unsubscribe(q)

    def _sse(self, msg):
        self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
        self.wfile.flush()

    # ----- exportação -----
    def _export_csv(self):
        out = io.StringIO()
        w = csv.writer(out, delimiter=";")
        w.writerow(["Posição", "Nome", "Pontuação", "Velocidade (m/s)", "Velocidade (km/h)",
                    "Força (kgf)", "Força bruta (HX711)", "Data/Hora", "Origem"])

        def br(n, d):
            return f"{to_float(n):.{d}f}".replace(".", ",")

        for i, e in enumerate(APP.ranking.sorted(), 1):
            w.writerow([i, e.get("player", ""), e.get("score", 0), br(e.get("speed_ms"), 2),
                        br(e.get("speed_kmh"), 1), br(e.get("force_kgf"), 2), e.get("force_raw", 0),
                        str(e.get("timestamp", "")).replace("T", " "), e.get("source", "")])
        stamp = datetime.now().strftime("%Y%m%d_%H%M")
        self._send(HTTPStatus.OK, "\ufeff" + out.getvalue(), "text/csv; charset=utf-8",
                   {"Content-Disposition": f'attachment; filename="ranking_medidor_forca_{stamp}.csv"'})

    def _export_json(self):
        stamp = datetime.now().strftime("%Y%m%d_%H%M")
        data = {"exported_at": now_iso(), "entries": APP.ranking.sorted()}
        self._send(HTTPStatus.OK, json.dumps(data, ensure_ascii=False, indent=2), "application/json; charset=utf-8",
                   {"Content-Disposition": f'attachment; filename="ranking_medidor_forca_{stamp}.json"'})

    # ----- roteamento -----
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path in ROUTES_HTML:
                return self._static(ROUTES_HTML[path])
            if path == "/api/events":
                return self._events()
            if path == "/api/state":
                return self._ok(**APP.snapshot())
            if path == "/api/ranking":
                return self._ok(ranking=APP.ranking.sorted())
            if path == "/api/ports":
                return self._ok(ports=SerialManager.list_ports(), serial=APP.serial.info())
            if path == "/api/export.csv":
                return self._export_csv()
            if path == "/api/export.json":
                return self._export_json()
            return self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # pragma: no cover
            self._err(f"Erro interno: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        try:
            if path == "/api/serial/connect":
                APP.serial.connect(body.get("port"), int(body.get("baud") or DEFAULT_BAUD))
                return self._ok(serial=APP.serial.info())
            if path == "/api/serial/disconnect":
                APP.serial.disconnect()
                return self._ok(serial=APP.serial.info())
            if path == "/api/serial/send":
                return self._ok(**APP.cmd_raw(body.get("line")))
            if path == "/api/command":
                cmd = str(body.get("cmd", "")).upper()
                if cmd == "START":
                    return self._ok(**APP.cmd_start(body.get("player")))
                if cmd == "RESET":
                    return self._ok(**APP.cmd_reset())
                if cmd == "TARE":
                    return self._ok(**APP.cmd_tare())
                return self._err(f"Comando desconhecido: {cmd}")
            if path == "/api/simulate/pir":
                return self._ok(**APP.simulate_pir())
            if path == "/api/simulate/hit":
                return self._ok(**APP.simulate_hit(body.get("player"), body.get("level")))
            if path == "/api/ranking/delete":
                del_id = int(body.get("id"))
                if not APP.ranking.delete(del_id):
                    return self._err("Registro não encontrado.", HTTPStatus.NOT_FOUND)
                with APP._lock:
                    if APP.last_result and APP.last_result.get("entry", {}).get("id") == del_id:
                        APP.last_result = None
                APP.log("sys", f"Registro #{del_id} removido do ranking.", "warn")
                APP.publish_ranking()
                return self._ok()
            if path == "/api/ranking/clear":
                only_sim = bool(body.get("only_simulated"))
                removed, backup = APP.ranking.clear(only_simulated=only_sim)
                if only_sim:
                    APP.log("sys", f"{removed} resultado(s) simulado(s) removido(s).", "warn")
                else:
                    APP.log("sys", f"Ranking zerado ({removed} registros). Backup: {backup or '—'}", "warn")
                with APP._lock:
                    APP.last_result = None
                APP.publish_ranking()
                return self._ok(removed=removed, backup=backup)
            return self._err("Rota não encontrada.", HTTPStatus.NOT_FOUND)
        except (ValueError, RuntimeError, TypeError) as exc:
            return self._err(exc)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # pragma: no cover
            self._err(f"Erro interno: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    global APP
    ap = argparse.ArgumentParser(description="Medidor de Força — Ranking ao Vivo + Painel do Operador")
    ap.add_argument("--host", default="127.0.0.1", help="Endereço (use 0.0.0.0 para acesso pela rede)")
    ap.add_argument("--port", type=int, default=8000, help="Porta HTTP (padrão 8000)")
    ap.add_argument("--serial", default="", help="Porta serial para --auto-connect (ex.: /dev/ttyACM0)")
    ap.add_argument("--baud", type=int, default=DEFAULT_BAUD, help="Baud rate (padrão 115200)")
    ap.add_argument("--auto-connect", action="store_true", help="Conecta na porta serial ao iniciar")
    ap.add_argument("--max-score", type=int, default=1000, help="Pontuação máxima da escala do medidor")
    ap.add_argument("--result-hold", type=float, default=10.0,
                    help="Segundos exibindo 'Resultado Registrado!' antes de voltar ao repouso")
    ap.add_argument("--open", action="store_true", help="Abre o navegador automaticamente")
    ap.add_argument("--verbose", action="store_true", help="Mostra o log de requisições HTTP")
    args = ap.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    APP = App(args)
    if not HAS_SERIAL:
        print("[AVISO] pyserial não encontrado — rodando apenas em MODO SIMULAÇÃO.")

    if args.auto_connect and HAS_SERIAL:
        port = args.serial
        if not port:
            likely = [p for p in SerialManager.list_ports() if p["likely_arduino"]]
            port = likely[0]["device"] if likely else ""
        if port:
            try:
                APP.serial.connect(port, args.baud)
            except Exception as exc:
                print(f"[AVISO] Não foi possível conectar em {port}: {exc}")
        else:
            print("[AVISO] Nenhum Arduino encontrado para --auto-connect.")

    httpd = Server((args.host, args.port), Handler)

    def _term(*_):
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGTERM, _term)
    except (ValueError, AttributeError):
        pass

    shown = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
    print("=" * 62)
    print("  MEDIDOR DE FORÇA — Ranking ao Vivo")
    print(f"  Telão (ranking):     http://{shown}:{args.port}/")
    print(f"  Painel do Operador:  http://{shown}:{args.port}/operador")
    print(f"  Ranking salvo em:    {RANKING_FILE}")
    print("  Ctrl+C para encerrar (a porta serial é liberada).")
    print("=" * 62)
    if args.open:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://{shown}:{args.port}/operador")).start()

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nEncerrando...")
    finally:
        APP.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()
