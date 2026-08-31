(* compile.ml — a small, self-contained AIPL(.abcl subset) -> .avm compiler.
   A standalone port of the project's avm_gen.ml that carries its OWN lexer +
   parser + codegen, so it needs nothing but the OCaml stdlib (no big AST /
   type checker).  Supported subset (what the kernel/host VM can run):
     - classes with integer/actor-id fields, methods with int params
     - arithmetic + comparison:  + - * / %  < <= > >= == !=
     - if / if-else ; while (cond) do stmt ; assignment to a field
     - send tgt.m(args)        (tgt = self | sender | a field/param actor id)
     - new C(args)             (spawn; if args, also send it init(args))
     - print(e)                (string-concat of literals + ints -> printf)
     - wait(ms) ; line(x1,y1,x2,y2,col) ; cls()                              *)

(* ===== AST ===== *)
type expr = Int of int | Var of string | Str of string
          | Bin of string * expr * expr | New of string * expr list | Call of string * expr list
          | Now of string * string * expr list * (expr * expr) option
            (* now t.m(args) [timeout ms else v] — 継続分割で実現する *)
          | Future of string * string * expr list          (* future t.m(args) — 送るだけ *)
          | Await of expr * (expr * expr) option           (* await f [timeout ms else v] *)
type stmt = Assign of string * expr | If of expr * stmt * stmt | While of expr * stmt
          | Block of stmt list | Send of string * string * expr list
          | CallS of string * expr list | Nop
          | LocalDecl of string * expr option   (* メソッド局所 var *)
type meth = { mn : string; params : string list; body : stmt;
              mlocals : string list }           (* このメソッドが宣言した局所名 *)
type cls  = { cn : string; fields : string list; meths : meth list;
              finits : (string * expr) list }   (* var f = e; の初期値 *)

(* ===== Lexer ===== *)
type tok = TINT of int | TID of string | TSTR of string
         | LB | RB | LP | RP | SEMI | COMMA | DOT
         | EQ2 | NE | LE | GE | LT | GT | ASSIGN
         | PLUS | MINUS | STAR | SLASH | PCT | EOF
         | COLON | BANG | AT   (* 現行 AIPL の注釈用: `: T` / `!{...}` / `@ N` *)

let lex (s : string) : tok array =
  let n = String.length s in
  let i = ref 0 in
  let toks = ref [] in
  let emit t = toks := t :: !toks in
  let is_id0 c = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c = '_' in
  let is_idc c = is_id0 c || (c >= '0' && c <= '9') in
  let is_dig c = c >= '0' && c <= '9' in
  while !i < n do
    let c = s.[!i] in
    if c = ' ' || c = '\t' || c = '\r' || c = '\n' then incr i
    else if c = '/' && !i + 1 < n && s.[!i+1] = '/' then
      (while !i < n && s.[!i] <> '\n' do incr i done)
    else if is_dig c then begin
      let j = ref !i in while !j < n && is_dig s.[!j] do incr j done;
      emit (TINT (int_of_string (String.sub s !i (!j - !i)))); i := !j
    end
    else if is_id0 c then begin
      let j = ref !i in while !j < n && is_idc s.[!j] do incr j done;
      let w = String.sub s !i (!j - !i) in
      (* 現行 AIPL の真偽値リテラル。AVM は真偽値を整数で持つ *)
      (match w with
       | "true"  -> emit (TINT 1)
       | "false" -> emit (TINT 0)
       | _       -> emit (TID w));
      i := !j
    end
    else if c = '"' then begin
      let b = Buffer.create 16 in incr i;
      while !i < n && s.[!i] <> '"' do
        if s.[!i] = '\\' && !i + 1 < n then begin
          incr i;
          (match s.[!i] with
           | 'n' -> Buffer.add_char b '\n'
           | 't' -> Buffer.add_char b '\t'
           | x -> Buffer.add_char b x)
        end else Buffer.add_char b s.[!i];
        incr i
      done;
      incr i; emit (TSTR (Buffer.contents b))
    end
    else begin
      let two = if !i + 1 < n then String.sub s !i 2 else "" in
      (match two with
       | "++" -> emit PLUS; i := !i + 2   (* 文字列連結。ここでは + が連結を担う *)
       | "==" -> emit EQ2; i := !i + 2
       | "!=" -> emit NE;  i := !i + 2
       | "<=" -> emit LE;  i := !i + 2
       | ">=" -> emit GE;  i := !i + 2
       | _ ->
         (match c with
          | '{' -> emit LB | '}' -> emit RB | '(' -> emit LP | ')' -> emit RP
          | ';' -> emit SEMI | ',' -> emit COMMA | '.' -> emit DOT
          | '=' -> emit ASSIGN | '<' -> emit LT | '>' -> emit GT
          | '+' -> emit PLUS | '-' -> emit MINUS | '*' -> emit STAR
          | '/' -> emit SLASH | '%' -> emit PCT
          | ':' -> emit COLON | '!' -> emit BANG | '@' -> emit AT
          | _ -> failwith (Printf.sprintf "lex: unexpected char '%c'" c));
         incr i)
    end
  done;
  emit EOF;
  Array.of_list (List.rev !toks)

