# 稼働中の確認ページを「独立部分の見立て」の層を持つコードへ切り替える手順書

**この手順書は実行していない。** 統括が研究者の状況を確かめてから実行する。稼働中の `http://127.0.0.1:5498` とその状態ファイルは、この手順書を書く間も、試験の間も読み取り以外で触れていない。試験は状態ファイルの写し・別ポートで行った（末尾「試験済みの事実」）。

## 0. 現状と前提

| 項目 | 値（2026-11-28 18:3x 時点の読み取り） |
|---|---|
| 稼働中のサーバー | node PID 56575（親 PID 1）、`/Users/Shogo/Developer/dialogue-grounding-part-observation-20261128/docs/review/orientation-app/server.ts`（`4307078`） |
| node | `/Users/Shogo/.local/share/fnm/node-versions/v24.22.1/installation/bin/node`（v24.22.1）。`REVIEW_*` の環境変数なし（既定のポート 5498・既定の状態ディレクトリ） |
| 状態ディレクトリ | `~/Library/Application Support/dialogue-grounding/orientation-review-v1/`（`review-state.json`・`review-state.previous.json`・`server.log`） |
| 状態の進み具合 | 状態ファイルの写しで revision **50**、現在位置 F2@0、確認済み1。反映（revision 37→38）の後も保存が続いており、**研究者が操作中の可能性が高い** |
| 新しいコード | 層を持つコミット（`434270a` 以降。統合後は統合ブランチ）。以下 `NEW` と呼ぶ。`dialogue-model/runtime/stimuli/primary-regions-data.ts` は同じ catalog `review-final-dae9359580d64a83` |

切り替えで変わること（研究者へ先に伝える）:

- 各領域に「独立部分の見立て」の欄が増える。全体の見立て・メモ・確認状態・現在位置・分割と幾何は変わらない。
- 欄に AI 案を入れるのは、切り替えとは別の手順 7（反映）。それまでの欄は空（「未作成」）で、観察メモの完了数にも影響しない。
- 反映の後、**F1@0 は「部分の見立て未確認」と表示され、完了数に数えられない**（データ上の確認済みは残る。「確認して次へ」を押せば完了に戻る）。反映前に確認済みだった行は、新しい欄を見ていないため。
- 反映で revision が上がるので、開いたままのブラウザは次の保存で拒否され、画面に「退避して保存版を読み込む」が出る。反映の前に画面を閉じてもらうか、反映の後に再読み込みしてもらう。

## 1. 変数

```sh
export PATH="/Users/Shogo/.local/share/fnm/aliases/default/bin:$PATH"
STATE="$HOME/Library/Application Support/dialogue-grounding/orientation-review-v1"
OLD=/Users/Shogo/Developer/dialogue-grounding-part-observation-20261128   # ロールバック先（4307078）
NEW=<新しいコードのチェックアウト>                                          # 例: 統合ブランチの worktree
PROPOSAL="$NEW/docs/review/part-construal-20261128/part-construal-468.json"  # 無ければ exp/BalmyDarwin 1c5fd3e から取り出した写し
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
- `NEW` で型・試験を確認済みであること: `node --test docs/review/orientation-app/independent-part-review.test.ts docs/review/part-construal-20261128/apply-part-construal-to-review.test.ts docs/review/orientation-app/orientation-review.test.ts`

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
sleep 2; tail -n 3 "$STATE/server.log"
```

期待する出力（`server.log` の末尾）:

```
独立部分の見立て: 旧版の保存内容に空の欄を補いました（次の保存まで保存ファイルは変わりません）。
Orientation review: http://127.0.0.1:5498/
State: /Users/Shogo/Library/Application Support/dialogue-grounding/orientation-review-v1/review-state.json
```

起動に失敗する場合（`既存の保存内容とデータが一致しません。上書きしません。`、`独立部分の見立て…` の検証エラー）は、状態ファイルを書き換えずに終了する。**ログを控えて「ロールバック A」へ。**

## 6. 移行の確認（読み取りだけ）

```sh
cmp "$STATE/review-state.json" "$BK/review-state.before.json" && echo "startup did not rewrite the file"
node "$NEW/docs/review/part-construal-20261128/verify-switch.ts" --url http://127.0.0.1:5498 \
  --before-state "$BK/review-state.before.json" --before-export "$BK/export-before.json" --layer empty
```

`verify-switch.ts` は GET だけを送り、次を確かめる（1つでも違えば `NG: …` と終了コード 1）。

- catalog・`sourceSha256`・`schemaVersion`・**現在位置（currentId）・revision・updatedAt が切り替え前と同じ**。
- 全120行の `results`（確認状態・メモ・全体の見立て・部分の役割・「形・位置の説明」）が切り替え前と完全に同じ。
- 独立部分の層は 120 方向・468 領域がすべて空（AI 案なし）。
- 書き出しは、切り替え前の書き出しと「独立部分」以外で同一（幾何・分割・面積・位置関係を含む）。

