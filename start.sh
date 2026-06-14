#!/usr/bin/env bash
# start.sh — one-shot launcher for aice-avm on WSL / Linux / macOS.
#
#   * If OCaml/dune is installed, it builds from source.
#   * Otherwise it downloads the prebuilt Linux binaries from the latest
#     GitHub release (no toolchain needed) — ideal for WSL Ubuntu.
#   * Then it starts the receiver and sends a sample actor to it.
#
# Usage (from the repo root):
#   ./start.sh                                   # PingPong on port 8080
#   ./start.sh 8080 samples/Rotate4Lines.abcl    # custom port + sample
set -euo pipefail

PORT="${1:-8080}"
SAMPLE="${2:-samples/PingPong.abcl}"
REPO="yaskodama/aice-avm"

cd "$(dirname "$0")"

if command -v dune >/dev/null 2>&1; then
  echo "[start] dune found — building from source..."
  dune build
  SERVER="$PWD/_build/default/server.exe"
  SEND="$PWD/_build/default/send.exe"
else
  echo "[start] dune not found — downloading prebuilt Linux binaries from the latest release..."
  mkdir -p bin
  SERVER="$PWD/bin/server"
  SEND="$PWD/bin/send"
  if [ ! -x "$SERVER" ] || [ ! -x "$SEND" ]; then
    base="https://github.com/$REPO/releases/latest/download"
    dl() { if command -v curl >/dev/null 2>&1; then curl -fL "$1" -o "$2"; else wget -O "$2" "$1"; fi; }
    dl "$base/server-linux-x86_64" "$SERVER"
    dl "$base/send-linux-x86_64"   "$SEND"
    chmod +x "$SERVER" "$SEND"
  fi
fi

echo "[start] launching receiver on port $PORT ..."
"$SERVER" "$PORT" &
SRV_PID=$!
trap 'kill "$SRV_PID" 2>/dev/null || true' EXIT
sleep 2

echo "[start] sending $SAMPLE ..."
"$SEND" "127.0.0.1:$PORT" "$SAMPLE"

echo ""
echo "[start] receiver PID $SRV_PID running — watch the [vm] lines above."
echo "[start] send more with:  $SEND 127.0.0.1:$PORT samples/Rotate4Lines.abcl"
read -r -p "[start] press Enter to stop the receiver " _ || true
