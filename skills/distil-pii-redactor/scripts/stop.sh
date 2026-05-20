#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="${DISTIL_PII_HOME:-$HOME/.hybridclaw/distil-pii}"
PID_FILE="$MODEL_DIR/server.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "No server PID file found. Server is not running."
    exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$PID_FILE"
    echo "llama-server (PID $PID) stopped."
else
    rm -f "$PID_FILE"
    echo "Server process (PID $PID) was not running. Cleaned up PID file."
fi