(* ===== Parser ===== *)
let toks = ref [||]
let pos = ref 0
let peek () = !toks.(!pos)
let advance () = let t = !toks.(!pos) in incr pos; t
let expect t = if peek () = t then ignore (advance ()) else failwith "parse: unexpected token"
let id () = match advance () with TID s -> s | _ -> failwith "parse: expected identifier"

let rec parse_args () =
  if peek () = RP then []
  else let a = parse_expr () in
    if peek () = COMMA then (ignore (advance ()); a :: parse_args ()) else [a]

and parse_primary () =
  match advance () with
  | TINT n -> Int n
  | TSTR s -> Str s
  | TID "new" -> let c = id () in expect LP; let a = parse_args () in expect RP; New (c, a)
  | TID "now" ->
      let t = id () in expect DOT; let m = id () in
      expect LP; let a = parse_args () in expect RP;
      if peek () = TID "timeout" then begin
        ignore (advance ());
        let ms = parse_add () in            (* 比較より内側で切る（else まで食わないように） *)
        (if peek () = TID "else" then ignore (advance ()) else failwith "parse: timeout には else が要る");
        let dflt = parse_add () in
        Now (t, m, a, Some (ms, dflt))
      end else Now (t, m, a, None)
  | TID "future" ->
      let t = id () in expect DOT; let m = id () in
      expect LP; let a = parse_args () in expect RP; Future (t, m, a)
  | TID "await" ->
      let h = parse_primary () in
      if peek () = TID "timeout" then begin
        ignore (advance ());
        let ms = parse_add () in
        (if peek () = TID "else" then ignore (advance ()) else failwith "parse: timeout には else が要る");
        let d = parse_add () in Await (h, Some (ms, d))
      end else Await (h, None)
  | TID "self" -> Var "self"
  | TID "sender" -> Var "sender"
  | TID x -> if peek () = LP then (ignore (advance ()); let a = parse_args () in expect RP; Call (x, a)) else Var x
  | LP -> let e = parse_expr () in expect RP; e
  | _ -> failwith "parse: bad primary"

and parse_unary () =
  if peek () = MINUS then (ignore (advance ()); Bin ("-", Int 0, parse_unary ())) else parse_primary ()

and parse_mul () =
  let rec go l = match peek () with
    | STAR  -> ignore (advance ()); go (Bin ("*", l, parse_unary ()))
    | SLASH -> ignore (advance ()); go (Bin ("/", l, parse_unary ()))
    | PCT   -> ignore (advance ()); go (Bin ("%", l, parse_unary ()))
    | _ -> l
  in go (parse_unary ())

and parse_add () =
  let rec go l = match peek () with
    | PLUS  -> ignore (advance ()); go (Bin ("+", l, parse_mul ()))
    | MINUS -> ignore (advance ()); go (Bin ("-", l, parse_mul ()))
    | _ -> l
  in go (parse_mul ())

and parse_expr () =
  let rec go l = match peek () with
    | LT  -> ignore (advance ()); go (Bin ("<",  l, parse_add ()))
    | LE  -> ignore (advance ()); go (Bin ("<=", l, parse_add ()))
    | GT  -> ignore (advance ()); go (Bin (">",  l, parse_add ()))
    | GE  -> ignore (advance ()); go (Bin (">=", l, parse_add ()))
    | EQ2 -> ignore (advance ()); go (Bin ("==", l, parse_add ()))
    | NE  -> ignore (advance ()); go (Bin ("!=", l, parse_add ()))
    | _ -> l
  in go (parse_add ())

(* `var x: int = 0;` の型注釈を読み飛ばす（parse_stmt から使うので先に置く） *)
let skip_type_ann_stmt () =
  if peek () = COLON then (ignore (advance ()); ignore (advance ()))

