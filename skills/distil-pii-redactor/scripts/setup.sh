#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="${DISTIL_PII_HOME:-$HOME/.hybridclaw/distil-pii}"
MODEL_PATH="${DISTIL_PII_MODEL_PATH:-$MODEL_DIR/Distil-PII-Llama-3.2-1B-Instruct.gguf}"
MODEL_URL="${DISTIL_PII_MODEL_URL:-https://huggingface.co/distil-labs/Distil-PII-Llama-3.2-1B-Instruct-gguf/resolve/main/model.gguf}"
PID_FILE="$MODEL_DIR/server.pid"
LOG_FILE="$MODEL_DIR/server.log"
HOST="${DISTIL_PII_HOST:-127.0.0.1}"
PORT="${DISTIL_PII_PORT:-8712}"

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
    curl -L --progress-bar -o "$MODEL_PATH" "$MODEL_URL"
    echo "Model downloaded to $MODEL_PATH"
else
    echo "Model already present at $MODEL_PATH"
fi

# 3. Check if server is already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "llama-server already running (PID $OLD_PID)"
        exit 0
    else
        rm -f "$PID_FILE"
    fi
fi

# 4. Start llama-server in background
echo "Starting llama-server on $HOST:$PORT..."
llama-server -m "$MODEL_PATH" --host "$HOST" --port "$PORT" --ctx-size 2048 >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

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
