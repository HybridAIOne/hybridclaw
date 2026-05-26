#!/usr/bin/env bash
set -euo pipefail
umask 077

MODEL_DIR="${DISTIL_PII_HOME:-$HOME/.hybridclaw/distil-pii}"
MODEL_PATH="${DISTIL_PII_MODEL_PATH:-$MODEL_DIR/Distil-PII-Llama-3.2-1B-Instruct.gguf}"
MODEL_URL="${DISTIL_PII_MODEL_URL:-https://huggingface.co/distil-labs/Distil-PII-Llama-3.2-1B-Instruct-gguf/resolve/main/model.gguf}"
PID_FILE="$MODEL_DIR/server.pid"
LOG_FILE="$MODEL_DIR/server.log"
HOST="${DISTIL_PII_HOST:-127.0.0.1}"
PORT="${DISTIL_PII_PORT:-8712}"

is_positive_pid() {
    [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_llama_server_pid() {
    ps -p "$1" -o comm= 2>/dev/null | grep -q "llama-server"
}

remove_stale_pidfile() {
    echo "Removing stale pidfile at $PID_FILE."
    rm -f "$PID_FILE"
}

# 1. Check for llama-server
if ! command -v llama-server &>/dev/null; then
    echo "ERROR: llama-server not found on PATH."
    echo ""
    echo "Install llama.cpp:"
    echo "  HybridClaw: hybridclaw skill install distil-pii-redactor llama-server"
    echo "  macOS:  brew install llama.cpp"
    echo "  Linux:  build from source - https://github.com/ggerganov/llama.cpp#build"
    exit 1
fi

# 2. Download model if not present
mkdir -p "$MODEL_DIR"
chmod 700 "$MODEL_DIR"
if [ ! -f "$MODEL_PATH" ]; then
    echo "Downloading Distil-PII 1B GGUF model (~5 GB)..."
    TMP_MODEL="$(mktemp "$MODEL_DIR/model.XXXXXX")"
    trap 'rm -f "$TMP_MODEL"' EXIT INT TERM
    curl --fail --location --retry 3 --retry-delay 2 --progress-bar -o "$TMP_MODEL" "$MODEL_URL"
    mv "$TMP_MODEL" "$MODEL_PATH"
    chmod 600 "$MODEL_PATH"
    trap - EXIT INT TERM
    echo "Model downloaded to $MODEL_PATH"
else
    echo "Model already present at $MODEL_PATH"
fi

# 3. Check if server is already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ! is_positive_pid "$OLD_PID"; then
        remove_stale_pidfile
    elif kill -0 "$OLD_PID" 2>/dev/null && is_llama_server_pid "$OLD_PID"; then
        echo "llama-server already running (PID $OLD_PID)"
        exit 0
    else
        remove_stale_pidfile
    fi
fi

# 4. Start llama-server in background
echo "Starting llama-server on $HOST:$PORT..."
llama-server -m "$MODEL_PATH" --host "$HOST" --port "$PORT" --ctx-size 2048 >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
chmod 600 "$PID_FILE" "$LOG_FILE"

# 5. Wait for server to be healthy
echo "Waiting for server to be ready..."
for i in $(seq 1 30); do
    if curl -s "http://$HOST:$PORT/health" | grep -q "ok"; then
        echo "Server is ready (PID $SERVER_PID, $HOST:$PORT)"
        exit 0
    fi
    sleep 1
done

echo "ERROR: Server failed to start within 30 seconds."
echo "Check $LOG_FILE or try running llama-server manually."
kill "$SERVER_PID" 2>/dev/null || true
rm -f "$PID_FILE"
exit 1