続けて研究者に、画面を再読み込みして現在位置と進み具合が切り替え前と同じこと、各領域に空の「独立部分の見立て」の欄があることを確かめてもらう。ここまでで問題があれば「ロールバック A」。

## 7. AI 案の反映（切り替えの確認が済んでから。統括の判断で別に実行してよい）

```sh
node "$NEW/docs/review/part-construal-20261128/apply-part-construal-to-review.ts" \
  --part-construal "$PROPOSAL" --backup-dir "$BK/apply-dry" --state-file "$STATE/review-state.json" --dry-run
```

期待: 切り替え直後なら `counts` が `added: 468`、他は 0。研究者が欄を確認・編集済みなら、その分が `keptConfirmed`・`keptEdited` に入り、置き換えられない。`updated` は古い AI 案の入れ替え。

```sh
node "$NEW/docs/review/part-construal-20261128/apply-part-construal-to-review.ts" \
  --part-construal "$PROPOSAL" --backup-dir "$BK/apply" --state-file "$STATE/review-state.json"
node "$NEW/docs/review/part-construal-20261128/verify-switch.ts" --url http://127.0.0.1:5498 \
  --before-state "$BK/review-state.before.json" --before-export "$BK/export-before.json" --layer applied
```

- 保存時に revision が変わっていれば（研究者が保存した）上書きせず、変更行を報告して終了コード 3 で止まる（`$BK/apply/conflict.json`）。**自動では再実行しない。** 研究者の保存が落ち着いてから、新しい `--backup-dir` で手順 7 をやり直す。
- 退避は `--backup-dir` に作られる（反映前の状態・書き出し・状態ファイルの写し・計画、反映後の状態・書き出し）。ディレクトリが既にあるとエラーになる。
- 反映後の `verify-switch.ts` が `NG: results … differ` を出したら、反映の後に研究者が保存した可能性がある。`$BK/apply/state-after.json` と比べる。
- 期待する反映後の層: 468領域すべてが AI 案、候補あり306領域・候補388件・候補なし162領域（`part-construal-468.json` の 1c5fd3e 版）。
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

**B. 反映の後・または新しい欄に保存が入った後**: 旧サーバーは新しい状態ファイルをそのまま読め、**独立部分の層を知らないまま保って保存する**（写しで旧コードに保存させて確かめた）。旧画面には層が見えず編集もできないが、全体の見立て・メモ・確認状態の保存は従来どおり。復元は不要で、まず書き出しを残してから A と同じ手順で旧コードを起動する。

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

- 研究者が確認する時は、各領域の「独立部分の見立て」の枠の左の色と札で状態が分かる: 黄＝AI案・未確認、緑＝確認済み、青＝編集済み、灰＝未作成。
- 「確認して次へ」はその方向の AI 案（未確認の欄）を確認済みにする。欄を編集すると「編集済み」になり、方向は未確認へ戻る（既存の規則と同じ）。「要修正として次へ」は欄の状態を変えない。
- 方向の完了＝「確認済み」かつ「AI 案の未確認が無い」こと。進み具合の `観察メモ N / 120方向` と「未確認のみ」の絞り込みはこの意味で数える。
- 書き出し JSON の各部分に `independentPart`（`reviewStatus`・`candidates`・`noCandidate`・`noCandidateReason`・`ai`）が入る。束の入力（B1）はこの形を使う。

## 試験済みの事実（2026-11-28、写しと別ポートで実施。稼働中のサーバーと状態ファイルへは書いていない）

稼働中の状態ファイルの**読み取りコピー**（revision 50、現在位置 F2@0、確認済み1、層なし）と、1c5fd3e の `part-construal-468.json` で確認した。

- 新サーバーは旧状態ファイルを変更せずに読み（起動前後のハッシュ一致）、revision・updatedAt・currentId・全120行の `results` が一致、層は468領域すべて空。
- `--dry-run` は `added: 468`。実際の反映後は revision +1、現在位置と `results` は完全一致、層は468領域（候補あり306・候補388・候補なし162・未合意3、すべて AI 案）。2回目の反映は変更なしで保存しない。
- 書き出しは、反映前後で独立部分の追加以外に差がない。
- 旧コード（`4e09b62` の `server.ts`）を新しい状態ファイルの写しで起動して保存させても、層は完全に保たれ、新コードで読み直しても層が残った（ロールバック B の根拠）。
- `verify-switch.ts` は、空・反映後の正しい状態で成功し、層の状態の取り違えと、反映後の研究者の保存では `NG` で終了コード 1 になることを確認した。
- 実ブラウザでの確認は別に記録する（担当への報告を参照）。
