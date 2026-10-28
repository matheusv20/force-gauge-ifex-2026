#!/usr/bin/env bash
# Inicia o site do Medidor de Força usando o .venv do projeto (com pyserial).
# Uso:  ./run.sh                 -> http://127.0.0.1:8000  (telão)  e  /operador
#       ./run.sh --auto-connect  -> já conecta no Arduino ao iniciar
#       ./run.sh --host 0.0.0.0  -> permite abrir o telão em outro PC da rede
cd "$(dirname "$0")" || exit 1

VENV_PY="../.venv/bin/python"
if [ -x "$VENV_PY" ]; then
  PY="$VENV_PY"
else
  echo "[aviso] ../.venv não encontrado, usando python3 do sistema"
  PY="python3"
fi

exec "$PY" server.py "$@"
