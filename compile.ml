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
type stmt = Assign of string * expr | If of expr * stmt * stmt | While of expr * stmt
          | Block of stmt list | Send of string * string * expr list
          | CallS of string * expr list | Nop
type meth = { mn : string; params : string list; body : stmt }
type cls  = { cn : string; fields : string list; meths : meth list }

(* ===== Lexer ===== *)
type tok = TINT of int | TID of string | TSTR of string
         | LB | RB | LP | RP | SEMI | COMMA | DOT
         | EQ2 | NE | LE | GE | LT | GT | ASSIGN
         | PLUS | MINUS | STAR | SLASH | PCT | EOF

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
      emit (TID (String.sub s !i (!j - !i))); i := !j
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
  | TID "var" -> failwith "compile: method-local 'var' unsupported (use class fields)"
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

let parse_params () =
  if peek () = RP then []
  else let rec go () = let p = id () in
    if peek () = COMMA then (ignore (advance ()); p :: go ()) else [p]
  in go ()

let parse_class () =
  expect (TID "class"); let name = id () in expect LB;
  let fields = ref [] and meths = ref [] in
  while peek () <> RB do
    match peek () with
    | TID "var" ->
        ignore (advance ()); let f = id () in
        (if peek () = ASSIGN then (ignore (advance ()); ignore (parse_expr ())));
        expect SEMI; fields := f :: !fields
    | TID "method" ->
        ignore (advance ()); let mn = id () in expect LP;
        let params = parse_params () in expect RP;
        expect LB;
        let ss = ref [] in
        while peek () <> RB do ss := parse_stmt () :: !ss done;
        ignore (advance ());
        meths := { mn; params; body = Block (List.rev !ss) } :: !meths
    | _ -> failwith "parse: expected var/method in class body"
  done;
  ignore (advance ());
  { cn = name; fields = List.rev !fields; meths = List.rev !meths }

let parse_program src =
  toks := lex src; pos := 0;
  let cs = ref [] in
  while peek () <> EOF do cs := parse_class () :: !cs done;
  List.rev !cs

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
      | None -> (match idx_of n fields with
                 | Some i -> u8 0x02; u8 i
                 | None -> failwith ("avm: unknown variable '" ^ n ^ "'")) in
  let rec has_string = function Str _ -> true | Bin (_, a, c) -> has_string a || has_string c | _ -> false in
  let rec ce = function
    | Int n -> u8 0x01; i32 n
    | Var n -> resolve n
    | Bin (op, a, c) -> ce a; ce c; u8 (binop_code op)
    | New (cls, args) ->
        (match Hashtbl.find_opt class_index cls with
         | Some ci -> u8 0x41; u16 ci;
             (match args with [] -> () | _ ->
                u8 0x08; List.iter ce args; u8 0x40; u16 (sid "init"); u8 (List.length args))
         | None -> failwith ("avm: new of unknown class '" ^ cls ^ "'"))
    | Call ("print", [a]) -> emit_print a
    | Str _ -> failwith "avm: bare string only valid in print()"
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
    | If (c, t, f) ->
        ce c; let l_else = new_label () and l_end = new_label () in
        jump 0x31 l_else; cs t; jump 0x30 l_end; place l_else; cs f; place l_end
    | While (c, body) ->
        let l_top = new_label () and l_end = new_label () in
        place l_top; ce c; jump 0x31 l_end; cs body; jump 0x30 l_top; place l_end
    | Send (tgt, m, args) ->
        resolve tgt; List.iter ce args; u8 0x40; u16 (sid m); u8 (List.length args)
    | CallS ("print", [a]) -> emit_print a
    | CallS ("wait", [ms]) -> ce ms; u8 0x07
    | CallS ("line", [x1;y1;x2;y2;col]) -> ce x1; ce y1; ce x2; ce y2; ce col; u8 0x45
    | CallS ("cls", []) -> u8 0x46
    | CallS (f, _) -> failwith ("avm: unsupported call '" ^ f ^ "'")
  in
  cs body; u8 0x43;   (* RET *)
  let by = Buffer.to_bytes b in
  List.iter (fun (p, l) ->
    let off = Hashtbl.find labels l in
    Bytes.set by p (Char.chr (off land 0xff));
    Bytes.set by (p+1) (Char.chr ((off asr 8) land 0xff))) !fixups;
  Bytes.to_string by

let gen_program (classes : cls list) : bytes =
  Hashtbl.reset strs; str_rev := []; str_n := 0; Hashtbl.reset class_index;
  List.iteri (fun i c -> Hashtbl.replace class_index c.cn i) classes;
  let compiled = List.map (fun c ->
    let ms = List.map (fun m ->
      (sid m.mn, List.length m.params, compile_method ~fields:c.fields ~params:m.params m.body)) c.meths in
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