let rec parse_stmt () =
  match peek () with
  | TID "if" ->
      ignore (advance ()); expect LP; let c = parse_expr () in expect RP;
      let t = parse_stmt () in
      if peek () = TID "else" then (ignore (advance ()); If (c, t, parse_stmt ()))
      else If (c, t, Nop)
  | TID "while" ->
      ignore (advance ()); expect LP; let c = parse_expr () in expect RP;
      expect (TID "do"); While (c, parse_stmt ())
  | TID "send" ->
      ignore (advance ());
      let tgt = id () in expect DOT; let m = id () in
      expect LP; let a = parse_args () in expect RP; expect SEMI; Send (tgt, m, a)
  | TID "call" ->
      ignore (advance ()); let f = id () in
      expect LP; let a = parse_args () in expect RP; expect SEMI; CallS (f, a)
  | TID "return" ->
      ignore (advance ());
      while peek () <> SEMI && peek () <> EOF do ignore (advance ()) done;
      (if peek () = SEMI then ignore (advance ())); Nop
  | TID "var" ->
      (* メソッド局所 var。隠しフィールドに割り当てるので、この VM の命令だけで足りる。 *)
      ignore (advance ()); let v = id () in
      let init = if peek () = ASSIGN then (ignore (advance ()); Some (parse_expr ())) else None in
      skip_type_ann_stmt ();
      expect SEMI; LocalDecl (v, init)
  | LB ->
      ignore (advance ());
      let ss = ref [] in
      while peek () <> RB do ss := parse_stmt () :: !ss done;
      ignore (advance ()); Block (List.rev !ss)
  | TID x ->
      ignore (advance ());
      (match peek () with
       | ASSIGN -> ignore (advance ()); let e = parse_expr () in expect SEMI; Assign (x, e)
       | LP -> ignore (advance ()); let a = parse_args () in expect RP; expect SEMI; CallS (x, a)
       | _ -> failwith "parse: bad statement")
  | _ -> failwith "parse: bad statement"

(* 現行 AIPL の注釈は AVM では意味を持たないので、構文として受理して読み飛ばす。
   「黙って落とす」のではなく、読み飛ばしていることを関数名で明示しておく。 *)
let skip_type_ann () =
  if peek () = COLON then (ignore (advance ()); ignore (advance ()))   (* : T *)

let skip_level_ann () =
  if peek () = AT then (ignore (advance ()); ignore (advance ()))      (* @ N *)

let skip_effect_ann () =
  if peek () = BANG then begin                                        (* !{a, b} *)
    ignore (advance ()); expect LB;
    while peek () <> RB do ignore (advance ()) done;
    ignore (advance ())
  end

let parse_params () =
  if peek () = RP then []
  else let rec go () = let p = id () in
    skip_type_ann ();
    if peek () = COMMA then (ignore (advance ()); p :: go ()) else [p]
  in go ()

(* 文の木から、その中で宣言された局所 var の名前を集める *)
let rec stmt_locals = function
  | LocalDecl (v, _) -> [v]
  | Block ss -> List.concat_map stmt_locals ss
  | If (_, t, f) -> stmt_locals t @ stmt_locals f
  | While (_, b) -> stmt_locals b
  | _ -> []

let parse_class () =
  expect (TID "class"); let name = id () in expect LB;
  let fields = ref [] and meths = ref [] and finits = ref [] in
  while peek () <> RB do
    match peek () with
    | TID "var" ->
        ignore (advance ()); let f = id () in
        skip_type_ann_stmt ();
        (if peek () = ASSIGN then begin
           ignore (advance ());
           let e = parse_expr () in
           (* 以前はここで ignore していた＝「var n = 100;」が黙って 0 になっていた *)
           finits := (f, e) :: !finits
         end);
        expect SEMI; fields := f :: !fields
    | TID "method" ->
        ignore (advance ()); let mn = id () in expect LP;
        let params = parse_params () in expect RP;
        skip_type_ann (); skip_level_ann (); skip_effect_ann ();
        expect LB;
        let ss = ref [] in
        while peek () <> RB do ss := parse_stmt () :: !ss done;
        ignore (advance ());
        let body = Block (List.rev !ss) in
        meths := { mn; params; body; mlocals = stmt_locals body } :: !meths
    | _ -> failwith "parse: expected var/method in class body"
  done;
  ignore (advance ());
  { cn = name; fields = List.rev !fields; meths = List.rev !meths;
    finits = List.rev !finits }

let parse_program src =
  toks := lex src; pos := 0;
  let cs = ref [] and tops = ref [] in
  while peek () <> EOF do
    if peek () = TID "class" then cs := parse_class () :: !cs
    else tops := parse_stmt () :: !tops
  done;
  let classes = List.rev !cs in
  match List.rev !tops with
  | [] -> classes
  | ts ->
      (* クラスの外に書かれた文（`var g = new G(); send g.tick();` など）は、
         合成したクラス __Top の tick に包む。この VM は「クラス 0 を spawn して
         tick を送る」約束なので、__Top を先頭に置けばそのまま起点になる。
         トップレベルの var は tick のメソッド局所 var として扱う。 *)
      (* トップレベルの var は __Top の「フィールド」にする（局所にしない）。
         こうすると名前が書き換わらないので、他クラスへ配るときにそのまま押せる。
         宣言は代入に落とす。 *)
      let body = Block ts in
      let gs = stmt_locals body in
      let rec decl2assign = function
        | LocalDecl (v, Some e) when List.mem v gs -> Assign (v, e)
        | LocalDecl (v, None) when List.mem v gs -> Nop
        | Block ss -> Block (List.map decl2assign ss)
        | If (c, t, f) -> If (c, decl2assign t, decl2assign f)
        | While (c, b) -> While (c, decl2assign b)
        | s -> s in
      { cn = "__Top"; fields = gs; finits = [];
        meths = [ { mn = "tick"; params = []; body = decl2assign body; mlocals = [] } ] } :: classes

