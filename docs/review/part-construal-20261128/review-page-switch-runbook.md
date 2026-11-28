# 稼働中の確認ページを「構造化の見立ての層」を持つコードへ切り替える手順書

構造化の層は2つ: 独立部分の見立て（領域ごと）と全体の見立て（方向ごと）。

**この手順書は実行していない。** 統括が研究者の状況を確かめてから実行する。稼働中の `http://127.0.0.1:5498` とその状態ファイルは、この手順書を書く間も、試験の間も読み取り以外で触れていない。試験は状態ファイルの写し・別ポートで行った（末尾「試験済みの事実」）。

## 0. 現状と前提

| 項目 | 値（2026-11-28 19:0x 時点の読み取り） |
|---|---|
| 稼働中のサーバー | node PID 56575（親 PID 1）、`/Users/Shogo/Developer/dialogue-grounding-part-observation-20261128/docs/review/orientation-app/server.ts`（`4307078`） |
| node | `/Users/Shogo/.local/share/fnm/node-versions/v24.22.1/installation/bin/node`（v24.22.1）。`REVIEW_*` の環境変数なし（既定のポート 5498・既定の状態ディレクトリ） |
| 状態ディレクトリ | `~/Library/Application Support/dialogue-grounding/orientation-review-v1/`（`review-state.json`・`review-state.previous.json`・`server.log`） |
| 状態の進み具合 | 状態ファイルの写しで revision **50**、現在位置 F2@0、確認済み1（F1@0）。反映（revision 37→38）の後も保存が続いており、**研究者が操作中の可能性が高い** |
| 新しいコード | 2つの層を持つコミット（統合後は統合ブランチ）。以下 `NEW` と呼ぶ。`dialogue-model/runtime/stimuli/primary-regions-data.ts` は同じ catalog `review-final-dae9359580d64a83` |

切り替えで変わること（研究者へ先に伝える）:

- 各領域に「独立部分の見立て」の欄、各方向に「全体の見立ての候補」（構造化した欄: 名詞・姿勢・向き・確信度・領域ごとの役割・根拠・弱点）が増える。自由文の全体の見立て・根拠・役割の行・メモ・確認状態・現在位置・分割と幾何は変わらない。
- 2つの欄に AI 案を入れるのは、切り替えとは別の手順 7（反映）。それまでの欄は空（「未作成」）で、観察メモの完了数にも影響しない。
- 反映の後、**F1@0（切り替え前に確認済み）は完了数に数えられない**。研究者が自由文を手で直していて AI 案の文と一致しないため、構造化の欄は自動で埋めず、全体の見立ての候補に「自由文と要照合」の印が付く（AI 案は未確認の参考として入る）。研究者が照合して「確認して次へ」を押すか、構造化の欄を編集すると印が外れる。ほかの行は、構造化の欄が AI 案のまま「全体の見立て未確認」「部分の見立て未確認」と表示される。
- 反映の後に自由文（全体の見立て・根拠・役割の行）を直すと、その方向に「自由文と要照合」の印が付く（構造化の欄と食い違うかもしれないため）。
- 反映で revision が上がるので、開いたままのブラウザは次の保存で拒否され、画面に「退避して保存版を読み込む」が出る。反映の前に画面を閉じてもらうか、反映の後に再読み込みしてもらう。

## 1. 変数

```sh
export PATH="/Users/Shogo/.local/share/fnm/aliases/default/bin:$PATH"
STATE="$HOME/Library/Application Support/dialogue-grounding/orientation-review-v1"
OLD=/Users/Shogo/Developer/dialogue-grounding-part-observation-20261128   # ロールバック先（4307078）
NEW=<新しいコードのチェックアウト>                                          # 例: 統合ブランチの worktree
PROPOSAL="$NEW/docs/review/part-construal-20261128/part-construal-468.json"  # 独立部分の AI 案。無ければ exp/BalmyDarwin 1c5fd3e から取り出した写し
CONSENSUS="$NEW/docs/review/construal-consensus-20261128/consensus-120.json"  # 全体の見立ての AI 案（構造化済み）
BK=/Users/Shogo/Research/dialogue-grounding/private-runs/2026-11-28-rotation-memory-implementation/review-backups/switch-$(date +%Y%m%d-%H%M)
```

`BK` はリポジトリの外。実対話データではないが研究者のメモを含むので、リポジトリや PR に入れない。

## 2. 実行前の確認（読み取りだけ）

