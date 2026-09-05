(* server.ml — AICE/AIPL dynamic-actor receiver with a live graphics window.
   Listens for HTTP POSTs of .avm actor modules and runs them on the host VM
   (avm.ml) WITHOUT a recompile — the Windows/host counterpart of the Xinu
   kernel's webactor + VM.

   The actors' graphics (line/cls) are shown in a *dynamically created* window:
   on the first draw the receiver opens the system browser at http://localhost:
   PORT/, an HTML5 canvas that polls the live line set and animates it. This
   works natively on Windows, in WSL, and on macOS/Linux (no GUI toolkit, no
   extra DLLs). print() output goes to the console.

   Endpoints:
     POST /actor/loadvm        body = a .avm module; spawns + runs it
                               (append ?ask=0 to skip the accept prompt)
     GET  /                    the live graphics window (HTML canvas)
     GET  /api/lines           current line set as JSON (polled by the page)
     GET  /api/actors          one line per live actor: id class enq deq

   Build/run:  dune exec ./server.exe -- [PORT] [--ask] [--no-open]
               (default PORT 8080; --ask prompts y/N per actor;
                --no-open keeps the browser from auto-opening) *)

let ask_default = ref false
let no_open = ref false
let the_port = ref 8080

(* ---- shared graphics state (updated by VM actor threads, read by /api/lines) ---- *)
let gw = 820 and gh = 640
let glock = Mutex.create ()
let glines : (int*int*int*int*int) list ref = ref []
let gtris : (int*int*int*int*int*int*int) list ref = ref []  (* x1,y1,x2,y2,x3,y3,col *)
let gopened = ref false

(* ---- shared console buffer (actor print output, read by /api/console) ---- *)
let clock = Mutex.create ()
let clog : (int * string) list ref = ref []   (* chronological; capped *)
let ctotal = ref 0
let push_console s =
  Mutex.lock clock;
  incr ctotal;
  clog := !clog @ [(!ctotal, s)];
  let n = List.length !clog in
  if n > 500 then clog := List.filteri (fun i _ -> i >= n - 500) !clog;
  Mutex.unlock clock
let json_escape s =
  let b = Buffer.create (String.length s + 8) in
  String.iter (fun c -> match c with
    | '"' -> Buffer.add_string b "\\\""
    | '\\' -> Buffer.add_string b "\\\\"
    | '\n' -> Buffer.add_string b "\\n"
    | '\r' -> ()
    | '\t' -> Buffer.add_string b "\\t"
    | c when Char.code c < 0x20 -> Buffer.add_string b (Printf.sprintf "\\u%04x" (Char.code c))
    | c -> Buffer.add_char b c) s;
  Buffer.contents b
let console_json since =
  Mutex.lock clock; let ls = !clog and tot = !ctotal in Mutex.unlock clock;
  let b = Buffer.create 256 in
  Buffer.add_string b (Printf.sprintf "{\"total\":%d,\"lines\":[" tot);
  let first = ref true in
  List.iter (fun (i, s) -> if i > since then begin
    if not !first then Buffer.add_char b ','; first := false;
    Buffer.add_char b '"'; Buffer.add_string b (json_escape s); Buffer.add_char b '"'
  end) ls;
  Buffer.add_string b "]}";
  Buffer.contents b

let open_browser () =
  if !no_open || !gopened then () else begin
    gopened := true;
    let url = Printf.sprintf "http://localhost:%d/" !the_port in
    let cands =
      if Sys.os_type = "Win32"
      then [ ("cmd.exe", [|"cmd.exe";"/c";"start";"";url|]) ]
      else [ ("cmd.exe", [|"cmd.exe";"/c";"start";"";url|]);   (* WSL -> Windows browser *)
             ("xdg-open", [|"xdg-open";url|]);
             ("open", [|"open";url|]) ]                        (* macOS *)
    in
    let devnull = try Unix.openfile (if Sys.os_type="Win32" then "NUL" else "/dev/null")
                        [Unix.O_WRONLY] 0 with _ -> Unix.stderr in
    let rec go = function
      | [] -> ()
      | (prog,args)::t ->
        (try ignore (Unix.create_process prog args Unix.stdin devnull devnull)
         with _ -> go t)
    in go cands;
    Printf.printf "[aice-avm] opening desktop UI: http://localhost:%d/\n%!" !the_port
  end

let io : Avm.io = {
  Avm.on_print = (fun id s ->
    let line = Printf.sprintf "a%d: %s" id s in
    Printf.printf "[vm] %s\n%!" line; push_console line);
  on_line = (fun _id x1 y1 x2 y2 col ->
    Mutex.lock glock; glines := (x1,y1,x2,y2,col) :: !glines; Mutex.unlock glock;
    open_browser ());
  on_tri = (fun _id x1 y1 x2 y2 x3 y3 col ->
    Mutex.lock glock; gtris := (x1,y1,x2,y2,x3,y3,col) :: !gtris; Mutex.unlock glock;
    open_browser ());
  on_cls = (fun () -> Mutex.lock glock; glines := []; gtris := []; Mutex.unlock glock; open_browser ());
}

