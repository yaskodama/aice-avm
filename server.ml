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
let gw = 480 and gh = 400
let glock = Mutex.create ()
let glines : (int*int*int*int*int) list ref = ref []
let gopened = ref false

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
    Printf.printf "[aice-avm] graphics window: http://localhost:%d/\n%!" !the_port
  end

let io : Avm.io = {
  Avm.on_print = (fun id s -> Printf.printf "[vm] a%d: %s\n%!" id s);
  on_line = (fun _id x1 y1 x2 y2 col ->
    Mutex.lock glock; glines := (x1,y1,x2,y2,col) :: !glines; Mutex.unlock glock;
    open_browser ());
  on_cls = (fun () -> Mutex.lock glock; glines := []; Mutex.unlock glock; open_browser ());
}

let lines_json () =
  Mutex.lock glock; let ls = !glines in Mutex.unlock glock;
  let b = Buffer.create 256 in
  Buffer.add_string b (Printf.sprintf "{\"w\":%d,\"h\":%d,\"lines\":[" gw gh);
  List.iteri (fun i (x1,y1,x2,y2,c) ->
    if i > 0 then Buffer.add_char b ',';
    Buffer.add_string b (Printf.sprintf "[%d,%d,%d,%d,%d]" x1 y1 x2 y2 c)) ls;
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
var col={1:'#ff5a5a',2:'#5aa0ff',3:'#5ad05a',4:'#ffd23c',0:'#dddddd'};
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

let http resp_ctype body =
  Printf.sprintf "HTTP/1.0 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
    resp_ctype (String.length body) body
let http_text = http "text/plain"
let http_json = http "application/json"
let http_html = http "text/html; charset=utf-8"

let ask_console nbytes =
  Printf.printf "[server] incoming actor binary: %d bytes — accept and run? [y/N] %!" nbytes;
  (try match String.trim (String.lowercase_ascii (input_line stdin)) with
       | "y" | "yes" -> true | _ -> false
   with End_of_file -> false)

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
    let resp =
      if starts_with path "/actor/loadvm" then begin
        let skip = find_sub path "ask=0" >= 0 || find_sub path "noask" >= 0 in
        let accepted = if skip || not !ask_default then true else ask_console (String.length body) in
        let id = if accepted then Avm.loadrun rt (Bytes.of_string body) else -1 in
        http_text (Printf.sprintf "loadvm: body=%d accepted=%d spawned actor id=%d\r\n"
                     (String.length body) (if accepted then 1 else 0) id)
      end
      else if starts_with path "/api/lines" then http_json (lines_json ())
      else if starts_with path "/api/actors" then begin
        let b = Buffer.create 256 in
        Buffer.add_string b "id class enq deq\r\n";
        List.iter (fun (id, c, e, d) -> Buffer.add_string b (Printf.sprintf "%d %d %d %d\r\n" id c e d))
          (Avm.actor_table rt);
        http_text (Buffer.contents b)
      end
      else if path = "/" || starts_with path "/?" || starts_with path "/index" then http_html page
      else http_text "aice-avm: GET / (graphics) | POST /actor/loadvm | GET /api/actors\r\n"
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

let () =
  Array.iteri (fun i a ->
    if i > 0 then
      if a = "--ask" then ask_default := true
      else if a = "--no-open" then no_open := true
      else (try the_port := int_of_string a with _ -> ())) Sys.argv;
  let rt = Avm.create_runtime io in
  let (s, bind_desc) = make_listen !the_port in
  Printf.printf "[aice-avm] receiver listening on %s  (accept-prompt: %s)\n%!"
    bind_desc (if !ask_default then "on" else "off");
  Printf.printf "[aice-avm] graphics window: open  http://localhost:%d/  in your browser.\n%!" !the_port;
  Printf.printf "[aice-avm] across a network / WSL port-forward, use the machine's LAN IP instead, e.g. http://<LAN-IP>:%d/\n%!" !the_port;
  Printf.printf "[aice-avm] send actors with:  send <thishost>:%d samples/Rotate4Lines.abcl\n%!" !the_port;
  while true do
    let (fd, _) = Unix.accept s in
    ignore (Thread.create (fun () -> handle rt fd) ())
  done