```sh
lsof -nP -iTCP:5498 -sTCP:LISTEN                                   # 稼働中の PID
PID=$(lsof -nP -iTCP:5498 -sTCP:LISTEN -t); ps -p "$PID" -o pid,ppid,etime,command
git -C "$OLD" log --oneline -1                                      # 4307078 以降であること（ロールバック先が残っている）
git -C "$NEW" log --oneline -1; git -C "$NEW" status --short        # 目的のコミットで、未コミットの差分が無い
curl -s http://127.0.0.1:5498/api/state | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log({revision:j.revision,updatedAt:j.updatedAt,currentId:j.currentId,confirmed:j.results.filter(r=>r.status==="確認済み").length})})'
```

- `updatedAt` が数分以内なら研究者が操作中。**切り替えの時刻を研究者と決める**（保存済み表示を確認して入力を止めてもらい、手順 3〜6 の間は画面を操作しない）。
- 他の担当のブラウザ E2E が動いていないこと（`ps` で headless のブラウザを確認）。重い処理を同時に走らせない。
- `NEW` で試験を確認済みであること: `node --test docs/review/orientation-app/orientation-review.test.ts docs/review/orientation-app/independent-part-review.test.ts docs/review/orientation-app/whole-construal-review.test.ts docs/review/part-construal-20261128/apply-part-construal-to-review.test.ts docs/review/part-construal-20261128/apply-whole-construal-to-review.test.ts`

## 3. 状態の退避（稼働中のまま、読み取りだけ）

```sh
mkdir -p -m 700 "$BK"
cp -p "$STATE/review-state.json"          "$BK/review-state.before.json"
cp -p "$STATE/review-state.previous.json" "$BK/review-state.previous.before.json"
cp -p "$STATE/server.log"                 "$BK/server.log.before"
curl -s http://127.0.0.1:5498/api/export -o "$BK/export-before.json"
( cd "$BK" && shasum -a 256 review-state.before.json review-state.previous.before.json export-before.json > sha256-before.txt )
```

## 4. 旧サーバーの停止

```sh
kill -TERM "$PID"; sleep 1
lsof -nP -iTCP:5498 -sTCP:LISTEN || echo "port 5498 is free"
cmp "$STATE/review-state.json" "$BK/review-state.before.json" && echo "state unchanged since the backup"
```

- 保存は各リクエストの中で同期的にアトミックに書かれる（一時ファイル→`rename`）ので、停止で中途半端な状態は残らない。
- `cmp` が不一致なら、手順 3 の後に研究者が保存した。**旧サーバーを手順「ロールバック A」の起動コマンドで起動し直し、手順 3 からやり直す**（この退避を基準にしない）。

## 5. 新サーバーの起動（同じポート・同じ状態ディレクトリ）

```sh
( cd "$NEW" && REVIEW_PORT=5498 REVIEW_STATE_DIR="$STATE" nohup node docs/review/orientation-app/server.ts >> "$STATE/server.log" 2>&1 < /dev/null & )
sleep 2; tail -n 4 "$STATE/server.log"
```

期待する出力（`server.log` の末尾）:

```
独立部分の見立て: 旧版の保存内容に空の欄を補いました（次の保存まで保存ファイルは変わりません）。
全体の見立ての構造化: 旧版の保存内容に空の欄を補いました（次の保存まで保存ファイルは変わりません）。
Orientation review: http://127.0.0.1:5498/
State: /Users/Shogo/Library/Application Support/dialogue-grounding/orientation-review-v1/review-state.json
```

起動に失敗する場合（`既存の保存内容とデータが一致しません。上書きしません。`、層の検証エラー）は、状態ファイルを書き換えずに終了する。**ログを控えて「ロールバック A」へ。**

## 6. 移行の確認（読み取りだけ）

```sh
cmp "$STATE/review-state.json" "$BK/review-state.before.json" && echo "startup did not rewrite the file"
node "$NEW/docs/review/part-construal-20261128/verify-switch.ts" --url http://127.0.0.1:5498 \
  --before-state "$BK/review-state.before.json" --before-export "$BK/export-before.json" --layer empty
```

`verify-switch.ts` は GET だけを送り、次を確かめる（1つでも違えば `NG: …` と終了コード 1）。

- catalog・`sourceSha256`・`schemaVersion`・**現在位置（currentId）・revision・updatedAt が切り替え前と同じ**。
- 全120行の `results`（確認状態・メモ・全体の見立ての自由文・部分の役割・「形・位置の説明」）が切り替え前と完全に同じ。
- 構造化の2つの層は空（独立部分は 120 方向・468 領域、全体の見立ては 120 方向。AI 案なし、「自由文と要照合」の印なし）。
- 書き出しは、切り替え前の書き出しと「構造化の2つの層」以外で同一（幾何・分割・面積・位置関係を含む）。

