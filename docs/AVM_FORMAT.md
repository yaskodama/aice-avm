# `.avm` module format & opcodes

A `.avm` module is a compact, little-endian actor-bytecode image. The same
format loads on the Xinu kernel VM and on this OCaml host VM.

## Module layout (little-endian)

```
"AVM1"
u16 nstr
nstr * ( u16 len, len bytes )                      ; string pool (UTF-8/ASCII)
u16 nclass
nclass * (
    u16 nameIdx                                    ; class name  -> string pool
    u16 nfields
    u16 nmethods
    nmethods * (
        u16 nameIdx                                ; method name -> string pool
        u8  nparams
        u16 codeLen
        codeLen bytes                              ; bytecode
    )
)
```

* The **first class** (index 0) is the entry: on load the receiver spawns one
  instance of it and delivers `tick()` to it.
* Class ids on the VM are `VM_CLASS_BASE + classIndex` (the kernel uses 200).
* Fields spawn zeroed; **field initialisers are not executed** — set them in a
  method.

## Stack machine

Each method runs on a small integer operand stack. An actor has:
* `fields[]`  — its own state (indexed by `LDF`/`STF`)
* `args[]`    — the arguments of the message currently being handled (`LDA`)
* `self`, `sender` — actor ids

Integers are machine words; `DIV`/`MOD` truncate toward zero (C semantics).

## Opcodes

| hex | name | operands | effect |
|-----|------|----------|--------|
| 01 | PUSHI | i32 | push immediate |
| 02 | LDF | u8 idx | push `fields[idx]` |
| 03 | STF | u8 idx | `fields[idx] = pop` |
| 04 | LDA | u8 idx | push `args[idx]` |
| 05 | SELF | | push `self` id |
| 06 | SENDER | | push `sender` id |
| 07 | WAIT | | `ms = pop`; sleep `ms` |
| 08 | DUP | | duplicate top |
| 10 | ADD | | `a+b` |
| 11 | SUB | | `a-b` |
| 12 | MUL | | `a*b` |
| 13 | DIV | | `a/b` (trunc toward 0) |
| 14 | MOD | | `a%b` |
| 20..25 | LT LE GT GE EQ NE | | comparison -> 1/0 |
| 30 | JMP | u16 target | `pc = target` |
| 31 | JZ | u16 target | `if pop==0: pc = target` |
| 40 | SEND | u16 mIdx, u8 nargs | pop `nargs` + receiver id; enqueue `strings[mIdx]` |
| 41 | SPAWN | u16 cIdx | spawn class `cIdx`; push new actor id |
| 42 | PRINT | | pop v; print `v` to the text sink |
| 43 | RET | | end method |
| 44 | PRINTF | u16 fmtIdx, u8 nargs | pop `nargs`; format `strings[fmtIdx]` (`%d`) to the text sink |
| 45 | LINE | | pop `col,y2,x2,y1,x1`; draw a line in the graphics sink |
| 46 | CLS | | clear the graphics sink |

## Reference implementations

* Host VM: [`avm.ml`](../avm.ml) (`exec`)
* Kernel VM: `apps/abcl_program.c` `abcl_vm_dispatch` in the Xinu tree
* Compiler: [`compile.ml`](../compile.ml) (`gen_program`)
