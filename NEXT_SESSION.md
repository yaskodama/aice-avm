# aice-avm — 次回セッション引き継ぎ (2026-06-25 更新)

OCaml 本物 AVM ホスト VM（Win/Mac/Linux、stdlib のみ）。GitHub `yaskodama/aice-avm`（public）。
**Web Xinu デスクトップ UI を合体**して「git clone → start だけで動くダウンロード配布アプリ」にするプロジェクト。

## ★現状サマリ（M1 + M2 = 完了・push 済み）
- HEAD `bb509b3`（main に push 済み）＋ タグ **`v0.6.0`** で **Release 公開済み**
  → https://github.com/yaskodama/aice-avm/releases/tag/v0.6.0
- Release アセット 6 個（CI が 3OS ビルド）: `server.exe`/`send.exe`(Win)・
  `server-linux-x86_64`/`send-linux-x86_64`・**`server-macos-arm64`/`send-macos-arm64`**（今回追加）。

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
