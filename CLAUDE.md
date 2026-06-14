# Instructions for Claude Code

This repo (`aice-avm`) lets you **send AIPL actors over HTTP and run them on a
host VM** — no recompile. It is self-contained OCaml (`unix` + `threads` only)
and ships a Windows one-shot launcher plus prebuilt binaries via GitHub
Releases.

## To start it on Windows (the only step the user needs)

After cloning, run **one** of these from the repo root:

```powershell
.\start.bat
```
or
```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

`start.ps1` will, in order:
1. Build with `dune` **if** OCaml/dune is installed; otherwise **download** the
   prebuilt `server.exe` / `send.exe` from the latest GitHub release into `bin\`
   (no toolchain required).
2. Launch the **receiver** (`server.exe <port>`) in a new console window.
3. **Send** `samples\PingPong.abcl` to it.

The receiver window then prints the actors running, e.g.:
```
[vm] a1: 15
[vm] a2: 15
...
[vm] a2: 1
```

### Options
- Different demo: `powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Sample samples\Rotate4Lines.abcl`
- Different port: `... -Port 9000`
- Send more actors by hand: `bin\send.exe 127.0.0.1:8080 samples\Rotate4Lines.abcl`
  (or `_build\default\send.exe ...` if you built from source)

## Manual build (optional, needs OCaml + dune)
```
dune build
dune exec ./server.exe -- 8080          # terminal 1
dune exec ./send.exe -- 127.0.0.1:8080 samples/PingPong.abcl   # terminal 2
```

## Talking to a real Xinu Pi
Same wire protocol — just point the sender at the Pi:
```
bin\send.exe 192.168.3.50:8080 samples\PingPong.abcl
```

See `README.md` for the full design and `docs/AVM_FORMAT.md` for the bytecode.