続けて研究者に、画面を再読み込みして現在位置と進み具合が切り替え前と同じこと、各領域に空の「独立部分の見立て」、各方向に空の「全体の見立ての候補」の欄があることを確かめてもらう。ここまでで問題があれば「ロールバック A」。

## 7. AI 案の反映（切り替えの確認が済んでから。統括の判断で別に実行してよい）

2つの反映は独立で、どちらから先でもよい。どちらも**変更があるときだけ**保存し（revision が1ずつ上がる）、確認済み・編集済みの欄、自由文、メモ、現在位置は変えない。

**7a. 独立部分の見立て**

```sh
node "$NEW/docs/review/part-construal-20261128/apply-part-construal-to-review.ts" \
  --part-construal "$PROPOSAL" --backup-dir "$BK/apply-parts-dry" --state-file "$STATE/review-state.json" --dry-run
node "$NEW/docs/review/part-construal-20261128/apply-part-construal-to-review.ts" \
  --part-construal "$PROPOSAL" --backup-dir "$BK/apply-parts" --state-file "$STATE/review-state.json"
```

期待（切り替え直後）: dry-run の `counts` が `added: 468`、他は 0。研究者が確認・編集済みにした欄は `keptConfirmed`・`keptEdited` に入り置き換えない。反映後は候補あり306領域・候補388件・候補なし162領域（1c5fd3e 版）。

**7b. 全体の見立て（構造化）**

```sh
node "$NEW/docs/review/part-construal-20261128/apply-whole-construal-to-review.ts" \
  --consensus "$CONSENSUS" --backup-dir "$BK/apply-whole-dry" --state-file "$STATE/review-state.json" --dry-run
node "$NEW/docs/review/part-construal-20261128/apply-whole-construal-to-review.ts" \
  --consensus "$CONSENSUS" --backup-dir "$BK/apply-whole" --state-file "$STATE/review-state.json"
```

期待（切り替え直後）: dry-run の `counts` が `added: 120`、他は 0。`needsTextCheck` と `textDiffersFromProposal` は **`["F1@0"]`**（写しの revision 50 時点。研究者がほかの行の自由文を手で直していればその行も入る。これらは失敗ではなく、画面で照合してもらう行）。反映後は候補あり80方向・候補99件・見立てなし40方向（`consensus-120.json` の 4e09b62 版）。自由文は AI 案の文との完全一致で判定し、**自由文を解析して構造化の欄を埋めることはしない**。

**7 の共通**

```sh
node "$NEW/docs/review/part-construal-20261128/verify-switch.ts" --url http://127.0.0.1:5498 \
  --before-state "$BK/review-state.before.json" --before-export "$BK/export-before.json" --layer applied
# 片方だけ反映した場合は --layer と --whole-layer を個別に empty|applied で指定する
```

- 保存時に revision が変わっていれば（研究者が保存した）上書きせず、変更行を報告して終了コード 3 で止まる（`$BK/apply-*/conflict.json`）。**自動では再実行しない。** 研究者の保存が落ち着いてから、新しい `--backup-dir` でやり直す。
- 退避は `--backup-dir` に作られる（反映前の状態・書き出し・状態ファイルの写し・計画、反映後の状態・書き出し）。ディレクトリが既にあるとエラーになる。
- 反映後の `verify-switch.ts` が `NG: results … differ` を出したら、反映の後に研究者が保存した可能性がある。`$BK/apply-*/state-after.json` と比べる。出力の `wholeConstruals.needsTextCheck` が「自由文と要照合」の行の一覧。
- 反映が済んだら研究者に再読み込みしてもらう（revision が上がっているので、開いたままの画面は次の保存で拒否される）。

## 8. ロールバック

トリガー: 新サーバーが起動しない、手順 6 の確認が NG、画面が壊れている、研究者が戻すよう求めた。**新しい欄で入力した内容は、戻す前に書き出して残す。**

**A. 反映の前（保存ファイルが旧のまま）**: 新サーバーを止めて旧コードを起動するだけ。状態ファイルは変わっていないので復元は不要。

```sh
PID=$(lsof -nP -iTCP:5498 -sTCP:LISTEN -t) && kill -TERM "$PID"; sleep 1
cmp "$STATE/review-state.json" "$BK/review-state.before.json" && echo "state is the one before the switch"
( cd "$OLD" && nohup node docs/review/orientation-app/server.ts >> "$STATE/server.log" 2>&1 < /dev/null & )
sleep 2; tail -n 2 "$STATE/server.log"
```

