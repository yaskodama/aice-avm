(* send.ml — AICE/AIPL actor sender.  Compiles an .abcl source to a .avm module
   (or reads a ready .avm) and POSTs it to a running receiver (server.ml or the
   Xinu webactor), which spawns and runs it.  Pure stdlib sockets, so it needs
   no curl and runs the same on Windows / macOS / Linux.

   Usage:  dune exec ./send.exe -- HOST:PORT FILE[.abcl|.avm] [--noask]
   e.g.    dune exec ./send.exe -- 127.0.0.1:8080 samples/PingPong.abcl
           dune exec ./send.exe -- 192.168.3.50:8080 samples/PingPong.avm --noask *)

let ends_with s suf =
  let ls = String.length s and lf = String.length suf in
  ls >= lf && String.sub s (ls - lf) lf = suf

let read_file path =
  let ic = open_in_bin path in
  let n = in_channel_length ic in
  let s = really_input_string ic n in
  close_in ic; s

let resolve_host h =
  try Unix.inet_addr_of_string h
  with _ -> (Unix.gethostbyname h).Unix.h_addr_list.(0)

let post host port path (body : string) : string =
  let addr = Unix.ADDR_INET (resolve_host host, port) in
  let fd = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.connect fd addr;
  let req = Printf.sprintf
      "POST %s HTTP/1.0\r\nHost: %s:%d\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
      path host port (String.length body) ^ body in
  ignore (Unix.write_substring fd req 0 (String.length req));
  let buf = Buffer.create 4096 in
  let chunk = Bytes.create 4096 in
  let rec drain () =
    let k = Unix.read fd chunk 0 (Bytes.length chunk) in
    if k > 0 then (Buffer.add_subbytes buf chunk 0 k; drain ()) in
  (try drain () with _ -> ());
  (try Unix.close fd with _ -> ());
  Buffer.contents buf

let () =
  if Array.length Sys.argv < 3 then begin
    prerr_endline "usage: send HOST:PORT FILE[.abcl|.avm] [--noask]"; exit 2
  end;
  let hostport = Sys.argv.(1) and file = Sys.argv.(2) in
  let noask = Array.exists (fun a -> a = "--noask") Sys.argv in
  let (host, port) =
    match String.index_opt hostport ':' with
    | Some i -> (String.sub hostport 0 i,
                 int_of_string (String.sub hostport (i+1) (String.length hostport - i - 1)))
    | None -> (hostport, 8080) in
  let avm =
    if ends_with file ".avm" then read_file file
    else (Printf.printf "[send] compiling %s -> .avm\n%!" file;
          Bytes.to_string (Compile.compile_file file)) in
  Printf.printf "[send] POST %d bytes to %s:%d/actor/loadvm\n%!" (String.length avm) host port;
  let path = "/actor/loadvm" ^ (if noask then "?ask=0" else "") in
  let resp = post host port path avm in
  let body = match String.index_opt resp '\r' with
    | Some _ -> (match
        (let rec f i = if i+3 < String.length resp && String.sub resp i 4 = "\r\n\r\n" then Some (i+4) else if i+4 >= String.length resp then None else f (i+1) in f 0)
        with Some b -> String.sub resp b (String.length resp - b) | None -> resp)
    | None -> resp in
  print_string (if String.length body > 0 then body else resp);
  print_newline ()
