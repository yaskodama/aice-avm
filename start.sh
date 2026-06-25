#!/usr/bin/env bash
# start.sh — one-shot launcher for aice-avm on WSL / Linux / macOS.
#
#   * If OCaml/dune is installed, it builds from source.
#   * Otherwise it downloads the prebuilt binaries for this OS from the latest
#     GitHub release (no toolchain needed).
#   * Then it starts the receiver, which opens the Xinu desktop UI in your
#     browser at http://localhost:PORT/ — load and run actors from there.
#
# Usage (from the repo root):
#   ./start.sh                                   # desktop UI on port 8080
#   ./start.sh 8080                              # custom port
#   ./start.sh 8080 samples/Rotate4Lines.abcl    # also auto-send a sample
set -euo pipefail

PORT="${1:-8080}"
SAMPLE="${2:-}"
REPO="yaskodama/aice-avm"

cd "$(dirname "$0")"

if command -v dune >/dev/null 2>&1; then
  echo "[start] dune found — building from source..."
  dune build
  SERVER="$PWD/_build/default/server.exe"
  SEND="$PWD/_build/default/send.exe"
else
  # Pick the prebuilt asset names for this OS.
  case "$(uname -s)" in
    Darwin) SRV_ASSET="server-macos-arm64"; SND_ASSET="send-macos-arm64" ;;
    *)      SRV_ASSET="server-linux-x86_64"; SND_ASSET="send-linux-x86_64" ;;
  esac
  echo "[start] dune not found — downloading prebuilt binaries ($SRV_ASSET) from the latest release..."
  mkdir -p bin
  SERVER="$PWD/bin/server"
  SEND="$PWD/bin/send"
  if [ ! -x "$SERVER" ] || [ ! -x "$SEND" ]; then
    base="https://github.com/$REPO/releases/latest/download"
    dl() { if command -v curl >/dev/null 2>&1; then curl -fL "$1" -o "$2"; else wget -O "$2" "$1"; fi; }
    dl "$base/$SRV_ASSET" "$SERVER"
    dl "$base/$SND_ASSET" "$SEND"
    chmod +x "$SERVER" "$SEND"
  fi
fi

echo "[start] launching receiver on port $PORT (the desktop UI opens in your browser)..."
"$SERVER" "$PORT" &
SRV_PID=$!
trap 'kill "$SRV_PID" 2>/dev/null || true' EXIT
sleep 2

if [ -n "$SAMPLE" ]; then
  echo "[start] sending $SAMPLE ..."
  "$SEND" "127.0.0.1:$PORT" "$SAMPLE"
fi

echo ""
echo "[start] receiver PID $SRV_PID running — desktop UI at http://localhost:$PORT/"
echo "[start] load actors from the UI, or:  $SEND 127.0.0.1:$PORT samples/Rotate4Lines.abcl"
read -r -p "[start] press Enter to stop the receiver " _ || true
