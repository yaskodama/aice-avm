# aice-avm — send AIPL actors over the network and run them, on a host VM

`aice-avm` is the **host / Windows counterpart** of the dynamic-actor mechanism
originally built for the Xinu kernel on a Raspberry Pi: you write an actor in
**AIPL** (`.abcl`), compile it to a tiny **`.avm`** bytecode module, ship it to a
running receiver over plain HTTP, and the receiver **spawns and runs it live —
without any recompile**. The very same `.avm` protocol runs on the Xinu kernel
VM and on this OCaml host VM, so you can target either.

It is written in **OCaml** and depends only on the standard library
(`unix` + `threads`) — **no SDL, no X11, no C bindings** — so it builds and runs
natively on **Windows**, macOS and Linux.

```
   PingPong.abcl ──compile──▶ PingPong.avm ──POST /actor/loadvm──▶  receiver
   (AIPL source)   (send.exe)   (bytecode)        (HTTP)           (server.exe)
                                                                    │
                                                       spawns Main, kicks tick(),
                                                       runs the actors on threads
```

## What's in here

| file | role |
|------|------|
| `avm.ml`      | the **host VM**: loads a `.avm` module, runs its actors on threads + mailboxes (a port of the Xinu kernel's `abcl_vm_dispatch`) |
| `compile.ml`  | a self-contained **AIPL `.abcl` → `.avm` compiler** (own lexer/parser/codegen) |
| `server.ml`   | the **receiver**: serves the Xinu desktop UI from `www/`, accepts `POST /actor/loadvm` (raw `.avm`) and `/actor/loadsrc` (`.abcl` source → compile → run), exposes `GET /api/actors` / `/api/console` / `/api/lines` |
| `send.ml`     | the **sender**: compiles an `.abcl` (or reads a `.avm`) and POSTs it to a receiver |
| `www/`        | the **Xinu desktop UI** (HTML/CSS/JS) the receiver serves at `/` — Console, Processes, VM Graphics, Actor Loader |
| `samples/`    | `PingPong.abcl`, `Rotate4Lines.abcl`, `Rotate4LinesLoop.abcl`, `DiningPhilosophers.abcl` |
| `docs/AVM_FORMAT.md` | the `.avm` bytecode format + opcode table |

## The Xinu desktop UI (opens automatically)

Starting the receiver now opens a **Xinu / AIPL desktop** in your browser at
`http://localhost:<port>/` — the same UI shipped on the Raspberry-Pi Xinu kernel,
running here against the **real OCaml host VM**:

* **Console** — live actor output (`/api/console`), the `[vm]` lines in your terminal.
* **Processes** — the actors currently alive on the VM (`/api/actors`), each tagged ● ACTOR.
* **VM Graphics** — a window that draws the actors' `line`/`cls` segments (`/api/lines`),
  reproducing the on-device "actor-to-actor Blender display".
* **Actor Loader** — paste/edit an actor and **send its `.abcl` source** (the server
  compiles it with `Compile.compile_source` and runs it), or drop a raw `.avm`.

So you can `git clone → ./start.sh` (or `start.bat`) and get a self-contained,
download-and-run desktop app — no airilab.app, no cloud. Pass `--no-open` to the
receiver to suppress the browser launch.

> **AIPL VM subset.** The host VM runs the same integer-only actor subset as the
> Xinu kernel: integers only (`print(n)` takes an int; expressions are fine), no
> top-level statements (the VM auto-starts class 0 `Main.tick()`), and class
> fields only (no method-local `var`). The Loader samples follow these rules.

## Windows: clone & run (no toolchain needed)

The fastest path — works even without OCaml installed, because a one-shot
launcher downloads the prebuilt binaries from the latest release:

```powershell
git clone https://github.com/yaskodama/aice-avm.git
cd aice-avm
.\start.bat
```

`start.bat` builds from source if `dune` is present, otherwise grabs the
prebuilt `server.exe` / `send.exe` from the [latest release](https://github.com/yaskodama/aice-avm/releases/latest),
launches the receiver, and sends `samples\PingPong.abcl` to it. The receiver
window prints the actors bouncing a counter (`a1: 15 … a2: 1`).

### Graphics window (rotating segments)

When an actor draws (`line`/`cls`), the receiver **dynamically opens a graphics
window** — your browser at `http://localhost:<port>/`, an HTML canvas that
animates the live segments. Try the four-rotating-segments demo:

```powershell
.\start.bat -Sample samples\Rotate4Lines.abcl
```
Four coloured line segments rotate about the four corners of a square, one
segment **per actor**, exactly like the Xinu "VM graphics" window. (The browser
auto-opens; pass `--no-open` to the receiver to disable that, then open the URL
yourself.) For a demo that rotates **endlessly**, send
`samples/Rotate4LinesLoop.abcl` instead.

> **Opening the window across a network or from WSL.** The receiver listens
> dual-stack, so `http://localhost:<port>/` works for a *local* (native) run.
> But when the receiver runs **inside WSL** reached via a Windows `netsh
> portproxy`, the port-forward only forwards the machine's **LAN address** — so
> open the browser at **`http://<LAN-IP>:<port>/`** (e.g. `http://192.168.3.32:8080/`),
> not `localhost`. Find the LAN IP with `ipconfig` (the adapter whose gateway is
> your router). Sending an actor to a remote receiver works the same way:
> `send <LAN-IP>:<port> samples/Rotate4Lines.abcl`.

> Using **Claude Code** on Windows? Just tell it to *clone
> `https://github.com/yaskodama/aice-avm` and start it* — it follows
> `CLAUDE.md` and runs `start.bat` for you. Try
> `.\start.bat -Sample samples\Rotate4Lines.abcl` for the rotating demo.

## WSL (Windows Subsystem for Linux) / Linux / macOS: clone & run

WSL is Linux, so it uses the Linux launcher (`start.sh`), which builds with
`dune` if present or else downloads the prebuilt **Linux** binaries from the
latest release — no toolchain required:

```bash
git clone https://github.com/yaskodama/aice-avm.git
cd aice-avm
./start.sh                              # PingPong on port 8080
./start.sh 8080 samples/Rotate4Lines.abcl   # rotating-segments demo
```

Both the receiver and sender run inside WSL (`127.0.0.1`), so no cross-network
setup is needed — the `[vm]` output appears right in your terminal.

> Only `curl` (or `wget`) is needed for the no-toolchain path; WSL Ubuntu has
> `curl` by default. To build from source instead:
> `sudo apt install -y opam && opam init -y && opam install -y dune && dune build`.

---

## Quick start on Windows (build from source)

### 1. Install OCaml + dune (once)

**Option A — native Windows (opam 2.2+):**
1. Install opam for Windows: <https://opam.ocaml.org/doc/Install.html#Windows>
   (or `winget install OCaml.opam`).
2. Open a terminal and run:
   ```
   opam init -y
   opam install -y dune
   ```

**Option B — WSL2 (Ubuntu), the easiest:**
```
wsl --install            # in an elevated PowerShell, then reboot
# inside Ubuntu:
sudo apt update && sudo apt install -y opam
opam init -y && eval $(opam env)
opam install -y dune
```

### 2. Build
```
git clone https://github.com/yaskodama/aice-avm.git
cd aice-avm
dune build
```

### 3. Run the receiver (terminal 1)
```
dune exec ./server.exe -- 8080
```
You should see:
```
[aice-avm] receiver listening on 0.0.0.0:8080  (accept-prompt: off)
```

### 4. Send an actor and run it (terminal 2)
```
dune exec ./send.exe -- 127.0.0.1:8080 samples/PingPong.abcl
```
Terminal 1 prints the actors bouncing a counter:
```
[vm] a1: 15
[vm] a2: 15
[vm] a1: 14
...
[vm] a2: 1
```
Try the four-rotating-segments demo too:
```
dune exec ./send.exe -- 127.0.0.1:8080 samples/Rotate4Lines.abcl
```
which streams `cls` + four `line` draws per frame (one line per `Line` actor,
pivoting about the four corners of a square).

> On Windows you can also run the produced native binaries directly:
> `_build/default/server.exe 8080` and
> `_build/default/send.exe 127.0.0.1:8080 samples/PingPong.abcl`.

## Talking to a real Xinu Pi instead of the host VM

The wire protocol is identical, so point `send` at the Pi's webactor:
```
dune exec ./send.exe -- 192.168.3.50:8080 samples/PingPong.abcl
```
There the actor runs on the **Xinu kernel** and opens on-screen *VM print* /
*VM graphics* windows.

## The accept prompt (optional)

Start the receiver with `--ask` to be prompted `y/N` on the console before each
incoming actor runs (the host equivalent of the Pi's on-screen "accept actor?"
dialog):
```
dune exec ./server.exe -- 8080 --ask
```
Senders can skip it (for benchmarks/scripts) with `--noask`, which appends
`?ask=0` to the request:
```
dune exec ./send.exe -- 127.0.0.1:8080 samples/PingPong.abcl --noask
```


> **Each send replaces the previous scene** — the receiver stops the old
> actors automatically when a new `.avm` arrives, so you never need to restart
> it between demos.

## Samples

| file | what it does |
|------|--------------|
| `samples/PingPong.abcl`         | two actors bounce a counter (text output) |
| `samples/Rotate4Lines.abcl`     | four segments, one per actor, rotate about a square's corners (5 turns) |
| `samples/Rotate4LinesLoop.abcl` | same, but rotates endlessly |
| `samples/DiningPhilosophers.abcl` | the dining-philosophers problem — 5 Philosopher + 5 Fork actors, deadlock-free (ordered pickup), visualised: philosophers as plus-signs (blue=think, yellow=hungry, green=eat), forks as segments (grey=free, red=held) |

Run one with, e.g. `./start.sh 8080 samples/DiningPhilosophers.abcl` (WSL/Linux)
or `.\start.bat -Sample samples\DiningPhilosophers.abcl` (Windows), then watch
the graphics window.

## Writing your own actor

See `samples/`. The supported AIPL subset (integer-only, matching the kernel VM):
classes with integer/actor-id fields and methods; `+ - * / %`,
`< <= > >= == !=`; `if/else`; `while (cond) do { ... }`; `send t.m(args)`
(`t` = `self` | `sender` | a field/param holding an actor id); `new C(args)`;
`print(...)`; `wait(ms)`; `line(x1,y1,x2,y2,col)`; `cls()`. Field initialisers
are **not** run (fields spawn as 0) — initialise inside a method (e.g. `tick`).
The module's **first class** is spawned on load and kicked with `tick()`.

## License

MIT — see `LICENSE`.