(* ===== Codegen (mirrors avm_gen.ml) ===== *)
let binop_code = function
  | "+" -> 0x10 | "-" -> 0x11 | "*" -> 0x12 | "/" -> 0x13 | "%" -> 0x14
  | "<" -> 0x20 | "<=" -> 0x21 | ">" -> 0x22 | ">=" -> 0x23 | "==" -> 0x24 | "!=" -> 0x25
  | op -> failwith ("avm: bad operator " ^ op)

let strs : (string, int) Hashtbl.t = Hashtbl.create 32
let str_rev = ref [] and str_n = ref 0
let sid s = match Hashtbl.find_opt strs s with
  | Some i -> i
  | None -> let i = !str_n in Hashtbl.replace strs s i; str_rev := s :: !str_rev; incr str_n; i

let class_index : (string, int) Hashtbl.t = Hashtbl.create 8
let class_has_finit : (string, unit) Hashtbl.t = Hashtbl.create 8
(* クラス名 -> そのクラスが要る大域変数の名前。new の直後に __setg で配る *)
let class_globals : (string, string list) Hashtbl.t = Hashtbl.create 8
let idx_of name lst =
  let rec go i = function [] -> None | x :: _ when x = name -> Some i | _ :: t -> go (i+1) t in go 0 lst

