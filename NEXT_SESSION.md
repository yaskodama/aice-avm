# aice-avm — 次回セッション引き継ぎ (2026-08-31 更新)

## ★2026-08-30〜31 — AVM の処理系を現行 AIPL へ追従させた（main に push 済み）

**目的**: Xinu Pi3/Pi5 の実機で「最新の AIPL」を動かすこと。
**結論**: **カーネルの再焼きは要らなかった。** 直したのは `compile.ml`（Mac 側）だけ。

### なぜ .avm なのか（先に潰した道）

- **Pi3 の `cc` に AIPL 実行時を結線する案は行き止まり**。`system/cc.c` は
  struct も大域変数も配列も持たない極小 C で、実機で確かめると
  `cc: only int main(void) supported in v1`。aipl2c の出力は `struct Obj g_obj[2048];`
  で始まるので読めない。Pi5 の AArch64 JIT を ARM32 へ書き直すのと同義。
- **カーネル内蔵の `abclc.c`（1165行）を伸ばす案も薄い**。認識語は 12 個だけで、
  言語定義が 5 つ目に増える。
- **`.avm`（magic AVM1）は Pi3・Pi5・Mac ホストVM で同じ形式**で、
  `actors/README.md` に「カーネル再ビルド無しで spawn+実行できる」と明記されている。ここに乗った。

```
Mac:  ./_build/default/compile_avm.exe IN.aipl OUT.avm
Pi3:  curl --data-binary @OUT.avm "http://192.168.3.50:8080/actor/loadvm?ask=0"
Pi5:  同じ（/actor/loadvm）
ホスト: ./_build/default/server.exe 8099 --no-open  → 同じ URL。/api/console で値が読める
```

### 入れた機能（すべて VM の既存命令だけに落としている）

| 機能 | 実現方法 |
|---|---|
| `++` / `: T` / `!{...}` / `@ N` / `true`・`false` | 字句と注釈。`: T` は仮引数にも付く |
| **メソッド局所 `var`** | `メソッド名#局所名` の**隠しフィールド**。LDF/STF だけで足りる |
| **`reply(v)`** | `send sender.reply(v)`。**future ではない**ので呼ぶ側に `method reply(..)` が要る |
| **トップレベル文** | 合成クラス `__Top` の `tick` に包んで先頭へ |
| **フィールド初期値** | 合成メソッド `__finit` にまとめ `new` 直後に送る（FIFO なので必ず先に走る） |
| **`now x.m()`** | **継続分割**。`__k` を立てて send して切り、合成 `reply(__v)` が後半を走らせる |
| 式の中の `now` | 一時変数へ持ち上げてから上記に落とす |
| **`timeout <ms> else <v>`** | 合成クラス `__Timer`（`wait(ms); send back.__to(k)`）。**wait は自分のアクタだけ止める**ので別アクタなら呼び出し元は止まらない。先着が `__k` を 0 に落とすので二重に走らない |
| **`future` / `await`** | future は送るだけ、**await が切る**。間の文は返信より先に走る |

**継続分割が成り立つ鍵**: 局所変数を先に隠しフィールドにしたこと。
アクタの状態なので、メソッドを切っても値が残る。

### 制限（黙らずにエラーにしてある）

- `now` / `future` / `await` は**メソッド直下の文の位置**でだけ。`while` の条件では持ち上げない。
- **未処理の `future` は同時に 1 つまで**。VM の返信に相関 ID が無く区別できない。
- `now` を使うクラスは `reply` を自分で定義できない（継続の受け口に使う）。
- **`__Timer` は消えない**。この VM に suicide が無いので `timeout` を使うたび 1 体溜まる。

### 到達点: 正典ガイド 10 本が 0/10 → 4/10

`~/aios/abclcp/docs/samples/guide/g*.aipl` で測る。**これが物差し。**
通るのは g7 / g8 / g9 / g10。残り 6 本の原因は**もう待ち合わせ機能ではない**:

| 本 | 原因 | 直す場所 |
|---|---|---|
| g1 / g2 / g6 | **文字列を値として扱えない**（VM の値は整数のみ） | **VM ＝ SD 焼き直し** |
| g3 | 大域変数（クラス外の変数を他クラスから参照） | compile.ml でも可（要設計） |
| g4 | `select` | VM に命令が無い |
| g5 / g6 | `web_listen` / `ai_call` | VM の組み込み |

### 次の一手 — 文字列を値にする（未着手）

いま `Str` は `print` の書式文字列の中でしか使えない（opcode 0x44 が
文字列表の添字＋`%d` 引数を取る形）。値として渡すには VM 側が要る。

- **案A: 文字列表の添字を値として流す**。`PUSHI (sid s)` で int として渡せるが、
  VM が「int 5」と「文字列 #5」を区別できない。print が壊れる。
  → タグ付き値か、専用 opcode（例 `PRINTS`）が要る。
- **案B: 値にタグを入れる**（Pi5 の cc.c は `(n<<1)|1` のタグ方式）。VM の全演算に影響。

いずれも **`avm.ml`（Mac）と Pi3 カーネル側 VM の両方**を直し、
**SD の物理差し替え**が要る（`/upload`+`/kexec` は brick の記録があるので使わない）。
Pi3 カーネルは `~/projects/xinu-rpi3`（branch `arm-rpi3-port`）、
ビルドは `cd compile && make PLATFORM=arm-rpi3` → `xinu.boot`。

### 実機の作法（踏んだ穴）

- **検証は「先に Mac のホストVM、次に実機」**。ホストVMは `/api/console` で
  値まで読めるが、Pi3 は `enq`/`deq`/`drops` しか読めない。
  **バイトコードの誤りはホストVMで捕まえる。**
- **ボードは連続リクエストに弱い**。2〜4 秒空けて 1 本ずつ。
- Pi3 が 2 度「ping は通るのに HTTP だけ止まる」状態になったが、**再現しなかった**
  （同じ .avm を同じ手順で入れ直すと通る）。1 度目は触っていない Pi5 も同時に落ちていた。
  電源再投入で戻る（`/actor/loadvm` は SD を書き換えない）。
  **再現するようになったら**、リポジトリ最新3コミットが
  まさに HTTP の詰まり（NTCP 不足・half-open・listener プール）を扱っているので焼く価値がある。
- 実機: Pi3 = `192.168.3.50:8080` / Pi5 = `192.168.3.101`（80番）。Pi4 = `.100` は今回ずっとオフライン。

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