let lines_json () =
  Mutex.lock glock; let ls = !glines and ts = List.rev !gtris in Mutex.unlock glock;
  let b = Buffer.create 256 in
  Buffer.add_string b (Printf.sprintf "{\"w\":%d,\"h\":%d,\"lines\":[" gw gh);
  List.iteri (fun i (x1,y1,x2,y2,c) ->
    if i > 0 then Buffer.add_char b ',';
    Buffer.add_string b (Printf.sprintf "[%d,%d,%d,%d,%d]" x1 y1 x2 y2 c)) ls;
  Buffer.add_string b "],\"tris\":[";
  (* back-to-front (emission order): gtris is prepended, so reverse for painter's *)
  List.iteri (fun i (x1,y1,x2,y2,x3,y3,c) ->
    if i > 0 then Buffer.add_char b ',';
    Buffer.add_string b (Printf.sprintf "[%d,%d,%d,%d,%d,%d,%d]" x1 y1 x2 y2 x3 y3 c)) ts;
  Buffer.add_string b "]}";
  Buffer.contents b

let page = {html|<!doctype html>
<html><head><meta charset="utf-8"><title>aice-avm graphics</title>
<style>html,body{margin:0;background:#0b0f12;color:#cde;font-family:sans-serif;text-align:center}
h3{margin:8px}</style></head>
<body>
<h3>aice-avm &mdash; VM graphics</h3>
<canvas id="c" width="480" height="400" style="background:#06100a;border:1px solid #2a3a30"></canvas>
<script>
/* ES5 + XMLHttpRequest for maximum browser compatibility. Draws a test
   pattern (vertex markers + status) immediately, so the canvas is visibly
   alive even before any data arrives. */
var cv=document.getElementById('c'), x=cv.getContext('2d');
var W=cv.width, H=cv.height, lines=[], status='connecting...', tick=0;
var col={0:'#000000',1:'#3060ff',2:'#30d040',3:'#30d0d0',4:'#e03030',5:'#e040e0',6:'#e0e040',7:'#f0f0f0',8:'#808080',9:'#80a0ff',10:'#80ff80',11:'#80ffff',12:'#ff8080',13:'#ff80ff',14:'#ffff80',15:'#ffffff'};
var verts=[[150,100],[290,100],[290,240],[150,240]];
function draw(){
  tick++;
  x.fillStyle='#06100a'; x.fillRect(0,0,W,H);
  x.fillStyle='#34484c';
  for(var i=0;i<verts.length;i++){ x.beginPath(); x.arc(verts[i][0],verts[i][1],3,0,7); x.fill(); }
  x.lineWidth=4; x.lineCap='round';
  for(var j=0;j<lines.length;j++){ var L=lines[j];
    x.strokeStyle=col[L[4]]||'#ffffff';
    x.beginPath(); x.moveTo(L[0],L[1]); x.lineTo(L[2],L[3]); x.stroke(); }
  x.fillStyle='#7fc8a0'; x.font='12px monospace';
  x.fillText('tick '+tick+'  segments '+lines.length+'  '+status, 8, 16);
}
function poll(){
  try{
    var r=new XMLHttpRequest();
    r.open('GET','/api/lines?t='+tick,true);
    r.onreadystatechange=function(){
      if(r.readyState===4){
        if(r.status===200){ try{ var d=JSON.parse(r.responseText); lines=d.lines; status='ok'; }
                            catch(e){ status='parse-error'; } }
        else { status='http '+r.status; }
      }
    };
    r.send();
  }catch(e){ status='xhr-error'; }
}
draw();
setInterval(function(){ poll(); draw(); }, 60);
</script>
</body></html>|html}

(* A Blender-like editor shell (dark theme, header tabs, toolbar, outliner,
   properties, timeline) whose 3D viewport canvas renders the AIPL-drawn model
   (polled from /api/lines).  The VM can only emit lines, so the editor chrome
   lives here in HTML/CSS and the AIPL program supplies the wireframe. *)
let editor_page = {ed|<!doctype html><html><head><meta charset="utf-8">
<title>aice-avm — Blender-like editor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#1d1d1d;color:#c4c4c4;
  font:11px/1.4 'Segoe UI',system-ui,sans-serif;overflow:hidden;user-select:none}
#app{display:flex;flex-direction:column;height:100vh}
.hdr{background:#303030;border-bottom:1px solid #161616;display:flex;align-items:center;height:24px;padding:0 6px;gap:14px}
.hdr .logo{color:#e87d0d;font-weight:700}
.hdr .menu{color:#c8c8c8}.hdr .menu span{margin-right:10px}
.tabs{background:#282828;border-bottom:1px solid #161616;display:flex;height:22px;align-items:stretch}
.tab{padding:3px 11px;color:#9a9a9a;border-right:1px solid #1c1c1c;line-height:16px}
.tab.on{background:#4772b3;color:#fff}
.tab:hover{background:#3a3a3a}
.main{flex:1;display:flex;min-height:0}
.toolbar{width:30px;background:#303030;border-right:1px solid #161616;display:flex;flex-direction:column;align-items:center;padding-top:4px;gap:2px}
.tool{width:24px;height:24px;display:flex;align-items:center;justify-content:center;color:#bcbcbc;border-radius:3px;font-size:13px}
.tool.on{background:#4772b3;color:#fff}.tool:hover{background:#3c3c3c}
.vp{flex:1;display:flex;flex-direction:column;min-width:0}
.vphdr{height:24px;background:#2c2c2c;border-bottom:1px solid #161616;display:flex;align-items:center;padding:0 8px;gap:12px;color:#bcbcbc}
.vphdr .grow{flex:1}
.vphdr .shade{display:flex;gap:3px}
.shade b{width:16px;height:16px;border-radius:50%;display:inline-block;border:1px solid #555}
.shade .s1{background:#777}.shade .s2{background:#aaa}.shade .s3{background:radial-gradient(circle at 6px 5px,#ddd,#666)}.shade .s4{background:radial-gradient(circle at 6px 5px,#9bf,#247)}
.shade .on{outline:2px solid #5a8de0}
.canvasWrap{flex:1;position:relative;background:radial-gradient(ellipse at 50% 35%,#515559 0%,#393b3e 55%,#2b2c2e 100%);min-height:0}
#vp{position:absolute;inset:0;width:100%;height:100%}
.gizmo{position:absolute;top:8px;right:10px;width:44px;height:44px;border-radius:50%;background:rgba(40,40,40,.35)}
.gizmo i{position:absolute;width:13px;height:13px;border-radius:50%;font-style:normal;font-size:9px;color:#111;text-align:center;line-height:13px;font-weight:700}
.gizmo .x{background:#e0584e;left:30px;top:16px}.gizmo .y{background:#a3d34f;left:16px;top:2px}.gizmo .z{background:#5a87e0;left:16px;top:30px}
.right{width:330px;background:#303030;border-left:1px solid #161616;display:flex;flex-direction:column}
.outl{flex:1;display:flex;flex-direction:column;border-bottom:1px solid #161616;min-height:0}
.rhdr{height:22px;background:#28282d;border-bottom:1px solid #161616;display:flex;align-items:center;padding:0 8px;color:#cfcfcf;gap:6px}
.tree{flex:1;overflow:auto;background:#28282d;padding:3px 0}
.row{padding:1px 8px;white-space:nowrap;color:#c2c2c2}
.row.sel{background:#4772b3;color:#fff}
.row .tri{color:#9a9a9a;margin-right:2px}
.row .ic{margin-right:4px}
.props{flex:1.25;display:flex;min-height:0}
.ptabs{width:26px;background:#262626;display:flex;flex-direction:column;align-items:center;padding-top:4px;gap:3px;border-right:1px solid #161616}
.ptab{width:20px;height:20px;display:flex;align-items:center;justify-content:center;color:#b0b0b0;border-radius:3px}
.ptab.on{background:#4772b3;color:#fff}
.pbody{flex:1;overflow:auto;padding:6px 8px}
.psec{font-weight:600;color:#dadada;margin:6px 0 3px;border-bottom:1px solid #222;padding-bottom:2px}
.fld{display:flex;justify-content:space-between;padding:2px 4px;margin:2px 0;background:#252525;border-radius:3px}
.fld b{color:#9a9a9a;font-weight:400}.fld span{color:#d2d2d2}
.tl{height:92px;background:#303030;border-top:1px solid #161616;display:flex;flex-direction:column}
.tlhdr{height:24px;display:flex;align-items:center;gap:10px;padding:0 10px;border-bottom:1px solid #161616;color:#c4c4c4}
.tlhdr .pc{font-size:14px;letter-spacing:2px}
.tlhdr .pc b{cursor:default}
.tlhdr .fr{background:#252525;padding:1px 8px;border-radius:3px}
.track{flex:1;position:relative;background:#252528;overflow:hidden}
#tlcanvas{position:absolute;inset:0;width:100%;height:100%}
.status{height:18px;background:#303030;border-top:1px solid #161616;display:flex;align-items:center;padding:0 10px;color:#8a8a8a;gap:14px}
</style></head><body><div id="app">
  <div class="hdr"><span class="logo">&#9650; Blender</span>
    <span class="menu"><span>File</span><span>Edit</span><span>Render</span><span>Window</span><span>Help</span></span>
  </div>
  <div class="tabs">
    <div class="tab">Layout</div><div class="tab">Modeling</div><div class="tab">Sculpt</div>
    <div class="tab">UV Editing</div><div class="tab">Shading</div><div class="tab on">Animation</div>
    <div class="tab">Rendering</div><div class="tab">Compositing</div><div class="tab">Scripting</div>
  </div>
  <div class="main">
    <div class="toolbar">
      <div class="tool on">&#9737;</div><div class="tool">&#10021;</div><div class="tool">&#8635;</div>
      <div class="tool">&#9744;</div><div class="tool">&#9998;</div><div class="tool">&#10070;</div><div class="tool">+</div>
    </div>
    <div class="vp">
      <div class="vphdr"><span>&#9776; View</span><span>Select</span><span>Object</span>
        <span style="color:#dcdcdc">Object Mode &#9662;</span><span class="grow"></span>
        <span class="shade"><b class="s1"></b><b class="s2 on"></b><b class="s3"></b><b class="s4"></b></span>
      </div>
      <div class="canvasWrap">
        <canvas id="vp"></canvas>
        <div class="gizmo"><i class="x">X</i><i class="y">Y</i><i class="z">Z</i></div>
      </div>
    </div>
    <div class="right">
      <div class="outl">
        <div class="rhdr">&#9776; Outliner</div>
        <div class="tree">
          <div class="row"><span class="tri">&#9662;</span><span class="ic">&#128247;</span>Scene Collection</div>
          <div class="row" style="padding-left:18px"><span class="tri">&#9662;</span><span class="ic">&#128193;</span>Collection</div>
          <div class="row" style="padding-left:30px"><span class="ic">&#128247;</span>Camera</div>
          <div class="row" style="padding-left:30px"><span class="ic">&#128161;</span>Light</div>
          <div class="row sel" style="padding-left:30px"><span class="tri">&#9662;</span><span class="ic">&#9650;</span>MAKINA-7</div>
          <div class="row" style="padding-left:46px"><span class="ic">&#9678;</span>Mesh</div>
          <div class="row" style="padding-left:46px"><span class="ic">&#9737;</span>Armature</div>
          <div class="row" style="padding-left:60px">Head</div>
          <div class="row" style="padding-left:60px">Spine</div>
          <div class="row" style="padding-left:60px">Arm.L</div>
          <div class="row" style="padding-left:60px">Arm.R</div>
          <div class="row" style="padding-left:60px">Leg.L</div>
          <div class="row" style="padding-left:60px">Leg.R</div>
        </div>
      </div>
      <div class="props">
        <div class="ptabs">
          <div class="ptab">&#9881;</div><div class="ptab">&#128249;</div><div class="ptab on">&#9723;</div>
          <div class="ptab">&#9737;</div><div class="ptab">&#9650;</div><div class="ptab">&#127912;</div>
        </div>
        <div class="pbody">
          <div class="psec">Object Properties &#8250; MAKINA-7</div>
          <div class="psec">Transform</div>
          <div class="fld"><b>Location X / Y / Z</b><span>0.0  0.0  0.0</span></div>
          <div class="fld"><b>Rotation X / Y / Z</b><span id="rotz">0  0  0</span></div>
          <div class="fld"><b>Scale X / Y / Z</b><span>1.0  1.0  1.0</span></div>
          <div class="fld"><b>Dimensions</b><span>0.88 2.04 0.58</span></div>
          <div class="psec">Statistics</div>
          <div class="fld"><b>Vertices</b><span id="nv">--</span></div>
          <div class="fld"><b>Edges</b><span id="ne">--</span></div>
          <div class="fld"><b>Source</b><span>MAKINA-7.glb</span></div>
        </div>
      </div>
    </div>
  </div>
  <div class="tl">
    <div class="tlhdr"><span class="pc"><b>&#9198;</b> <b>&#9194;</b> <b id="play" style="cursor:pointer">&#9205;</b> <b>&#9193;</b> <b>&#9197;</b></span>
      <span class="fr">Frame: <b id="cf">1</b></span><span class="fr">Start 1</span><span class="fr">End 96</span>
      <span style="flex:1"></span><span style="color:#8a8a8a">Action: Turntable</span>
    </div>
    <div class="track"><canvas id="tlcanvas"></canvas></div>
  </div>
  <div class="status"><span>aice-avm host VM</span><span>MAKINA-7.glb</span><span id="st">connecting...</span></div>
</div>
<script>
var cv=document.getElementById('vp'), x=cv.getContext('2d');
var tlc=document.getElementById('tlcanvas'), tx=tlc.getContext('2d');
var lines=[], W=480, H=400, t=0, frame=0;
var zoom=1, panx=0, pany=0, drag=false, lx=0, ly=0, paused=false;
var COL={0:'#000000',1:'#3060ff',2:'#30d040',3:'#30d0d0',4:'#e03030',5:'#e040e0',6:'#e0e040',7:'#f0f0f0',8:'#808080',9:'#80a0ff',10:'#80ff80',11:'#80ffff',12:'#ff8080',13:'#ff80ff',14:'#ffff80',15:'#ffffff'};
function fit(c){ var r=c.getBoundingClientRect(); if(c.width!=Math.round(r.width)||c.height!=Math.round(r.height)){c.width=r.width;c.height=r.height;} }
function draw(){
  fit(cv); var w=cv.width,h=cv.height; x.clearRect(0,0,w,h);
  var sc=Math.min(w/W,h/H)*0.92*zoom, ox=(w-W*sc)/2+panx, oy=(h-H*sc)/2+pany;
  x.lineCap='round';
  for(var i=0;i<lines.length;i++){ var L=lines[i], cc=L[4];
    x.strokeStyle=COL[cc]||'#cfcfcf'; x.lineWidth=(cc==7?1.3:1);
    x.beginPath(); x.moveTo(ox+L[0]*sc,oy+L[1]*sc); x.lineTo(ox+L[2]*sc,oy+L[3]*sc); x.stroke(); }
  fit(tlc); var tw=tlc.width,th=tlc.height; tx.clearRect(0,0,tw,th);
  tx.strokeStyle='#3a3a40'; for(var k=0;k<=96;k+=8){var px=10+k*(tw-20)/96; tx.beginPath(); tx.moveTo(px,0); tx.lineTo(px,th); tx.stroke();}
  tx.fillStyle='#8a8a8a'; tx.font='9px sans-serif'; for(var k2=0;k2<=96;k2+=16){var px2=10+k2*(tw-20)/96; tx.fillText(k2,px2-3,10);}
  var ph=10+frame*(tw-20)/96; tx.fillStyle='#e0922a'; tx.fillRect(ph-1,0,2,th);
}
function poll(){
  if(paused) return;
  var r=new XMLHttpRequest(); r.open('GET','/api/lines?t='+(t++),true);
  r.onreadystatechange=function(){ if(r.readyState==4 && r.status==200){ try{
    var d=JSON.parse(r.responseText); W=d.w; H=d.h; lines=d.lines;
    document.getElementById('st').textContent='live  '+lines.length+' segs';
    document.getElementById('ne').textContent=lines.length;
    document.getElementById('nv').textContent=Math.round(lines.length*0.5);
    frame=(frame+1)%96; document.getElementById('cf').textContent=frame+1;
    document.getElementById('rotz').textContent='0  '+Math.round(frame*360/96)+'  0';
  }catch(e){} } }; r.send();
}
cv.addEventListener('wheel',function(e){ e.preventDefault(); zoom*=(e.deltaY<0?1.1:0.9); if(zoom<0.3)zoom=0.3; if(zoom>4)zoom=4; draw(); },{passive:false});
cv.addEventListener('mousedown',function(e){ drag=true; lx=e.clientX; ly=e.clientY; });
window.addEventListener('mouseup',function(){ drag=false; });
window.addEventListener('mousemove',function(e){ if(drag){ panx+=e.clientX-lx; pany+=e.clientY-ly; lx=e.clientX; ly=e.clientY; draw(); } });
var pb=document.getElementById('play');
if(pb) pb.addEventListener('click',function(){ paused=!paused; pb.innerHTML=paused?'&#9205;':'&#9208;'; });
var rows=document.querySelectorAll('.tree .row');
for(var ri=0;ri<rows.length;ri++) rows[ri].addEventListener('click',function(){ for(var q=0;q<rows.length;q++)rows[q].classList.remove('sel'); this.classList.add('sel'); });
draw(); setInterval(function(){ poll(); draw(); },66);
window.addEventListener('resize',draw);
</script></body></html>|ed}

(* ---- HTTP plumbing ---- *)
let find_sub s sub =
  let ls = String.length s and lu = String.length sub in
  let rec go i = if i + lu > ls then -1
                 else if String.sub s i lu = sub then i else go (i+1) in
  if lu = 0 then 0 else go 0

let starts_with s pre =
  String.length s >= String.length pre && String.sub s 0 (String.length pre) = pre

let content_length headers =
  let low = String.lowercase_ascii headers in
  let i = find_sub low "content-length:" in
  if i < 0 then 0
  else begin
    let j = ref (i + String.length "content-length:") in
    let n = String.length headers in
    while !j < n && (headers.[!j] = ' ' || headers.[!j] = '\t') do incr j done;
    let b = Buffer.create 8 in
    while !j < n && headers.[!j] >= '0' && headers.[!j] <= '9' do
      Buffer.add_char b headers.[!j]; incr j done;
    (try int_of_string (Buffer.contents b) with _ -> 0)
  end

let cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
let http resp_ctype body =
  Printf.sprintf "HTTP/1.0 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\n%sConnection: close\r\n\r\n%s"
    resp_ctype (String.length body) cors body
let http_preflight =
  Printf.sprintf "HTTP/1.0 204 No Content\r\n%sContent-Length: 0\r\nConnection: close\r\n\r\n" cors
(* Static assets (HTML/JS/CSS) must never be cached, or browsers keep an old
   xinu.js after an update and the VM graphics window renders stale code. *)
let http_static resp_ctype body =
  Printf.sprintf "HTTP/1.0 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-cache, no-store, must-revalidate\r\nPragma: no-cache\r\n%sConnection: close\r\n\r\n%s"
    resp_ctype (String.length body) cors body
let http_text = http "text/plain"
let http_json = http "application/json"
let http_html = http "text/html; charset=utf-8"

let ends_with s suf =
  let ls = String.length s and lf = String.length suf in
  ls >= lf && String.sub s (ls - lf) lf = suf

let read_file_opt p =
  try let ic = open_in_bin p in
    let n = in_channel_length ic in
    let s = really_input_string ic n in close_in ic; Some s
  with _ -> None

let ctype_of p =
  if ends_with p ".html" then "text/html; charset=utf-8"
  else if ends_with p ".css" then "text/css"
  else if ends_with p ".js" then "application/javascript"
  else if ends_with p ".json" then "application/json"
  else "application/octet-stream"

(* Serve files from the www/ directory next to the receiver (the Xinu UI). *)
let serve_static path =
  let p = (match String.index_opt path '?' with Some i -> String.sub path 0 i | None -> path) in
  let p = if p = "/" then "/index.html" else p in
  if find_sub p ".." >= 0 then http_text "bad path"
  else match read_file_opt ("www" ^ p) with
    | Some body -> http_static (ctype_of p) body
    | None -> Printf.sprintf "HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

(* Parse an integer query param, e.g. ?since=12 -> 12 (default 0). *)
let int_param path name =
  let key = name ^ "=" in
  let i = find_sub path key in
  if i < 0 then 0
  else begin
    let j = ref (i + String.length key) in
    let n = String.length path in
    let b = Buffer.create 8 in
    while !j < n && path.[!j] >= '0' && path.[!j] <= '9' do Buffer.add_char b path.[!j]; incr j done;
    (try int_of_string (Buffer.contents b) with _ -> 0)
  end

(* String query param, e.g. ?host=192.168.3.101 -> "192.168.3.101". *)
let str_param path name =
  let key = name ^ "=" in
  let i = find_sub path key in
  if i < 0 then ""
  else begin
    let j = ref (i + String.length key) in
    let n = String.length path in
    let b = Buffer.create 16 in
    while !j < n && path.[!j] <> '&' && path.[!j] <> ' ' do
      Buffer.add_char b path.[!j]; incr j done;
    Buffer.contents b
  end

(* URL-decode a query value (%2F -> '/', '+' -> ' '). *)
let url_decode s =
  let n = String.length s in
  let b = Buffer.create n in
  let i = ref 0 in
  while !i < n do
    (match s.[!i] with
     | '%' when !i + 2 < n ->
        (try Buffer.add_char b (Char.chr (int_of_string ("0x" ^ String.sub s (!i + 1) 2)));
             i := !i + 3
         with _ -> Buffer.add_char b '%'; incr i)
     | '+' -> Buffer.add_char b ' '; incr i
     | c -> Buffer.add_char b c; incr i)
  done;
  Buffer.contents b

(* ---- real host filesystem, exposed to the desktop shell as /computer ----
   The browser VFS is in-memory only; these routes let `ls /computer`,
   `cd`, `cat`, and the write commands (cp, echo>, touch, mkdir, rm) reach the
   actual machine's filesystem (read-write). *)
let jstr s = "\"" ^ json_escape s ^ "\""

let host_ls_json qpath =
  let p = url_decode qpath in
  let p = if p = "" then "/" else p in
  try
    let st = Unix.stat p in
    (match st.Unix.st_kind with
     | Unix.S_DIR ->
        let names = try Sys.readdir p with _ -> [||] in
        Array.sort compare names;
        let b = Buffer.create 1024 in
        Buffer.add_string b (Printf.sprintf "{\"path\":%s,\"type\":\"dir\",\"entries\":[" (jstr p));
        Array.iteri (fun i name ->
          if i > 0 then Buffer.add_char b ',';
          let full = if p = "/" then "/" ^ name else p ^ "/" ^ name in
          let kind, size =
            (try let ls = Unix.lstat full in
               ((match ls.Unix.st_kind with
                 | Unix.S_DIR -> "dir" | Unix.S_LNK -> "link" | _ -> "file"),
                ls.Unix.st_size)
             with _ -> ("?", 0)) in
          Buffer.add_string b (Printf.sprintf "{\"name\":%s,\"type\":%s,\"size\":%d}"
            (jstr name) (jstr kind) size)) names;
        Buffer.add_string b "]}";
        Buffer.contents b
     | _ -> Printf.sprintf "{\"path\":%s,\"type\":\"file\",\"size\":%d}" (jstr p) st.Unix.st_size)
  with
  | Unix.Unix_error (e, _, _) -> Printf.sprintf "{\"error\":%s}" (jstr (Unix.error_message e))
  | Sys_error m -> Printf.sprintf "{\"error\":%s}" (jstr m)
  | _ -> "{\"error\":\"cannot read\"}"

let host_cat qpath =
  let p = url_decode qpath in
  try
    (match (Unix.stat p).Unix.st_kind with
     | Unix.S_DIR -> "cat: " ^ p ^ ": Is a directory"
     | _ ->
        let ic = open_in_bin p in
        let n = in_channel_length ic in
        let cap = 262144 in
        let m = if n > cap then cap else n in
        let s = really_input_string ic m in
        close_in ic;
        if n > cap then s ^ Printf.sprintf "\n[... truncated: %d of %d bytes shown ...]\n" cap n
        else s)
  with
  | Unix.Unix_error (e, _, _) -> "cat: " ^ p ^ ": " ^ Unix.error_message e
  | Sys_error m -> "cat: " ^ m
  | _ -> "cat: cannot read " ^ p

(* ---- host filesystem writes (make /computer read-write) ----------------
   write/mkdir/rm/cp on the real machine, backing the desktop shell's cp,
   echo>, touch, mkdir and rm under /computer. *)
let host_write qpath (body : string) =
  let p = url_decode qpath in
  try
    (match (try Some (Unix.stat p).Unix.st_kind with _ -> None) with
     | Some Unix.S_DIR -> Printf.sprintf "{\"error\":%s}" (jstr (p ^ ": Is a directory"))
     | _ ->
        let oc = open_out_bin p in
        output_string oc body; close_out oc;
        Printf.sprintf "{\"ok\":true,\"path\":%s,\"bytes\":%d}" (jstr p) (String.length body))
  with
  | Unix.Unix_error (e, _, _) -> Printf.sprintf "{\"error\":%s}" (jstr (Unix.error_message e))
  | Sys_error m -> Printf.sprintf "{\"error\":%s}" (jstr m)
  | _ -> Printf.sprintf "{\"error\":%s}" (jstr "cannot write")

let host_mkdir qpath =
  let p = url_decode qpath in
  try Unix.mkdir p 0o755; Printf.sprintf "{\"ok\":true,\"path\":%s}" (jstr p)
  with
  | Unix.Unix_error (e, _, _) -> Printf.sprintf "{\"error\":%s}" (jstr (Unix.error_message e))
  | _ -> Printf.sprintf "{\"error\":%s}" (jstr "cannot mkdir")

let rec rm_rf p =
  match (Unix.lstat p).Unix.st_kind with
  | Unix.S_DIR ->
     Array.iter (fun n -> rm_rf (Filename.concat p n)) (Sys.readdir p);
     Unix.rmdir p
  | _ -> Unix.unlink p

let host_rm qpath recursive =
  let p = url_decode qpath in
  try
    (match (Unix.lstat p).Unix.st_kind with
     | Unix.S_DIR when not recursive ->
        Printf.sprintf "{\"error\":%s}" (jstr (p ^ ": is a directory (use -r)"))
     | Unix.S_DIR -> rm_rf p; Printf.sprintf "{\"ok\":true,\"path\":%s}" (jstr p)
     | _ -> Unix.unlink p; Printf.sprintf "{\"ok\":true,\"path\":%s}" (jstr p))
  with
  | Unix.Unix_error (e, _, _) -> Printf.sprintf "{\"error\":%s}" (jstr (Unix.error_message e))
  | _ -> Printf.sprintf "{\"error\":%s}" (jstr "cannot remove")

let copy_file src dst =
  let ic = open_in_bin src in
  let n = in_channel_length ic in
  let data = really_input_string ic n in
  close_in ic;
  let oc = open_out_bin dst in
  output_string oc data; close_out oc

let rec cp_r src dst =
  match (Unix.stat src).Unix.st_kind with
  | Unix.S_DIR ->
     (try Unix.mkdir dst 0o755 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
     Array.iter (fun n -> cp_r (Filename.concat src n) (Filename.concat dst n)) (Sys.readdir src)
  | _ -> copy_file src dst

let host_cp qsrc qdst recursive =
  let src = url_decode qsrc and dst0 = url_decode qdst in
  try
    let src_kind = (Unix.stat src).Unix.st_kind in
    (* if dst is an existing directory, copy into it under src's basename *)
    let dst =
      match (try Some (Unix.stat dst0).Unix.st_kind with _ -> None) with
      | Some Unix.S_DIR -> Filename.concat dst0 (Filename.basename src)
      | _ -> dst0 in
    (match src_kind with
     | Unix.S_DIR when not recursive ->
        Printf.sprintf "{\"error\":%s}" (jstr (src ^ ": is a directory (use -r)"))
     | Unix.S_DIR -> cp_r src dst; Printf.sprintf "{\"ok\":true,\"path\":%s}" (jstr dst)
     | _ -> copy_file src dst; Printf.sprintf "{\"ok\":true,\"path\":%s}" (jstr dst))
  with
  | Unix.Unix_error (e, _, _) -> Printf.sprintf "{\"error\":%s}" (jstr (Unix.error_message e))
  | Sys_error m -> Printf.sprintf "{\"error\":%s}" (jstr m)
  | _ -> Printf.sprintf "{\"error\":%s}" (jstr "cannot copy")

(* ---- AVM inbox: modules received from other machines --------------------
   Every .avm pushed to this receiver (POST /actor/loadvm — the `send` tool, a
   Pi board, or another aice-avm) is recorded here with its origin, so the
   desktop's "AVM 受信箱" window can list them and re-run / disassemble / save
   each one.  This is the unified reception point surfaced in the UI. *)
type inbox_entry = {
  iid : int; iname : string; ifrom : string;
  isize : int; its : float; ibytes : bytes; mutable iran : bool;
}
let ilock = Mutex.create ()
let inbox : inbox_entry list ref = ref []      (* newest first *)
let inext = ref 0
let inbox_add name from bytes ran =
  Mutex.lock ilock;
  let id = !inext in incr inext;
  let e = { iid = id; iname = name; ifrom = from;
            isize = Bytes.length bytes; its = Unix.gettimeofday ();
            ibytes = bytes; iran = ran } in
  inbox := e :: !inbox;
  (let n = List.length !inbox in                (* bound memory to last 100 *)
   if n > 100 then inbox := List.filteri (fun i _ -> i < 100) !inbox);
  Mutex.unlock ilock;
  id
let inbox_find id =
  Mutex.lock ilock; let r = List.find_opt (fun e -> e.iid = id) !inbox in Mutex.unlock ilock; r
let inbox_json () =
  Mutex.lock ilock; let es = !inbox in Mutex.unlock ilock;
  let b = Buffer.create 512 in
  Buffer.add_char b '[';
  List.iteri (fun i e ->
    if i > 0 then Buffer.add_char b ',';
    Buffer.add_string b
      (Printf.sprintf "{\"id\":%d,\"name\":%s,\"from\":%s,\"size\":%d,\"ts\":%.0f,\"ran\":%s}"
         e.iid (jstr e.iname) (jstr e.ifrom) e.isize e.its (if e.iran then "true" else "false"))) es;
  Buffer.add_char b ']';
  Buffer.contents b

(* Outbound HTTP/1.0 GET to a board on the LAN; returns the response body (the
   browser can't reach the boards' non-CORS bench routes directly, so the
   desktop hits us same-origin and we proxy).  A read timeout guards a slow
   board so one benchmark can't wedge the receiver. *)
let http_get_lan host port path =
  try
    let he = Unix.gethostbyname host in
    let addr = Unix.ADDR_INET (he.Unix.h_addr_list.(0), port) in
    let fd = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
    (try Unix.setsockopt_float fd Unix.SO_RCVTIMEO 25.0 with _ -> ());
    (try Unix.setsockopt_float fd Unix.SO_SNDTIMEO 10.0 with _ -> ());
    Unix.connect fd addr;
    let req = Printf.sprintf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" path host in
    ignore (Unix.write_substring fd req 0 (String.length req));
    let buf = Buffer.create 4096 in
    let chunk = Bytes.create 4096 in
    (try
       let rec loop () =
         let k = Unix.read fd chunk 0 (Bytes.length chunk) in
         if k > 0 then (Buffer.add_subbytes buf chunk 0 k; loop ()) in
       loop ()
     with _ -> ());
    (try Unix.close fd with _ -> ());
    let s = Buffer.contents buf in
    let i = find_sub s "\r\n\r\n" in
    if i >= 0 then String.sub s (i + 4) (String.length s - i - 4) else s
  with e -> Printf.sprintf "proxy-error: %s" (Printexc.to_string e)

(* Outbound HTTP/1.0 POST of a binary body to a board (e.g. one /actor/loadvm
   chunk).  Returns the response body. *)
let http_post_lan host port path (body : string) =
  try
    let he = Unix.gethostbyname host in
    let addr = Unix.ADDR_INET (he.Unix.h_addr_list.(0), port) in
    let fd = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
    (try Unix.setsockopt_float fd Unix.SO_RCVTIMEO 25.0 with _ -> ());
    (try Unix.setsockopt_float fd Unix.SO_SNDTIMEO 15.0 with _ -> ());
    Unix.connect fd addr;
    let hdr = Printf.sprintf
      "POST %s HTTP/1.0\r\nHost: %s\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
      path host (String.length body) in
    ignore (Unix.write_substring fd hdr 0 (String.length hdr));
    let n = String.length body and off = ref 0 in
    (try while !off < n do
       let k = Unix.write_substring fd body !off (min 16384 (n - !off)) in
       if k <= 0 then raise Exit; off := !off + k
     done with _ -> ());
    let buf = Buffer.create 512 and chunk = Bytes.create 4096 in
    (try let rec loop () =
       let k = Unix.read fd chunk 0 (Bytes.length chunk) in
       if k > 0 then (Buffer.add_subbytes buf chunk 0 k; loop ()) in loop ()
     with _ -> ());
    (try Unix.close fd with _ -> ());
    let s = Buffer.contents buf in
    let i = find_sub s "\r\n\r\n" in
    if i >= 0 then String.sub s (i + 4) (String.length s - i - 4) else s
  with e -> Printf.sprintf "post-error: %s" (Printexc.to_string e)

(* /mesh/loadvm?host=H[&port=P][&file=NAME] — chunk-upload a local meshes/NAME.avm
   to a board's /actor/loadvm (rpi5 protocol: POST ?off=&total= chunks, then
   GET ?go=1&len=) so the Mesh Control Center can push the blender display
   (e.g. MAKINA-7) with one click.  file= is a basename (no path traversal). *)
let mesh_loadvm path =
  let host = str_param path "host" in
  let port = let p = int_param path "port" in if p = 0 then 80 else p in
  let file = let f = str_param path "file" in if f = "" then "MakinaMesh.avm" else f in
  let base = Filename.basename file in           (* strip any directory part *)
  if host = "" then "loadvm-error: missing host"
  else
    let fpath = Filename.concat "meshes" base in
    try
      let ic = open_in_bin fpath in
      let len = in_channel_length ic in
      let data = really_input_string ic len in
      close_in ic;
      let csz = 60000 and off = ref 0 and nchunk = ref 0 and ok = ref true in
      while !off < len && !ok do
        let sz = min csz (len - !off) in
        let r = http_post_lan host port
                  (Printf.sprintf "/actor/loadvm?off=%d&total=%d" !off len)
                  (String.sub data !off sz) in
        if find_sub r "ok off=" < 0 then ok := false;
        incr nchunk; off := !off + sz
      done;
      if not !ok then Printf.sprintf "loadvm: chunk upload failed at off=%d" !off
      else
        let run = http_get_lan host port (Printf.sprintf "/actor/loadvm?go=1&len=%d" len) in
        Printf.sprintf "uploaded %s (%d bytes, %d chunks) -> %s : %s"
          base len !nchunk host (String.trim run)
    with
    | Sys_error m -> Printf.sprintf "loadvm-error: %s (have meshes/%s?)" m base
    | e -> Printf.sprintf "loadvm-error: %s" (Printexc.to_string e)

(* /mesh/bench?host=H[&port=P]&kind=primes[&n=N] — run a benchmark on one mesh
   board and return its raw text result (proxied; bypasses CORS). *)
let mesh_bench path =
  let host = str_param path "host" in
  let port = let p = int_param path "port" in if p = 0 then 80 else p in
  let n = let v = int_param path "n" in if v = 0 then 300000 else v in
  let kind = str_param path "kind" in
  if host = "" then "bench-error: missing host"
  else match kind with
    | "primes" | "" -> http_get_lan host port (Printf.sprintf "/smp-bench?n=%d" n)
    | "nqueens" | "dining" ->
        http_get_lan host port (Printf.sprintf "/bench?kind=%s&n=%d" kind n)
    | other -> Printf.sprintf "bench-error: kind '%s' has no board route yet" other

(* The desktop Actor Loader's "Binarize/Save" produces an "AVM1" container that
   wraps .abcl SOURCE (not compiled bytecode):
     "AVM1" | ver(1) | flags(1) | nameLen(1) | name | srcLen(u32 LE) | source
   The VM loader (runvm / loadvm / disasm) expects a compiled AVM module, so a
   saved .avm from the Actor Loader would fail to open.  Detect the container,
   extract the source and compile it here; pass any other bytes through
   unchanged so real .avm bytecode still loads directly. *)
let module_of_bytes (data : string) : bytes =
  let n = String.length data in
  (* NOTE: a COMPILED module also starts with "AVM1" (its bytes 4..5 are the
     u16 string count).  A source container is distinguished by ver=1, flags=0
     AND an exact total length of 7 + nameLen + 4 + srcLen — a real module would
     have to have exactly 1 string AND that precise size to be mistaken, which
     does not happen.  Anything else is passed through as compiled bytecode. *)
  let looks_source =
    n >= 11 && data.[0] = 'A' && data.[1] = 'V' && data.[2] = 'M' && data.[3] = '1'
    && Char.code data.[4] = 1 && Char.code data.[5] = 0 in
  if not looks_source then Bytes.of_string data
  else
    let name_len = Char.code data.[6] in
    let o = 7 + name_len in
    if o + 4 > n then Bytes.of_string data
    else
      let src_len =
        (Char.code data.[o])
        lor (Char.code data.[o + 1] lsl 8)
        lor (Char.code data.[o + 2] lsl 16)
        lor (Char.code data.[o + 3] lsl 24) in
      let src_start = o + 4 in
      if src_len < 0 || src_start + src_len <> n then Bytes.of_string data
      else Compile.compile_source (String.sub data src_start src_len)

(* /mesh/cmd?host=H[&port=P]&via=run|shell&c=wifi%20status — proxy a shell
   command to a board's /run (rpi5) or /shell (rpi3/rpi4) route and return its
   raw text.  Lets the desktop read mesh status / AODV results despite CORS. *)
let mesh_cmd path =
  let host = str_param path "host" in
  let port = let p = int_param path "port" in if p = 0 then 80 else p in
  let via  = let v = str_param path "via" in if v = "" then "run" else v in
  let c    = str_param path "c" in
  if host = "" || c = "" then "cmd-error: missing host/c"
  else http_get_lan host port (Printf.sprintf "/%s?cmd=%s" via c)

let ask_console nbytes =
  Printf.printf "[server] incoming actor binary: %d bytes — accept and run? [y/N] %!" nbytes;
  (try match String.trim (String.lowercase_ascii (input_line stdin)) with
       | "y" | "yes" -> true | _ -> false
   with End_of_file -> false)

(* ---- remote restart ----------------------------------------------------
   /api/restart re-launches a fresh copy of this server on the same port and
   exits the current one.  We close the listener first so the child can re-bind
   (SO_REUSEADDR covers any lingering TIME_WAIT).  Cross-platform: uses
   create_process rather than execv — execv's Windows emulation keeps the old
   process alive holding the port.  Reachable even while an actor wedges a
   handler thread, because the accept loop keeps spawning new threads. *)
let listen_sock : Unix.file_descr option ref = ref None
let do_restart () =
  (match !listen_sock with Some s -> (try Unix.close s with _ -> ()) | None -> ());
  (try ignore (Unix.create_process Sys.executable_name Sys.argv
                 Unix.stdin Unix.stdout Unix.stderr)
   with _ -> ());
  exit 0

let handle rt fd =
  let buf = Buffer.create 8192 in
  let chunk = Bytes.create 8192 in
  let he = ref (-1) in
  (try
     while !he < 0 do
       let k = Unix.read fd chunk 0 (Bytes.length chunk) in
       if k = 0 then raise Exit;
       Buffer.add_subbytes buf chunk 0 k;
       he := find_sub (Buffer.contents buf) "\r\n\r\n"
     done
   with Exit -> ());
  if !he >= 0 then begin
    let headers = String.sub (Buffer.contents buf) 0 !he in
    let body_start = !he + 4 in
    let clen = content_length headers in
    (try
       while Buffer.length buf < body_start + clen do
         let k = Unix.read fd chunk 0 (Bytes.length chunk) in
         if k = 0 then raise Exit;
         Buffer.add_subbytes buf chunk 0 k
       done
     with Exit -> ());
    let full = Buffer.contents buf in
    let avail = String.length full - body_start in
    let body = if avail > 0 then String.sub full body_start (min clen avail) else "" in
    let reqline = (match String.index_opt headers '\r' with
                   | Some i -> String.sub headers 0 i | None -> headers) in
    let path = (match String.split_on_char ' ' reqline with _ :: p :: _ -> p | _ -> "/") in
    let meth = (match String.split_on_char ' ' reqline with m :: _ -> m | _ -> "GET") in
    (* origin of this connection, recorded with any received .avm module *)
    let peer = (try match Unix.getpeername fd with
                    | Unix.ADDR_INET (a, _) -> Unix.string_of_inet_addr a
                    | _ -> "local"
                with _ -> "?") in
    let resp =
      if meth = "OPTIONS" then http_preflight  (* CORS preflight *)
      else if starts_with path "/actor/loadvm" then begin
        let skip = find_sub path "ask=0" >= 0 || find_sub path "noask" >= 0 in
        let accepted = if skip || not !ask_default then true else ask_console (String.length body) in
        let id = if accepted then (try Avm.loadrun rt (module_of_bytes body) with _ -> -1) else -1 in
        (* record every received module in the inbox (surfaced in the desktop) *)
        let nm = let n = str_param path "name" in
                 if n = "" then "incoming.avm" else url_decode n in
        let iid = inbox_add nm peer (Bytes.of_string body) accepted in
        http_text (Printf.sprintf "loadvm: body=%d accepted=%d spawned actor id=%d inbox=%d\r\n"
                     (String.length body) (if accepted then 1 else 0) id iid)
      end
      else if starts_with path "/actor/loadsrc" then begin
        (* Browser sends .abcl source; compile here and run on the host VM. *)
        (try
           let avm = Compile.compile_source body in
           let id = Avm.loadrun rt avm in
           http_text (Printf.sprintf "loadsrc: src=%d avm=%d spawned actor id=%d\r\n"
                        (String.length body) (Bytes.length avm) id)
         with e -> http_text (Printf.sprintf "loadsrc-error: %s\r\n" (Printexc.to_string e)))
      end
      (* web_expose で公開したアクタを叩く:
           POST/GET /api/x/<パス>?method=say&args=hi
         パスは web_expose("/echo", "echo") の第1引数。返信は本文で返す。 *)
      else if starts_with path "/api/x/" then begin
        let q = (try String.sub path 0 (String.index path '?') with Not_found -> path) in
        let route = String.sub q 6 (String.length q - 6) in   (* "/api/x" を落とす *)
        let m = let v = str_param path "method" in if v = "" then "say" else v in
        let a = str_param path "args" in
        let args = if a = "" then [] else [a] in
        match Avm.web_call rt route m args with
        | None ->
            http_text (Printf.sprintf "no route %s\n公開済み: %s\n" route
              (String.concat ", " (List.map fst (Avm.web_routes_list ()))))
        | Some v -> http_text (v ^ "\n")
      end
      else if starts_with path "/api/routes" then
        http_text (String.concat "\n"
          (List.map (fun (p, a) -> Printf.sprintf "%s -> actor %d" p a) (Avm.web_routes_list ())) ^ "\n")
      else if starts_with path "/api/lines" then http_json (lines_json ())
      else if starts_with path "/api/console" then http_json (console_json (int_param path "since"))
      else if starts_with path "/api/actors" then begin
        let b = Buffer.create 256 in
        Buffer.add_string b "id class enq deq\r\n";
        List.iter (fun (id, c, e, d) -> Buffer.add_string b (Printf.sprintf "%d %d %d %d\r\n" id c e d))
          (Avm.actor_table rt);
        http_text (Buffer.contents b)
      end
      else if starts_with path "/api/restart" || path = "/restart" then begin
        (* respond first, then relaunch shortly so the client sees the ack *)
        ignore (Thread.create (fun () -> Thread.delay 0.3; do_restart ()) ());
        http_text "restarting aice-avm (fresh process on the same port)...\r\n"
      end
      else if starts_with path "/api/host/ls" then http_json (host_ls_json (str_param path "path"))
      else if starts_with path "/api/host/cat" then http_text (host_cat (str_param path "path"))
      else if starts_with path "/api/host/write" then http_json (host_write (str_param path "path") body)
      else if starts_with path "/api/host/mkdir" then http_json (host_mkdir (str_param path "path"))
      else if starts_with path "/api/host/rm" then http_json (host_rm (str_param path "path") (find_sub path "r=1" >= 0))
      else if starts_with path "/api/host/cp" then http_json (host_cp (str_param path "src") (str_param path "dst") (find_sub path "r=1" >= 0))
      else if starts_with path "/api/host/runvm" then begin
        (* Read a .avm file straight off the real machine and run it on the host
           VM — backs the "run an avm file from the Mac" page. *)
        let p = url_decode (str_param path "path") in
        (match read_file_opt p with
         | None -> http_json (Printf.sprintf "{\"error\":%s}" (jstr (p ^ ": cannot read")))
         | Some data ->
            (try
               let id = Avm.loadrun rt (module_of_bytes data) in
               if id < 0 then
                 http_json (Printf.sprintf
                   "{\"error\":%s}"
                   (jstr (p ^ ": not a runnable AVM actor module (bad/failed to load)")))
               else
                 http_json (Printf.sprintf "{\"ok\":true,\"path\":%s,\"bytes\":%d,\"id\":%d}"
                              (jstr p) (String.length data) id)
             with e -> http_json (Printf.sprintf "{\"error\":%s}" (jstr (Printexc.to_string e)))))
      end
      else if starts_with path "/api/host/disasm" then begin
        (* Recover a readable bytecode listing from a .avm file on the machine. *)
        let p = url_decode (str_param path "path") in
        (match read_file_opt p with
         | None -> http_text ("disasm: " ^ p ^ ": cannot read")
         | Some data ->
            (try http_text (Avm.disassemble (module_of_bytes data))
             with e -> http_text ("disasm: not a valid .avm module (" ^ Printexc.to_string e ^ ")")))
      end
      else if starts_with path "/api/cls" then begin
        Mutex.lock glock; glines := []; gtris := []; Mutex.unlock glock;
        http_json "{\"ok\":true}"
      end
      (* ---- AVM inbox (received-from-other-machines) API ---- *)
      else if starts_with path "/api/inbox/run" then begin
        let id = int_param path "id" in
        (match inbox_find id with
         | None -> http_json "{\"error\":\"no such inbox item\"}"
         | Some e -> e.iran <- true;
             let aid = Avm.loadrun rt e.ibytes in
             http_json (Printf.sprintf "{\"ok\":true,\"id\":%d,\"actor\":%d}" id aid))
      end
      else if starts_with path "/api/inbox/disasm" then begin
        let id = int_param path "id" in
        (match inbox_find id with
         | None -> http_text "disasm: no such inbox item"
         | Some e -> (try http_text (Avm.disassemble e.ibytes)
                      with ex -> http_text ("disasm: " ^ Printexc.to_string ex)))
      end
      else if starts_with path "/api/inbox/save" then begin
        let id = int_param path "id" in
        let p = url_decode (str_param path "path") in
        (match inbox_find id with
         | None -> http_json "{\"error\":\"no such inbox item\"}"
         | Some e -> (try
              let oc = open_out_bin p in output_bytes oc e.ibytes; close_out oc;
              http_json (Printf.sprintf "{\"ok\":true,\"path\":%s,\"bytes\":%d}" (jstr p) e.isize)
            with ex -> http_json (Printf.sprintf "{\"error\":%s}" (jstr (Printexc.to_string ex)))))
      end
      else if starts_with path "/api/inbox" then http_json (inbox_json ())
      else if starts_with path "/mesh/bench" then http_text (mesh_bench path)
      else if starts_with path "/mesh/loadvm" then http_text (mesh_loadvm path)
      else if starts_with path "/mesh/cmd" then http_text (mesh_cmd path)
      else if starts_with path "/editor" then http_html editor_page
      else if path = "/graphics" then http_html page
      else serve_static path
    in
    (try ignore (Unix.write_substring fd resp 0 (String.length resp)) with _ -> ())
  end;
  (try Unix.close fd with _ -> ())

(* Listen dual-stack (IPv4 + IPv6) when possible, so http://localhost/ works
   even when the OS resolves "localhost" to ::1.  Fall back to IPv4-only. *)
let make_listen port =
  try
    let s = Unix.socket Unix.PF_INET6 Unix.SOCK_STREAM 0 in
    Unix.setsockopt s Unix.SO_REUSEADDR true;
    (try Unix.setsockopt s Unix.IPV6_ONLY false with _ -> ());
    Unix.bind s (Unix.ADDR_INET (Unix.inet6_addr_any, port));
    Unix.listen s 16;
    (s, Printf.sprintf "[::]:%d (IPv4+IPv6)" port)
  with _ ->
    let s = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
    Unix.setsockopt s Unix.SO_REUSEADDR true;
    Unix.bind s (Unix.ADDR_INET (Unix.inet_addr_any, port));
    Unix.listen s 16;
    (s, Printf.sprintf "0.0.0.0:%d (IPv4)" port)

(* AIPL の remote("host:port","actor") の受け口。実機 3 台と同じ電文を話すので、
   この Mac をそのまま相手役にできる（板を 1 台ずつ焼きながら確かめられる）。 *)
let remote_listener rt =
  let sock = Unix.socket Unix.PF_INET Unix.SOCK_DGRAM 0 in
  (try Unix.setsockopt sock Unix.SO_REUSEADDR true with _ -> ());
  (try
    Unix.bind sock (Unix.ADDR_INET (Unix.inet_addr_any, 9010));
    Printf.printf "[aice-avm] AIPL remote listening on UDP 9010\n%!"
  with e ->
    Printf.printf "[aice-avm] AIPL remote: UDP 9010 を開けません (%s)\n%!"
      (Printexc.to_string e); raise e);
  (* 応答の控え（at-most-once）。実機は要求を再送するので、素朴に作ると
     アクターのメソッドが二度走る。(送り主, reqid) で最後の答えを覚え、
     同じものが来たら実行せずに返す。 *)
  let answered : (string * string, string) Hashtbl.t = Hashtbl.create 16 in
  let buf = Bytes.create 2048 in
  while true do
    try
      let (n, from) = Unix.recvfrom sock buf 0 (Bytes.length buf) [] in
      let line = String.trim (Bytes.sub_string buf 0 n) in
      if String.length line > 2 && line.[0] = 'Q' && line.[1] = ' ' then begin
        (* Q <reqid> <actor> <method> <arg...> — arg は行末まで *)
        let rest = String.sub line 2 (String.length line - 2) in
        let parts = String.split_on_char ' ' rest in
        match parts with
        | id :: actor :: meth :: argl ->
            let arg = String.concat " " argl in
            let key =
              (match from with
               | Unix.ADDR_INET (a, _) -> Unix.string_of_inet_addr a
               | _ -> "?"), id in
            (* 公開名は "/echo" で登録されている。両方の書き方を受ける。 *)
            let v =
              match Hashtbl.find_opt answered key with
              | Some prev -> prev
              | None ->
              match Avm.remote_dispatch rt actor meth (if arg = "" then [] else [arg]) with
              | Some r -> r
              | None ->
                (match Avm.remote_dispatch rt ("/" ^ actor) meth
                         (if arg = "" then [] else [arg]) with
                 | Some r -> r
                 | None -> "err") in
            Hashtbl.replace answered key v;
            let r = Printf.sprintf "R %s %s\n" id v in
            ignore (Unix.sendto sock (Bytes.of_string r) 0 (String.length r) [] from)
        | _ -> ()
      end
    with _ -> ()
  done

let () =
  Array.iteri (fun i a ->
    if i > 0 then
      if a = "--ask" then ask_default := true
      else if a = "--no-open" then no_open := true
      else (try the_port := int_of_string a with _ -> ())) Sys.argv;
  let rt = Avm.create_runtime io in
  let (s, bind_desc) = make_listen !the_port in
  listen_sock := Some s;     (* so /api/restart can free the port before relaunch *)
  Printf.printf "[aice-avm] receiver listening on %s  (accept-prompt: %s)\n%!"
    bind_desc (if !ask_default then "on" else "off");
  Printf.printf "[aice-avm] graphics window: open  http://localhost:%d/  in your browser.\n%!" !the_port;
  Printf.printf "[aice-avm] across a network / WSL port-forward, use the machine's LAN IP instead, e.g. http://<LAN-IP>:%d/\n%!" !the_port;
  Printf.printf "[aice-avm] send actors with:  send <thishost>:%d samples/Rotate4Lines.abcl\n%!" !the_port;
  (* Open the Xinu desktop UI in the browser right away (respects --no-open). *)
  open_browser ();
  ignore (Thread.create (fun () -> try remote_listener rt with _ -> ()) ());
  while true do
    let (fd, _) = Unix.accept s in
    (* don't leak this client fd into a child spawned by /api/restart *)
    (try Unix.set_close_on_exec fd with _ -> ());
    ignore (Thread.create (fun () -> handle rt fd) ())
  done
