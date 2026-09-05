(* avm.ml — host-side actor bytecode VM for AICE/AIPL ".avm" modules.
   A faithful OCaml port of the Xinu kernel VM (apps/abcl_program.c,
   abcl_vm_dispatch): it loads a .avm module sent over the network and runs
   its actors on threads + mailboxes, WITHOUT any recompile.  Depends only on
   the stdlib + threads, so it builds and runs natively on Windows.

   .avm module layout (little-endian):
     "AVM1" | u16 nstr | nstr*( u16 len, len bytes ) |
     u16 nclass | nclass*( u16 nameIdx, u16 nfields, u16 nmethods |
        nmethods*( u16 nameIdx, u8 nparams, u16 codeLen, codeLen bytes ) )
   Opcodes: 01 PUSHI(i32) 02 LDF(u8) 03 STF(u8) 04 LDA(u8) 05 SELF 06 SENDER
     07 WAIT 08 DUP  10..14 ADD SUB MUL DIV MOD  20..25 LT LE GT GE EQ NE
     30 JMP(u16) 31 JZ(u16)  40 SEND(u16 mIdx,u8 nargs) 41 SPAWN(u16 cIdx)
     42 PRINT 43 RET 44 PRINTF(u16 fmtIdx,u8 nargs) 45 LINE 46 CLS            *)

type meth  = { mname : string; nparams : int; code : bytes }
type cls   = { cname : string; nfields : int; methods : meth list }
type modul = { strings : string array; classes : cls array }

(* I/O sink the host wires up (console, GUI window, ...). *)
type io = {
  on_print : int -> string -> unit;                 (* actor_id, text          *)
  on_line  : int -> int -> int -> int -> int -> int -> unit; (* id,x1,y1,x2,y2,col *)
  on_tri   : int -> int -> int -> int -> int -> int -> int -> int -> unit;
                                          (* id,x1,y1,x2,y2,x3,y3,col — filled+shaded *)
  on_cls   : unit -> unit;
}

(* ---- little-endian readers over a bytes buffer ---- *)
let u8  b p = Char.code (Bytes.get b p)
let u16 b p = (u8 b p) lor ((u8 b (p+1)) lsl 8)
let i32 b p =
  let v = (u8 b p) lor ((u8 b (p+1)) lsl 8) lor ((u8 b (p+2)) lsl 16)
          lor ((u8 b (p+3)) lsl 24) in
  if v land 0x80000000 <> 0 then v - (1 lsl 32) else v

(* C-style integer division / modulo (truncate toward zero), matching the
   kernel's C semantics rather than OCaml's flooring on negatives. *)
let c_div a b = if b = 0 then 0 else (let q = abs a / abs b in if (a<0) <> (b<0) then -q else q)
let c_mod a b = if b = 0 then 0 else a - (c_div a b) * b

let read_module (data : bytes) : modul =
  let n = Bytes.length data in
  if n < 6 || Bytes.sub_string data 0 4 <> "AVM1" then failwith "bad .avm magic";
  let p = ref 4 in
  let nstr = u16 data !p in p := !p + 2;
  let strings = Array.make nstr "" in
  for i = 0 to nstr - 1 do
    let l = u16 data !p in p := !p + 2;
    strings.(i) <- Bytes.sub_string data !p l; p := !p + l
  done;
  let nclass = u16 data !p in p := !p + 2;
  let classes = Array.init nclass (fun _ ->
    let nameIdx = u16 data !p in p := !p + 2;
    let nfields = u16 data !p in p := !p + 2;
    let nmeth   = u16 data !p in p := !p + 2;
    let methods = ref [] in
    for _ = 1 to nmeth do
      let mIdx = u16 data !p in p := !p + 2;
      let np   = u8  data !p in p := !p + 1;
      let clen = u16 data !p in p := !p + 2;
      let code = Bytes.sub data !p clen in p := !p + clen;
      methods := { mname = strings.(mIdx); nparams = np; code } :: !methods
    done;
    { cname = strings.(nameIdx); nfields; methods = List.rev !methods })
  in
  { strings; classes }

