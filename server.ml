(* server.ml — AICE/AIPL dynamic-actor receiver.  Listens for HTTP POSTs of
   .avm actor modules and runs them on the host VM (avm.ml) WITHOUT a recompile
   — the Windows/host counterpart of the Xinu kernel's webactor + VM.

   Endpoints:
     POST /actor/loadvm        body = a .avm module; spawns + runs it, replies
                               "loadvm: body=N accepted=A spawned actor id=K"
                               (append ?ask=0 to skip the accept prompt)
     GET  /api/actors          one line per live actor: id class enq deq

   Build/run:  dune exec ./server.exe -- [PORT] [--ask]
               (default PORT 8080; --ask prompts y/N on the console per actor) *)

let ask_default = ref false   (* set by --ask; ?ask=0 always overrides to skip *)

let console_io : Avm.io = {
  Avm.on_print = (fun id s -> Printf.printf "[vm] a%d: %s\n%!" id s);
  on_line = (fun id x1 y1 x2 y2 col ->
    Printf.printf "[vm] a%d line (%d,%d)-(%d,%d) col=%d\n%!" id x1 y1 x2 y2 col);
  on_cls = (fun () -> Printf.printf "[vm] cls\n%!");
}

(* find substring `sub` in `s`, or -1 *)
let find_sub s sub =
  let ls = String.length s and lu = String.length sub in
  let rec go i = if i + lu > ls then -1
                 else if String.sub s i lu = sub then i else go (i+1) in
  if lu = 0 then 0 else go 0

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

let http_text body =
  Printf.sprintf "HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
    (String.length body) body

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
    let resp =
      if find_sub reqline "/actor/loadvm" >= 0 then begin
        let skip = find_sub reqline "ask=0" >= 0 || find_sub reqline "noask" >= 0 in
        let accepted = if skip || not !ask_default then true else ask_console (String.length body) in
        let id = if accepted then Avm.loadrun rt (Bytes.of_string body) else -1 in
        http_text (Printf.sprintf "loadvm: body=%d accepted=%d spawned actor id=%d\r\n"
                     (String.length body) (if accepted then 1 else 0) id)
      end
      else if find_sub reqline "/api/actors" >= 0 then begin
        let b = Buffer.create 256 in
        Buffer.add_string b "id class enq deq\r\n";
        List.iter (fun (id, c, e, d) -> Buffer.add_string b (Printf.sprintf "%d %d %d %d\r\n" id c e d))
          (Avm.actor_table rt);
        http_text (Buffer.contents b)
      end
      else http_text "aice-avm: try POST /actor/loadvm or GET /api/actors\r\n"
    in
    (try ignore (Unix.write_substring fd resp 0 (String.length resp)) with _ -> ())
  end;
  (try Unix.close fd with _ -> ())

let () =
  let port = ref 8080 in
  Array.iteri (fun i a ->
    if i > 0 then
      if a = "--ask" then ask_default := true
      else (try port := int_of_string a with _ -> ())) Sys.argv;
  let rt = Avm.create_runtime console_io in
  let s = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.setsockopt s Unix.SO_REUSEADDR true;
  Unix.bind s (Unix.ADDR_INET (Unix.inet_addr_any, !port));
  Unix.listen s 16;
  Printf.printf "[aice-avm] receiver listening on 0.0.0.0:%d  (accept-prompt: %s)\n%!"
    !port (if !ask_default then "on" else "off");
  Printf.printf "[aice-avm] send actors with:  dune exec ./send.exe -- <thishost>:%d samples/PingPong.abcl\n%!" !port;
  while true do
    let (fd, _) = Unix.accept s in
    ignore (Thread.create (fun () -> handle rt fd) ())
  done
