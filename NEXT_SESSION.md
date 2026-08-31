# aice-avm — 次回セッション引き継ぎ (2026-08-31 更新)

## ★2026-08-30〜31 — AVM の処理系を現行 AIPL へ追従させた（main に push 済み）

**目的**: Xinu Pi3/Pi5 の実機で「最新の AIPL」を動かすこと。
**結果**: **正典ガイド 10 本が 0/10 → 9/10**（実機で確定）。焼き直しは **3 回**。

### 物差し

`~/aios/abclcp/docs/samples/guide/g*.aipl` を通す。**コンパイルが通っただけでは数えない。**
必ずホスト VM で走らせて**出力まで確認する**（g2/g3 は「通っている」ように見えて
実は無言・誤答だった。exit 0 は動作証明ではない）。

```
Mac 処理系:  ./_build/default/compile_avm.exe IN.aipl OUT.avm
ホスト VM :  ./_build/default/server.exe 8099 --no-open
             curl --data-binary @OUT.avm "http://127.0.0.1:8099/actor/loadvm?ask=0"
             curl http://127.0.0.1:8099/api/console      ← 値まで読める
Pi3 実機  :  curl --data-binary @OUT.avm "http://192.168.3.50:8080/actor/loadvm?ask=0"
             （/api/console は無い。enq/deq/drops しか見えない）
```

### 通る 8 本と、その出力

```
g1  hello, AIPL / tick 1 / tick 2
g2  twice = 43 / awaited = 20 / v=7
g3  ok, left=7 / sold out
g4  waiting / got 1 / via select:1
g5  /api/routes -> /echo -> a2 ; /api/x/echo?method=say&args=hi -> echo: hi
g7  fast = 42 / slow(timed out) = 0 / await = 42
g8  literal true ok / literal false ok / b = 1 / not-eq: 1
g9  got actor / after send / pong
g10 fork = 1 / latch = 2
```

### 入れた機能

**焼き直しが要らなかったもの（Mac 側 compile.ml だけ）**

| 機能 | 実現方法 |
|---|---|
| `++` / `: T` / `!{...}` / `@ N` / `true`・`false` | 字句と注釈。`: T` は仮引数にも |
| メソッド局所 `var` | `メソッド名#局所名` の**隠しフィールド**。これが後の全部の土台 |
| `reply(v)` | `send __snd.reply(v)`。**`sender` ではない**（下記） |
| トップレベル文 | 合成クラス `__Top` の `tick` に包み先頭へ |
| フィールド初期値 | 合成 `__finit` を `new` 直後に送る（FIFO で必ず先） |
| `now` | **継続分割**。`__k` を立てて送り、合成 `reply(__v)` が後半を走らせる |
| 式の中の `now` | 一時変数へ持ち上げる |
| `timeout <ms> else <v>` | 合成クラス `__Timer`（`wait` は自分のアクタだけ止める） |
| `future` / `await` | future は送るだけ、**await が切る** |
| 大域変数 | `__Top` のフィールドにし、`new` 直後に `__setg` で配る |
| **`select`** | **case の本体を受け側メソッドの先頭へ移す**。`__sel` で切替 |

**焼き直しが要ったもの（VM 側）— 2 回**

| 機能 | 実現方法 | md5 |
|---|---|---|
| 文字列を値に | `0x40000000 | 文字列表の添字`。**印字のときだけタグを見る** | `8a20d5b9…` |
| 実行時の文字列連結 | 文字列ヒープ + `CONCAT`(0x15)。ヒープはビット23で区別 | `90bd55eb…` |
| **`web_listen`/`web_expose`** | 命令 0x50/0x51 + 経路表。呼び出しの送り主を `web_sink(-2)` にして、そこ宛ての `reply` を横取りし HTTP 応答にする。webactor に `/api/x/<パス>` と `/api/routes` | `558bc437…` |

**成立の鍵**: 局所変数を先に隠しフィールドにしたこと。アクタの状態なので、
メソッドを継続分割しても値が残る。`now`/`future`/`await`/`select` は全部これに乗っている。

### 踏んだ穴（再発させないこと）

- **`reply` の宛先は `sender` ではない。** 継続分割すると後半は別のメッセージの中で走るので、
  そのとき `sender` は元の呼び出し元ではない。メソッド開始時に `__snd` へ控える。
  これを間違えて g3 が長く無言だった。
- **フィールド初期値が `ignore (parse_expr ())` で捨てられていた。** `var n = 100;` が黙って 0。
  既存サンプルが動いていたのは、たまたま初期値が 0 だったから。
