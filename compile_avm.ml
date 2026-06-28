(* compile_avm.ml — compile an .abcl source to a .avm module file (for chunked
   upload to a Xinu board's kernel AVM VM via /actor/loadvm). *)
let () =
  if Array.length Sys.argv < 3 then (prerr_endline "usage: compile_avm IN.abcl OUT.avm"; exit 2);
  let avm = Compile.compile_file Sys.argv.(1) in
  let oc = open_out_bin Sys.argv.(2) in
  output_bytes oc avm; close_out oc;
  Printf.printf "compiled %s -> %s (%d bytes)\n" Sys.argv.(1) Sys.argv.(2) (Bytes.length avm)
