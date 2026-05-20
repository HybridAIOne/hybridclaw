#!/usr/bin/env bash
set -euo pipefail
umask 077

MODEL_DIR="${DISTIL_PII_HOME:-$HOME/.hybridclaw/distil-pii}"
PID_FILE="$MODEL_DIR/server.pid"

is_positive_pid() {
    [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_llama_server_pid() {
    ps -p "$1" -o comm= 2>/dev/null | grep -q "llama-server"
}

if [ ! -f "$PID_FILE" ]; then
    echo "No server PID file found. Server is not running."
    exit 0
fi

PID=$(cat "$PID_FILE")

if ! is_positive_pid "$PID"; then
    echo "ERROR: Invalid PID in $PID_FILE. Keeping pidfile for inspection." >&2
    exit 1
fi

if kill -0 "$PID" 2>/dev/null && ! is_llama_server_pid "$PID"; then
    echo "ERROR: PID $PID is not a llama-server process. Keeping pidfile for inspection." >&2
    exit 1
fi

if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$PID_FILE"
    echo "llama-server (PID $PID) stopped."
else
    rm -f "$PID_FILE"
    echo "Server process (PID $PID) was not running. Cleaned up PID file."
fi