- **実行時の文字列連結を整数加算にしてはいけない。** タグ付き値の加算はゴミになる。
  ヒープを入れるまでは明示的なコンパイルエラーにしていた。
- **黙って落とさない。** 未対応は必ずコンパイルエラーにする（`now` の位置、`future` の同時 2 個、
  文字列への `-`、`case` に対応するメソッドが無い、など）。

### 残り 1 本

| 本 | 要るもの | 見立て |
|---|---|---|
| g6 `ai_call` | AI 呼び出しの結線。**Pi3 に AI は無い**（Pi5 には小さなモデルがある） | **Pi3 では原理的に不可能。ここが打ち止め** |

### 制限（黙らずにエラーにしてある）

- `now` / `future` / `await` / `select` は**メソッド直下の文の位置**でだけ
- **未処理の `future` は同時に 1 つまで**（返信に相関 ID が無い）
- `now` を使うクラスは `reply` メソッドを自分で定義できない
- **`__Timer` は消えない**（suicide が無い）。`timeout` のたび 1 体溜まる
- 文字列ヒープは回収されない（host 256 本 / Pi3 64 本・2KB）。溢れたら印を出す

### 実機の作法

- **検証は必ずホスト VM → 実機**。Pi3 は値を読めないので、
  **シリアルの出力文字数の差**で判定する（長い文字列版と短い版を比べると投入の雑音が相殺される）。
- ボードは**連続リクエストに弱い**。2〜4 秒空けて 1 本ずつ。
- **ネットワーク経由の kexec は使わない。** `/upload` のバッファが 512KB でカーネルは 1,089KB、
  黙って切り捨てられて起動しなくなる。**焼くのは SD の物理差し替えのみ。**
- 焼き方: `cd compile && make PLATFORM=arm-rpi3` → `cp xinu.boot /Volumes/XINU/kernel.img` →
  md5 照合 → `diskutil eject`。**退避を `kernel.img.bak-pre-<何>-<md5>` で残す**（8 世代ある）。
  `config.txt` には触らない。
- 実機: Pi3 = `192.168.3.50:8080` / Pi5 = `192.168.3.101`(80)。Pi4 = `.100` は今回ずっとオフライン。
- **Pi5 には未反映**。文字列の 2 つの変更は `xinu-rpi5` 側にも入れないと Pi5 では効かない。

---

# aice-avm — 次回セッション引き継ぎ (2026-07-08 更新)

OCaml 本物 AVM ホスト VM（Win/Mac/Linux、stdlib のみ）。GitHub `yaskodama/aice-avm`（public）。
**Web Xinu デスクトップ UI を合体**して「git clone → start だけで動くダウンロード配布アプリ」にするプロジェクト。

## ★2026-07-08 セッションの変更（main `c3a9250` に push 済み）
1. **BASIC グラフィックデモ5本を移植**（`78a63fe`）。`www/js/xinu.js` の Tiny BASIC を
   カーネル BASIC 方言に拡張し、`~/projects/xinu-raz/xinu/apps/basic.c`（=rpi3 実機正本）から
   rescue/dragon/koch/bubble/qsort を**無改変**で移植。BASIC 窓のプルダウンで選択 → ▶ RUN。
   - 追加した方言: ラベル `*NAME`/`GOTO|GOSUB *NAME`、`LINE (x,y)-(x,y),色名`・`CIRCLE (x,y),r,色名`
     （名前色 BLUE/GREEN/YELLOW/CYAN/RED/MAGENTA…、ネスト括弧対応）、`CLS n`、配列 `DIM a(n)`/`a(i)`、
     `WAIT 秒`（引数なしは約0.6s一時停止）、`BUTTON id,"label",line`＋`STR$()`（koch のクリックUI）。
   - キャンバスを 640×400 に拡大（カーネル座標に一致）。koch は下部 Level± ボタンで再帰階層変更。
   - 検証: Node スタブで全5本エラー0。bubble/qsort は最終フレームの棒が実際に昇順整列を確認。