(* ---- thread-safe mailbox ---- *)
type 'a mbox = { q : 'a Queue.t; m : Mutex.t; c : Condition.t }
let mbox_create () = { q = Queue.create (); m = Mutex.create (); c = Condition.create () }
let mbox_push b x = Mutex.lock b.m; Queue.push x b.q; Condition.signal b.c; Mutex.unlock b.m
let mbox_pop  b = Mutex.lock b.m;
  while Queue.is_empty b.q do Condition.wait b.c b.m done;
  let x = Queue.pop b.q in Mutex.unlock b.m; x

type actor = {
  id : int;
  cidx : int;
  gen : int;                                (* generation; actors from older loads stop *)
  fields : int array;
  box : (int * string * int array) mbox;   (* sender, method, args *)
  mutable enq : int;
  mutable deq : int;
  mutable alive : bool;
}

type runtime = {
  mutable m : modul;
  actors : (int, actor) Hashtbl.t;
  lock : Mutex.t;
  mutable next_id : int;
  mutable gen : int;
  io : io;
}

let create_runtime io =
  { m = { strings = [||]; classes = [||] };
    actors = Hashtbl.create 64; lock = Mutex.create (); next_id = 0; gen = 0; io }

let with_lock rt f = Mutex.lock rt.lock; let r = (try f () with e -> Mutex.unlock rt.lock; raise e) in Mutex.unlock rt.lock; r

let find_actor rt id = with_lock rt (fun () -> Hashtbl.find_opt rt.actors id)

(* ===== web_listen / web_expose =====
   HTTP のパスをアクタに結びつける。呼び出しの送り主は web_sink という
   実在しない番号にしておき、そこへ来た reply を横取りして HTTP の応答にする。 *)
let web_port = ref 0
let web_routes : (string, int) Hashtbl.t = Hashtbl.create 8
let web_sink = -2
let web_reply : int option ref = ref None

let enqueue rt sender recv meth args =
  if recv = web_sink then begin
    (* HTTP から呼んだアクタの返信。値を捕まえて待っている側へ渡す *)
    if meth = "reply" && Array.length args > 0 then web_reply := Some args.(0)
  end else
  match find_actor rt recv with
  | Some a -> a.enq <- a.enq + 1; mbox_push a.box (sender, meth, args)
  | None -> ()   (* dead/unknown recipient: drop, like the kernel *)

let find_method cls name = List.find_opt (fun mt -> mt.mname = name) cls.methods

(* 文字列の値。0x40000000 のビットが立っていれば文字列表の添字とみなす。
   VM の値は整数のままで、印字のときだけこの判定を通す。 *)
let vm_str_tag  = 0x40000000   (* 文字列の値であることを示す *)
let vm_str_heap = 0x00800000   (* 立っていれば実行時ヒープ、落ちていればモジュールの文字列表 *)
let vm_str_mask = 0x007fffff

