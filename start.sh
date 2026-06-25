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

# --- Self-update: check GitHub for a newer version before launching --------
# Disable with AICE_NO_UPDATE=1. Non-destructive: a git checkout only
# fast-forwards (never merges/rebases over local work); offline = skip.
if [ "${AICE_NO_UPDATE:-0}" != "1" ] && [ "${AICE_REEXEC:-0}" != "1" ]; then
  if [ -d .git ] && command -v git >/dev/null 2>&1; then
    echo "[start] checking GitHub for updates..."
    before="$(git rev-parse HEAD 2>/dev/null || echo none)"
    if git pull --ff-only 2>/dev/null; then
      after="$(git rev-parse HEAD 2>/dev/null || echo none)"
      if [ "$before" != "$after" ]; then
        echo "[start] updated $before -> $after — relaunching with the new version."
        AICE_REEXEC=1 exec "$0" "$@"
      fi
      echo "[start] already up to date."
    else
      echo "[start] (skip) cannot fast-forward (local changes or offline) — using the current version."
    fi
  fi
fi

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
  mkdir -p bin
  SERVER="$PWD/bin/server"
  SEND="$PWD/bin/send"
  dl() { if command -v curl >/dev/null 2>&1; then curl -fL "$1" -o "$2"; else wget -O "$2" "$1"; fi; }
  # Find the latest release tag (no jq needed) and re-download if it changed.
  latest="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
            | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[ ]*:[ ]*"([^"]+)".*/\1/')"
  have="$(cat bin/.release 2>/dev/null || echo none)"
  if [ ! -x "$SERVER" ] || [ ! -x "$SEND" ] || { [ -n "$latest" ] && [ "$latest" != "$have" ]; }; then
    echo "[start] downloading prebuilt binaries ($SRV_ASSET, release ${latest:-latest}) from GitHub..."
    base="https://github.com/$REPO/releases/latest/download"
    dl "$base/$SRV_ASSET" "$SERVER"
    dl "$base/$SND_ASSET" "$SEND"
    chmod +x "$SERVER" "$SEND"
    [ -n "$latest" ] && echo "$latest" > bin/.release
  else
    echo "[start] prebuilt binaries already up to date (release $have)."
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