2. **runvm.html 互換化 + MAKINA 描画版**（`c3a9250`）。★重要な落とし穴の解消:
   - Actor Loader の Binarize/Save は `.abcl` **ソースを内包する "AVM1" コンテナ**を出力するが、
     runvm.html（`/api/host/runvm`）はコンパイル済み .avm を期待し開けなかった。
   - `server.ml` に `module_of_bytes` を追加：先頭 "AVM1" かつ **ver=1・flags=0・全長が
     `7+nameLen+4+srcLen` にピタリ一致** なら AVM1 ソースコンテナと判定し `Compile.compile_source`
     でコンパイル、それ以外は生バイト（コンパイル済みモジュール。これも先頭 "AVM1"）としてそのまま
     実行。**コンパイル済みモジュールも magic "AVM1" なので、ver/flags＋厳密全長一致で区別**するのが肝。
     runvm / loadvm / disasm の3経路に適用。
   - Actor Loader の MAKINA サンプルは `print` だけで描画ゼロ→ runvm で何も出なかった。`cls()`/`line()`/
     `wait()` で歩行する MAKINA-7 ロボットを `send self` ループで描く版に置換（`MAKINA_ACTOR`）。
   - 検証: 本物 `www/avm/MakinaActor.avm`(430KB, 7700三角形)は回帰なし。AVM1 版 `~/Downloads/MAKINA.avm`
     は runvm で `{"ok":true}` + 19本描画（歩行ロボット表示）。
   - ★これで [落とし穴] の「AVM1=動く/AVM2=不可」に加え、**AVM1 ソースコンテナも runvm/loadvm で開ける**。

### 描画アクターを書くときのメモ（compile.ml/avm.ml）
- 命令: `cls()`=0x46, `line(x1,y1,x2,y2,col)`=0x45, `tri(...)`=0x47, `wait(ms)`=0x07, `print(a)`。
- 色: 16色パレット index、または 24bit トゥルーカラー `0x01RRGGBB`。制約は下の「VM サブセット制約」参照。
- 演算子優先順位は標準（`* / %` > `+ -` > 比較）。アニメは `send self` ループ＋`wait()`。

## ★現状サマリ
- HEAD **`c3a9250`**（main に push 済み, 2026-07-08。上記「2026-07-08 セッションの変更」）。
  以前の主要点は下記（`873d8a7` = `/computer` 実FS・自動更新, 2026-07-01）。M1+M2 完了 = タグ **`v0.6.0`** で Release 公開済み
  → https://github.com/yaskodama/aice-avm/releases/tag/v0.6.0
- Release アセット 6 個（CI が 3OS ビルド）: `server.exe`/`send.exe`(Win)・
  `server-linux-x86_64`/`send-linux-x86_64`・**`server-macos-arm64`/`send-macos-arm64`**。
  ※ `873d8a7` は Release 未タグ（ソース起動 `start.sh`/dune では自動反映。prebuilt 派に配るなら要 `v0.6.1` タグ）。

## 再起動手順（これだけ）
```bash
cd ~/projects/aice-avm && dune build
./_build/default/server.exe 8080          # 起動時にブラウザで http://localhost:8080/ が自動で開く
# 配布形態の確認: ./start.sh （dune があればソースビルド、無ければ Release から OS 判定で prebuilt DL）
```
描画を見る（VM Graphics 窓に回転する4本線・無限ループ）:
```bash
./_build/default/send.exe 127.0.0.1:8080 samples/Rotate4LinesLoop.abcl
```
停止: `lsof -ti:8080 | xargs kill`
★ブラウザで既に開いている場合は **⌘R でリロード**（`index.html` は `xinu.js?v=9`。開きっぱなしのタブは旧JSのまま）。

## ★今回の変更（commit `873d8a7`, 2026-07-01）
- **`/computer` = 本機の実ファイルシステム（read-only）をシェルからアクセス可能に**:
  - `server.ml`: `GET /api/host/ls?path=…`（`Unix.stat`/`Sys.readdir`/`Unix.lstat` → JSON `{path,type,entries:[{name,type,size}]}`、失敗は `{"error":…}`）と
    `GET /api/host/cat?path=…`（内容 text、256KB上限で truncate、ディレクトリ/権限エラーは text）。`%2F` を戻す `url_decode` 追加。
  - `www/js/xinu.js`: VFS に `/computer` マウント。パス先頭が `computer` の時だけ実FSへ（`/computer/Users`→実 `/Users`）。`ls`/`cd`/`cat` を非同期化（出力が次プロンプト前に出るよう Enter で `runCmd` を await）。`tree` と書込系(`mkdir/touch/rm/echo`)は `/computer` 配下で read-only。
  - 使い方: Console 窓で `ls /computer` = 本機ルート、`cd /computer/Users`、`cat /computer/etc/hosts`。