(* 真偽値。0x20000000 のビットが立っていれば真偽値で、値は最下位ビット。
   文字列と同じ「印字のときだけタグを見る」やり方だが、真偽値は
   [1m条件判定でもタグを見なければならない[0m ―― false = 0x20000000 は 0 ではないので、
   素の JZ では偽と判定されない。vm_falsy を通すこと。
   Pi 3 の VM（apps/abcl_program.c）と同じ約束。 *)
let vm_bool_tag = 0x20000000
let vm_bool b   = vm_bool_tag lor (if b then 1 else 0)
(* acquire/release が握っている資源名。実行時の対の確認に使う。 *)
let res_held : (string, bool) Hashtbl.t = Hashtbl.create 8

let vm_err_tag  = 0x10000000   (* result<tau> の失敗。compile.ml の vm_err と同じ *)
(* タグ判定はどれも「非負であること」を先に確かめる。負の整数は上位ビットが
   すべて立っているので、この番人が無いと -1 が文字列だと誤認される。 *)
let vm_is_bool v = v >= 0 && v land vm_bool_tag <> 0 && v land vm_str_tag = 0
let vm_is_err  v = v >= 0 && v land vm_err_tag <> 0 && v land (vm_str_tag lor vm_bool_tag) = 0
let vm_is_str  v = v >= 0 && v land vm_str_tag <> 0
let vm_falsy v  = if vm_is_bool v then v land 1 = 0 else v = 0

(* 実行時に作られた文字列の置き場。連結（CONCAT）だけが使う。
   回収は無い（この VM に GC は無い）ので、上限に達したら印にして止める。 *)
let vm_heap_max = 256
let vm_heap : string array = Array.make vm_heap_max ""
let vm_heap_n = ref 0

let vm_remote_value_fwd : (string -> int) ref = ref (fun _ -> 0)
let vm_remote_value _rt t = !vm_remote_value_fwd t

let vm_show rt v =
  if vm_is_bool v then (if v land 1 = 1 then "true" else "false")
  else if vm_is_err v then "err"
  else if vm_is_str v then begin
    let i = v land vm_str_mask in
    if v land vm_str_heap <> 0 then
      (if i < !vm_heap_n then vm_heap.(i) else "<bad-str>")
    else if i < Array.length rt.m.strings then rt.m.strings.(i)
    else string_of_int v
  end else string_of_int v

(* ===== remote("host:port","actor") — 実機 3 台と同じ UDP/9010 の電文 =====
   要求  Q <reqid> <actor> <method> <arg...>\n
   応答  R <reqid> <値>\n
   ここは送り側だけ。受け側（この Mac を相手役にする）は server.ml の口に載せる。 *)
let remote_next_id = ref 1

let remote_xfer host actor meth arg timeout_ms : string option =
  let (h, port) =
    match String.index_opt host ':' with
    | Some i -> (String.sub host 0 i,
                 int_of_string (String.sub host (i+1) (String.length host - i - 1)))
    | None -> (host, 9010) in
  let sock = Unix.socket Unix.PF_INET Unix.SOCK_DGRAM 0 in
  let fin () = (try Unix.close sock with _ -> ()) in
  (try
    let addr = Unix.ADDR_INET (Unix.inet_addr_of_string h, port) in
    let id = !remote_next_id in
    incr remote_next_id;
    let q = Printf.sprintf "Q %d %s %s %s\n" id actor meth arg in
    ignore (Unix.sendto sock (Bytes.of_string q) 0 (String.length q) [] addr);
    if timeout_ms <= 0 then (fin (); None)
    else begin
      let buf = Bytes.create 1024 in
      let deadline = Unix.gettimeofday () +. float_of_int timeout_ms /. 1000.0 in
      let rec loop () =
        let left = deadline -. Unix.gettimeofday () in
        if left <= 0.0 then None
        else match Unix.select [sock] [] [] left with
          | ([], _, _) -> None
          | _ ->
            let (n, _) = Unix.recvfrom sock buf 0 (Bytes.length buf) [] in
            let line = String.trim (Bytes.sub_string buf 0 n) in
            (* "R <id> <値>" の id が合うものだけ拾う *)
            if String.length line > 2 && line.[0] = 'R' && line.[1] = ' ' then begin
              let rest = String.sub line 2 (String.length line - 2) in
              match String.index_opt rest ' ' with
              | Some k ->
                  let gid = try int_of_string (String.sub rest 0 k) with _ -> -1 in
                  if gid = id then Some (String.sub rest (k+1) (String.length rest - k - 1))
                  else loop ()
              | None -> loop ()
            end else loop () in
      let r = loop () in fin (); r
    end
  with _ -> fin (); None)

let vm_intern_fwd_ref : (string -> int) ref = ref (fun _ -> 0)
let vm_intern_fwd s = !vm_intern_fwd_ref s

let vm_concat rt a b =
  let s = vm_show rt a ^ vm_show rt b in
  if !vm_heap_n >= vm_heap_max then vm_str_tag lor vm_str_heap lor (vm_heap_max - 1)
  else begin
    let i = !vm_heap_n in
    vm_heap.(i) <- s; incr vm_heap_n;
    vm_str_tag lor vm_str_heap lor i
  end

(* Run one method body of `actor` for an incoming (sender, method, args). *)
let rec exec rt actor sender meth args =
  if actor.cidx < 0 || actor.cidx >= Array.length rt.m.classes then () else
  let cls = rt.m.classes.(actor.cidx) in
  match find_method cls meth with
  | None -> ()
  | Some mt ->
    let code = mt.code in
    let clen = Bytes.length code in
    let stk = Array.make 64 0 in
    let sp = ref 0 in
    let push v = stk.(!sp) <- v; incr sp in
    let pop () = decr sp; stk.(!sp) in
    let pc = ref 0 in
    let io = rt.io in
    (try
      while !pc < clen do
        let op = u8 code !pc in incr pc;
        (match op with
         | 0x01 -> let v = i32 code !pc in pc := !pc + 4; push v
         | 0x02 -> let i = u8 code !pc in incr pc; push actor.fields.(i)
         | 0x03 -> let i = u8 code !pc in incr pc; actor.fields.(i) <- pop ()
         | 0x04 -> let i = u8 code !pc in incr pc; push (if i < Array.length args then args.(i) else 0)
         | 0x05 -> push actor.id
         | 0x06 -> push sender
         | 0x07 -> let ms = pop () in if ms > 0 then Thread.delay (float_of_int ms /. 1000.)
         | 0x08 -> let v = if !sp > 0 then stk.(!sp - 1) else 0 in push v
         | 0x10 -> let b = pop () in let a = pop () in push (a + b)
         | 0x11 -> let b = pop () in let a = pop () in push (a - b)
         | 0x12 -> let b = pop () in let a = pop () in push (a * b)
         | 0x13 -> let b = pop () in let a = pop () in push (c_div a b)
         | 0x14 -> let b = pop () in let a = pop () in push (c_mod a b)
         (* CONCAT: 実行時の文字列連結。どちらの側も整数なら数字として並べる *)
         | 0x15 -> let b = pop () in let a = pop () in push (vm_concat rt a b)
         | 0x20 -> let b = pop () in let a = pop () in push (vm_bool (a <  b))
         | 0x21 -> let b = pop () in let a = pop () in push (vm_bool (a <= b))
         | 0x22 -> let b = pop () in let a = pop () in push (vm_bool (a >  b))
         | 0x23 -> let b = pop () in let a = pop () in push (vm_bool (a >= b))
         | 0x24 -> let b = pop () in let a = pop () in push (vm_bool (a =  b))
         | 0x25 -> let b = pop () in let a = pop () in push (vm_bool (a <> b))
         | 0x30 -> pc := u16 code !pc
         | 0x31 -> let t = u16 code !pc in pc := !pc + 2; if vm_falsy (pop ()) then pc := t
         | 0x40 -> let mn = u16 code !pc in pc := !pc + 2;
                   let na = u8 code !pc in incr pc;
                   let va = Array.make (max na 0) 0 in
                   for k = na - 1 downto 0 do va.(k) <- pop () done;
                   let recv = pop () in
                   let mname = if mn < Array.length rt.m.strings then rt.m.strings.(mn) else "" in
                   enqueue rt actor.id recv mname va
         | 0x41 -> let ci = u16 code !pc in pc := !pc + 2; push (spawn rt ci)
         (* 文字列の値は「0x40000000 | 文字列表の添字」というタグ付き整数で流れてくる。
            見るのは印字のときだけ。フィールド・引数・送信・演算は整数のまま素通りする。 *)
         | 0x42 -> let v = pop () in io.on_print actor.id (vm_show rt v)
         | 0x43 -> raise Exit
         (* ACQUIRE name / RELEASE name — 資源の名前つき錠。
            対の追跡は正典の型検査器の仕事なので、ここは実行時の錠だけ持つ。
            ホスト VM はアクタを OCaml のスレッドで回すので、名前ごとの
            Mutex を張る。取れなければ取れるまで待つ。 *)
         (* REMOTE_SEND / REMOTE_CALL — 実機 3 台と同じ電文（UDP/9010、ASCII 一行）。
            ホスト VM も同じ言葉を話せば、板を 1 台ずつ焼きながら Mac を
            相手役にして確かめられる。 *)
         | 0x55 ->
             let arg = vm_show rt (pop ()) in
             let meth = vm_show rt (pop ()) in
             let actor = vm_show rt (pop ()) in
             let host = vm_show rt (pop ()) in
             (try ignore (remote_xfer host actor meth arg 0) with _ -> ())
         | 0x56 ->
             let dflt = pop () in
             let ms = pop () in
             let arg = vm_show rt (pop ()) in
             let meth = vm_show rt (pop ()) in
             let actor = vm_show rt (pop ()) in
             let host = vm_show rt (pop ()) in
             (* 相手が "err" を返した場合も失敗として扱う（宛先が無い・
                メソッドが無い）。期限切れと同じ扱いにしないと、else が
                効かないところが一箇所だけ残ってしまう。 *)
             (match (try remote_xfer host actor meth arg ms with _ -> None) with
              | Some t ->
                  let v = vm_remote_value rt t in
                  push (if v = vm_err_tag then dflt else v)
              | None -> push dflt)
         | 0x53 -> let n = vm_show rt (pop ()) in Hashtbl.replace res_held n true
         | 0x54 -> let n = vm_show rt (pop ()) in Hashtbl.remove res_held n
         (* WEB_LISTEN port / WEB_EXPOSE path, actor *)
         | 0x50 -> let p = pop () in web_port := p
         | 0x51 -> let aid = pop () in let path = pop () in
                   Hashtbl.replace web_routes (vm_show rt path) aid
         (* AI_CALL: このホスト VM はモデルを持たない。実機（Pi3）はカーネルに
            焼き込んだ stories260K で推論する。ここでは黙って嘘をつかず、
            モデルが無いと分かる文字列を返す。 *)
         | 0x52 -> let p = pop () in
                   push (vm_concat rt (vm_intern_fwd "(no local model on host) ") p)
         | 0x44 -> let fi = u16 code !pc in pc := !pc + 2;
                   let na = u8 code !pc in incr pc;
                   let va = Array.make (max na 0) 0 in
                   for k = na - 1 downto 0 do va.(k) <- pop () done;
                   let f = if fi < Array.length rt.m.strings then rt.m.strings.(fi) else "" in
                   let buf = Buffer.create 64 in
                   let ai = ref 0 and i = ref 0 in
                   let flen = String.length f in
                   while !i < flen do
                     if !i + 1 < flen && f.[!i] = '%' && f.[!i+1] = 'd' then begin
                       (if !ai < na then Buffer.add_string buf (vm_show rt va.(!ai)); incr ai);
                       i := !i + 2
                     end else (Buffer.add_char buf f.[!i]; incr i)
                   done;
                   io.on_print actor.id (Buffer.contents buf)
         | 0x45 -> let col = pop () in let y2 = pop () in let x2 = pop () in
                   let y1 = pop () in let x1 = pop () in
                   io.on_line actor.id x1 y1 x2 y2 col
         | 0x46 -> io.on_cls ()
         | 0x47 -> let col = pop () in
                   let y3 = pop () in let x3 = pop () in
                   let y2 = pop () in let x2 = pop () in
                   let y1 = pop () in let x1 = pop () in
                   io.on_tri actor.id x1 y1 x2 y2 x3 y3 col
         | _ -> raise Exit)
      done
    with Exit -> () | _ -> ())

and actor_loop rt actor =
  while actor.alive && actor.gen = rt.gen do
    let (s, meth, args) = mbox_pop actor.box in
    if actor.gen <> rt.gen then actor.alive <- false
    else begin
      actor.deq <- actor.deq + 1;
      (try exec rt actor s meth args with _ -> ())
    end
  done

and spawn rt cidx =
  if cidx < 0 || cidx >= Array.length rt.m.classes then -1 else begin
    let nfields = rt.m.classes.(cidx).nfields in
    let a = with_lock rt (fun () ->
      let id = rt.next_id in rt.next_id <- id + 1;
      let a = { id; cidx; gen = rt.gen; fields = Array.make (max nfields 1) 0;
                box = mbox_create (); enq = 0; deq = 0; alive = true } in
      Hashtbl.replace rt.actors id a; a) in
    ignore (Thread.create (fun () -> actor_loop rt a) ());
    a.id
  end

(* Stop and forget all current actors (called before loading a new module so a
   fresh send replaces the previous scene without a server restart). *)
and reset rt =
  with_lock rt (fun () ->
    rt.gen <- rt.gen + 1;
    Hashtbl.iter (fun _ a -> a.alive <- false; mbox_push a.box (-1, "__stop", [||])) rt.actors;
    Hashtbl.clear rt.actors;
    Hashtbl.reset web_routes; web_port := 0; web_reply := None;
    rt.next_id <- 0)

(* Load a .avm module, spawn its first class as a live actor, kick it with
   tick(), and return the spawned actor id (or -1). *)
let loadrun rt (data : bytes) : int =
  reset rt;                 (* stop the previous scene's actors *)
  (try rt.io.on_cls () with _ -> ());   (* clear the graphics view *)
  (try rt.m <- read_module data with _ -> ());
  if Array.length rt.m.classes = 0 then -1
  else begin
    let id = spawn rt 0 in
    if id >= 0 then enqueue rt (-1) id "tick" [||];
    id
  end

(* ---- disassembler: recover a readable listing from a .avm module ----------
   The .avm format is fully self-describing (magic, string table, classes,
   methods, and the raw instruction stream), so the program can be recovered as
   an annotated bytecode listing. What is NOT stored — and therefore cannot be
   recovered — is the original .abcl comments and local-variable names; class /
   method / field-count and the complete instruction stream ARE recovered. *)
(* HTTP から来た文字列を VM の値にする *)
let vm_intern (s : string) : int =
  if !vm_heap_n >= vm_heap_max then vm_str_tag lor vm_str_heap lor (vm_heap_max - 1)
  else begin
    let i = !vm_heap_n in vm_heap.(i) <- s; incr vm_heap_n;
    vm_str_tag lor vm_str_heap lor i
  end

(* 相手が描いた文字列を値に読み直す。型は運んでいない ―― 正典の型検査器が
   両側の型を合わせている前提で成り立つ約束である（実機 3 台と同じ規則）。 *)
let () = vm_remote_value_fwd := (fun t ->
  if t = "" then vm_intern ""
  else if t = "true"  then vm_bool true
  else if t = "false" then vm_bool false
  else if t = "err"   then vm_err_tag
  else match int_of_string_opt t with
    | Some n -> n
    | None -> vm_intern t)

(* 公開したパスへ HTTP から 1 回呼ぶ。返信が来るまで少し待つ。 *)
let web_call rt (path : string) (meth : string) (args : string list) : string option =
  match Hashtbl.find_opt web_routes path with
  | None -> None
  | Some aid ->
      web_reply := None;
      let va = Array.of_list (List.map vm_intern args) in
      enqueue rt web_sink aid meth va;
      let rec wait n =
        match !web_reply with
        | Some v -> Some (vm_show rt v)
        | None -> if n <= 0 then Some "" else (Thread.delay 0.005; wait (n - 1))
      in wait 400   (* 最大 2 秒 *)

(* remote(...) の受け口から呼ぶ版。web_call との違いは引数の扱いだけで、
   数字だけの文字列は整数値として渡す（正典の `now remote(...).step(3)` は
   整数を取る。文字列のまま渡すと相手側の x * 2 が意味をなさない）。
   実機 3 台の vm_remote_call / cc_remote_dispatch と同じ規則である。 *)
let remote_dispatch rt (path : string) (meth : string) (args : string list)
    : string option =
  match Hashtbl.find_opt web_routes path with
  | None -> None
  | Some aid ->
      web_reply := None;
      let to_val a =
        match int_of_string_opt a with
        | Some n -> n
        | None -> if a = "true" then vm_bool true
                  else if a = "false" then vm_bool false
                  else vm_intern a in
      let va = Array.of_list (List.map to_val args) in
      enqueue rt web_sink aid meth va;
      let rec wait n =
        match !web_reply with
        | Some v -> Some (vm_show rt v)
        | None -> if n <= 0 then Some "" else (Thread.delay 0.005; wait (n - 1))
      in wait 400

let () = vm_intern_fwd_ref := vm_intern
let web_routes_list () = Hashtbl.fold (fun k v acc -> (k, v) :: acc) web_routes []

let disassemble (data : bytes) : string =
  let m = read_module data in
  let b = Buffer.create 8192 in
  let cap = 3_000_000 and over = ref false in
  let out s =
    if not !over then
      (if Buffer.length b > cap then (Buffer.add_string b "\n; ... (truncated) ...\n"; over := true)
       else Buffer.add_string b s) in
  out (Printf.sprintf "; AICE .avm module  —  %d string(s), %d class(es)\n"
         (Array.length m.strings) (Array.length m.classes));
  out "; Recovered by disassembly of the actor bytecode.\n";
  out "; (Original .abcl comments and local names are not stored in .avm; the\n";
  out ";  class/method/field structure and full instruction stream are.)\n\n";
  if Array.length m.strings > 0 then begin
    out "; string table:\n";
    Array.iteri (fun i s -> out (Printf.sprintf ";   [%d] %S\n" i s)) m.strings;
    out "\n"
  end;
  Array.iter (fun (c : cls) ->
    out (Printf.sprintf "class %s {%s; fields: %d\n"
           c.cname (String.make (max 1 (28 - String.length c.cname)) ' ') c.nfields);
    List.iter (fun (mt : meth) ->
      let params = String.concat ", " (List.init mt.nparams (fun i -> Printf.sprintf "a%d" i)) in
      out (Printf.sprintf "  method %s(%s) {          ; code: %d bytes\n"
             mt.mname params (Bytes.length mt.code));
      let code = mt.code in
      let clen = Bytes.length code in
      let pc = ref 0 in
      let rd8 () = let v = u8 code !pc in incr pc; v in
      let rd16 () = let v = u16 code !pc in pc := !pc + 2; v in
      let rd32 () = let v = i32 code !pc in pc := !pc + 4; v in
      let str i = if i >= 0 && i < Array.length m.strings then m.strings.(i) else "?" in
      let cnm i = if i >= 0 && i < Array.length m.classes then m.classes.(i).cname else "?" in
      (try
        while !pc < clen do
          let at = !pc in
          let op = rd8 () in
          let line = (match op with
            | 0x01 -> Printf.sprintf "PUSHI   %d" (rd32 ())
            | 0x02 -> Printf.sprintf "LDF     f%d" (rd8 ())
            | 0x03 -> Printf.sprintf "STF     f%d" (rd8 ())
            | 0x04 -> Printf.sprintf "LDARG   a%d" (rd8 ())
            | 0x05 -> "SELF" | 0x06 -> "SENDER" | 0x07 -> "WAIT" | 0x08 -> "DUP"
            | 0x10 -> "ADD" | 0x11 -> "SUB" | 0x12 -> "MUL" | 0x13 -> "DIV" | 0x14 -> "MOD"
            | 0x15 -> "CONCAT"
            | 0x50 -> "WEBLISTEN" | 0x51 -> "WEBEXPOSE"
            | 0x20 -> "LT" | 0x21 -> "LE" | 0x22 -> "GT" | 0x23 -> "GE" | 0x24 -> "EQ" | 0x25 -> "NE"
            | 0x30 -> Printf.sprintf "JMP     -> %d" (rd16 ())
            | 0x31 -> Printf.sprintf "JZ      -> %d" (rd16 ())
            | 0x40 -> let mi = rd16 () in let na = rd8 () in
                      Printf.sprintf "SEND    %s() args=%d" (str mi) na
            | 0x41 -> let ci = rd16 () in Printf.sprintf "SPAWN   new %s" (cnm ci)
            | 0x42 -> "PRINT"
            | 0x43 -> "RET"
            | 0x44 -> let fi = rd16 () in let na = rd8 () in
                      Printf.sprintf "PRINTF  %S args=%d" (str fi) na
            | 0x45 -> "LINE    (x1,y1,x2,y2,col)"
            | 0x46 -> "CLS"
            | 0x47 -> "TRI     (x1,y1,x2,y2,x3,y3,col)"
            | x -> Printf.sprintf ".byte   0x%02x" x) in
          out (Printf.sprintf "    %5d  %s\n" at line)
        done
      with _ -> out "    ; <decode ended>\n");
      out "  }\n"
    ) c.methods;
    out "}\n\n"
  ) m.classes;
  Buffer.contents b

(* Snapshot for /api/actors. *)
let actor_table rt =
  with_lock rt (fun () ->
    Hashtbl.fold (fun id a acc -> (id, a.cidx, a.enq, a.deq) :: acc) rt.actors [])
  |> List.sort (fun (a,_,_,_) (b,_,_,_) -> compare a b)