let compile_method ~fields ~params (body : stmt) : string =
  let b = Buffer.create 64 in
  let lbl = ref 0 in
  let new_label () = incr lbl; !lbl in
  let labels : (int, int) Hashtbl.t = Hashtbl.create 8 in
  let fixups = ref [] in
  let u8 x = Buffer.add_char b (Char.chr (x land 0xff)) in
  let u16 x = u8 x; u8 (x asr 8) in
  let i32 x = u8 x; u8 (x asr 8); u8 (x asr 16); u8 (x asr 24) in
  let place l = Hashtbl.replace labels l (Buffer.length b) in
  let jump op l = u8 op; fixups := (Buffer.length b, l) :: !fixups; u16 0 in
  let resolve n =
    if n = "self" then u8 0x05
    else if n = "sender" then u8 0x06
    else match idx_of n params with
      | Some i -> u8 0x04; u8 i
      | None ->
        (match idx_of n fields with
         | Some i -> u8 0x02; u8 i
         | None -> failwith ("avm: unknown variable '" ^ n ^ "'")) in
  let rec has_string = function Str _ -> true | Bin (_, a, c) -> has_string a || has_string c | _ -> false in
  let rec ce = function
    | Int n -> u8 0x01; i32 n
    | Var n -> resolve n
    | Bin ("+", a, c) when has_string (Bin ("+", a, c)) ->
        (* 実行時の文字列連結。VM の CONCAT(0x15) が文字列ヒープに積む。
           print の中の連結は emit_print が書式として組み立て時に解決するので
           ここには来ない（ヒープを使わずに済む）。 *)
        ce a; ce c; u8 0x15
    | Bin (op, a, c) when has_string (Bin (op, a, c)) ->
        failwith ("avm: 文字列に " ^ op ^ " は使えない（連結は ++ だけ）")
    | Bin (op, a, c) -> ce a; ce c; u8 (binop_code op)
    | New (cls, args) ->
        (match Hashtbl.find_opt class_index cls with
         | Some ci -> u8 0x41; u16 ci;
             (* 初期値がある場合は先に __finit を送る。メールボックスは FIFO なので
                呼び出し側が続けて送るメッセージより必ず先に走る。 *)
             (if Hashtbl.mem class_has_finit cls then
                (u8 0x08; u8 0x40; u16 (sid "__finit"); u8 0));
             (* 大域を要るクラスなら、生成直後に __setg で配る *)
             (match Hashtbl.find_opt class_globals cls with
              | None -> ()
              | Some gs ->
                  u8 0x08; List.iter (fun g -> ce (Var g)) gs;
                  u8 0x40; u16 (sid "__setg"); u8 (List.length gs));
             (match args with [] -> () | _ ->
                u8 0x08; List.iter ce args; u8 0x40; u16 (sid "init"); u8 (List.length args))
         | None -> failwith ("avm: new of unknown class '" ^ cls ^ "'"))
    | Call ("print", [a]) -> emit_print a
    | Str s ->
        (* 文字列の値は「0x40000000 | 文字列表の添字」で表す。命令は増やさない。
           VM 側は印字のときだけこのタグを見る（avm.ml の vm_show）。
           注意: タグ付き値に算術を掛けても検査されない（この処理系に型は無い）。 *)
        u8 0x01; i32 (0x40000000 lor (sid s))
    | Now _ -> failwith "avm: now はメソッド直下の `var x = now t.m(..);` / `x = now t.m(..);` の位置でだけ書ける"
    | Future _ -> failwith "avm: future はメソッド直下の `var f = future t.m(..);` の位置でだけ書ける"
    | Await _  -> failwith "avm: await はメソッド直下の `var x = await f;` の位置でだけ書ける"
    | _ -> failwith "avm: unsupported expression"
  and emit_print a =
    let rec parts = function
      | Str s -> [`Lit s]
      | Bin ("+", x, y) as e when has_string e -> parts x @ parts y
      | e -> [`Val e] in
    let ps = parts a in
    if List.exists (function `Lit _ -> true | _ -> false) ps then begin
      let fmt = Buffer.create 32 and vals = ref [] in
      List.iter (function `Lit s -> Buffer.add_string fmt s
                        | `Val e -> Buffer.add_string fmt "%d"; vals := e :: !vals) ps;
      let vals = List.rev !vals in
      List.iter ce vals;
      u8 0x44; u16 (sid (Buffer.contents fmt)); u8 (List.length vals)
    end else (ce a; u8 0x42)
  in
  let rec cs = function
    | Block ss -> List.iter cs ss
    | Nop -> ()
    | Assign (n, e) ->
        ce e;
        (match idx_of n fields with Some i -> u8 0x03; u8 i
         | None -> failwith ("avm: assignment to non-field '" ^ n ^ "'"))
    | LocalDecl (v, init) ->
        (* この時点で v は既に隠しフィールド名に書き換わっている *)
        (match init with Some e -> ce e | None -> u8 0x01; i32 0);
        (match idx_of v fields with Some i -> u8 0x03; u8 i
         | None -> failwith ("avm: local slot missing for '" ^ v ^ "'"))
    | If (c, t, f) ->
        ce c; let l_else = new_label () and l_end = new_label () in
        jump 0x31 l_else; cs t; jump 0x30 l_end; place l_else; cs f; place l_end
    | While (c, body) ->
        let l_top = new_label () and l_end = new_label () in
        place l_top; ce c; jump 0x31 l_end; cs body; jump 0x30 l_top; place l_end
    | Send (tgt, m, args) ->
        resolve tgt; List.iter ce args; u8 0x40; u16 (sid m); u8 (List.length args)
    | CallS ("reply", args) ->
        (* reply(v) は「送り主の reply メソッドへ送る」に落とす（この VM に future は無い）。
           宛先は sender ではなく、メソッド開始時に控えた __snd を使う。
           now で継続分割すると後半は別のメッセージの中で走るため、
           そのとき sender は元の呼び出し元ではなくなっているからである。 *)
        (match idx_of "__snd" fields with
         | Some i -> u8 0x02; u8 i
         | None -> u8 0x06);
        List.iter ce args; u8 0x40; u16 (sid "reply"); u8 (List.length args)
    | CallS ("print", [a]) -> emit_print a
    | CallS ("wait", [ms]) -> ce ms; u8 0x07
    | CallS ("line", [x1;y1;x2;y2;col]) -> ce x1; ce y1; ce x2; ce y2; ce col; u8 0x45
    | CallS ("cls", []) -> u8 0x46
    | CallS ("tri", [x1;y1;x2;y2;x3;y3;col]) ->
        ce x1; ce y1; ce x2; ce y2; ce x3; ce y3; ce col; u8 0x47
    | CallS (f, _) -> failwith ("avm: unsupported call '" ^ f ^ "'")
  in
  cs body; u8 0x43;   (* RET *)
  let by = Buffer.to_bytes b in
  List.iter (fun (p, l) ->
    let off = Hashtbl.find labels l in
    Bytes.set by p (Char.chr (off land 0xff));
    Bytes.set by (p+1) (Char.chr ((off asr 8) land 0xff))) !fixups;
  Bytes.to_string by

(* ===== 局所名の確定と、now の継続分割 =====
   1) メソッド局所 var を "メソッド名#局所名" の隠しフィールド名へ書き換える。
   2) `var x = now t.m(a);` を「送って終わり」と「返信で続きを走らせる」に切る。
      局所はフィールドなので、分割をまたいでも値が残る（ここが効いている）。
      切った後半は合成した reply(__v) の中で `__k` を見て選ばれる。
      この VM に future は無いので、これが now を実現する唯一の道。 *)
let rec ren_e f = function
  | Var v -> Var (f v)
  | Bin (o, a, b) -> Bin (o, ren_e f a, ren_e f b)
  | New (c, args) -> New (c, List.map (ren_e f) args)
  | Call (g, args) -> Call (g, List.map (ren_e f) args)
  | Now (t, m, args, tk) -> Now (f t, m, List.map (ren_e f) args,
                                Option.map (fun (a,b) -> (ren_e f a, ren_e f b)) tk)
  | Future (t, m, args) -> Future (f t, m, List.map (ren_e f) args)
  | Await (h, tk) -> Await (ren_e f h,
                            Option.map (fun (a,b) -> (ren_e f a, ren_e f b)) tk)
  | e -> e

let rec ren_s f = function
  | Assign (n, e) -> Assign (f n, ren_e f e)
  | LocalDecl (v, e) -> LocalDecl (f v, Option.map (ren_e f) e)
  | If (c, t, el) -> If (ren_e f c, ren_s f t, ren_s f el)
  | While (c, b) -> While (ren_e f c, ren_s f b)
  | Block ss -> Block (List.map (ren_s f) ss)
  | Send (t, m, args) -> Send (f t, m, List.map (ren_e f) args)
  | CallS (g, args) -> CallS (g, List.map (ren_e f) args)
  | Nop -> Nop

(* 式の中に現れた now を、直前の一時変数へ持ち上げる。
     print(now c.bump())  ->  var __nw1 = now c.bump(); print(__nw1);
   こうしておけば、あとは既存の「文の位置の now」の分割がそのまま使える。
   while の条件だけは持ち上げない（毎周回で分割が要るため）。持ち上げなかった
   now は codegen が明示的にエラーにする。 *)
let hoist_now (ctr : int ref) (ss : stmt list) : stmt list * string list =
  let temps = ref [] in
  let pre = ref [] in
  let rec go = function
    | Now (t, m, args, tk) ->
        let args = List.map go args in
        incr ctr;
        let tv = Printf.sprintf "__nw%d" !ctr in
        temps := tv :: !temps;
        pre := LocalDecl (tv, Some (Now (t, m, args, tk))) :: !pre;
        Var tv
    | Bin (o, a, b) -> let a = go a in let b = go b in Bin (o, a, b)
    | New (c, args) -> New (c, List.map go args)
    | Call (g, args) -> Call (g, List.map go args)
    | x -> x
  in
  let flush s acc = (s :: List.rev_append !pre acc) in
  let out =
    List.fold_left (fun acc s ->
      pre := [];
      match s with
      (* 既に「文の位置の now」なら触らない *)
      | LocalDecl (_, Some (Now _)) | Assign (_, Now _) -> s :: acc
      | Assign (n, e)          -> let e = go e in flush (Assign (n, e)) acc
      | LocalDecl (v, Some e)  -> let e = go e in flush (LocalDecl (v, Some e)) acc
      | Send (t, m, args)      -> let a = List.map go args in flush (Send (t, m, a)) acc
      | CallS (g, args)        -> let a = List.map go args in flush (CallS (g, a)) acc
      | If (c, t, f)           -> let c = go c in flush (If (c, t, f)) acc
      | _ -> s :: acc) [] ss
  in
  (List.rev out, List.rev !temps)

let split_at_now ss =
  let rec go acc = function
    | [] -> (List.rev acc, None)
    | LocalDecl (x, Some (Now (t, mm, args, tk))) :: rest ->
        (List.rev acc, Some (x, Some (t, mm, args), tk, rest))
    | Assign (x, Now (t, mm, args, tk)) :: rest ->
        (List.rev acc, Some (x, Some (t, mm, args), tk, rest))
    (* await は「送らずに切るだけ」の分割点。送信は future の地点で済んでいる *)
    | LocalDecl (x, Some (Await (_, tk))) :: rest -> (List.rev acc, Some (x, None, tk, rest))
    | Assign (x, Await (_, tk)) :: rest           -> (List.rev acc, Some (x, None, tk, rest))
    | s :: rest -> go (s :: acc) rest
  in go [] ss

let prepare_class (c : cls) : cls =
  (* 0-) reply を使うクラスは、メソッド開始時に送り主を __snd へ控える。
     継続分割の後半では sender が変わってしまうので、フィールドに逃がしておく。 *)
  let rec has_reply = function
    | CallS ("reply", _) -> true
    | Block ss -> List.exists has_reply ss
    | If (_, t, f) -> has_reply t || has_reply f
    | While (_, b) -> has_reply b
    | _ -> false in
  let uses_reply = List.exists (fun m -> has_reply m.body) c.meths in
  let c = if not uses_reply then c
          else { c with fields = c.fields @ ["__snd"];
                 meths = List.map (fun m ->
                     let ss = match m.body with Block ss -> ss | s -> [s] in
                     { m with body = Block (Assign ("__snd", Var "sender") :: ss) }) c.meths } in
  (* 0) 式の中の now を一時変数へ持ち上げる *)
  let tctr = ref 0 in
  let c = { c with meths = List.map (fun m ->
      let ss = match m.body with Block ss -> ss | s -> [s] in
      let (ss, tmps) = hoist_now tctr ss in
      { m with body = Block ss; mlocals = m.mlocals @ tmps }) c.meths } in
  (* 0.5) future は「送るだけ」に書き換える。切るのは await の地点。
     返信に相関 ID が無いので、未処理の future は同時に 1 つまで。 *)
  let rewrite_futures ss =
    let outstanding = ref 0 in
    List.concat_map (fun s ->
      match s with
      | LocalDecl (_, Some (Future (t, mm, args))) | Assign (_, Future (t, mm, args)) ->
          incr outstanding;
          if !outstanding > 1 then
            failwith "avm: 未処理の future は同時に 1 つまで（この VM の返信に相関 ID が無く区別できない）";
          [ Assign ("__k", Int 0); Send (t, mm, args) ]
      | LocalDecl (_, Some (Await _)) | Assign (_, Await _) -> decr outstanding; [ s ]
      | s -> [ s ]) ss
  in
  let c = { c with meths = List.map (fun m ->
      let ss = match m.body with Block ss -> ss | s -> [s] in
      { m with body = Block (rewrite_futures ss) }) c.meths } in
  let ms = List.map (fun m ->
      let f v = if List.mem v m.mlocals then m.mn ^ "#" ^ v else v in
      { m with body = ren_s f m.body;
               mlocals = List.map (fun v -> m.mn ^ "#" ^ v) m.mlocals }) c.meths in
  (* now の分割。timeout つきなら、別アクタ __Timer を立てて
     「wait(ms) してから呼び出し元の __to(kid) を叩く」役をさせる。
     この VM の wait は自分のアクタだけを止めるので、別アクタなら
     呼び出し元は止まらない。返信とタイムアウトのどちらが先に来ても
     __k を 0 に落とすので、後から来た方は無視される。 *)
  let kctr = ref 0 and entries = ref [] and touts = ref []
  and uses = ref false and extra = ref [] in
  let rec chop owner ss =
    let (pre, k) = split_at_now ss in
    match k with
    | None -> Block pre
    | Some (x, sendopt, tk, rest) ->
        uses := true; incr kctr; let kid = !kctr in
        let cont = chop owner rest in
        entries := (kid, x, cont) :: !entries;
        let setup =
          match tk with
          | None -> []
          | Some (ms, dflt) ->
              let tv = Printf.sprintf "%s#__tmr%d" owner kid in
              extra := tv :: !extra;
              touts := (kid, x, dflt, cont) :: !touts;
              [ LocalDecl (tv, Some (New ("__Timer", [])));
                Send (tv, "fire", [ ms; Var "self"; Int kid ]) ]
        in
        (* now は送ってから切る。await は future の地点で送信済みなので切るだけ。 *)
        let tail = match sendopt with
          | Some (t, mm, args) -> [ Send (t, mm, args) ]
          | None -> [] in
        Block (pre @ [ Assign ("__k", Int kid) ] @ setup @ tail)
  in
  let ms = List.map (fun m ->
      let ss = match m.body with Block ss -> ss | s -> [s] in
      { m with body = chop m.mn ss }) ms in
  (* フィールド初期値は合成メソッド __finit にまとめ、生成直後に送る（New 参照）。
     この VM には生成フックが無いので、これが初期値を効かせる唯一の道。 *)
  let ms = if c.finits = [] then ms
           else ms @ [ { mn = "__finit"; params = []; mlocals = [];
                         body = Block (List.map (fun (f, e) -> Assign (f, e)) c.finits) } ] in
  let hidden = List.concat_map (fun m -> m.mlocals) ms @ List.rev !extra in
  if not !uses then { c with fields = c.fields @ hidden; meths = ms }
  else begin
    if List.exists (fun m -> m.mn = "reply") c.meths then
      failwith ("avm: クラス " ^ c.cn
                ^ " は now を使っているので reply を自分で定義できない（継続の受け口に使うため）");
    let disp = Block (List.map (fun (kid, x, b) ->
        If (Bin ("==", Var "__k", Int kid),
            Block [ Assign ("__k", Int 0); Assign (x, Var "__v"); b ], Nop))
        (List.rev !entries)) in
    let ms = ms @ [ { mn = "reply"; params = ["__v"]; body = disp; mlocals = [] } ] in
    let ms =
      if !touts = [] then ms
      else
        let td = Block (List.map (fun (kid, x, dflt, b) ->
            If (Bin ("==", Var "__tk", Int kid),
                Block [ If (Bin ("==", Var "__k", Int kid),
                            Block [ Assign ("__k", Int 0); Assign (x, dflt); b ], Nop) ], Nop))
            (List.rev !touts)) in
        ms @ [ { mn = "__to"; params = ["__tk"]; body = td; mlocals = [] } ]
    in
    { c with fields = c.fields @ hidden @ ["__k"]; meths = ms }
  end

(* ===== 大域変数（トップレベルの var）を、参照するクラスへ配る =====
   この VM に大域は無いので、参照するクラスに同名のフィールドを足し、
   __Top が new した直後に __setg で送り込む。
   new が __Top の外にある場合は、そこに大域が見えないので
   codegen が "unknown variable" で落ちる＝黙って動かない形にはならない。 *)
let rec fv_e acc = function
  | Var v -> v :: acc
  | Bin (_, a, b) -> fv_e (fv_e acc a) b
  | New (_, args) | Call (_, args) -> List.fold_left fv_e acc args
  | Now (t, _, args, tk) ->
      let acc = List.fold_left fv_e (t :: acc) args in
      (match tk with Some (a, b) -> fv_e (fv_e acc a) b | None -> acc)
  | Future (t, _, args) -> List.fold_left fv_e (t :: acc) args
  | Await (h, tk) ->
      let acc = fv_e acc h in
      (match tk with Some (a, b) -> fv_e (fv_e acc a) b | None -> acc)
  | _ -> acc
let rec fv_s acc = function
  | Assign (n, e) -> fv_e (n :: acc) e
  | LocalDecl (_, Some e) -> fv_e acc e
  | If (c, t, f) -> fv_s (fv_s (fv_e acc c) t) f
  | While (c, b) -> fv_s (fv_e acc c) b
  | Block ss -> List.fold_left fv_s acc ss
  | Send (t, _, args) -> List.fold_left fv_e (t :: acc) args
  | CallS (_, args) -> List.fold_left fv_e acc args
  | _ -> acc

let distribute_globals (classes : cls list) : cls list =
  match List.find_opt (fun c -> c.cn = "__Top") classes with
  | None -> classes
  | Some top ->
    let gs = top.fields in
    if gs = [] then classes
    else List.map (fun c ->
      if c.cn = "__Top" then c
      else begin
        let bound = c.fields @ List.concat_map (fun m -> m.mn :: m.params @ m.mlocals) c.meths
                    @ ["self"; "sender"] in
        let used = List.concat_map (fun m -> fv_s [] m.body) c.meths in
        let need = List.filter (fun g -> List.mem g used && not (List.mem g bound)) gs in
        if need = [] then c
        else begin
          Hashtbl.replace class_globals c.cn need;
          { c with fields = c.fields @ need;
                   meths = c.meths @
                     [ { mn = "__setg"; params = List.map (fun g -> "__g_" ^ g) need;
                         mlocals = [];
                         body = Block (List.map (fun g -> Assign (g, Var ("__g_" ^ g))) need) } ] }
        end
      end) classes

let gen_program (classes : cls list) : bytes =
  Hashtbl.reset strs; str_rev := []; str_n := 0; Hashtbl.reset class_index;
  Hashtbl.reset class_has_finit; Hashtbl.reset class_globals;
  let classes = distribute_globals classes in
  List.iter (fun c -> if c.finits <> [] then Hashtbl.replace class_has_finit c.cn ()) classes;
  let classes = List.map prepare_class classes in
  (* timeout を使ったクラスがあれば、待ち役の __Timer を足す。
     wait は自分のアクタだけを止めるので、別アクタにやらせれば
     呼び出し元は止まらずに返信を受け取れる。 *)
  let needs_timer =
    List.exists (fun c -> List.exists (fun m -> m.mn = "__to") c.meths) classes in
  let classes =
    if not needs_timer then classes
    else classes @ [ { cn = "__Timer"; fields = []; finits = [];
                       meths = [ { mn = "fire"; params = ["ms"; "back"; "k"]; mlocals = [];
                                   body = Block [ CallS ("wait", [Var "ms"]);
                                                  Send ("back", "__to", [Var "k"]) ] } ] } ]
  in
  List.iteri (fun i c -> Hashtbl.replace class_index c.cn i) classes;
  let compiled = List.map (fun c ->
    let ms = List.map (fun m ->
      (sid m.mn, List.length m.params,
       compile_method ~fields:c.fields ~params:m.params m.body)) c.meths in
    (sid c.cn, List.length c.fields, ms)) classes in
  let out = Buffer.create 256 in
  let u8 x = Buffer.add_char out (Char.chr (x land 0xff)) in
  let u16 x = u8 x; u8 (x asr 8) in
  Buffer.add_string out "AVM1";
  let strings = List.rev !str_rev in
  u16 (List.length strings);
  List.iter (fun s -> u16 (String.length s); Buffer.add_string out s) strings;
  u16 (List.length compiled);
  List.iter (fun (cn, nf, ms) ->
    u16 cn; u16 nf; u16 (List.length ms);
    List.iter (fun (mn, np, code) ->
      u16 mn; u8 np; u16 (String.length code); Buffer.add_string out code) ms) compiled;
  Buffer.to_bytes out

let compile_source (src : string) : bytes = gen_program (parse_program src)

let compile_file (path : string) : bytes =
  let ic = open_in_bin path in
  let n = in_channel_length ic in
  let s = really_input_string ic n in
  close_in ic;
  compile_source s
