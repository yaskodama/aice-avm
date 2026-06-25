'use strict';

// Browser "Xinu desktop" simulator. Gated: only boots when the logged-in
// account is authorized (server enforces via /api/xinu/boot → 403 otherwise).
// Provides a small window manager + a Xinu-style console/shell, a process
// table, and a BASIC window with a graphics-capable Tiny BASIC interpreter.

(function () {
  // ---- boot (aice-avm host VM mode) ------------------------------------
  async function boot() {
    const who = document.getElementById('who');
    if (who) who.textContent = 'host VM';
    startClock();
    startDesktop({
      build: 'aice-avm',
      bootLog: [
        'Xinu/AIPL host VM (aice-avm) — OCaml, threads + mailboxes',
        'avm: bytecode loader ready (POST /actor/loadsrc, /actor/loadvm)',
        'wm: window manager started',
        'basic: BASIC interpreter loaded',
        'display: software 3D (Blender) ready',
        'shell: xsh ready',
      ],
    });
  }

  function startClock() {
    const el = document.getElementById('clock');
    function tick() {
      const d = new Date();
      el.textContent = d.toLocaleTimeString();
    }
    tick();
    setInterval(tick, 1000);
  }

  // ---- window manager --------------------------------------------------
  let zTop = 10;
  const windows = [];

  function makeWindow(opts) {
    const desktop = document.getElementById('desktop');
    const taskbar = document.getElementById('taskbar');

    const win = document.createElement('div');
    win.className = 'xwin';
    win.style.left = (opts.x || 40) + 'px';
    win.style.top = (opts.y || 30) + 'px';
    win.style.width = (opts.w || 360) + 'px';
    win.style.height = (opts.h || 240) + 'px';
    win.innerHTML =
      '<div class="xwin-title">' +
      '<button class="xwin-btn close" title="close"></button>' +
      '<button class="xwin-btn min" title="minimize"></button>' +
      '<span class="t"></span></div>' +
      '<div class="xwin-body"></div>' +
      '<div class="xwin-resize"></div>';
    win.querySelector('.t').textContent = opts.title;
    const body = win.querySelector('.xwin-body');
    if (opts.node) body.appendChild(opts.node);
    desktop.appendChild(win);

    const task = document.createElement('button');
    task.className = 'task-btn';
    task.textContent = opts.title;
    taskbar.appendChild(task);

    const rec = { win, task, minimized: false };
    windows.push(rec);

    function focus() {
      win.style.zIndex = ++zTop;
      windows.forEach((w) => { w.win.classList.remove('active'); w.task.classList.remove('active'); });
      win.classList.add('active');
      task.classList.add('active');
    }
    win.addEventListener('mousedown', focus);
    task.addEventListener('click', () => {
      if (rec.minimized || win.style.display === 'none') { win.style.display = ''; rec.minimized = false; }
      focus();
    });
    focus();

    // close / minimize
    win.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation(); win.remove(); task.remove();
      if (opts.onClose) opts.onClose();
    });
    win.querySelector('.min').addEventListener('click', (e) => {
      e.stopPropagation(); win.style.display = 'none'; rec.minimized = true;
    });

    // drag
    const title = win.querySelector('.xwin-title');
    title.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('xwin-btn')) return;
      const sx = e.clientX, sy = e.clientY;
      const ox = win.offsetLeft, oy = win.offsetTop;
      function mv(ev) { win.style.left = (ox + ev.clientX - sx) + 'px'; win.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });

    // resize
    const grip = win.querySelector('.xwin-resize');
    grip.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = win.offsetWidth, oh = win.offsetHeight;
      function mv(ev) {
        win.style.width = Math.max(240, ow + ev.clientX - sx) + 'px';
        win.style.height = Math.max(140, oh + ev.clientY - sy) + 'px';
        if (opts.onResize) opts.onResize();
      }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });

    return { win, body, focus };
  }

  // ---- desktop boot ----------------------------------------------------
  function startDesktop(info) {
    openConsole(info);
    openProcesses();
    openVmGraphics();
    openDisplay();
    openBasic();
    openLoader();
  }

  // Live actor drawing from the host VM: polls /api/lines and renders the
  // line set the running actors emit (cls/line opcodes) inside a Xinu window.
  function openVmGraphics() {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<canvas class="vmg-canvas" width="300" height="234" style="background:#000;border:1px solid #2b3650;border-radius:8px;flex:1;width:100%"></canvas>' +
      '<div style="color:#8b949e;font-size:11px">live actor drawing · polls /api/lines (host VM)</div>';
    let alive = true;
    makeWindow({ title: 'VM Graphics', x: 30, y: 300, w: 340, h: 300, node, onClose: () => { alive = false; } });
    const canvas = node.querySelector('.vmg-canvas');
    const ctx = canvas.getContext('2d');
    const PAL = ['#7dcfff', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#7aa2f7', '#ffffff'];
    (function frame() {
      if (!alive) return;
      fetch('/api/lines').then((r) => r.json()).then((d) => {
        const W = canvas.width, H = canvas.height;
        const sx = W / (d.w || 820), sy = H / (d.h || 640);
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.lineWidth = 1.5;
        (d.lines || []).forEach((ln) => {
          ctx.strokeStyle = PAL[(((ln[4] || 1) - 1) % PAL.length + PAL.length) % PAL.length];
          ctx.beginPath(); ctx.moveTo(ln[0] * sx, ln[1] * sy); ctx.lineTo(ln[2] * sx, ln[3] * sy); ctx.stroke();
        });
      }).catch(() => {}).finally(() => { if (alive) setTimeout(frame, 100); });
    })();
    xlog('[3d] VM Graphics window opened (polling /api/lines)', 'boot-info');
  }

  // Console + tiny shell
  function openConsole(info) {
    const node = document.createElement('div');
    node.innerHTML = '<div class="con-out"></div>';
    const out = node.querySelector('.con-out');
    const { body } = makeWindow({ title: 'Xinu Console', x: 30, y: 24, w: 440, h: 260, node });

    const bootLines = (info.bootLog || [
      'Xinu booting on arm-rpi3 (BCM2837, cortex-a53)...',
      'memory: heap 0x00400000 - 0x3F000000',
      'sysinit: 50 processes, 100 semaphores',
      'clkinit: timer @ 1000 Hz',
      'usbinit: keyboard, mouse attached',
      'wm: window manager started',
      'shell: ready',
    ]);
    let i = 0;
    (function stream() {
      if (i < bootLines.length) {
        const div = document.createElement('div');
        div.className = 'con-line ' + (i === bootLines.length - 1 ? 'boot-ok' : 'boot-info');
        div.textContent = (i === bootLines.length - 1 ? '[OK] ' : '') + bootLines[i];
        out.appendChild(div);
        body.scrollTop = body.scrollHeight;
        i++;
        setTimeout(stream, 180);
      } else {
        addPrompt();
      }
    })();

    function println(text, cls) {
      const div = document.createElement('div');
      div.className = 'con-line' + (cls ? ' ' + cls : '');
      div.textContent = text;
      out.appendChild(div);
      body.scrollTop = body.scrollHeight;
    }
    // Let other windows (Actor Loader) echo activity into the console.
    window.__xinuLog = (t, cls) => println(t, cls);

    // aice-avm: stream the host VM's actor print output into the console.
    if (window.__XINU_AVM) {
      let cursor = 0;
      setInterval(async () => {
        try {
          const d = await (await fetch('/api/console?since=' + cursor)).json();
          if (d && Array.isArray(d.lines)) {
            d.lines.forEach((ln) => println('[vm] ' + ln, 'boot-ok'));
            cursor = d.total;
          }
        } catch (_e) { /* server gone */ }
      }, 700);
    }

    function addPrompt() {
      const line = document.createElement('div');
      line.className = 'con-input';
      line.innerHTML = '<span class="ps1">xsh$</span><input type="text" autocomplete="off" spellcheck="false">';
      out.appendChild(line);
      const input = line.querySelector('input');
      input.focus();
      body.scrollTop = body.scrollHeight;
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const cmd = input.value.trim();
        input.parentElement.innerHTML = '<span class="ps1">xsh$</span> ' + escapeHtml(cmd);
        runCmd(cmd);
        addPrompt();
      });
    }

    function runCmd(cmd) {
      const a = cmd.split(/\s+/);
      const c = (a[0] || '').toLowerCase();
      if (!c) return;
      switch (c) {
        case 'help': println('commands: help ver ps clear date echo basic loadvm blender about'); break;
        case 'ver': println('Xinu (browser sim) — AIPL/AICE edition, build ' + (info.build || 'web')); break;
        case 'about': println('Embedded Xinu desktop simulator. Multi-window WM + BASIC.'); break;
        case 'ps':
          PROCS.concat(actorProcs).forEach((p) =>
            println('  ' + pad(p.pid, 4) + pad(p.name, 14) + pad(p.actor ? '[actor]' : 'sys', 9) + p.state,
              p.actor ? 'boot-ok' : ''));
          break;
        case 'date': println(new Date().toString()); break;
        case 'echo': println(cmd.slice(5)); break;
        case 'clear': out.querySelectorAll('.con-line').forEach((n) => n.remove()); break;
        case 'basic': openBasic(); println('[wm] focused BASIC window'); break;
        case 'loadvm': openLoader(); println('[wm] opened Actor Loader'); break;
        case 'blender': case 'display': openDisplay(); println('[wm] opened 3D Display'); break;
        case 'graphics': case 'lines': openVmGraphics(); println('[wm] opened VM Graphics'); break;
        default: println('xsh: unknown command: ' + c + '  (try: help)');
      }
    }
  }

  // System processes (not user actors) + dynamically-spawned actor processes.
  const PROCS = [
    { pid: 0, name: 'null', state: 'ready', actor: false },
    { pid: 1, name: 'main', state: 'current', actor: false },
    { pid: 2, name: 'rdsproc', state: 'wait', actor: false },
    { pid: 3, name: 'wm', state: 'ready', actor: false },
    { pid: 4, name: 'shell', state: 'ready', actor: false },
    { pid: 5, name: 'basic', state: 'suspend', actor: false },
  ];
  let actorProcs = [];      // actors launched via the Actor Loader (marked)
  let nextActorPid = 20;
  let procRender = null;    // re-render hook owned by the Processes window

  function procStateClass(s) {
    if (s === 'current' || s === 'running') return 'curr';
    if (s === 'wait') return 'wait';
    if (s === 'suspend') return 'susp';
    if (s === 'error') return 'susp';
    return 'ready';
  }

  // Register/track a real actor process; `state` defaults to 'running'.
  function spawnActor(name, cls, state) {
    const p = { pid: nextActorPid++, name: name + (cls ? ':' + cls : ''), state: state || 'running', actor: true };
    actorProcs.push(p);
    if (actorProcs.length > 12) actorProcs.shift();
    if (procRender) procRender();
    return p;
  }
  function setActorState(p, state) { p.state = state; if (procRender) procRender(); }

  function openProcesses() {
    const node = document.createElement('div');
    node.innerHTML = '<table class="proc-table"><thead><tr><th>PID</th><th>NAME</th><th>KIND</th><th>STATE</th></tr></thead><tbody></tbody></table>';
    const tbody = node.querySelector('tbody');
    procRender = () => {
      tbody.innerHTML = PROCS.concat(actorProcs).map((p) => {
        const kind = p.actor
          ? '<span class="actor-mark">● ACTOR</span>'
          : '<span class="sys-mark">sys</span>';
        return '<tr><td>' + p.pid + '</td><td>' + p.name + '</td><td>' + kind +
          '</td><td class="state-' + procStateClass(p.state) + '">' + p.state + '</td></tr>';
      }).join('');
    };
    procRender();
    makeWindow({ title: 'Processes', x: 470, y: 24, w: 300, h: 220, node, onClose: () => { procRender = null; } });

    // aice-avm: poll the host VM for the real live actor table (marked ● ACTOR).
    if (window.__XINU_AVM) {
      setInterval(async () => {
        try {
          const txt = await (await fetch('/api/actors')).text();
          const rows = txt.trim().split('\n').slice(1); // drop "id class enq deq" header
          actorProcs = rows.filter(Boolean).map((r) => {
            const f = r.trim().split(/\s+/);
            const id = f[0], cls = f[1], enq = f[2], deq = f[3];
            return { pid: Number(id), name: 'actor' + id + ' (c' + cls + ')',
              state: enq === deq ? 'ready' : 'running', actor: true };
          });
          if (procRender) procRender();
        } catch (_e) { /* server gone */ }
      }, 1000);
    }
  }

  // ---- BASIC window ----------------------------------------------------
  const SAMPLES = {
    Hello: '10 REM Hello / counter\n20 PRINT "HELLO FROM XINU BASIC"\n30 FOR I=1 TO 5\n40 PRINT "COUNT ="; I\n50 NEXT I\n60 PRINT "DONE"',
    Spiral: '10 REM spiral graphics\n20 CLS\n30 FOR T=0 TO 300 STEP 4\n40 LET R=T/4\n50 LET X=120+R*COS(T/12)\n60 LET Y=90+R*SIN(T/12)\n70 PLOT X,Y\n80 NEXT T\n90 CIRCLE 120,90,70',
    Fib: '10 REM fibonacci\n20 LET A=0\n30 LET B=1\n40 FOR I=1 TO 12\n50 PRINT A;\n60 PRINT " ";\n70 LET C=A+B\n80 LET A=B\n90 LET B=C\n100 NEXT I\n110 PRINT ""',
    Lines: '10 CLS\n20 FOR I=0 TO 240 STEP 20\n30 LINE 0,I,I,180\n40 NEXT I\n50 COLOR 1\n60 CIRCLE 120,90,40',
    'Rotate (回転)': '10 REM rotating line segment / 線分の回転\n20 LET A=0\n30 CLS\n40 COLOR 5\n50 CIRCLE 120,90,72\n60 LET X=120+70*COS(A)\n70 LET Y=90+70*SIN(A)\n80 COLOR 2\n90 LINE 120,90,X,Y\n100 PLOT X,Y\n110 PAUSE 30\n120 LET A=A+0.18\n130 GOTO 30',
  };

  function openBasic() {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<div class="basic-toolbar">' +
      '<button data-act="run">▶ RUN</button>' +
      '<button data-act="stop">■ STOP</button>' +
      '<button data-act="list">LIST</button>' +
      '<button data-act="cls">CLS</button>' +
      '<button data-act="clr">NEW</button>' +
      '<select class="samp"></select>' +
      '</div>' +
      '<div class="basic-split">' +
      '<textarea class="basic-code" spellcheck="false"></textarea>' +
      '<div class="basic-right">' +
      '<canvas id="basic-canvas" width="240" height="180"></canvas>' +
      '<div class="basic-output"></div>' +
      '</div></div>';

    const { body } = makeWindow({ title: 'BASIC', x: 120, y: 150, w: 560, h: 330, node, onClose: () => { try { basic.stop(); } catch (_e) {} } });
    const code = node.querySelector('.basic-code');
    const outEl = node.querySelector('.basic-output');
    const canvas = node.querySelector('#basic-canvas');
    const samp = node.querySelector('.samp');

    Object.keys(SAMPLES).forEach((k) => {
      const o = document.createElement('option'); o.value = k; o.textContent = k; samp.appendChild(o);
    });
    code.value = SAMPLES.Hello;
    samp.addEventListener('change', () => { code.value = SAMPLES[samp.value]; });

    const basic = makeBasic(
      (s) => { outEl.textContent += s; outEl.scrollTop = outEl.scrollHeight; },
      canvas
    );

    node.querySelector('.basic-toolbar').addEventListener('click', (e) => {
      const act = e.target.getAttribute('data-act');
      if (!act) return;
      if (act === 'run') { outEl.textContent = ''; basic.run(code.value); }
      else if (act === 'stop') { basic.stop(); outEl.textContent += '[stopped]\n'; }
      else if (act === 'list') { outEl.textContent = basic.list(code.value) + '\n'; }
      else if (act === 'cls') { basic.clearScreen(); }
      else if (act === 'clr') { code.value = ''; outEl.textContent = ''; basic.clearScreen(); }
    });
  }

  // ---- Actor Loader: binarize an AIPL actor to ".avm" and send to server
  // aice-avm VM subset: integer-only, no strings, no top-level statements
  // (the VM auto-runs class 0 `Main.tick()`), no method-local `var`.
  const DEFAULT_ACTOR =
    'class Main {\n' +
    '  var c = 0;\n' +
    '  method tick() { c = new Counter(); send c.run(5); }\n' +
    '}\n' +
    'class Counter {\n' +
    '  var n = 0;\n' +
    '  method run(max) {\n' +
    '    print(n);\n' +
    '    n = n + 1;\n' +
    '    if (n < max) { send self.run(max); }\n' +
    '  }\n' +
    '}';

  const MAKINA_ACTOR =
    'class Main {\n' +
    '  var m = 0;\n' +
    '  method tick() { m = new Makina(); send m.walk(6); }\n' +
    '}\n' +
    'class Makina {\n' +
    '  var step = 0;\n' +
    '  method walk(n) {\n' +
    '    print(step * 30);\n' +   // hip angle (deg), integer FK gait
    '    step = step + 1;\n' +
    '    if (step < n) { send self.walk(n); }\n' +
    '  }\n' +
    '}';

  const PINGPONG_ACTOR =
    'class Main {\n' +
    '  var p = 0;\n' +
    '  var q = 0;\n' +
    '  method tick() {\n' +
    '    q = new Ponger(); p = new Pinger();\n' +
    '    send p.setq(q); send q.setp(p); send p.serve(15);\n' +
    '  }\n' +
    '}\n' +
    'class Pinger {\n' +
    '  var peer = 0; var left = 0;\n' +
    '  method setq(x) { peer = x; }\n' +
    '  method serve(n) { left = n; send peer.ping(left); }\n' +
    '  method pong(n) { print(n); left = left - 1; if (left > 0) { send peer.ping(left); } }\n' +
    '}\n' +
    'class Ponger {\n' +
    '  var peer = 0;\n' +
    '  method setp(x) { peer = x; }\n' +
    '  method ping(n) { print(n); send peer.pong(n); }\n' +
    '}';

  const LOADER_SAMPLES = { Counter: DEFAULT_ACTOR, MAKINA: MAKINA_ACTOR, PingPong: PINGPONG_ACTOR };

  // AVM1 container: "AVM1" | ver | flags | nameLen | name | srcLen(u32 LE) | source
  function binarize(name, source) {
    const enc = new TextEncoder();
    const nameB = enc.encode(name).subarray(0, 255);
    const srcB = enc.encode(source);
    const buf = new Uint8Array(7 + nameB.length + 4 + srcB.length);
    const dv = new DataView(buf.buffer);
    let o = 0;
    buf[o++] = 0x41; buf[o++] = 0x56; buf[o++] = 0x4D; buf[o++] = 0x31; // "AVM1"
    buf[o++] = 1; buf[o++] = 0; buf[o++] = nameB.length;
    buf.set(nameB, o); o += nameB.length;
    dv.setUint32(o, srcB.length, true); o += 4;
    buf.set(srcB, o);
    return buf;
  }

  function hexdump(bytes, max) {
    const n = Math.min(bytes.length, max || 48);
    let s = '';
    for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0') + (i % 16 === 15 ? '\n' : ' ');
    if (bytes.length > n) s += '…';
    return s;
  }

  // Best-effort decode of our AVM1-source container (null if not our format).
  function decodeAvmClient(bytes) {
    try {
      if (bytes.length < 11) return null;
      if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'AVM1') return null;
      const nameLen = bytes[6];
      let o = 7;
      const dec = new TextDecoder();
      const name = dec.decode(bytes.subarray(o, o + nameLen)); o += nameLen;
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      const srcLen = dv.getUint32(o, true); o += 4;
      if (bytes.length < o + srcLen || srcLen > 200000) return null;
      const source = dec.decode(bytes.subarray(o, o + srcLen));
      return { name, source };
    } catch (_e) { return null; }
  }

  function xlog(msg, cls) { if (window.__xinuLog) window.__xinuLog(msg, cls); }

  function openLoader() {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<div class="basic-toolbar">' +
      '<select class="vm-samp"></select>' +
      '<span style="color:#8b949e">name:</span>' +
      '<input class="vm-name" value="Counter" style="width:84px;background:#182236;color:#d8dee9;border:1px solid #2b3650;border-radius:6px;padding:3px 6px;font-family:inherit;font-size:11.5px">' +
      '<button data-act="bin">⚙ Binarize</button>' +
      '<button data-act="open">📂 Open .avm</button>' +
      '<button data-act="send" disabled>📤 Send</button>' +
      '<button data-act="save" disabled>💾 Save</button>' +
      '<input type="file" class="vm-file" accept=".avm,application/octet-stream" style="display:none">' +
      '</div>' +
      '<textarea class="basic-code vm-src" spellcheck="false"></textarea>' +
      '<div class="vm-info" style="color:#8b949e;font-size:11px;white-space:pre-wrap;font-family:inherit"></div>' +
      '<div class="basic-output vm-out" style="max-height:110px;color:#7dcfff"></div>';

    makeWindow({ title: 'Actor Loader (.avm)', x: 470, y: 250, w: 480, h: 370, node });
    const samp = node.querySelector('.vm-samp');
    const nameI = node.querySelector('.vm-name');
    const srcT = node.querySelector('.vm-src');
    const info = node.querySelector('.vm-info');
    const out = node.querySelector('.vm-out');
    const fileI = node.querySelector('.vm-file');
    const sendBtn = node.querySelector('[data-act=send]');
    const saveBtn = node.querySelector('[data-act=save]');
    let avm = null;

    Object.keys(LOADER_SAMPLES).forEach((k) => {
      const o = document.createElement('option'); o.value = k; o.textContent = k; samp.appendChild(o);
    });
    srcT.value = LOADER_SAMPLES.Counter;
    // aice-avm host VM compiles source on the server, so Send works directly.
    const avmMode = !!window.__XINU_AVM;
    if (avmMode) sendBtn.disabled = false;
    samp.addEventListener('change', () => {
      srcT.value = LOADER_SAMPLES[samp.value]; nameI.value = samp.value;
      avm = null; sendBtn.disabled = !avmMode; saveBtn.disabled = true; info.textContent = '';
    });
    srcT.addEventListener('input', () => { avm = null; sendBtn.disabled = !avmMode; saveBtn.disabled = true; });

    function setBinary(bytes, label) {
      avm = bytes;
      info.textContent = label + '\n' + hexdump(bytes, 48);
      sendBtn.disabled = false; saveBtn.disabled = false;
    }

    function loadFile(file) {
      const fr = new FileReader();
      fr.onload = () => {
        const bytes = new Uint8Array(fr.result);
        const dec = decodeAvmClient(bytes);
        if (dec) {
          nameI.value = dec.name; srcT.value = dec.source;
          setBinary(bytes, 'loaded ' + file.name + ': ' + bytes.length + ' B (AVM1, decoded "' + dec.name + '")');
          xlog('[avm] opened ' + file.name + ' (' + bytes.length + ' B) → "' + dec.name + '"', 'boot-info');
        } else {
          setBinary(bytes, 'loaded ' + file.name + ': ' + bytes.length + ' B (raw — not AVM1-source; will send as-is)');
          xlog('[avm] opened ' + file.name + ' (' + bytes.length + ' B, foreign format)', 'boot-info');
        }
      };
      fr.readAsArrayBuffer(file);
    }

    fileI.addEventListener('change', () => { if (fileI.files[0]) loadFile(fileI.files[0]); });

    // drag & drop onto the window
    node.addEventListener('dragover', (e) => { e.preventDefault(); node.style.outline = '2px dashed #5eb1ff'; });
    node.addEventListener('dragleave', () => { node.style.outline = ''; });
    node.addEventListener('drop', (e) => {
      e.preventDefault(); node.style.outline = '';
      if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });

    node.querySelector('.basic-toolbar').addEventListener('click', async (e) => {
      const act = e.target.getAttribute('data-act');
      if (act === 'bin') {
        avm = binarize(nameI.value || 'actor', srcT.value);
        info.textContent = 'binary: ' + avm.length + ' bytes (AVM1)\n' + hexdump(avm, 48);
        sendBtn.disabled = false; saveBtn.disabled = false;
        xlog('[avm] binarized ' + (nameI.value || 'actor') + ' → ' + avm.length + ' bytes', 'boot-info');
      } else if (act === 'open') {
        fileI.click();
      } else if (act === 'save') {
        if (!avm) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([avm], { type: 'application/octet-stream' }));
        a.download = (nameI.value || 'actor') + '.avm';
        a.click(); URL.revokeObjectURL(a.href);
      } else if (act === 'send') {
        // aice-avm host VM: send .abcl source to be compiled+run; raw .avm bytes go to loadvm.
        if (window.__XINU_AVM) {
          out.textContent = '';
          const dec = avm ? decodeAvmClient(avm) : null;
          try {
            let txt;
            if (avm && !dec) {
              // foreign/real .avm bytecode → load straight into the VM
              xlog('[net] POST /actor/loadvm (' + avm.length + ' B real .avm)…', 'boot-info');
              txt = await (await fetch('/actor/loadvm?noask=1', {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: avm,
              })).text();
            } else {
              const source = dec ? dec.source : srcT.value;
              xlog('[net] POST /actor/loadsrc (' + (nameI.value || 'actor') + ', compile+run)…', 'boot-info');
              txt = await (await fetch('/actor/loadsrc', {
                method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: source,
              })).text();
            }
            out.textContent = txt.trim();
            xlog('[vm] ' + txt.trim(), /spawned actor id=/.test(txt) ? 'boot-ok' : '');
          } catch (_e) { out.textContent = '⚠ network error (is the receiver running?)'; }
          return;
        }
        if (!avm) return;
        out.textContent = '';
        const liveProc = spawnActor(nameI.value || 'actor', null, 'running'); // marked in Processes
        xlog('[net] uploading ' + (nameI.value || 'actor') + '.avm (' + avm.length + ' bytes)…', 'boot-info');
        try {
          const r = await fetch('/api/xinu/loadvm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: avm,
          });
          const d = await r.json().catch(() => ({}));
          if (d.ok) {
            xlog('[loadvm] received ' + d.name + ' (' + d.bytes + ' B) → executing on runtime', 'boot-ok');
            out.textContent = (d.stdout || '').replace(/\n$/, '') || '(no output)';
            if (d.errors && d.errors.length) out.textContent += '\n⚠ ' + d.errors.join('\n⚠ ');
            setActorState(liveProc, 'ended');
            // Mark each actor instance the runtime actually created as an actor process.
            (d.stdout || '').split('\n').forEach((line) => {
              const m = line.match(/\[actor created\]\s+(\S+)\s*:\s*(\S+)/);
              if (m) spawnActor(m[1], m[2], 'ran');
            });
          } else {
            out.textContent = '⚠ ' + ((d.errors || ['error']).join('; '));
            xlog('[loadvm] rejected: ' + ((d.errors || []).join('; ')), '');
            setActorState(liveProc, 'error');
          }
        } catch (_e) { out.textContent = '⚠ network error'; setActorState(liveProc, 'error'); }
      }
    });
  }

  // ---- "Blender display system": software 3D mesh viewer ---------------
  // Mirrors the on-device Xinu native 3D renderer / MakinaDisplayActor:
  // an integer-ish software renderer drawing a turntable mesh (wire/solid).
  function meshBuilder() {
    const m = { name: '', verts: [], faces: [], edges: [] };
    m.addBox = (cx, cy, cz, w, h, d, color) => {
      const b = m.verts.length, hw = w / 2, hh = h / 2, hd = d / 2;
      [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, hh, -hd], [-hw, hh, -hd],
       [-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]]
        .forEach((p) => m.verts.push({ x: cx + p[0], y: cy + p[1], z: cz + p[2] }));
      [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]]
        .forEach((q) => m.faces.push({ idx: q.map((i) => b + i), color }));
      [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
        .forEach((e) => m.edges.push([b + e[0], b + e[1]]));
    };
    return m;
  }

  const MESHES = {
    MAKINA() {
      const m = meshBuilder(); m.name = 'MAKINA-7';
      m.addBox(0, 0.1, 0, 1.0, 1.4, 0.6, '#5eb1ff');        // torso
      m.addBox(0, 1.15, 0, 0.7, 0.7, 0.7, '#b78cff');       // head
      m.addBox(-0.85, 0.15, 0, 0.32, 1.1, 0.32, '#7dcfff'); // left arm
      m.addBox(0.85, 0.15, 0, 0.32, 1.1, 0.32, '#7dcfff');  // right arm
      m.addBox(-0.3, -1.25, 0, 0.42, 1.2, 0.42, '#9ece6a'); // left leg
      m.addBox(0.3, -1.25, 0, 0.42, 1.2, 0.42, '#9ece6a');  // right leg
      return m;
    },
    Cube() { const m = meshBuilder(); m.name = 'Cube'; m.addBox(0, 0, 0, 1.4, 1.4, 1.4, '#5eb1ff'); return m; },
    Pyramid() {
      const m = meshBuilder(); m.name = 'Pyramid'; const b = m.verts.length;
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, 1.3, 0]].forEach((p) => m.verts.push({ x: p[0], y: p[1], z: p[2] }));
      m.faces.push(
        { idx: [b + 0, b + 1, b + 2], color: '#e0af68' }, { idx: [b + 0, b + 2, b + 3], color: '#e0af68' },
        { idx: [b + 0, b + 1, b + 4], color: '#f7768e' }, { idx: [b + 1, b + 2, b + 4], color: '#f7768e' },
        { idx: [b + 2, b + 3, b + 4], color: '#f7768e' }, { idx: [b + 3, b + 0, b + 4], color: '#f7768e' });
      [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]].forEach((e) => m.edges.push([b + e[0], b + e[1]]));
      return m;
    },
  };

  function v3sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function v3cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
  function v3norm(v) { const L = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / L, y: v.y / L, z: v.z / L }; }
  function shadeHex(hex, k) { const n = parseInt(hex.slice(1), 16); return 'rgb(' + ((((n >> 16) & 255) * k) | 0) + ',' + ((((n >> 8) & 255) * k) | 0) + ',' + (((n & 255) * k) | 0) + ')'; }

  function rotPoint(p, ay, ax) {
    const cy = Math.cos(ay), sy = Math.sin(ay);
    const x1 = p.x * cy + p.z * sy, z1 = -p.x * sy + p.z * cy;
    const cx = Math.cos(ax), sx = Math.sin(ax);
    return { x: x1, y: p.y * cx - z1 * sx, z: p.y * sx + z1 * cx };
  }

  function render3d(ctx, canvas, mesh, ay, ax, solid) {
    const W = canvas.width, H = canvas.height, cam = 6, f = 300, S = 0.9;
    ctx.fillStyle = '#05080e'; ctx.fillRect(0, 0, W, H);
    const rv = mesh.verts.map((p) => rotPoint({ x: p.x * S, y: p.y * S, z: p.z * S }, ay, ax));
    const proj = rv.map((p) => { const zz = p.z + cam; return { x: W / 2 + f * p.x / zz, y: H / 2 - f * p.y / zz, z: zz }; });
    if (solid) {
      const light = v3norm({ x: -0.4, y: 0.7, z: -0.7 });
      mesh.faces.map((fc) => ({ fc, zs: fc.idx.reduce((s, i) => s + proj[i].z, 0) / fc.idx.length }))
        .sort((a, b) => b.zs - a.zs)
        .forEach(({ fc }) => {
          const n = v3norm(v3cross(v3sub(rv[fc.idx[1]], rv[fc.idx[0]]), v3sub(rv[fc.idx[2]], rv[fc.idx[0]])));
          const sh = Math.max(0.2, Math.min(1, Math.abs(n.x * light.x + n.y * light.y + n.z * light.z) * 0.85 + 0.25));
          ctx.fillStyle = shadeHex(fc.color, sh);
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath();
          fc.idx.forEach((i, k) => { const p = proj[i]; if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
          ctx.closePath(); ctx.fill(); ctx.stroke();
        });
    } else {
      ctx.strokeStyle = '#7dcfff'; ctx.lineWidth = 1;
      mesh.edges.forEach((e) => { const a = proj[e[0]], b = proj[e[1]]; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); });
    }
  }

  function openDisplay() {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<div class="basic-toolbar">' +
      '<select class="d-mesh"><option>MAKINA</option><option>Cube</option><option>Pyramid</option></select>' +
      '<button data-act="mode">Solid</button>' +
      '<button data-act="spin">⏸ Spin</button>' +
      '</div>' +
      '<canvas class="d-canvas" width="300" height="240" style="background:#05080e;border:1px solid #2b3650;border-radius:8px;flex:1;width:100%;cursor:grab"></canvas>' +
      '<div style="color:#8b949e;font-size:11px">drag to rotate · software 3D (actor-to-actor Blender display)</div>';

    let alive = true;
    makeWindow({ title: '3D Display (Blender)', x: 700, y: 30, w: 330, h: 330, node, onClose: () => { alive = false; } });
    const canvas = node.querySelector('.d-canvas');
    const ctx = canvas.getContext('2d');
    let solid = true, spin = true, ay = 0.6, ax = -0.35;
    let mesh = MESHES.MAKINA();

    node.querySelector('.d-mesh').addEventListener('change', (e) => { mesh = MESHES[e.target.value](); xlog('[3d] loaded mesh ' + mesh.name, 'boot-info'); });
    const modeBtn = node.querySelector('[data-act=mode]');
    const spinBtn = node.querySelector('[data-act=spin]');
    modeBtn.addEventListener('click', () => { solid = !solid; modeBtn.textContent = solid ? 'Solid' : 'Wire'; });
    spinBtn.addEventListener('click', () => { spin = !spin; spinBtn.textContent = (spin ? '⏸' : '▶') + ' Spin'; });

    let dragging = false, lx = 0, ly = 0;
    canvas.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; spin = false; spinBtn.textContent = '▶ Spin'; });
    window.addEventListener('mousemove', (e) => { if (!dragging) return; ay += (e.clientX - lx) * 0.01; ax += (e.clientY - ly) * 0.01; lx = e.clientX; ly = e.clientY; });
    window.addEventListener('mouseup', () => { dragging = false; });

    (function frame() {
      if (!alive) return;
      if (spin) ay += 0.02;
      render3d(ctx, canvas, mesh, ay, ax, solid);
      requestAnimationFrame(frame);
    })();
    xlog('[3d] Blender display started (' + mesh.name + ')', 'boot-ok');
  }

  // ---- Tiny BASIC interpreter (graphics-capable) -----------------------
  function makeBasic(print, canvas) {
    const ctx = canvas.getContext('2d');
    const COLORS = ['#9ece6a', '#f7768e', '#7aa2f7', '#e0af68', '#bb9af7', '#7dcfff', '#ffffff'];

    let gen = 0; // generation token: bumping it stops any in-flight run()
    function stop() { gen++; }
    function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, Math.min(2000, ms)))); }

    // BASIC built-in functions (declared once, in makeBasic scope to avoid TDZ).
    const FUNCS = {
      INT: Math.floor, ABS: Math.abs, SQR: Math.sqrt, SIN: Math.sin, COS: Math.cos,
      TAN: Math.tan, ATN: Math.atan, SGN: Math.sign, RND: (n) => Math.floor(Math.random() * (n || 1)),
    };
    const FUNCS0 = { RND: () => Math.random(), PI: () => Math.PI };

    function clearScreen() { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    clearScreen();

    function list(src) {
      return parseProgram(src).map((l) => l.ln + ' ' + l.src).join('\n');
    }

    function parseProgram(src) {
      const lines = [];
      src.split('\n').forEach((raw) => {
        const t = raw.trim();
        if (!t) return;
        const m = t.match(/^(\d+)\s*(.*)$/);
        if (m) lines.push({ ln: parseInt(m[1], 10), src: m[2] });
        else lines.push({ ln: -1, src: t }); // immediate / unnumbered
      });
      lines.sort((a, b) => a.ln - b.ln);
      return lines;
    }

    async function run(src) {
      const myGen = ++gen; // supersedes any previous run (e.g. a running animation)
      const prog = parseProgram(src);
      const idxOf = {};
      prog.forEach((l, i) => { idxOf[l.ln] = i; });
      const vars = {};
      let color = COLORS[0];
      const forStack = [];
      const subStack = [];
      let pc = 0;
      let steps = 0;

      function err(msg) { print('?' + msg + '\n'); throw { halt: true }; }

      try {
        while (pc < prog.length) {
          if (myGen !== gen) return; // stopped or superseded by a newer run
          if (++steps > 300000) err('TOO MANY STEPS (use PAUSE in animation loops)');
          const line = prog[pc];
          const jumped = await execLine(line.src, line.ln);
          if (!jumped) pc++;
        }
      } catch (e) { if (!e || !e.halt) print('?ERROR ' + (e && e.message ? e.message : e) + '\n'); }

      // returns true if a jump changed pc
      async function execLine(text, ln) {
        const stmts = splitTop(text, ':');
        for (let s = 0; s < stmts.length; s++) {
          const j = await execStmt(stmts[s].trim(), ln);
          if (j) return true;
        }
        return false;
      }

      async function execStmt(st, ln) {
        if (!st) return false;
        const up = st.toUpperCase();
        let kw = (up.match(/^[A-Z]+/) || [''])[0];

        if (kw === 'REM') return false;
        if (kw === 'END' || kw === 'STOP') { pc = prog.length; return true; }
        if (kw === 'PRINT' || st[0] === '?') { doPrint(st.replace(/^\s*(PRINT|\?)/i, '')); return false; }
        if (kw === 'CLS') { clearScreen(); return false; }
        if (kw === 'COLOR') { color = COLORS[(evalExpr(st.slice(5)) | 0) % COLORS.length] || COLORS[0]; return false; }
        if (kw === 'PLOT') { const a = args(st.slice(4)); ctx.fillStyle = color; ctx.fillRect(a[0] | 0, a[1] | 0, 2, 2); return false; }
        if (kw === 'LINE') { const a = args(st.slice(4)); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[2], a[3]); ctx.stroke(); return false; }
        if (kw === 'CIRCLE') { const a = args(st.slice(6)); ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(a[0], a[1], a[2], 0, 7); ctx.stroke(); return false; }
        if (kw === 'PAUSE' || kw === 'WAIT') { await sleep(evalExpr(st.slice(kw.length)) || 0); steps = 0; return false; }
        if (kw === 'INPUT') { doInput(st.slice(5)); return false; }
        if (kw === 'GOTO') { const t = evalExpr(st.slice(4)) | 0; if (!(t in idxOf)) err('UNDEF LINE ' + t); pc = idxOf[t]; return true; }
        if (kw === 'GOSUB') { const t = evalExpr(st.slice(5)) | 0; if (!(t in idxOf)) err('UNDEF LINE ' + t); subStack.push(pc + 1); pc = idxOf[t]; return true; }
        if (kw === 'RETURN') { if (!subStack.length) err('RETURN WITHOUT GOSUB'); pc = subStack.pop(); return true; }
        if (kw === 'FOR') return doFor(st.slice(3));
        if (kw === 'NEXT') return doNext(st.slice(4));
        if (kw === 'IF') return await doIf(st.slice(2), ln);
        if (kw === 'LET') { doAssign(st.slice(3)); return false; }
        if (/^[A-Za-z][A-Za-z0-9]*\$?\s*=/.test(st)) { doAssign(st); return false; }
        err('SYNTAX: ' + st);
      }

      function doPrint(rest) {
        rest = rest.trim();
        if (rest === '') { print('\n'); return; }
        const parts = splitTop(rest, ';|,', true);
        let line = '';
        let trailing = false;
        for (let i = 0; i < parts.length; i++) {
          const seg = parts[i];
          if (seg.sep) { trailing = true; if (seg.token === ',') line += '\t'; continue; }
          // Skip synthetic empty text segments (e.g. after a trailing ';').
          if (seg.text.trim() === '') continue;
          trailing = false;
          line += toStr(evalExpr(seg.text));
        }
        print(line + (trailing ? '' : '\n'));
      }

      function doInput(rest) {
        rest = rest.trim();
        let prompt = '? ';
        const sm = rest.match(/^"([^"]*)"\s*[,;]?\s*(.*)$/);
        let target = rest;
        if (sm) { prompt = sm[1] + ' '; target = sm[2]; }
        const name = target.trim();
        const v = window.prompt(prompt);
        if (name.endsWith('$')) vars[name] = v == null ? '' : v;
        else vars[name] = parseFloat(v) || 0;
      }

      function doAssign(s) {
        const eq = s.indexOf('=');
        const name = s.slice(0, eq).trim();
        const val = evalExpr(s.slice(eq + 1));
        vars[name] = val;
      }

      function doFor(s) {
        const eq = s.indexOf('=');
        const name = s.slice(0, eq).trim();
        const rest = s.slice(eq + 1);
        const toM = rest.toUpperCase().indexOf(' TO ');
        const stepM = rest.toUpperCase().indexOf(' STEP ');
        const start = evalExpr(rest.slice(0, toM));
        const limit = evalExpr(rest.slice(toM + 4, stepM >= 0 ? stepM : undefined));
        const step = stepM >= 0 ? evalExpr(rest.slice(stepM + 6)) : 1;
        vars[name] = start;
        forStack.push({ name, limit, step, bodyPc: pc + 1 });
        return false;
      }

      function doNext(s) {
        if (!forStack.length) err('NEXT WITHOUT FOR');
        const f = forStack[forStack.length - 1];
        vars[f.name] += f.step;
        const cont = f.step >= 0 ? vars[f.name] <= f.limit : vars[f.name] >= f.limit;
        if (cont) { pc = f.bodyPc; return true; }
        forStack.pop();
        return false;
      }

      async function doIf(s, ln) {
        const thenM = s.toUpperCase().indexOf('THEN');
        if (thenM < 0) err('IF WITHOUT THEN');
        const cond = evalExpr(s.slice(0, thenM));
        if (cond) {
          const after = s.slice(thenM + 4).trim();
          if (/^\d+$/.test(after)) { const t = parseInt(after, 10); if (!(t in idxOf)) err('UNDEF LINE ' + t); pc = idxOf[t]; return true; }
          return await execStmt(after, ln);
        }
        return false;
      }

      function args(s) { return splitTop(s, ',').map((x) => evalExpr(x)); }

      // expression evaluator (recursive descent)
      function evalExpr(src) { const p = { s: src, i: 0 }; const v = parseCmp(p); return v; }
      function ws(p) { while (p.i < p.s.length && p.s[p.i] === ' ') p.i++; }
      function parseCmp(p) {
        let a = parseAdd(p); ws(p);
        const ops = ['<=', '>=', '<>', '=', '<', '>'];
        for (;;) {
          ws(p); let m = null;
          for (const o of ops) if (p.s.startsWith(o, p.i)) { m = o; break; }
          if (!m) break;
          p.i += m.length; const b = parseAdd(p);
          let r;
          if (m === '=') r = a === b; else if (m === '<>') r = a !== b;
          else if (m === '<') r = a < b; else if (m === '>') r = a > b;
          else if (m === '<=') r = a <= b; else r = a >= b;
          a = r ? -1 : 0;
        }
        return a;
      }
      function parseAdd(p) {
        let a = parseMul(p);
        for (;;) { ws(p); const c = p.s[p.i]; if (c === '+' || c === '-') { p.i++; const b = parseMul(p); a = c === '+' ? add(a, b) : a - b; } else break; }
        return a;
      }
      function parseMul(p) {
        let a = parseUnary(p);
        for (;;) { ws(p); const c = p.s[p.i]; if (c === '*' || c === '/') { p.i++; const b = parseUnary(p); a = c === '*' ? a * b : a / b; } else break; }
        return a;
      }
      function parseUnary(p) { ws(p); if (p.s[p.i] === '-') { p.i++; return -parseUnary(p); } if (p.s[p.i] === '+') { p.i++; return parseUnary(p); } return parseAtom(p); }
      function parseAtom(p) {
        ws(p);
        const c = p.s[p.i];
        if (c === '(') { p.i++; const v = parseCmp(p); ws(p); if (p.s[p.i] === ')') p.i++; return v; }
        if (c === '"') { p.i++; let str = ''; while (p.i < p.s.length && p.s[p.i] !== '"') str += p.s[p.i++]; p.i++; return str; }
        if (c >= '0' && c <= '9' || c === '.') { let num = ''; while (p.i < p.s.length && /[0-9.]/.test(p.s[p.i])) num += p.s[p.i++]; return parseFloat(num); }
        if (/[A-Za-z]/.test(c)) {
          let id = ''; while (p.i < p.s.length && /[A-Za-z0-9]/.test(p.s[p.i])) id += p.s[p.i++];
          if (p.s[p.i] === '$') { id += '$'; p.i++; }
          const fn = id.toUpperCase();
          ws(p);
          if (p.s[p.i] === '(' && FUNCS[fn]) { p.i++; const arg = parseCmp(p); ws(p); if (p.s[p.i] === ')') p.i++; return FUNCS[fn](arg); }
          if (FUNCS0[fn]) return FUNCS0[fn]();
          return id in vars ? vars[id] : 0;
        }
        return 0;
      }

      function add(a, b) { return (typeof a === 'string' || typeof b === 'string') ? toStr(a) + toStr(b) : a + b; }
    }

    function toStr(v) { return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(6))) : String(v); }

    // split at top level (not inside quotes); sep can be a regex alternation
    function splitTop(s, sepRe, keepSep) {
      const out = []; let buf = ''; let q = false;
      const isAlt = /[|]/.test(sepRe);
      const seps = isAlt ? sepRe.split('|') : [sepRe];
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"') q = !q;
        if (!q && seps.indexOf(ch) >= 0) {
          if (keepSep) { out.push({ text: buf }); out.push({ sep: true, token: ch }); }
          else out.push(buf);
          buf = '';
        } else buf += ch;
      }
      if (keepSep) out.push({ text: buf }); else out.push(buf);
      return out;
    }

    return { run, list, clearScreen, stop };
  }

  // ---- helpers ---------------------------------------------------------
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // Browser: boot on load. Node (tests): export the interpreter factory.
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', boot);
  if (typeof module !== 'undefined' && module.exports) module.exports.makeBasic = makeBasic;
})();