- **「`ls /computer` が非常に遅い」修正**（真因はサーバでなくブラウザ側）:
  - `boot()` が起動時に**実機 Pi ボード3台の HDMI ミラー窓**(`192.168.3.101/.100/.50`)＋Mesh窓を自動起動 → 各窓が `/fb` を定期ポーリング。
  - ボードが LAN に居ない環境（別サブネットでブラックホール）だと **各TCP接続が数十秒ハング**し積み上がり、Chrome のネットワーク/メインスレッド飽和 → シェル入力・出力・`ls` を含め全体が激重に。
  - 修正: 標準配布アプリ（`window.__XINU_AVM`）では**ボードミラー窓＋Mesh窓を自動起動しない**（メニューからは従来どおり開ける）。Pi クラスタ実機運用（非AVMモード）は従来通り自動起動。
  - 検証: バックエンド ls は curl/ヘッドレスChrome とも 0〜10ms（元々速い）。修正後デスクトップは Console/Processes/VM Graphics/3D Display/BASIC/Actor Loader のみ自動起動（ヘッドレス撮影で確認）。

## 自己更新（commit `a92478f`・push 済み）
- `start.sh` / `start.ps1` は **起動時に GitHub を確認し、新しい更新があれば自動取得**:
  - git checkout 利用者 → `git pull --ff-only`（非破壊。ローカル変更/オフライン/非FF は継続）。HEAD が進んだら **launcher を re-exec** して新ソース/スクリプトを反映 → dune が再ビルド。
  - prebuilt 利用者（ツールチェーン無し）→ GitHub API で最新 Release タグを確認し、`bin/.release` と異なればバイナリ再 DL。
  - 無効化: `AICE_NO_UPDATE=1`（env）。`AICE_REEXEC` で再起動ループ防止。
  - ★ローカル bare リポで FF→re-exec の自動更新を実証済み（`a92478f -> 新` に自動前進）。
  - ★初回採用の壁: a92478f より前の古い checkout はこのロジックを持たないので**初回だけ手動 `git pull` が必要**（以後は自動）。

## M2 で入れた変更（commit `bb509b3`）
- **server.ml**: main 末尾で `open_browser()` を呼び、起動時に Xinu デスクトップ UI を自動オープン（従来は描画時のみ）。`--no-open` 尊重。メッセージを "opening desktop UI" に。
- **start.sh**: `uname -s` で OS 判定 DL（Darwin→`server-macos-arm64` / 他→`server-linux-x86_64`）。サンプル自動送信は任意化（第2引数があれば送る。UI の Loader が主入口）。
- **scripts/start.ps1**: サンプル送信任意化・メッセージをデスクトップ UI 案内に。
- **.github/workflows/release.yml**: macOS バイナリの stage/upload/release 追加（★既に macos-latest でビルドしてたのに捨てていたのが盲点だった）。
- **README**: 「The Xinu desktop UI」節 + 整数のみ VM サブセット節を追記。

## ★落とし穴（次回も効く）
- **VM サブセット制約**: 整数のみ・文字列 print 不可（`print(n)` は int、式は OK）・トップレベル文なし（VM が class0 `Main.tick()` を自動起動）・メソッドローカル var 不可（class field のみ・初期化子は実行されず 0、tick() で設定）。
- **.avm 互換**: AVM1（整数アクター bytecode）= 動く。**AVM2（メッシュ/3D）= `avm.ml:42` が "AVM1" 以外を bad magic 拒否 → 動かない**（MakinaMesh/ArmMesh/PortraitMesh）。
- **macOS prebuilt の Gatekeeper**: ブラウザで Releases ページから手動 DL した未署名バイナリは隔離されブロック（`xattr -d com.apple.quarantine <file>`）。**`start.sh` は curl/wget 取得なので隔離されず問題なし**（検証済み）。
- `www/` は aipl-web 由来。`window.__XINU_AVM` モードでログイン無し直起動。Console=/api/console・Processes=/api/actors・VM Graphics=/api/lines・Loader=/actor/loadsrc(ソース) または /actor/loadvm(生.avm)。CORS 有効（aipl-web localhost:4000 → 8080 cross-origin 送信可）。

## 次にやれること（任意・未着手）
1. **README に macOS Gatekeeper 注記**（手動 DL 時の `xattr -d` 一言）。小コミット 1 本。
2. **VM 能力拡張**（選択肢B）: 文字列 print・メソッドローカル var・AVM2 メッシュ受信。
3. **UI 強化**（選択肢C）: 新サンプルアクター・VM Graphics 窓改善・Loader サンプル追加。
4. start.sh の macOS は arm64 のみ（CI の macos-latest が arm64）。Intel Mac 対応が要れば x86_64 ビルドを matrix に追加。

## 関連
- メモリ: `project_aice_avm_xinu_merge.md`（M2 完了で更新済み）
- 元 UI/サイト: `~/aipl-web/NEXT_SESSION.md`（airilab.app 版）