**B. 反映の後・または新しい欄に保存が入った後**: 旧サーバーは新しい状態ファイルをそのまま読め、**2つの層を知らないまま保って保存する**（写しで旧コードに保存させて確かめた）。旧画面には層が見えず編集もできないが、全体の見立て（自由文）・メモ・確認状態の保存は従来どおり。復元は不要で、まず書き出しを残してから A と同じ手順で旧コードを起動する。

```sh
curl -s http://127.0.0.1:5498/api/export -o "$BK/export-rollback.json"          # 新しいサーバーが動いているうちに
cp -p "$STATE/review-state.json" "$BK/review-state.rollback.json"
# 以降は A の停止・起動と同じ
```

**C. 切り替え前の状態へ完全に戻す**（新しい欄の入力と切り替え後の保存を捨てる。B の書き出しを必ず先に残す）:

```sh
PID=$(lsof -nP -iTCP:5498 -sTCP:LISTEN -t) && kill -TERM "$PID"; sleep 1
cp -p "$STATE/review-state.json" "$BK/review-state.discarded.json"
cp -p "$BK/review-state.before.json"          "$STATE/review-state.json"
cp -p "$BK/review-state.previous.before.json" "$STATE/review-state.previous.json"
( cd "$OLD" && nohup node docs/review/orientation-app/server.ts >> "$STATE/server.log" 2>&1 < /dev/null & )
```

稼働中のプロセスがあるまま状態ファイルを差し替えない（サーバーは状態をメモリに持ち、次の保存で上書きする）。戻した後は `curl -s http://127.0.0.1:5498/api/state` の revision が `before` の値と同じことを確かめ、研究者に再読み込みしてもらう。

## 9. 画面の確認と、確認済みの意味

- 構造化の欄（独立部分・全体の見立ての候補）の左の色と札で状態が分かる: 黄＝AI案・未確認、緑＝確認済み、青＝編集済み、灰＝未作成。全体の見立ての候補に橙の「自由文と要照合」が付く行は、自由文と構造化の欄の照合が必要。
- 「確認して次へ」はその方向の未確認の AI 案（独立部分・全体の両方）を確認済みにし、「自由文と要照合」の印を外す。構造化の欄を編集すると編集済みになり、印も外れる（方向は未確認へ戻る＝既存の規則）。「要修正として次へ」は欄の状態を変えない。自由文だけを編集すると、印が付く。
- 方向の完了＝「確認済み」かつ、構造化の2つの層に「AI 案の未確認」も「自由文と要照合」の印も無いこと。進み具合の `観察メモ N / 120方向` と「未確認のみ」の絞り込みはこの意味で数える。
- 書き出し JSON は、各方向に `wholeConstrual`、各部分に `independentPart` を持つ（形式は `orientation-app/README.md`）。束の入力（B1）はこの形を使い、確定として扱うのは「確認済み」かつ AI 案の未確認と印が無い方向で、残りは一覧で報告する。

## 試験済みの事実（2026-11-28、写しと別ポートで実施。稼働中のサーバーと状態ファイルへは書いていない）

稼働中の状態ファイルの**読み取りコピー**（revision 50、現在位置 F2@0、確認済み1、層なし）と、1c5fd3e の `part-construal-468.json`、4e09b62 の `consensus-120.json` で確認した。

- 新サーバーは旧状態ファイルを変更せずに読み（起動前後のハッシュ一致）、revision・updatedAt・currentId・全120行の `results` が一致、2つの層は空（起動ログは上記の2行）。
- 独立部分の反映は `--dry-run` で added 468、反映後は revision+1、候補あり306・候補388・候補なし162・未合意3。全体の見立ての反映は added 120、候補あり80・候補99・見立てなし40・未合意1、**印が付くのは F1@0 の1行だけ**。どちらも `results` と現在位置は完全一致で、2回目の反映は変更なしで保存しない。
- 書き出しは、反映前後で2つの層以外に差がない。
- 旧コード（`4e09b62` の `server.ts`）を2つの層を持つ状態ファイルの写しで起動して保存させても、2つの層は完全に保たれ、新コードで読み直しても残った（ロールバック B の根拠）。
- `verify-switch.ts` は、空・片方だけ反映・両方反映の正しい状態で成功し、層の状態の取り違えと、反映後の研究者の保存では `NG` で終了コード 1 になることを確認した。
- 実ブラウザ（headless Chrome for Testing 1248・使い捨てプロファイル・別ポート・写し）: 保存位置の表示、F1@0 の「自由文と要照合」と完了数、独立部分と全体の見立ての編集・追加・削除・見立てなし、自由文の編集で印が付き構造化の編集で外れること、確認して次へ・要修正として次へ、書き出しと `/api/export` の一致、幅390pxで欄の中にあふれなし。証跡は担当への報告に記載。
