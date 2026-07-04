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
    // Deep-link: opening the desktop at #<window> raises that window to the
    // front after boot (e.g. /#vmg → VM Graphics). Lets an external caller
    // focus a window by navigating the URL, without needing DOM access.
    focusWindowFromHash();
    window.addEventListener('hashchange', focusWindowFromHash);
  }

  // Map a URL hash to a window title and raise it (un-minimise + top z-index).
  function focusWindowFromHash() {
    const key = (location.hash || '').replace('#', '').toLowerCase();
    if (!key) return;
    const titles = { vmg: 'VM Graphics', graphics: 'VM Graphics', finder: 'avm Finder',
      avm: 'avm Finder', display: '3D Display', basic: 'BASIC', console: 'Xinu Console' };
    const want = titles[key];
    if (!want) return;
    setTimeout(() => {
      const rec = windows.find((w) => {
        const t = w.win.querySelector('.t');
        return t && t.textContent.indexOf(want) >= 0;
      });
      if (rec) {
        rec.win.style.display = ''; rec.minimized = false;
        rec.win.style.zIndex = ++zTop;
        windows.forEach((w) => { w.win.classList.remove('active'); w.task.classList.remove('active'); });
        rec.win.classList.add('active'); rec.task.classList.add('active');
      }
    }, 500);
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

  // ---- desktop context menu -------------------------------------------
  // Shift+click (or right-click on Windows) an empty desktop area pops up a
  // small menu that launches an extra Shell (xsh) or BASIC window at the click.
  let desktopInfo = { build: 'aice-avm' };

  function closeDesktopMenu() {
    const m = document.getElementById('desktop-menu');
    if (m) m.remove();
  }

  function showDesktopMenu(px, py) {
    closeDesktopMenu();
    const menu = document.createElement('div');
    menu.id = 'desktop-menu';
    menu.style.cssText =
      'position:fixed;z-index:100000;min-width:170px;background:#0e1626;' +
      'border:1px solid #2b3650;border-radius:8px;padding:4px;' +
      'box-shadow:0 10px 28px rgba(0,0,0,.55);font-family:inherit;font-size:13px;' +
      'color:#d8dee9;user-select:none';
    const header = document.createElement('div');
    header.textContent = 'New window';
    header.style.cssText = 'padding:4px 12px 6px;color:#8b949e;font-size:11px;border-bottom:1px solid #1c2740;margin-bottom:4px';
    menu.appendChild(header);
    const items = [
      { label: '🖥  シェル (Shell)', act: () => openConsole(desktopInfo, { primary: false, title: 'xsh (shell)', x: px, y: py }) },
      { label: '📝  BASIC',          act: () => openBasic({ x: px, y: py }) },
      { label: '🧊  avm Finder',     act: () => openAvmFinder({ x: px, y: py }) },
      { label: '📥  AVM 受信箱 (Inbox)', act: () => openInbox({ x: px, y: py }) },
    ];
    items.forEach((it) => {
      const el = document.createElement('div');
      el.textContent = it.label;
      el.style.cssText = 'padding:7px 12px;border-radius:6px;cursor:pointer;white-space:nowrap';
      el.addEventListener('mouseenter', () => { el.style.background = '#1b2942'; });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
      el.addEventListener('click', (e) => { e.stopPropagation(); closeDesktopMenu(); it.act(); });
      menu.appendChild(el);
    });
    document.body.appendChild(menu);
    // clamp to viewport so the menu never opens off-screen near the edges
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(px, window.innerWidth  - r.width  - 6) + 'px';
    menu.style.top  = Math.min(py, window.innerHeight - r.height - 6) + 'px';
  }

  function wireDesktopMenu() {
    const desktopEl = document.getElementById('desktop');
    // Shift+click on empty desktop → menu. Plain click elsewhere closes it.
    desktopEl.addEventListener('click', (e) => {
      if (e.shiftKey && e.target === desktopEl) { e.preventDefault(); showDesktopMenu(e.clientX, e.clientY); }
      else closeDesktopMenu();
    });
    // Right-click on empty desktop → same menu (Windows-style). Leave the
    // native context menu intact when right-clicking inside a window (text, etc).
    desktopEl.addEventListener('contextmenu', (e) => {
      if (e.target !== desktopEl) return;
      e.preventDefault();
      showDesktopMenu(e.clientX, e.clientY);
    });
    // Dismiss on any outside mousedown / Escape.
    document.addEventListener('mousedown', (e) => {
      const m = document.getElementById('desktop-menu');
      if (m && !m.contains(e.target)) closeDesktopMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDesktopMenu(); });
  }

  // ---- desktop boot ----------------------------------------------------
  function startDesktop(info) {
    desktopInfo = info;
    wireDesktopMenu();
    openProcesses();
    openVmGraphics();
    openDisplay();
    openBasic();
    openLoader();
    // Real Raspberry Pi Xinu boards mirrored as windows (HDMI over HTTP /fb).
    // The standalone aice-avm app (__XINU_AVM) has no Pi cluster on the LAN, so
    // auto-opening these mirrors + the mesh monitor makes the browser hammer
    // unreachable hosts (each connect stalls ~tens of seconds), which starves
    // the network/main thread and makes the whole desktop — including the shell
    // and `ls /computer` — feel very slow. Only auto-open them for the Pi-cluster
    // deployment; they remain available from the desktop menu either way.
    if (!window.__XINU_AVM) {
      openPiScreen({ title: 'rpi5 Screen (HDMI)', host: '192.168.3.101', x: 720, y: 300 });
      openPiScreen({ title: 'rpi4 Screen (HDMI)', host: '192.168.3.100', x: 360, y: 300 });
      openPiScreen({ title: 'rpi3 Screen (HDMI)', host: '192.168.3.50:8080',  x: 30,  y: 330, res: 96, ival: 10000 });
      openMeshControl();
    }
    // Open the console last so it starts on top (highest z-index) and its shell
    // prompt is visible and clickable rather than buried behind other windows.
    openConsole(info);
  }

  // ---- Raspberry Pi remote screen mirror ------------------------------
  // Shows a real Raspberry Pi Xinu's HDMI framebuffer (which may have no
  // monitor attached) as one window of this simulator. Each Pi kernel exposes
  // a /fb route: "GET /fb?w=N" returns "DW DH SRCW SRCH" dimensions;
  // "GET /fb?off=N&w=N" returns a chunk of the down-scaled RGB565 (LE) frame.
  function openPiScreen(cfg) {
    // Per-board defaults: rpi3 talks over WiFi via the one-connection-at-a-time
    // webactor (port 8080), so it defaults to a small res + slow interval.
    const defRes = cfg.res || 160;
    const defIval = (cfg.ival != null) ? cfg.ival : 5000;
    const opt = (v, label) => '<option value="' + v + '"' +
      (v == defRes || v == defIval ? ' selected' : '') + '>' + label + '</option>';
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<div class="basic-toolbar">' +
      '<span style="color:#8b949e">host</span>' +
      '<input class="r4-host" value="' + (cfg.host || '192.168.3.100') + '" ' +
      'style="width:108px;background:#182236;color:#d8dee9;border:1px solid #2b3650;border-radius:6px;padding:3px 6px;font-family:inherit;font-size:11.5px">' +
      '<span style="color:#8b949e">res</span>' +
      '<select class="r4-res">' +
      opt(96, '96') + opt(160, '160') + opt(240, '240') +
      opt(320, '320') + opt(400, '400') + opt(480, '480') +
      '</select>' +
      '<span style="color:#8b949e">every</span>' +
      '<select class="r4-ival">' +
      opt(0, 'once') + opt(2000, '2s') + opt(5000, '5s') + opt(10000, '10s') +
      '</select>' +
      '<button data-act="refresh">⟳ Refresh</button>' +
      '<button data-act="auto">▶ Auto</button>' +
      '</div>' +
      '<canvas class="r4-canvas" width="320" height="240" ' +
      'style="background:#000;border:1px solid #2b3650;border-radius:8px;flex:1;width:100%;image-rendering:pixelated"></canvas>' +
      '<div class="r4-stat" style="color:#8b949e;font-size:11px">idle · real Pi HDMI over HTTP</div>';

    let alive = true, timer = null, busy = false;
    makeWindow({ title: cfg.title || 'Pi Screen (HDMI)', x: cfg.x || 360, y: cfg.y || 300, w: 380, h: 340, node,
      onClose: () => { alive = false; if (timer) clearInterval(timer); } });

    const canvas = node.querySelector('.r4-canvas');
    const ctx = canvas.getContext('2d');
    const hostI = node.querySelector('.r4-host');
    const resS = node.querySelector('.r4-res');
    const ivalS = node.querySelector('.r4-ival');
    const stat = node.querySelector('.r4-stat');
    const autoBtn = node.querySelector('[data-act=auto]');

    // The current Pi 4 kernel appends a literal "404 not found\n" (14 bytes) to
    // every /fb response; strip it so the pixel stream stays aligned.
    const SUF = [52, 48, 52, 32, 110, 111, 116, 32, 102, 111, 117, 110, 100, 10];
    function strip404(a) {
      if (a.length >= SUF.length) {
        let m = true;
        for (let k = 0; k < SUF.length; k++) if (a[a.length - SUF.length + k] !== SUF[k]) { m = false; break; }
        if (m) return a.subarray(0, a.length - SUF.length);
      }
      return a;
    }

    async function grab() {
      if (busy || !alive) return; busy = true;
      const host = hostI.value.trim();
      const w = parseInt(resS.value, 10);
      const base = 'http://' + host + '/fb';
      try {
        stat.textContent = 'fetching dims…';
        const info = (await (await fetch(base + '?w=' + w, { cache: 'no-store' })).text()).trim().split(/\s+/);
        const dw = +info[0], dh = +info[1];
        const total = dw * dh * 2;
        const buf = new Uint8Array(total);
        let off = 0, chunks = 0;
        const t0 = performance.now();
        while (off < total && alive) {
          const r = await fetch(base + '?off=' + off + '&w=' + w, { cache: 'no-store' });
          const ab = strip404(new Uint8Array(await r.arrayBuffer()));
          const take = Math.min(ab.length, total - off);
          buf.set(ab.subarray(0, take), off);
          off += take; chunks++;
          if (ab.length === 0) break;
          stat.textContent = 'loading ' + Math.round(100 * off / total) + '%  (' + chunks + ' chunks)';
        }
        // RGB565 (little-endian) -> RGBA
        const img = ctx.createImageData(dw, dh);
        for (let i = 0; i < dw * dh; i++) {
          const v = buf[2 * i] | (buf[2 * i + 1] << 8);
          const o = i * 4;
          img.data[o] = ((v >> 11) & 0x1f) << 3;
          img.data[o + 1] = ((v >> 5) & 0x3f) << 2;
          img.data[o + 2] = (v & 0x1f) << 3;
          img.data[o + 3] = 255;
        }
        const tmp = document.createElement('canvas'); tmp.width = dw; tmp.height = dh;
        tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
        const ms = Math.round(performance.now() - t0);
        stat.textContent = 'OK ' + dw + '×' + dh + ', ' + chunks + ' chunks, ' + ms + ' ms';
      } catch (_e) {
        stat.textContent = '⚠ error (is rpi4 reachable at ' + host + '?)';
      } finally { busy = false; }
    }

    function stopAuto() { if (timer) { clearInterval(timer); timer = null; } autoBtn.textContent = '▶ Auto'; }
    function startAuto() {
      const ms = parseInt(ivalS.value, 10);
      if (!ms) { grab(); return; }        // "once" → single shot
      stopAuto();
      autoBtn.textContent = '⏸ Stop';
      grab();
      timer = setInterval(grab, ms);
    }

    node.querySelector('.basic-toolbar').addEventListener('click', (e) => {
      const act = e.target.getAttribute('data-act');
      if (act === 'refresh') grab();
      else if (act === 'auto') { if (timer) stopAuto(); else startAuto(); }
    });
    // Re-arm with the new interval if the dropdown changes mid-run.
    ivalS.addEventListener('change', () => { if (timer) startAuto(); });

    xlog('[net] ' + (cfg.title || 'Pi Screen') + ' window opened (mirrors HDMI via /fb)', 'boot-info');
    grab();
  }

  // ---- Mesh Control Center --------------------------------------------
  // Discovers real Xinu boards on the LAN, joins them into a WiFi ad-hoc
  // (IBSS) MANET (10.0.0.N) with AODV multi-hop routing, and manages them.
  // Control/discovery stay on the wired LAN (each board's /fb is CORS-enabled,
  // so reachability probes work cross-origin); the mesh itself runs on the
  // boards' otherwise-idle WiFi radios.  "Join" hits each board's /wifi-adhoc
  // route (fire-and-forget, so it works even before the route is CORS-enabled).
  // join = non-blocking /wifi-adhoc (all 3 boards). leave = fast `wifi off`
  // over each board's shell-HTTP (rpi5 uses /run, rpi3/rpi4 use /shell).
  // via = how to read the board's own "wifi status" through the server proxy
  // (/mesh/cmd). rpi4 has no status subcommand → via:null → detected by asking
  // a peer to AODV it.
  const MESH_BOARDS = [
    { name: 'rpi3', host: '192.168.3.50:8080', node: 1, via: 'shell', leave: '/shell?cmd=wifi+off', kind: 'board' },
    { name: 'rpi4', host: '192.168.3.100',     node: 2, via: null,    leave: '/shell?cmd=wifi+off', kind: 'board' },
    { name: 'rpi5', host: '192.168.3.101',     node: 3, via: 'run',   leave: '/run?cmd=wifi%20off', kind: 'board' },
  ];

  function openMeshControl() {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<div class="basic-toolbar">' +
      '<span style="color:#8b949e">ssid</span>' +
      '<input class="mc-ssid" value="MANET" style="width:70px;background:#182236;color:#d8dee9;border:1px solid #2b3650;border-radius:6px;padding:3px 6px;font-family:inherit;font-size:11.5px">' +
      '<span style="color:#8b949e">ch</span>' +
      '<input class="mc-ch" value="6" style="width:34px;background:#182236;color:#d8dee9;border:1px solid #2b3650;border-radius:6px;padding:3px 6px;font-family:inherit;font-size:11.5px">' +
      '<button data-act="auto">▶ Auto</button>' +
      '<button data-act="scan">🔍 Scan</button>' +
      '<button data-act="verify">✓ Verify</button>' +
      '<button data-act="verifybuild">⚙ Verify &amp; Build</button>' +
      '<button data-act="form">🕸 Form</button>' +
      '<button data-act="leaveall">⏏ Leave All</button>' +
      '<button data-act="rebuild">♻ Rebuild</button>' +
      '<button data-act="refresh">⟳ Refresh Status</button>' +
      '<button data-act="swarm">🚁 Drone Swarm</button>' +
      '</div>' +
      '<div class="basic-toolbar">' +
      '<span style="color:#8b949e">bench:</span>' +
      '<button data-bench="primes">∑ Primes</button>' +
      '<button data-bench="nqueens">♛ N-Queens</button>' +
      '<button data-bench="dining">🍝 Philosophers</button>' +
      '<span style="color:#8b949e">　display:</span>' +
      '<button data-bench="makina">🎭 MAKINA-7→rpi5</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex:1;min-height:0">' +
      '<table class="proc-table mc-tbl" style="flex:1"><thead><tr>' +
      '<th>NODE</th><th>HOST</th><th>LINK</th><th>LAT</th><th>CAP</th><th>MESH</th>' +
      '</tr></thead><tbody></tbody></table>' +
      '<canvas class="mc-topo" width="220" height="200" style="background:#05080e;border:1px solid #2b3650;border-radius:8px;width:230px"></canvas>' +
      '</div>' +
      '<div class="basic-output mc-log" style="max-height:96px;color:#7dcfff;font-size:11px"></div>';

    makeWindow({ title: 'Mesh Control Center', x: 200, y: 80, w: 660, h: 440, node,
                 onClose: () => { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } } });
    const tbody = node.querySelector('tbody');
    const logEl = node.querySelector('.mc-log');
    const ssidI = node.querySelector('.mc-ssid');
    const chI = node.querySelector('.mc-ch');
    const topo = node.querySelector('.mc-topo');
    const tctx = topo.getContext('2d');
    // Xinu simulators (OCaml aice-avm VMs) act as monitoring CENTERS / LAN
    // coordinators, not IBSS members.  Seed the known ones (this Mac VM = self,
    // plus the Windows sim) so they always appear in the table and topology.
    const SIM_COORDS = [
      { name: 'mac-sim', host: (location.host || 'localhost:8080'), node: 0, kind: 'sim' },
      { name: 'win-sim', host: '192.168.3.218:8080',                 node: 0, kind: 'sim' },
    ];
    // board state: { ...cfg, up, joined, verify, dims, lat(ms), cores, sp, cap }
    const boards = MESH_BOARDS.concat(SIM_COORDS).map((b) => ({
      ...b, up: false, joined: false, verify: '?', dims: '',
      lat: null, cores: null, sp: null, cap: null, lastJoinAt: 0, seen: 0,
    }));
    // Auto-pilot (continuous monitor) state.
    let autoOn = false, autoTimer = null, tickN = 0, busy = false;
    const TICK_MS = 5000, SWEEP_EVERY = 4, SMP_EVERY = 12;

    function log(msg) {
      const d = document.createElement('div');
      d.textContent = msg;
      logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
      xlog('[mesh] ' + msg, 'boot-info');
    }

    // CORS-readable reachability probe.  Boards answer /fb (HDMI mirror dims);
    // sims (OCaml aice-avm VMs) answer /api/console.  Also times the round-trip
    // into a rolling latency (ms) used by the load-distribution perf table.
    async function probe(b) {
      const path = b.kind === 'sim' ? '/api/console' : '/fb?w=16';
      const t0 = (performance && performance.now) ? performance.now() : Date.now();
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch('http://' + b.host + path, { cache: 'no-store', signal: ctl.signal });
        clearTimeout(t);
        b.up = r.ok;
        if (r.ok) {
          const dt = ((performance && performance.now) ? performance.now() : Date.now()) - t0;
          b.lat = (b.lat == null) ? dt : b.lat * 0.6 + dt * 0.4;   // EWMA
          b.seen = Date.now();
          if (b.kind !== 'sim') {
            const f = (await r.text()).trim().split(/\s+/);
            if (f.length >= 4) b.dims = f[2] + 'x' + f[3];          // SRCW x SRCH
          }
        }
      } catch (_e) { b.up = false; }
      return b.up;
    }

    // Run a shell command on a board through the server-side proxy (/mesh/cmd),
    // which bypasses the board's lack of CORS on /run and /shell.
    function hostPort(h) { const p = h.split(':'); return { h: p[0], port: p[1] || '80' }; }
    async function proxyCmd(host, via, cmd) {
      const hp = hostPort(host);
      const u = '/mesh/cmd?host=' + hp.h + '&port=' + hp.port + '&via=' + via +
                '&c=' + encodeURIComponent(cmd);
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch(u, { cache: 'no-store', signal: ctl.signal });
        clearTimeout(t);
        return r.ok ? await r.text() : '';
      } catch (_e) { return ''; }
    }

    // Detect REAL mesh membership (not just "Join clicked this session"):
    //  - rpi3/rpi5 report it via `wifi status` (ip 10.0.0.N + connected/MANET)
    //  - rpi4 has no status → ask an up, status-capable peer to AODV 10.0.0.2;
    //    "route already known/found" means rpi4 is a live neighbour on the cell.
    async function detectJoined(b) {
      if (b.via) {
        const t = await proxyCmd(b.host, b.via, 'wifi status');
        return t.indexOf('10.0.0.' + b.node) >= 0 && /connected|MANET/i.test(t);
      }
      const peer = boards.find((x) => x.via && x.up && x !== b);
      if (!peer) return false;
      const t = await proxyCmd(peer.host, peer.via, 'wifi aodv 10.0.0.' + b.node);
      return /route already known|route found|\bhop\b/i.test(t) && !/no route|unreachable/i.test(t);
    }

    // Common verification "script" run against every board, the same way:
    //  1) LAN reachable?  2) /fb screen-mirror responds with real dims?
    //  3) ready to mesh (has the /wifi-adhoc control plane).
    // Uses /fb (CORS) — the one route every patched Xinu exposes cross-origin.
    async function verify() {
      log('=== VERIFY: running common check on ' + boards.length + ' boards ===');
      let pass = 0;
      for (const b of boards) {
        b.verify = '?'; render();
        const ok = await probe(b);
        b.verify = ok ? 'ok' : 'fail';
        if (ok) { pass++; log('  ✓ ' + b.name + ' (' + b.host + ') fb=' + b.dims + ' — ready'); }
        else    { log('  ✗ ' + b.name + ' (' + b.host + ') — unreachable'); }
        render();
      }
      log('VERIFY: ' + pass + '/' + boards.length + ' boards ready' +
          (pass === boards.length ? ' — all green ✓' : ''));
      return pass === boards.length;
    }

    // One-click: verify, and if every board passes, auto-build the mesh.
    async function verifyAndBuild() {
      const allOk = await verify();
      if (!allOk) { log('Verify & Build: aborting — not all boards passed.'); return; }
      log('=== AUTO-BUILD: all verified, forming the mesh ===');
      boards.forEach((b, k) => { if (b.up) setTimeout(() => joinOne(b), k * 1500); });
      // After the radios settle, draw the resulting topology.
      setTimeout(drawMesh, boards.length * 1500 + 2000);
    }

    // Visualize the mesh: joined+up nodes around a ring, fully connected
    // (an IBSS cell makes every member a 1-hop neighbour of every other).
    function drawMesh() {
      const W = topo.width, H = topo.height, cx = W / 2, cy = H / 2 + 24, R = 50;
      tctx.fillStyle = '#05080e'; tctx.fillRect(0, 0, W, H);
      tctx.textAlign = 'left';
      tctx.fillStyle = '#8b949e'; tctx.font = '11px monospace';
      tctx.fillText('MESH ' + (ssidI.value || 'MANET'), 8, 13);

      // --- monitoring centers (Xinu simulators) across the top -------------
      const sims = boards.filter((b) => b.kind === 'sim' && b.up);
      const simPos = sims.map((b, i) => ({
        b, x: sims.length === 1 ? cx : 26 + i * (W - 52) / Math.max(1, sims.length - 1), y: 30,
      }));

      // --- mesh ring: every up board (solid=joined, dashed=pending) --------
      const mem = boards.filter((b) => b.kind === 'board' && b.up);
      const pos = mem.map((b, i) => {
        const a = -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, mem.length);
        return { b, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
      });

      // monitor → mesh links (dashed: the sim watches/coordinates the cell)
      tctx.setLineDash([3, 3]); tctx.strokeStyle = '#274060'; tctx.lineWidth = 1;
      simPos.forEach((s) => {
        tctx.beginPath(); tctx.moveTo(s.x, s.y + 9); tctx.lineTo(cx, cy); tctx.stroke();
      });
      tctx.setLineDash([]);

      // mesh edges: full 1-hop among JOINED members
      const jp = pos.filter((p) => p.b.joined);
      tctx.strokeStyle = '#2e6f5e'; tctx.lineWidth = 1.5;
      for (let i = 0; i < jp.length; i++)
        for (let j = i + 1; j < jp.length; j++) {
          tctx.beginPath(); tctx.moveTo(jp[i].x, jp[i].y); tctx.lineTo(jp[j].x, jp[j].y); tctx.stroke();
        }

      // board nodes
      pos.forEach((p) => {
        tctx.beginPath(); tctx.arc(p.x, p.y, 15, 0, 7);
        tctx.fillStyle = p.b.joined ? '#143' : '#1a1410'; tctx.fill();
        if (!p.b.joined) tctx.setLineDash([3, 2]);
        tctx.strokeStyle = p.b.joined ? '#9ece6a' : '#e0af68'; tctx.lineWidth = 2; tctx.stroke();
        tctx.setLineDash([]);
        tctx.fillStyle = '#e6edf3'; tctx.font = 'bold 10px monospace'; tctx.textAlign = 'center';
        tctx.fillText(p.b.name, p.x, p.y - 1);
        tctx.fillStyle = '#7dcfff'; tctx.font = '8px monospace';
        tctx.fillText(p.b.joined ? '.0.0.' + p.b.node : 'pending', p.x, p.y + 8);
      });

      // monitor (sim) nodes — drawn last so they sit on top
      simPos.forEach((s) => {
        tctx.fillStyle = '#0e1830';
        tctx.fillRect(s.x - 24, s.y - 9, 48, 18);
        tctx.strokeStyle = '#7aa2f7'; tctx.lineWidth = 1.5;
        tctx.strokeRect(s.x - 24, s.y - 9, 48, 18);
        tctx.fillStyle = '#9db8ff'; tctx.font = 'bold 8px monospace'; tctx.textAlign = 'center';
        tctx.fillText('◆' + s.b.name, s.x, s.y + 3);
      });

      tctx.textAlign = 'left';
      if (mem.length === 0 && sims.length === 0) {
        tctx.fillStyle = '#566'; tctx.fillText('(scanning…)', cx - 30, cy);
      }
      const joined = mem.filter((b) => b.joined).length;
      tctx.fillStyle = '#8b949e'; tctx.font = '9px monospace';
      tctx.fillText(joined + ' mesh · ' + sims.length + ' monitor', 8, H - 6);
    }

    async function joinOne(b) {
      if (b.kind === 'sim') return;   // sims are LAN coordinators, not IBSS members
      const ssid = ssidI.value.trim() || 'MANET';
      const ch = parseInt(chI.value, 10) || 6;
      const url = 'http://' + b.host + '/wifi-adhoc?ssid=' + encodeURIComponent(ssid) +
                  '&ch=' + ch + '&n=' + b.node;
      log('joining ' + b.name + ' -> 10.0.0.' + b.node + ' (ssid=' + ssid + ' ch=' + ch + ') ...');
      // fire-and-forget: the board's /wifi-adhoc may freeze its gateway for ~1
      // min during WiFi bring-up, so we don't await a readable response.
      try { fetch(url, { mode: 'no-cors', cache: 'no-store' }); } catch (_e) {}
      b.joined = true;
      render();
    }

    async function leaveOne(b) {
      if (b.kind === 'sim') return;   // sims have no IBSS radio to drop
      log('leaving ' + b.name + ' (wifi off, radio down) ...');
      try { fetch('http://' + b.host + b.leave, { mode: 'no-cors', cache: 'no-store' }); } catch (_e) {}
      b.joined = false;
      render();
    }

    // Tear the whole mesh down, then re-form it after the radios settle.
    async function rebuild() {
      log('=== REBUILD: leaving all, then re-forming the mesh ===');
      boards.forEach((b) => { if (b.up) leaveOne(b); });
      // give the radios a few seconds to drop the IBSS cell, then re-join
      setTimeout(() => {
        boards.forEach((b, k) => { if (b.up) setTimeout(() => joinOne(b), k * 1500); });
      }, 4000);
    }

    function render() {
      tbody.innerHTML = boards.map((b, i) => {
        const name = (b.kind === 'sim' ? '🖥 ' : '') + b.name;
        const link = b.up ? '<span class="state-ready">● up</span>'
                          : '<span class="state-susp">○ down</span>';
        const lat = b.lat == null ? '<span style="color:#566">–</span>'
                  : '<span style="color:' + (b.lat < 60 ? '#9ece6a' : b.lat < 300 ? '#e0af68' : '#f7768e') +
                    '">' + Math.round(b.lat) + 'ms</span>';
        const cap = b.cap != null ? '<span class="actor-mark">' + b.cap + '</span>' +
                      (b.sp ? ' <span style="color:#7aa2f7">' + b.sp.toFixed(1) + 'x</span>' : '')
                  : (b.cores ? b.cores + 'c' : '<span style="color:#566">–</span>');
        let meshcell;
        if (b.kind === 'sim') {
          meshcell = '<span style="color:#7aa2f7">◆ monitor</span> ' +
            '<button data-restart="' + i + '" style="font-size:11px">↻ Restart</button>';
        } else {
          const meship = b.joined ? '<span class="actor-mark">10.0.0.' + b.node + '</span> '
                                  : '<span style="color:#8b949e">10.0.0.' + b.node + '</span> ';
          meshcell = meship +
            '<button data-join="' + i + '" style="font-size:11px">Join</button> ' +
            '<button data-leave="' + i + '" style="font-size:11px">Leave</button>';
        }
        return '<tr><td>' + name + '</td><td>' + b.host + '</td><td>' + link +
          '</td><td>' + lat + '</td><td>' + cap + '</td><td>' + meshcell + '</td></tr>';
      }).join('');
      tbody.querySelectorAll('[data-join]').forEach((btn) => {
        btn.onclick = () => joinOne(boards[+btn.getAttribute('data-join')]);
      });
      tbody.querySelectorAll('[data-leave]').forEach((btn) => {
        btn.onclick = () => leaveOne(boards[+btn.getAttribute('data-leave')]);
      });
      tbody.querySelectorAll('[data-restart]').forEach((btn) => {
        btn.onclick = () => restartSim(boards[+btn.getAttribute('data-restart')]);
      });
      drawMesh();
    }

    // Remotely restart a Xinu simulator (OCaml VM) via its /api/restart route —
    // the server relaunches a fresh copy of itself on the same port.  Recovers a
    // wedged sim without physical access.  No response = expected (it exited).
    async function restartSim(b) {
      log('restarting ' + b.name + ' (' + b.host + ') remotely via /api/restart ...');
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 3000);
        const r = await fetch('http://' + b.host + '/api/restart', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(t);
        log('  ' + b.name + ': ' + (await r.text()).trim());
      } catch (_e) {
        log('  ' + b.name + ': restart issued (relaunching — brief downtime expected)');
      }
      b.up = false; b.lat = null; render();
      setTimeout(() => probe(b).then(render), 3000);   // re-probe after it comes back
    }

    // Full live status: LAN reachability + REAL mesh membership, then explain
    // the state of every board (and, if the mesh is incomplete, exactly why).
    async function refreshStatus() {
      log('=== STATUS @ ' + new Date().toLocaleTimeString() + ' — probing ' +
          boards.length + ' boards (LAN /fb + mesh status) ===');
      await Promise.all(boards.map(probe));
      await Promise.all(boards.map(async (b) => {
        b.joined = (b.up && b.kind !== 'sim') ? await detectJoined(b) : false;
      }));
      publishPerf();
      render();
      const meshed = boards.filter((b) => b.joined);
      const reasons = [];
      for (const b of boards) {
        if (b.up && b.joined) {
          log('  ✓ ' + b.name + ' up · MESH 10.0.0.' + b.node + ' · fb=' + (b.dims || '?'));
        } else if (b.up && !b.joined) {
          log('  ◐ ' + b.name + ' up (LAN ' + b.host + ') but NOT on mesh');
          reasons.push(b.name + ': reachable on Ethernet but its WiFi radio is not in the IBSS cell — click Join (or Form) to bring it onto 10.0.0.' + b.node + '.');
        } else {
          log('  ✗ ' + b.name + ' DOWN (' + b.host + ')');
          reasons.push(b.name + ': not reachable on LAN — powered off, wrong IP, or HTTP wedged (reboot the board).');
        }
      }
      if (meshed.length >= 2) {
        log('MESH: ' + meshed.map((b) => b.name).join(' + ') + ' connected (' +
            meshed.length + ' nodes, full 1-hop).');
      } else {
        log('MESH: NOT BUILT (' + meshed.length + ' node' + (meshed.length === 1 ? '' : 's') +
            ' on the cell — need ≥2). Reasons:');
        reasons.forEach((r) => log('   • ' + r));
      }
    }

    // Classify one host:port — 'board' (real Pi: CORS /fb HDMI mirror, joins the
    // IBSS mesh) or 'sim' (OCaml aice-avm VM: /api/console, a LAN coordinator) or
    // null.  Used by both the manual Scan button and the auto-pilot sweep.
    async function classify(hp) {
      async function ok(path) {
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 1200);
          const r = await fetch('http://' + hp + path, { cache: 'no-store', signal: ctl.signal });
          clearTimeout(t);
          return r.ok;
        } catch (_e) { return false; }
      }
      if (await ok('/fb?w=16')) return 'board';
      if (await ok('/api/console')) return 'sim';
      return null;
    }

    // Sweep the LAN (both :80 and :8080) for Xinu not already in the table and
    // merge any new ones.  Returns the list of newly added boards.
    async function sweepInto() {
      const cand = [];
      for (let i = 2; i <= 254; i++)
        for (const port of [80, 8080]) {
          const hp = '192.168.3.' + i + (port === 80 ? '' : ':' + port);
          if (boards.some((b) => b.host === hp)) continue;
          cand.push(hp);
        }
      const added = [];
      // bounded concurrency so a full /24 sweep doesn't open 500 sockets at once
      let idx = 0;
      async function worker() {
        while (idx < cand.length) {
          const hp = cand[idx++];
          const kind = await classify(hp);
          if (!kind) continue;
          if (boards.some((b) => b.host === hp)) continue;
          const node = boards.length + 1;
          const nb = {
            name: (kind === 'sim' ? 'sim' : 'xinu') + node, host: hp, node, kind,
            via: kind === 'sim' ? null : 'shell', leave: '/shell?cmd=wifi+off',
            up: true, joined: false, verify: '?', dims: '',
            lat: null, cores: null, sp: null, cap: null, lastJoinAt: 0, seen: Date.now(),
          };
          boards.push(nb); added.push(nb);
          log('discovered ' + kind + ' at ' + hp + ' → node ' + node);
        }
      }
      await Promise.all(Array.from({ length: 24 }, worker));
      return added;
    }

    async function scan() {
      log('scanning 192.168.3.0/24 (:80 + :8080) for Xinu boards & sims ...');
      const added = await sweepInto();
      if (!added.length) log('scan: no new Xinu found (' + boards.length + ' already tracked).');
      await Promise.all(boards.map(probe));
      render();
    }

    // Capacity probe for the load-distribution table: a short SMP primes run
    // gives cores_online + speedup; capacity ≈ cores*speedup scaled by 1/time
    // (higher = more parallel headroom for actor placement).  Boards only.
    async function refreshPerf(b) {
      if (b.kind === 'sim' || !b.up) return;
      const hp = hostPort(b.host);
      try {
        const r = await fetch('/mesh/bench?host=' + hp.h + '&port=' + hp.port +
                              '&kind=primes&n=120000', { cache: 'no-store' });
        const t = (await r.text()).trim();
        const cores = (t.match(/cores_online\s*=\s*([0-9]+)/i) || [])[1];
        const spx   = (t.match(/speedup\s*x100\s*=\s*([0-9]+)/i) || [])[1];
        const all   = (t.match(/N-core\s*ms\s*=\s*([0-9]+)/i) || [])[1];
        if (cores) b.cores = parseInt(cores, 10);
        if (spx)   b.sp = parseInt(spx, 10) / 100;
        if (all)   b.cap = Math.round((b.cores || 1) * (b.sp || 1) * 1000 / Math.max(1, parseInt(all, 10)));
      } catch (_e) {}
    }

    // Publish a live, sorted perf snapshot so a load-balancer / actor-placement
    // policy can pick the highest-capacity, lowest-latency mesh member.
    function publishPerf() {
      const snap = boards.filter((b) => b.up).map((b) => ({
        name: b.name, host: b.host, node: b.node, kind: b.kind, joined: b.joined,
        lat: b.lat == null ? null : Math.round(b.lat),
        cores: b.cores, speedup: b.sp, capacity: b.cap, seen: b.seen,
      }));
      // best target first: most capacity, then lowest latency
      snap.sort((a, z) => (z.capacity || 0) - (a.capacity || 0) ||
                          ((a.lat == null ? 1e9 : a.lat) - (z.lat == null ? 1e9 : z.lat)));
      window.__MESH_PERF = { ts: Date.now(), nodes: snap };
      return snap;
    }

    // One monitor tick: discover (periodically) → probe liveness+latency →
    // detect real mesh membership → auto-join stragglers → refresh capacity →
    // publish the perf table.  Guarded by `busy` so ticks never overlap.
    async function monitorTick() {
      if (busy) return; busy = true;
      try {
        tickN++;
        if (tickN % SWEEP_EVERY === 1) await sweepInto();
        await Promise.all(boards.map(probe));
        await Promise.all(boards.map(async (b) => {
          b.joined = (b.up && b.kind !== 'sim') ? await detectJoined(b) : false;
        }));
        if (autoOn) {
          const now = Date.now();
          for (const b of boards) {
            if (b.kind === 'board' && b.up && !b.joined && now - (b.lastJoinAt || 0) > 45000) {
              b.lastJoinAt = now;
              log('auto-join ' + b.name + ' (up on LAN, not on mesh) → 10.0.0.' + b.node);
              joinOne(b);
            }
          }
        }
        if (tickN % SMP_EVERY === 2)
          for (const b of boards.filter((x) => x.up && x.kind === 'board')) await refreshPerf(b);
        publishPerf();
        render();
      } finally { busy = false; }
    }

    function setAuto(on) {
      autoOn = on;
      const btn = node.querySelector('[data-act="auto"]');
      if (btn) { btn.textContent = on ? '⏸ Auto ON' : '▶ Auto'; btn.style.color = on ? '#9ece6a' : ''; }
      if (on && !autoTimer) {
        log('=== AUTO-PILOT ON: monitoring net every ' + (TICK_MS / 1000) +
            's, auto-joining boards, keeping the perf table ===');
        autoTimer = setInterval(monitorTick, TICK_MS);
        monitorTick();
      } else if (!on && autoTimer) {
        clearInterval(autoTimer); autoTimer = null;
        log('=== AUTO-PILOT OFF ===');
      }
    }

    // Run a benchmark across every reachable board and tabulate the results.
    // primes uses each board's real SMP benchmark (/smp-bench via the proxy);
    // nqueens/dining need a board-side route that isn't flashed yet.
    async function runBench(kind) {
      // MAKINA-7: push the AVM2 binary-mesh blender display to rpi5 (the board
      // with the B+B' kernel) via the server-side /mesh/loadvm proxy, then open
      // its HDMI mirror so the turntable is visible.
      if (kind === 'makina') {
        const host = '192.168.3.101', port = 80;
        log('=== MAKINA-7: uploading AVM2 mesh (MakinaMesh.avm) to rpi5 ' + host + ' ===');
        try {
          const r = await fetch('/mesh/loadvm?host=' + host + '&port=' + port + '&file=MakinaMesh.avm',
                                { cache: 'no-store' });
          log('  ' + (await r.text()).trim());
        } catch (e) { log('  upload failed: ' + e); return; }
        openPiScreen({ title: 'rpi5 Screen (HDMI)', host: '192.168.3.101', x: 720, y: 300 });
        log('  opened rpi5 HDMI mirror — MAKINA-7 should be rotating (z-buffered turntable).');
        return;
      }
      const up = boards.filter((b) => b.up);
      if (!up.length) { log('bench: no reachable boards — run Refresh Status first.'); return; }
      if (kind === 'primes') {
        const n = 300000;
        log('=== BENCH primes: count primes < ' + n + ' (SMP, all cores) on ' + up.length + ' boards ===');
        const rows = [];
        for (const b of up) {
          const hp = hostPort(b.host);
          log('  running on ' + b.name + ' ...');
          try {
            const r = await fetch('/mesh/bench?host=' + hp.h + '&port=' + hp.port +
                                  '&kind=primes&n=' + n, { cache: 'no-store' });
            const t = (await r.text()).trim();
            const one   = (t.match(/1-core\s*ms\s*=\s*([0-9]+)/i) || [])[1];
            const all   = (t.match(/N-core\s*ms\s*=\s*([0-9]+)/i) || [])[1];
            const cores = (t.match(/cores_online\s*=\s*([0-9]+)/i) || [])[1];
            const spx   = (t.match(/speedup\s*x100\s*=\s*([0-9]+)/i) || [])[1];
            const sp    = spx ? (parseInt(spx, 10) / 100).toFixed(2) : null;
            rows.push({ name: b.name, one, all, sp, cores, raw: t });
            log('    ' + b.name + ': ' + (cores || '?') + ' cores · 1-core=' +
                (one || '?') + 'ms  ' + (cores || 'N') + '-core=' + (all || '?') +
                'ms  speedup=' + (sp || '?') + 'x');
          } catch (_e) { log('    ' + b.name + ': bench failed'); }
        }
        log('BENCH primes done: ' + rows.length + '/' + up.length + ' boards reported.');
      } else if (kind === 'nqueens' || kind === 'dining') {
        const n = kind === 'nqueens' ? 13 : 5;
        const what = kind === 'nqueens'
          ? 'N-Queens (board ' + n + ', count all solutions)'
          : 'Dining Philosophers (' + n + ' philosophers, independent tables)';
        log('=== BENCH ' + kind + ': ' + what + ' — SMP, all cores — on ' + up.length + ' boards ===');
        const rows = [];
        for (const b of up) {
          const hp = hostPort(b.host);
          log('  running on ' + b.name + ' ...');
          try {
            const r = await fetch('/mesh/bench?host=' + hp.h + '&port=' + hp.port +
                                  '&kind=' + kind + '&n=' + n, { cache: 'no-store' });
            const t = (await r.text()).trim();
            const one    = (t.match(/1-core\s*ms\s*=\s*([0-9]+)/i) || [])[1];
            const all    = (t.match(/N-core\s*ms\s*=\s*([0-9]+)/i) || [])[1];
            const cores  = (t.match(/cores_online\s*=\s*([0-9]+)/i) || [])[1];
            const spx    = (t.match(/speedup\s*x100\s*=\s*([0-9]+)/i) || [])[1];
            const sp     = spx ? (parseInt(spx, 10) / 100).toFixed(2) : null;
            const metric = (t.match(/(?:solutions|meals)\s*=\s*[0-9]+/i) || [''])[0];
            rows.push({ name: b.name, one, all, sp, cores, raw: t });
            log('    ' + b.name + ': ' + (cores || '?') + ' cores · ' + metric +
                ' · 1-core=' + (one || '?') + 'ms  ' + (cores || 'N') + '-core=' +
                (all || '?') + 'ms  speedup=' + (sp || '?') + 'x');
          } catch (_e) { log('    ' + b.name + ': bench failed (board needs the /bench reflash?)'); }
        }
        log('BENCH ' + kind + ' done: ' + rows.length + '/' + up.length + ' boards reported.');
      } else {
        log('bench "' + kind + '": unknown kind.');
      }
    }

    node.querySelectorAll('.basic-toolbar')[1].addEventListener('click', (e) => {
      const k = e.target.getAttribute('data-bench');
      if (k) runBench(k);
    });

    node.querySelector('.basic-toolbar').addEventListener('click', (e) => {
      const act = e.target.getAttribute('data-act');
      if (act === 'auto') setAuto(!autoOn);
      else if (act === 'scan') scan();
      else if (act === 'verify') verify();
      else if (act === 'verifybuild') verifyAndBuild();
      else if (act === 'refresh') refreshStatus();
      else if (act === 'form') {
        log('=== Forming mesh on all reachable boards ===');
        boards.forEach((b, k) => { if (b.up) setTimeout(() => joinOne(b), k * 1500); });
      }
      else if (act === 'leaveall') {
        log('=== Leaving mesh on all boards ===');
        boards.forEach((b) => { if (b.up) leaveOne(b); });
      }
      else if (act === 'rebuild') rebuild();
      else if (act === 'swarm') openSwarmControl();
    });

    render();
    setAuto(true);   // start continuously monitoring + auto-joining on open
    xlog('[mesh] Mesh Control Center opened (auto-pilot ON)', 'boot-ok');
  }

  // ---- Drone Swarm Supervisor (P1) ------------------------------------
  // Load-aware actor placement applied to drone control: assigns N drones to
  // mesh Xinu boards using the live perf table (window.__MESH_PERF, published
  // by the Mesh Control Center).  Each drone goes to the board minimising
  // (load+1)/capacity + latency penalty, so the fleet spreads proportionally
  // to each board's parallel compute power while balancing load and latency.
  function openSwarmControl() {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    const inp = 'background:#182236;color:#d8dee9;border:1px solid #2b3650;border-radius:6px;padding:3px 6px;font-family:inherit;font-size:11.5px';
    node.innerHTML =
      '<div class="basic-toolbar">' +
      '<span style="color:#8b949e">drones</span>' +
      '<input class="sw-n" value="12" style="width:44px;' + inp + '">' +
      '<button data-sw="assign">⚙ Assign</button>' +
      '<button data-sw="auto">▶ Auto</button>' +
      '<span style="color:#8b949e" class="sw-info"></span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex:1;min-height:0">' +
      '<table class="proc-table sw-tbl" style="flex:1"><thead><tr>' +
      '<th>XINU</th><th>CAP</th><th>LAT</th><th>DRONES</th><th>IDS</th>' +
      '</tr></thead><tbody></tbody></table>' +
      '<canvas class="sw-topo" width="240" height="220" style="background:#05080e;border:1px solid #2b3650;border-radius:8px;width:240px"></canvas>' +
      '</div>' +
      '<div class="basic-output sw-log" style="max-height:90px;color:#7dcfff;font-size:11px"></div>';
    makeWindow({ title: 'Drone Swarm Supervisor', x: 240, y: 120, w: 690, h: 440, node,
                 onClose: () => { if (timer) clearInterval(timer); } });
    const tbody = node.querySelector('tbody');
    const logEl = node.querySelector('.sw-log');
    const info  = node.querySelector('.sw-info');
    const nI    = node.querySelector('.sw-n');
    const topo  = node.querySelector('.sw-topo');
    const tctx  = topo.getContext('2d');
    let timer = null;

    function log(m) { const d = document.createElement('div'); d.textContent = m; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; }

    // Greedy load-aware placement over the live mesh perf table.
    function assign(nDrones) {
      const perf = window.__MESH_PERF;
      const boards = (perf && perf.nodes) ? perf.nodes.filter((n) => n.kind === 'board') : [];
      if (!boards.length) {
        info.textContent = ' — no mesh boards yet (open Mesh Control Center & form the mesh)';
        return null;
      }
      const load = {}; boards.forEach((b) => { load[b.name] = 0; });
      const map = [];
      for (let d = 0; d < nDrones; d++) {
        let best = null, bs = Infinity;
        for (const b of boards) {
          const cap = b.capacity || b.cores || 1;
          const lat = (b.lat == null) ? 120 : b.lat;
          const s = (load[b.name] + 1) / cap + lat / 1000;     // lower = better target
          if (s < bs) { bs = s; best = b; }
        }
        load[best.name]++; map.push({ drone: d, board: best.name, node: best.node });
      }
      return { boards, load, map };
    }

    function render(a) {
      if (!a) { tbody.innerHTML = ''; drawTopo(null); return; }
      const total = a.map.length;
      tbody.innerHTML = a.boards.map((b) => {
        const cnt = a.load[b.name] || 0;
        const ids = a.map.filter((m) => m.board === b.name).map((m) => 'D' + m.drone);
        const bar = '█'.repeat(Math.round(cnt / Math.max(1, total) * 12));
        return '<tr><td>' + b.name + '</td>' +
          '<td>' + (b.capacity != null ? b.capacity : (b.cores ? b.cores + 'c' : '–')) + '</td>' +
          '<td>' + (b.lat == null ? '–' : b.lat + 'ms') + '</td>' +
          '<td><span class="actor-mark">' + cnt + '</span> <span style="color:#2e6f5e">' + bar + '</span></td>' +
          '<td style="color:#7dcfff;font-size:10px">' + ids.join(' ') + '</td></tr>';
      }).join('');
      info.textContent = ' — ' + total + ' drones → ' + a.boards.length + ' boards';
      drawTopo(a);
    }

    function drawTopo(a) {
      const W = topo.width, H = topo.height, cx = W / 2, cy = H / 2 + 8, R = 70;
      tctx.fillStyle = '#05080e'; tctx.fillRect(0, 0, W, H);
      tctx.fillStyle = '#8b949e'; tctx.font = '11px monospace'; tctx.textAlign = 'left';
      tctx.fillText('SWARM → XINU', 8, 14);
      if (!a || !a.boards.length) { tctx.fillStyle = '#566'; tctx.fillText('(no assignment)', cx - 40, cy); return; }
      const n = a.boards.length, total = a.map.length;
      a.boards.forEach((b, i) => {
        const ang = -Math.PI / 2 + i * 2 * Math.PI / n;
        const x = cx + R * Math.cos(ang), y = cy + R * Math.sin(ang);
        const cnt = a.load[b.name] || 0;
        const rad = 11 + Math.round(cnt / Math.max(1, total) * 22);
        tctx.beginPath(); tctx.arc(x, y, rad, 0, 7);
        tctx.fillStyle = '#11304a'; tctx.fill();
        tctx.strokeStyle = '#7aa2f7'; tctx.lineWidth = 2; tctx.stroke();
        tctx.fillStyle = '#e6edf3'; tctx.font = 'bold 10px monospace'; tctx.textAlign = 'center';
        tctx.fillText(b.name, x, y - 1);
        tctx.fillStyle = '#9ece6a'; tctx.font = '9px monospace';
        tctx.fillText(cnt + ' ▸', x, y + 10);
      });
      tctx.textAlign = 'left'; tctx.fillStyle = '#8b949e'; tctx.font = '9px monospace';
      tctx.fillText(total + ' drones placed (size ∝ load)', 8, H - 6);
    }

    function doAssign() {
      const n = parseInt(nI.value, 10) || 0;
      const a = assign(n);
      if (a) log('placed ' + n + ' drones: ' + a.boards.map((b) => b.name + '=' + (a.load[b.name] || 0)).join('  '));
      render(a);
    }

    node.querySelector('.basic-toolbar').addEventListener('click', (e) => {
      const k = e.target.getAttribute('data-sw');
      if (k === 'assign') doAssign();
      else if (k === 'auto') {
        const btn = e.target;
        if (timer) { clearInterval(timer); timer = null; btn.textContent = '▶ Auto'; btn.style.color = ''; log('auto-reassign OFF'); }
        else { btn.textContent = '⏸ Auto ON'; btn.style.color = '#9ece6a'; log('auto-reassign ON (tracks the live perf table)'); doAssign(); timer = setInterval(doAssign, 5000); }
      }
    });

    doAssign();
    xlog('[swarm] Drone Swarm Supervisor opened', 'boot-ok');
  }

  // Live actor drawing from the host VM: polls /api/lines and renders the
  // line set the running actors emit (cls/line opcodes) inside a Xinu window.
  function openVmGraphics() {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<canvas class="vmg-canvas" width="410" height="320" style="background:#06100a;border:1px solid #2b3650;border-radius:8px;flex:1;width:100%"></canvas>' +
      '<div style="color:#8b949e;font-size:11px">live actor drawing · polls /api/lines (host VM)</div>';
    let alive = true;
    makeWindow({ title: 'VM Graphics', x: 30, y: 300, w: 470, h: 430, node, onClose: () => { alive = false; } });
    const canvas = node.querySelector('.vmg-canvas');
    const ctx = canvas.getContext('2d');
    // wireframe line palette (1-based index), and the 16-colour solid palette
    const PAL = ['#7dcfff', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#7aa2f7', '#ffffff'];
    const PAL16 = ['#000000', '#3060ff', '#30d040', '#30d0d0', '#e03030', '#e040e0', '#e0e040', '#f0f0f0',
                   '#808080', '#80a0ff', '#80ff80', '#80ffff', '#ff8080', '#ff80ff', '#ffff80', '#ffffff'];
    // an actor colour is either a direct 24-bit RGB (bit24 set) or a palette index
    function avmColor(c) {
      if (c & 0x1000000) return 'rgb(' + ((c >> 16) & 0xff) + ',' + ((c >> 8) & 0xff) + ',' + (c & 0xff) + ')';
      return PAL16[c & 15];
    }
    let lastSig = '';
    (function frame() {
      if (!alive) return;
      fetch('/api/lines').then((r) => r.json()).then((d) => {
        const tris = d.tris || [], lines = d.lines || [];
        // a static mesh is large; only repaint when the scene actually changes
        const sig = lines.length + '/' + tris.length + (tris.length ? '/' + tris[0].join(',') : '');
        if (sig === lastSig) return;
        lastSig = sig;
        const W = canvas.width, H = canvas.height;
        const sx = W / (d.w || 820), sy = H / (d.h || 640);
        ctx.fillStyle = '#06100a'; ctx.fillRect(0, 0, W, H);
        // filled+shaded triangles first (server sends them back-to-front)
        for (let i = 0; i < tris.length; i++) {
          const t = tris[i];
          ctx.fillStyle = avmColor(t[6]);
          ctx.beginPath();
          ctx.moveTo(t[0] * sx, t[1] * sy); ctx.lineTo(t[2] * sx, t[3] * sy); ctx.lineTo(t[4] * sx, t[5] * sy);
          ctx.closePath(); ctx.fill();
        }
        // wireframe lines on top
        ctx.lineWidth = 1.5;
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          ctx.strokeStyle = PAL[(((ln[4] || 1) - 1) % PAL.length + PAL.length) % PAL.length];
          ctx.beginPath(); ctx.moveTo(ln[0] * sx, ln[1] * sy); ctx.lineTo(ln[2] * sx, ln[3] * sy); ctx.stroke();
        }
      }).catch(() => {}).finally(() => { if (alive) setTimeout(frame, 120); });
    })();
    xlog('[3d] VM Graphics window opened (polling /api/lines)', 'boot-info');
  }

  // Console + tiny shell
  // ---- in-memory hierarchical filesystem (shared across all shells) ----
  // A tiny Unix-like VFS. Nodes are { type:'dir', children:{name:node} } or
  // { type:'file', data:string }. Every xsh shell shares this one tree but
  // keeps its own current-working-directory, so `mkdir` in one shell is
  // visible from another.
  const fsRoot = { type: 'dir', children: {} };

  function fsSeed() {
    function mkdir(parts) {
      let node = fsRoot;
      for (const name of parts) {
        if (!node.children[name]) node.children[name] = { type: 'dir', children: {} };
        node = node.children[name];
      }
      return node;
    }
    function mkfile(dirParts, name, data) { mkdir(dirParts).children[name] = { type: 'file', data }; }
    // An .avm module carries an `avm` descriptor telling the avm Finder how to
    // run/display it (kind:'mesh' → 3D Display, kind:'actor' → Actor Loader).
    function mkavm(dirParts, name, avm, data) {
      mkdir(dirParts).children[name] = { type: 'file', avm, data: data || '' };
    }
    mkfile(['home', 'xinu'], 'readme.txt',
      'Welcome to the Xinu/AIPL host VM (aice-avm).\n' +
      'This is an in-memory hierarchical filesystem.\n' +
      'Try: ls, pwd, cd, cat, mkdir, touch, rm, echo, tree.\n');
    mkfile(['home', 'xinu'], 'hello.bas',
      '10 PRINT "HELLO FROM XINU BASIC"\n20 FOR I=1 TO 5\n30 PRINT I\n40 NEXT I\n');
    mkdir(['home', 'xinu', 'projects']);
    mkfile(['etc'], 'motd', 'Xinu/AIPL host VM — actors over HTTP, no recompile.\n');
    mkfile(['etc'], 'version', 'aice-avm host VM\nbrowser desktop simulator\n');
    mkfile(['actors'], 'PingPong.abcl',
      'class Main {\n  method tick() { send new Ping().go(3); }\n}\n');
    // MAKINA-7.avm — the real 3D-mesh character baked into a self-contained
    // ACTOR .avm (true payload = the /avm/MakinaActor.avm asset). Runs on the
    // host VM, streaming 10500 true-colour (0x01RRGGBB) triangles to the op_tri
    // display. Because its real bytes live in a server asset, `cp` copies that
    // binary faithfully — the on-disk file stays a runnable, full-colour 3D .avm
    // (see runvm.html), not a text stub.
    mkavm(['home', 'xinu'], 'MAKINA-7.avm',
      { kind: 'actor', src: '/avm/MakinaActor.avm', title: 'MAKINA-7' },
      'AVM actor module: MAKINA-7 (real 3D mesh, 10500 true-colour triangles).\n' +
      'Double-click to load into the host VM — renders live in colour in the VM\n' +
      'Graphics window. cp it to /computer to get the real .avm binary on disk,\n' +
      'then run it from the "run an .avm file" page for the same colour 3D view.\n');
    // The real MAKINA-7 character baked into an ACTOR .avm: 3 actors
    // (Main/Makina/Display) stream 10500 solid triangles to the host VM's
    // op_tri "Blender display", shown live in the VM Graphics window.
    mkavm(['home', 'xinu'], 'MakinaActor.avm',
      { kind: 'actor', src: '/avm/MakinaActor.avm', title: 'MAKINA-7 (actor)' },
      'AVM actor module: MAKINA-7 (real mesh, 10500 tris).\n' +
      'Main spawns Makina + Display; Makina streams triangles to the Display\n' +
      'actor, which drives the kernel op_tri Blender display. Double-click to\n' +
      'load it into the host VM — it renders live in the VM Graphics window.\n');
    mkdir(['dev']);
    mkfile(['dev'], 'console', '(the live VM console — see the Xinu Console window)\n');
    mkdir(['tmp']);
    // /computer is a mount onto the REAL host machine's filesystem (read-write),
    // served by the receiver's /api/host/* routes. `ls /computer` lists the
    // actual root directory of the machine running the host VM; cp/echo>/touch/
    // mkdir/rm under it mutate the real machine.
    mkdir(['computer']).mount = 'host';
  }
  fsSeed();

  // ---- real host filesystem, mounted at /computer (read-write) ----------
  // Any resolved path whose first component is 'computer' is backed by the
  // host machine, not the in-memory VFS. hostPathOf(['computer','Users']) -> '/Users'.
  function isHostParts(parts) { return parts[0] === 'computer'; }
  function hostPathOf(parts) { return '/' + parts.slice(1).join('/'); }
  function hostLs(parts) {
    return fetch('/api/host/ls?path=' + encodeURIComponent(hostPathOf(parts)))
      .then((r) => r.json());
  }
  // /computer is read-write: these back cp, echo>, touch, mkdir and rm on the
  // real host machine via the receiver's /api/host/* mutation routes.
  function hostCat(parts) {
    return fetch('/api/host/cat?path=' + encodeURIComponent(hostPathOf(parts))).then((r) => r.text());
  }
  function hostWrite(parts, data) {
    return fetch('/api/host/write?path=' + encodeURIComponent(hostPathOf(parts)),
      { method: 'POST', body: data }).then((r) => r.json());
  }
  function hostMkdir(parts) {
    return fetch('/api/host/mkdir?path=' + encodeURIComponent(hostPathOf(parts))).then((r) => r.json());
  }
  function hostRm(parts, rec) {
    return fetch('/api/host/rm?path=' + encodeURIComponent(hostPathOf(parts)) + (rec ? '&r=1' : ''))
      .then((r) => r.json());
  }
  function hostCp(srcParts, dstParts, rec) {
    return fetch('/api/host/cp?src=' + encodeURIComponent(hostPathOf(srcParts)) +
      '&dst=' + encodeURIComponent(hostPathOf(dstParts)) + (rec ? '&r=1' : '')).then((r) => r.json());
  }
  // Resolve the real bytes of a VFS file node for copying OUT to the host FS.
  // A .avm module's real payload lives as a server asset (its avm.src), not in
  // the node's `data` (which is only a human-readable note) — so a faithful cp
  // must fetch those bytes. Returns a promise of a string or ArrayBuffer body.
  function vfsFileBytes(node) {
    if (node.avm && node.avm.src) {
      return fetch(node.avm.src).then((r) => r.arrayBuffer());
    }
    return Promise.resolve(node.data || '');
  }
  // Deep-copy an in-memory VFS node (for cp of a VFS subtree). Preserves the
  // `avm` descriptor so an .avm copied within the VFS keeps its type/payload.
  function deepCopyNode(n) {
    if (n.type === 'dir') {
      const c = {};
      for (const k in n.children) c[k] = deepCopyNode(n.children[k]);
      return { type: 'dir', children: c };
    }
    const f = { type: 'file', data: n.data || '' };
    if (n.avm) f.avm = n.avm;
    return f;
  }
  // Resolve a cp destination: if it is an existing directory, copy INTO it
  // under the source's basename (real cp semantics). Returns a promise of parts.
  function cpResolveDst(dstParts, srcBase, dstHost) {
    if (dstHost) {
      return hostLs(dstParts).then((d) => (d && d.type === 'dir') ? dstParts.concat([srcBase]) : dstParts)
        .catch(() => dstParts);
    }
    const node = fsLookup(dstParts);
    return Promise.resolve((node && node.type === 'dir') ? dstParts.concat([srcBase]) : dstParts);
  }

  // Resolve a path (absolute or relative to cwd) to an array of name parts,
  // collapsing '.' and '..'. cwd is an absolute path string like '/home/xinu'.
  function fsResolveParts(cwd, path) {
    const base = path.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
    const stack = base.slice();
    for (const p of path.split('/').filter(Boolean)) {
      if (p === '.') continue;
      else if (p === '..') stack.pop();
      else stack.push(p);
    }
    return stack;
  }
  function fsPartsToPath(parts) { return '/' + parts.join('/'); }
  function fsLookup(parts) {
    let node = fsRoot;
    for (const name of parts) {
      if (node.type !== 'dir') return null;
      node = node.children[name];
      if (!node) return null;
    }
    return node;
  }
  function fsParentAndName(parts) {
    return { parent: fsLookup(parts.slice(0, -1)), name: parts[parts.length - 1] };
  }
  function stripQuotes(s) {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  }

  function openConsole(info, opts) {
    // primary = the desktop's main console (streams boot log, owns window.__xinuLog).
    // Extra shells spawned from the desktop menu pass { primary:false } and get
    // their own independent xsh prompt without hijacking the global log sink.
    const primary = !(opts && opts.primary === false);
    const node = document.createElement('div');
    node.innerHTML = '<div class="con-out"></div>';
    const out = node.querySelector('.con-out');
    const { win, body } = makeWindow({ title: (opts && opts.title) || 'Xinu Console',
      x: (opts && opts.x != null) ? opts.x : 30,
      y: (opts && opts.y != null) ? opts.y : 24,
      w: 440, h: 260, node });
    // The console may open behind other windows, and makeWindow only raises a
    // window (z-index) on mousedown without focusing anything inside it — so a
    // click on the console would leave the shell input unfocused/uncovered by a
    // window on top. Raise-and-focus the shell input on any click here.
    win.addEventListener('mousedown', () => {
      const inp = out.querySelector('.con-input input');
      if (inp) setTimeout(() => inp.focus(), 0);
    });

    const bootLines = primary ? (info.bootLog || [
      'Xinu booting on arm-rpi3 (BCM2837, cortex-a53)...',
      'memory: heap 0x00400000 - 0x3F000000',
      'sysinit: 50 processes, 100 semaphores',
      'clkinit: timer @ 1000 Hz',
      'usbinit: keyboard, mouse attached',
      'wm: window manager started',
      'shell: ready',
    ]) : [
      'xsh: new interactive shell (build ' + (info.build || 'web') + ')',
      'shell: ready — type help',
    ];
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
    // Only the primary console owns this global sink; extra shells stay local.
    if (primary) window.__xinuLog = (t, cls) => println(t, cls);

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

    // Each shell keeps its own current directory into the shared VFS.
    let cwd = fsLookup(['home', 'xinu']) ? '/home/xinu' : '/';
    function ps1() { return 'xsh:' + cwd + '$'; }

    function addPrompt() {
      const line = document.createElement('div');
      line.className = 'con-input';
      line.innerHTML = '<span class="ps1"></span><input type="text" autocomplete="off" spellcheck="false">';
      line.querySelector('.ps1').textContent = ps1();
      out.appendChild(line);
      const input = line.querySelector('input');
      input.focus();
      body.scrollTop = body.scrollHeight;
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const cmd = input.value.trim();
        input.parentElement.innerHTML = '<span class="ps1">' + escapeHtml(ps1()) + '</span> ' + escapeHtml(cmd);
        // runCmd may return a promise for host-FS (/computer) commands; wait for
        // it so its output prints above the next prompt.
        Promise.resolve(runCmd(cmd)).catch(() => {}).then(addPrompt);
      });
    }

    function runCmd(cmd) {
      const a = cmd.split(/\s+/);
      const c = (a[0] || '').toLowerCase();
      if (!c) return;
      switch (c) {
        case 'help':
          println('files: ls pwd cd cat cp mkdir touch rm echo tree');
          println('host:  ls /computer  — browse the real machine filesystem (read-write)');
          println('system: help ver ps clear date basic avm loadvm blender rpi3 rpi4 rpi5 mesh about');
          break;
        case 'ver': println('Xinu (browser sim) — AIPL/AICE edition, build ' + (info.build || 'web')); break;
        case 'about': println('Embedded Xinu desktop simulator. Multi-window WM + BASIC.'); break;
        case 'ps':
          PROCS.concat(actorProcs).forEach((p) =>
            println('  ' + pad(p.pid, 4) + pad(p.name, 14) + pad(p.actor ? '[actor]' : 'sys', 9) + p.state,
              p.actor ? 'boot-ok' : ''));
          break;
        case 'date': println(new Date().toString()); break;
        case 'clear': out.querySelectorAll('.con-line').forEach((n) => n.remove()); break;

        // ---- filesystem commands ----
        case 'pwd': println(cwd); break;

        case 'ls': {
          const targ = a[1] || '.';
          const parts = fsResolveParts(cwd, targ);
          if (isHostParts(parts)) {
            return hostLs(parts).then((d) => {
              if (d.error) { println('ls: ' + targ + ': ' + d.error, 'boot-warn'); return; }
              if (d.type === 'file') { println(targ); return; }
              (d.entries || []).forEach((e) =>
                println(e.type === 'dir' ? e.name + '/' : e.name, e.type === 'dir' ? 'boot-info' : ''));
            }).catch(() => println('ls: ' + targ + ': host unreachable', 'boot-warn'));
          }
          const node = fsLookup(parts);
          if (!node) { println('ls: ' + targ + ': No such file or directory', 'boot-warn'); break; }
          if (node.type === 'file') { println(targ); break; }
          const names = Object.keys(node.children).sort();
          if (!names.length) break;
          names.forEach((n) => {
            const child = node.children[n];
            println(child.type === 'dir' ? n + '/' : n, child.type === 'dir' ? 'boot-info' : '');
          });
          break;
        }

        case 'cd': {
          const targ = a[1] || '/home/xinu';
          const parts = fsResolveParts(cwd, targ);
          if (isHostParts(parts)) {
            return hostLs(parts).then((d) => {
              if (d.error) { println('cd: ' + targ + ': ' + d.error, 'boot-warn'); return; }
              if (d.type !== 'dir') { println('cd: ' + targ + ': Not a directory', 'boot-warn'); return; }
              cwd = fsPartsToPath(parts);
            }).catch(() => println('cd: ' + targ + ': host unreachable', 'boot-warn'));
          }
          const node = fsLookup(parts);
          if (!node) { println('cd: ' + targ + ': No such file or directory', 'boot-warn'); break; }
          if (node.type !== 'dir') { println('cd: ' + targ + ': Not a directory', 'boot-warn'); break; }
          cwd = fsPartsToPath(parts);
          break;
        }

        case 'cat': {
          if (!a[1]) { println('usage: cat <file>'); break; }
          const parts = fsResolveParts(cwd, a[1]);
          if (isHostParts(parts)) {
            return fetch('/api/host/cat?path=' + encodeURIComponent(hostPathOf(parts)))
              .then((r) => r.text())
              .then((t) => { t.replace(/\n$/, '').split('\n').forEach((ln) => println(ln)); })
              .catch(() => println('cat: ' + a[1] + ': host unreachable', 'boot-warn'));
          }
          const node = fsLookup(parts);
          if (!node) { println('cat: ' + a[1] + ': No such file or directory', 'boot-warn'); break; }
          if (node.type === 'dir') { println('cat: ' + a[1] + ': Is a directory', 'boot-warn'); break; }
          const text = node.data || '';
          if (text !== '') text.replace(/\n$/, '').split('\n').forEach((ln) => println(ln));
          break;
        }

        case 'cp': {
          let rec = false, args = a.slice(1);
          if (args[0] === '-r' || args[0] === '-R' || args[0] === '-rf') { rec = true; args = args.slice(1); }
          if (args.length < 2) { println('usage: cp [-r] <src> <dst>'); break; }
          const srcParts = fsResolveParts(cwd, args[0]);
          const dstParts = fsResolveParts(cwd, args[1]);
          const srcHost = isHostParts(srcParts), dstHost = isHostParts(dstParts);
          const srcBase = srcParts[srcParts.length - 1] || '';

          // host -> host: server-side copy (handles dir-dst and -r itself).
          if (srcHost && dstHost) {
            return hostCp(srcParts, dstParts, rec)
              .then((d) => { if (d.error) println('cp: ' + d.error, 'boot-warn'); })
              .catch(() => println('cp: host unreachable', 'boot-warn'));
          }

          // vfs -> host: write the file's REAL bytes to the machine. For a .avm
          // module that means its server-asset payload (avm.src), so the on-disk
          // file is the true binary — not the descriptor's text note.
          if (!srcHost && dstHost) {
            const node = fsLookup(srcParts);
            if (!node) { println('cp: ' + args[0] + ': No such file or directory', 'boot-warn'); break; }
            if (node.type === 'dir') {
              println('cp: ' + args[0] + ': recursive copy into /computer not supported', 'boot-warn'); break;
            }
            return cpResolveDst(dstParts, srcBase, true).then((fin) =>
              vfsFileBytes(node).then((body) =>
                hostWrite(fin, body).then((d) => { if (d.error) println('cp: ' + d.error, 'boot-warn'); })))
              .catch(() => println('cp: host unreachable', 'boot-warn'));
          }

          // host -> vfs: read the machine file into a new in-memory file.
          if (srcHost && !dstHost) {
            return hostLs(srcParts).then((info) => {
              if (info.error) { println('cp: ' + args[0] + ': ' + info.error, 'boot-warn'); return; }
              if (info.type === 'dir') {
                println('cp: ' + args[0] + ': recursive copy from /computer not supported', 'boot-warn'); return;
              }
              return hostCat(srcParts).then((t) => cpResolveDst(dstParts, srcBase, false).then((fin) => {
                const { parent, name } = fsParentAndName(fin);
                if (!parent || parent.type !== 'dir') { println('cp: ' + args[1] + ': No such file or directory', 'boot-warn'); return; }
                parent.children[name] = { type: 'file', data: t };
              }));
            }).catch(() => println('cp: ' + args[0] + ': host unreachable', 'boot-warn'));
          }

          // vfs -> vfs: pure in-memory copy.
          const node = fsLookup(srcParts);
          if (!node) { println('cp: ' + args[0] + ': No such file or directory', 'boot-warn'); break; }
          if (node.type === 'dir' && !rec) { println('cp: ' + args[0] + ': is a directory (use -r)', 'boot-warn'); break; }
          return cpResolveDst(dstParts, srcBase, false).then((fin) => {
            const { parent, name } = fsParentAndName(fin);
            if (!parent || parent.type !== 'dir') { println('cp: ' + args[1] + ': No such file or directory', 'boot-warn'); return; }
            parent.children[name] = (node.type === 'dir') ? deepCopyNode(node)
              : (function () { const f = { type: 'file', data: node.data || '' }; if (node.avm) f.avm = node.avm; return f; })();
          });
        }

        case 'mkdir': {
          if (!a[1]) { println('usage: mkdir <dir>'); break; }
          {
            const hp = fsResolveParts(cwd, a[1]);
            if (isHostParts(hp)) {
              return hostMkdir(hp).then((d) => { if (d.error) println('mkdir: ' + d.error, 'boot-warn'); })
                .catch(() => println('mkdir: host unreachable', 'boot-warn'));
            }
          }
          const { parent, name } = fsParentAndName(fsResolveParts(cwd, a[1]));
          if (!parent || parent.type !== 'dir') { println('mkdir: ' + a[1] + ': No such file or directory', 'boot-warn'); break; }
          if (parent.children[name]) { println('mkdir: ' + a[1] + ': File exists', 'boot-warn'); break; }
          parent.children[name] = { type: 'dir', children: {} };
          break;
        }

        case 'touch': {
          if (!a[1]) { println('usage: touch <file>'); break; }
          {
            const hp = fsResolveParts(cwd, a[1]);
            if (isHostParts(hp)) {
              return hostLs(hp).then((d) => {
                if (d && !d.error) return; // exists — leave contents intact
                return hostWrite(hp, '').then((w) => { if (w.error) println('touch: ' + w.error, 'boot-warn'); });
              }).catch(() => println('touch: host unreachable', 'boot-warn'));
            }
          }
          const { parent, name } = fsParentAndName(fsResolveParts(cwd, a[1]));
          if (!parent || parent.type !== 'dir') { println('touch: ' + a[1] + ': No such file or directory', 'boot-warn'); break; }
          if (!parent.children[name]) parent.children[name] = { type: 'file', data: '' };
          break;
        }

        case 'rm': {
          let rec = false, targ = a[1];
          if (a[1] === '-r' || a[1] === '-rf' || a[1] === '-R') { rec = true; targ = a[2]; }
          if (!targ) { println('usage: rm [-r] <path>'); break; }
          const parts = fsResolveParts(cwd, targ);
          if (isHostParts(parts)) {
            if (parts.length <= 1) { println('rm: refusing to remove /computer root', 'boot-warn'); break; }
            return hostRm(parts, rec).then((d) => { if (d.error) println('rm: ' + d.error, 'boot-warn'); })
              .catch(() => println('rm: host unreachable', 'boot-warn'));
          }
          if (!parts.length) { println('rm: cannot remove /', 'boot-warn'); break; }
          const node = fsLookup(parts);
          if (!node) { println('rm: ' + targ + ': No such file or directory', 'boot-warn'); break; }
          if (node.type === 'dir' && !rec) { println('rm: ' + targ + ': is a directory (use -r)', 'boot-warn'); break; }
          const { parent, name } = fsParentAndName(parts);
          delete parent.children[name];
          break;
        }

        case 'echo': {
          const rest = cmd.slice(4).replace(/^\s+/, '');
          const m = rest.match(/^(.*?)\s*(>>|>)\s*(\S+)\s*$/);
          if (!m) { println(stripQuotes(rest)); break; }
          {
            const hp = fsResolveParts(cwd, m[3]);
            if (isHostParts(hp)) {
              const content = stripQuotes(m[1]) + '\n';
              if (m[2] === '>>') {
                return hostCat(hp).then((prev) => {
                  const base = (prev && prev.indexOf('cat: ') === 0) ? '' : prev;
                  return hostWrite(hp, base + content);
                }).then((w) => { if (w && w.error) println('echo: ' + w.error, 'boot-warn'); })
                  .catch(() => println('echo: host unreachable', 'boot-warn'));
              }
              return hostWrite(hp, content).then((w) => { if (w.error) println('echo: ' + w.error, 'boot-warn'); })
                .catch(() => println('echo: host unreachable', 'boot-warn'));
            }
          }
          const { parent, name } = fsParentAndName(fsResolveParts(cwd, m[3]));
          if (!parent || parent.type !== 'dir') { println('echo: ' + m[3] + ': No such file or directory', 'boot-warn'); break; }
          let f = parent.children[name];
          if (!f || f.type !== 'file') f = parent.children[name] = { type: 'file', data: '' };
          f.data = (m[2] === '>>' ? (f.data || '') : '') + stripQuotes(m[1]) + '\n';
          break;
        }

        case 'tree': {
          const parts = fsResolveParts(cwd, a[1] || '.');
          if (isHostParts(parts)) { println('tree: not supported under /computer — use ls', 'boot-warn'); break; }
          const node = fsLookup(parts);
          if (!node) { println('tree: ' + (a[1] || '.') + ': No such file or directory', 'boot-warn'); break; }
          println(fsPartsToPath(parts) || '/', 'boot-info');
          if (node.type === 'dir') (function walk(n, prefix) {
            const names = Object.keys(n.children).sort();
            names.forEach((nm, i) => {
              const last = i === names.length - 1;
              const child = n.children[nm];
              println(prefix + (last ? '└── ' : '├── ') + nm + (child.type === 'dir' ? '/' : ''),
                child.type === 'dir' ? 'boot-info' : '');
              if (child.type === 'dir') walk(child, prefix + (last ? '    ' : '│   '));
            });
          })(node, '');
          break;
        }
        case 'basic': openBasic(); println('[wm] focused BASIC window'); break;
        case 'avm': case 'finder': openAvmFinder(); println('[wm] opened avm Finder'); break;
        case 'loadvm': openLoader(); println('[wm] opened Actor Loader'); break;
        case 'blender': case 'display': openDisplay(); println('[wm] opened 3D Display'); break;
        case 'graphics': case 'lines': openVmGraphics(); println('[wm] opened VM Graphics'); break;
        case 'rpi3': openPiScreen({ title: 'rpi3 Screen (HDMI)', host: '192.168.3.50:8080', x: 30, y: 330, res: 96, ival: 10000 }); println('[wm] opened rpi3 Screen'); break;
        case 'rpi4': case 'screen': openPiScreen({ title: 'rpi4 Screen (HDMI)', host: '192.168.3.100', x: 360, y: 300 }); println('[wm] opened rpi4 Screen'); break;
        case 'rpi5': openPiScreen({ title: 'rpi5 Screen (HDMI)', host: '192.168.3.101', x: 720, y: 300 }); println('[wm] opened rpi5 Screen'); break;
        case 'mesh': case 'meshctl': openMeshControl(); println('[wm] opened Mesh Control Center'); break;
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

  function openBasic(opts) {
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

    const { body } = makeWindow({ title: 'BASIC',
      x: (opts && opts.x != null) ? opts.x : 120,
      y: (opts && opts.y != null) ? opts.y : 150,
      w: 560, h: 330, node, onClose: () => { try { basic.stop(); } catch (_e) {} } });
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

  // ---- AVM 受信箱 (Inbox): modules received from other machines ----------
  // The unified reception point: every .avm pushed to this receiver's
  // POST /actor/loadvm (the `send` tool, a Pi board, another aice-avm) is
  // recorded by the server and listed here. Each item can be re-run on the host
  // VM, disassembled back to a bytecode listing, or saved to the host FS.
  function openInbox(opts) {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<div class="basic-toolbar">' +
      '<span style="color:#8b949e">他マシンから送信された .avm の受信箱</span>' +
      '<span style="flex:1"></span>' +
      '<label style="color:#8b949e;font-size:11px"><input type="checkbox" class="ib-auto" checked> 自動更新</label>' +
      '<button data-act="refresh">🔄 更新</button>' +
      '</div>' +
      '<div class="ib-list" style="flex:1;overflow:auto;font-size:12px"></div>' +
      '<div class="basic-output ib-out" style="max-height:120px;color:#7dcfff;white-space:pre-wrap"></div>';
    const { win } = makeWindow({ title: 'AVM 受信箱 (Inbox)', x: (opts && opts.x) || 120, y: (opts && opts.y) || 90,
      w: 560, h: 420, node, onClose: () => { alive = false; } });
    const listEl = node.querySelector('.ib-list');
    const outEl = node.querySelector('.ib-out');
    const autoEl = node.querySelector('.ib-auto');
    let alive = true;
    function ibout(t) { outEl.textContent = t; }

    function fmtSize(n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' K';
      return (n / 1048576).toFixed(1) + ' M';
    }
    function fmtTime(ts) { try { return new Date(ts * 1000).toLocaleTimeString(); } catch (_e) { return ''; } }

    async function run(id) {
      ibout('running #' + id + ' …');
      try { const d = await (await fetch('/api/inbox/run?id=' + id)).json();
        ibout(d.error ? ('run: ' + d.error) : ('▶ ran #' + id + ' → actor id=' + d.actor + '（VM Graphics に表示）'));
        openVmGraphics();
      } catch (_e) { ibout('run: host unreachable'); }
    }
    async function disasm(id, name) {
      ibout('disassembling #' + id + ' …');
      try {
        const t = await (await fetch('/api/inbox/disasm?id=' + id)).text();
        ibout('');
        openTextWindow('逆アセンブル — ' + (name || ('#' + id)), t);
      } catch (_e) { ibout('disasm: host unreachable'); }
    }
    async function save(id, name) {
      const p = prompt('保存先（ホストの絶対パス）:', '/Users/' + (name || ('inbox-' + id + '.avm')));
      if (!p) return;
      ibout('saving #' + id + ' → ' + p + ' …');
      try { const d = await (await fetch('/api/inbox/save?id=' + id + '&path=' + encodeURIComponent(p))).json();
        ibout(d.error ? ('save: ' + d.error) : ('💾 saved ' + d.bytes + ' B → ' + d.path));
      } catch (_e) { ibout('save: host unreachable'); }
    }

    async function refresh() {
      let items;
      try { items = await (await fetch('/api/inbox')).json(); }
      catch (_e) { listEl.innerHTML = '<div style="color:#f0a0a0;padding:8px">host unreachable</div>'; return; }
      if (!items.length) {
        listEl.innerHTML = '<div style="color:#8b949e;padding:10px">まだ受信はありません。\n他マシンから  send <host>:8080 file.avm  で送信すると、ここに表示されます。</div>';
        return;
      }
      listEl.innerHTML = '';
      items.forEach((e) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 8px;border-bottom:1px solid #1c2740';
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0';
        info.innerHTML = '<div style="color:#9ece6a;font-weight:600;overflow:hidden;text-overflow:ellipsis">' +
          escapeHtml(e.name) + (e.ran ? ' <span style="color:#7aa2f7;font-weight:400">· 実行済</span>' : '') + '</div>' +
          '<div style="color:#8b949e;font-size:11px">#' + e.id + ' · from ' + escapeHtml(e.from) +
          ' · ' + fmtSize(e.size) + ' · ' + fmtTime(e.ts) + '</div>';
        row.appendChild(info);
        [['▶ 実行', () => run(e.id)], ['&lt;/&gt; ソース', () => disasm(e.id, e.name)], ['💾 保存', () => save(e.id, e.name)]]
          .forEach(([label, fn]) => {
            const b = document.createElement('button');
            b.innerHTML = label; b.style.cssText = 'font-size:11px;padding:4px 8px';
            b.addEventListener('click', fn); row.appendChild(b);
          });
        listEl.appendChild(row);
      });
    }
    node.querySelector('[data-act=refresh]').addEventListener('click', refresh);
    refresh();
    (function poll() {
      if (!alive) return;
      if (autoEl.checked) refresh();
      setTimeout(poll, 1500);
    })();
    xlog('[inbox] AVM 受信箱を開きました（POST /actor/loadvm の受信を一覧）', 'boot-info');
    return win;
  }

  // A simple scrollable text window (used for disassembly output).
  function openTextWindow(title, text) {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText = 'margin:0;flex:1;overflow:auto;white-space:pre;font:12px/1.45 ui-monospace,monospace;color:#b8d4c0;padding:8px';
    node.appendChild(pre);
    makeWindow({ title, x: 200, y: 130, w: 620, h: 460, node });
  }

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

  function openDisplay(opts) {
    const startMesh = (opts && opts.mesh && MESHES[opts.mesh]) ? opts.mesh : 'MAKINA';
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
    const title = (opts && opts.title) ? opts.title + ' — 3D Display' : '3D Display (Blender)';
    makeWindow({ title, x: (opts && opts.x != null) ? opts.x : 700, y: (opts && opts.y != null) ? opts.y : 30,
      w: 330, h: 330, node, onClose: () => { alive = false; } });
    const canvas = node.querySelector('.d-canvas');
    const ctx = canvas.getContext('2d');
    let solid = true, spin = true, ay = 0.6, ax = -0.35;
    let mesh = MESHES[startMesh]();

    const meshSel = node.querySelector('.d-mesh');
    meshSel.value = startMesh;
    meshSel.addEventListener('change', (e) => { mesh = MESHES[e.target.value](); xlog('[3d] loaded mesh ' + mesh.name, 'boot-info'); });
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

  // ---- avm Finder ------------------------------------------------------
  // A file-manager window that scans the VFS for ".avm" modules and shows them
  // as icons. Double-click (or select + Open) runs the module: a mesh module
  // opens the 3D Display showing it; anything else is handed to the Actor Loader.
  function runAvmFile(f) {
    const d = f.node.avm;
    xlog('[avm] launching ' + f.path + ' …', 'boot-info');
    if (d && d.kind === 'mesh') {
      openDisplay({ mesh: d.mesh || 'MAKINA', title: d.title || f.name.replace(/\.avm$/i, '') });
      xlog('[avm] ' + (d.title || f.name) + ' → 3D Display', 'boot-ok');
    } else if (d && d.kind === 'actor' && d.src) {
      // Ship the actor .avm to the host VM; its actors stream tris to the
      // op_tri "Blender display", which the VM Graphics window renders live.
      openVmGraphics();
      xlog('[avm] loading ' + f.name + ' into the host VM …', 'boot-info');
      (async () => {
        try {
          const bytes = await (await fetch(d.src, { cache: 'no-store' })).arrayBuffer();
          const r = await fetch('/actor/loadvm?noask=1', { method: 'POST', body: bytes });
          xlog('[avm] host VM: ' + (await r.text()).trim(), 'boot-ok');
          xlog('[avm] ' + (d.title || f.name) + ' streaming to VM Graphics (Blender display)', 'boot-ok');
        } catch (e) { xlog('[avm] load failed: ' + e, 'boot-warn'); }
      })();
    } else {
      openLoader();
      xlog('[avm] ' + f.name + ' → Actor Loader (no display descriptor)', 'boot-info');
    }
  }

  function openAvmFinder(opts) {
    const node = document.createElement('div');
    node.className = 'basic-wrap';
    node.innerHTML =
      '<div class="basic-toolbar">' +
      '<button data-act="refresh">⟳ Refresh</button>' +
      '<button data-act="run">▶ Open</button>' +
      '<span style="color:#8b949e" class="avf-info"></span>' +
      '</div>' +
      '<div class="avf-grid" style="flex:1;overflow:auto;display:flex;flex-wrap:wrap;align-content:flex-start;' +
      'gap:8px;padding:8px;background:#0b1220;border:1px solid #2b3650;border-radius:8px"></div>' +
      '<div style="color:#8b949e;font-size:11px">double-click an .avm to run &amp; display it</div>';
    makeWindow({ title: 'avm Finder',
      x: (opts && opts.x != null) ? opts.x : 180, y: (opts && opts.y != null) ? opts.y : 90,
      w: 460, h: 300, node });
    const grid = node.querySelector('.avf-grid');
    const info = node.querySelector('.avf-info');
    let selected = null;

    // Recursively collect every *.avm file in the shared VFS.
    function collect() {
      const out = [];
      (function walk(n, path) {
        if (n.type !== 'dir') return;
        Object.keys(n.children).sort().forEach((nm) => {
          const child = n.children[nm];
          const p = (path === '/' ? '' : path) + '/' + nm;
          if (child.type === 'dir') walk(child, p);
          else if (nm.toLowerCase().endsWith('.avm')) out.push({ path: p, name: nm, node: child });
        });
      })(fsRoot, '/');
      return out;
    }

    function render() {
      const files = collect();
      grid.innerHTML = '';
      selected = null;
      info.textContent = ' — ' + files.length + ' .avm file' + (files.length === 1 ? '' : 's');
      if (!files.length) {
        grid.innerHTML = '<div style="color:#566;padding:12px">no .avm files found in the filesystem</div>';
        return;
      }
      files.forEach((f) => {
        const kind = f.node.avm && f.node.avm.kind;
        const icon = kind === 'mesh' ? '🧊' : kind === 'actor' ? '🤖' : '📦';
        const el = document.createElement('div');
        el.className = 'avf-item';
        el.title = f.path;
        el.style.cssText = 'width:88px;text-align:center;cursor:pointer;border-radius:8px;padding:8px 4px';
        el.innerHTML =
          '<div style="font-size:34px;line-height:1">' + icon + '</div>' +
          '<div style="font-size:11px;color:#d8dee9;word-break:break-all;margin-top:3px">' + escapeHtml(f.name) + '</div>' +
          '<div style="font-size:9px;color:#566;word-break:break-all">' + escapeHtml(f.path) + '</div>';
        el.addEventListener('click', () => {
          selected = f;
          grid.querySelectorAll('.avf-item').forEach((x) => { x.style.background = ''; });
          el.style.background = '#1b2942';
        });
        el.addEventListener('dblclick', () => runAvmFile(f));
        grid.appendChild(el);
      });
    }

    node.querySelector('.basic-toolbar').addEventListener('click', (e) => {
      const act = e.target.getAttribute('data-act');
      if (act === 'refresh') render();
      else if (act === 'run') {
        if (selected) runAvmFile(selected);
        else info.textContent = ' — select a file first, then Open (or double-click it)';
      }
    });

    render();
    xlog('[wm] avm Finder opened (' + collect().length + ' .avm files)', 'boot-ok');
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
