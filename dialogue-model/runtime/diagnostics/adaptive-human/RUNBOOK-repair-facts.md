# repairFacts の opt-in 技術試運転

研究計画の正本は [dialogue-model/README.md](../../../README.md)。本手順は Issue #14 案 A2 の配線・記録・復元の診断であり、研究条件の採用、意味上の進展の判定、実参加者の予備試験を代替しない。固定回数による repair 禁止や defer/move_on の強制は行わない。本変更の検証では実モデルを呼び出さず、Worker・参加者 UI を配信しない。

`adaptive_repair_v3` は v2 の agreement gate・修復見込み・採否表・生成設定を維持し、Jev の行動判断・詳細選択・修復見込みに機械的な `facts` を加える。人間の参照対象推定には加えない。特徴文の一致や候補集合の一致は意味的同一性や停滞の判定ではない。OFF/v1/v2 は従来の経路を維持する。

## オフラインで先に確認する

Node の型除去を使う。以下の HTTP テストはブラウザなしで、合成の Luna/Jev transport だけを使用する。外部 API・本物の鍵は不要。

```sh
node --test tests/participant-jev-wiring.test.ts tests/adaptive-human-cli.test.ts tests/adaptive-human-http.test.ts
./node_modules/.bin/tsc -p tsconfig.runtime.json
```

HTTP テストは既定 OFF と v3 の両方略を順に実行し、非空の修復履歴を持つ実際の偽 Jev リクエストに facts が入り、両方略で同一であることを確認する。続いてサーバーを停止・再起動し、cookie を引き継いだ同じ記録・台帳・trace・queue を追加 POST なしで復元してから、6名称と仮質問紙を提出する。参加者設定の未知版・余剰キー、新旧版の混用、v3 の識別情報を欠く保存も拒否する。少数 POST で予算を使い切る局所テストは、停止済み台帳の復元と手動 retry が追加 POST を発生させないことを確認する。

Chrome を使うブラウザ E2E は統合担当が一系列ずつ実施する。専用の Chrome または loopback CDP を指定する。未指定時の skip はブラウザ検証の成功とは数えない。

```sh
ADAPTIVE_HUMAN_CDP="$CDP_ORIGIN" ADAPTIVE_HUMAN_KEEP=1 node --test tests/adaptive-human-e2e.test.ts
```

v2 と v3 の同一条件での合成出力を個別に残す例（各出力先は新規、repository 外）。`CDP_ORIGIN` は `http://127.0.0.1:<port>`、`OUT_ROOT` は専用の private directory を事前に指定する。

```sh
umask 077
for version in adaptive_repair_v2 adaptive_repair_v3; do
  for strategy in repair-first bypass-enabled; do
    node dialogue-model/runtime/diagnostics/adaptive-human/run.ts --mode offline --out "$OUT_ROOT/$version-$strategy" --cdp "$CDP_ORIGIN" --turns 3 --persona-seed 20261027 --trial-version "$version" --strategy "$strategy" --jev-actions confirm,repair,accept
  done
done
```

`--technical-trial` は従来どおり v1。`--trial-version` は v1/v2/v3 の明示値だけを受け付ける。未知版を OFF に読み替えない。`--strategy` と `--jev-actions` は offline の合成制御であり、実モデルの選択を固定するためには使わない。

## 将来、承認された実モデル試運転を行う場合

以下は実施手順の記録であり、本作業では実行していない。研究者が対象 seed、人間役条件、試行数と総予算、送信する合成画像、停止条件を承認してから、統合担当が起動する。

必要な接続情報・秘密は次のとおり。

- `RESEARCH_AI_PROVIDER=cloudflare` と `RESEARCH_AI_BASE_URL`（研究用 Worker の `/v1`）。クライアントは `purpose=dialogue_turn` のみを送り、モデルを指定しない。Worker の `/v1/model-policy` と返却モデルで同一性を確認する。
- `RESEARCH_PROXY_TOKEN` は研究用 Worker への接続用。上流の `UPSTREAM_API_KEY` は Worker Secret にのみ置き、ローカルへコピーしない。
- Jev は既存の macOS Keychain reader が読み取る OpenRouter 用の鍵。鍵の登録・取得は既存の運用手順に従い、値をファイルやターミナルへ表示しない。この鍵は Worker の上流鍵とは別。
- `ADMIN_TOKEN` はローカル管理 export 用。32〜512文字の既存仕様を満たすものを operator が用意する。URL やコマンド引数に秘密を含めない。
- `ENV_FILE`、`GUARD_MODULE`、`SERIALIZER_MODULE` は統合担当の private な既存設定。env file は0600、親 directory・記録保存先・owner store・観察 cache は0700。symlink や共有 hardlink の設定ファイルは使わない。

参加者設定は `participant_jev_config_v1` の既存項目を維持し、v3 の設定ファイルにだけ `"technicalTrial":{"version":"adaptive_repair_v3"}` を加える。比較用 v2 は `adaptive_repair_v2` とする。`lunaRequest`、timeouts、cacheDirectory、modelId、memoSha256、seed、limits は同じ値にする。limits は `lunaCalls/lunaTokens/lunaPosts/jevPosts/jevUsd` 全項目を明示し、試行前に研究者が決める。jevUsd は既存の上限0.05 USD以下であり、推奨予算や hard な総費用上限ではない。

assignment は既存の private `base_assignment_config_v1` を使い、同じ seed と referenceMemory=true で両方略を別々に起動する。既存 P1 配線は `relative_pm90` のみ。研究者が回転条件を変える場合は別途その経路の対応・検証が必要で、この試運転で独断変更しない。観察 cache は同一の memo を共用し、cache MISS・hash 不一致なら参加者開始前に停止する。新規 warm-up が必要なら、それ自体を別途承認・計上し、`participant-jev-warm.ts` の既存手順を使う。

承認後に統合担当が実行する起動形（private な変数値は出力しない）:

```sh
node --env-file="$ENV_FILE" --import "$GUARD_MODULE" dialogue-model/runtime/web/server.mjs --port "$APP_PORT" --base-assignment-file "$ASSIGNMENT_FILE" --base-store-root "$OWNER_ROOT" --participant-jev-config "$PARTICIPANT_CONFIG"
```

別のターミナルで、起動済み参加者サーバーと専用 CDP に接続する。

```sh
node --env-file="$ENV_FILE" --import "$GUARD_MODULE" dialogue-model/runtime/diagnostics/adaptive-human/run.ts --mode live --app "$APP_ORIGIN" --cdp "$CDP_ORIGIN" --out "$OUT_DIR" --turns "$TURN_CAP" --persona-seed "$PERSONA_SEED" --before-turn-module "$SERIALIZER_MODULE"
```

live の版と方略は参加者サーバーの private 設定で選ぶ。live driver の `--trial-version/--technical-trial/--strategy/--jev-actions` は、サーバー設定に反映できないため拒否する。driver の turn cap は技術停止であり、研究の時間制限や停滞判定ではない。

## 予算・停止と復元

participant ledger は各試行の実 POST 直前で予約する。Luna の論理呼出し数・POST数・観測 token 数、Jev の POST数・観測費用を記録し、上限到達や費用不明、モデル不一致で止まる。観測費用/token は事後値であり、進行中の送信による超過や token 不明分を含む hard cap ではない。native retry も POST の予約対象。タイムアウト時に結果不明の Jev 予約を消さない。

人間役 live simulator の費用と、別プロセスの warm-up は participant ledger の外である。統合担当の既存 guard はそれらも含む総予算・未決済予約を扱う必要がある。`before-turn-module` は台帳自体を harness に渡さず、未決済予約の解消を待つ既存の引数なし async 関数を指定する。guard が未準備なら live は始めない。

budget_stop、費用不明、モデル不一致、API エラー、UI timeout、保存失敗が出たら、その試行を停止し、次の pair に進まない。driver は閉じた失敗 code だけを記録する。元の owner store と設定・記録を保存し、自動 retry や新規 store で予算をリセットしない。サーバーを停止して設定が同一であることを確認し、再起動は同じ store と cookie で行う。停止済み台帳は保持され、追加送信を許さない。v2 保存を v3 で開く、v3 保存をフラグなしで開く、といった途中移行は拒否される。新しい比較試行は、operator の明示判断の後で別 directory に作成し、失敗試行も分母に残す。

## 出力の回収と比較

driver は `surfaces.private.json`、`page.public.html`、`human.private.json`、`DRIVER-LOG.json` を出力する。offline は assignment/config/cache/owners と `record.private.json` も出力する。実試行の researcher record と質問紙は、既存の認証付きローカル管理 export で別途回収する。鍵・画像本文・公開発話を Git、Issue、CI に貼らない。失敗時も driver が保存した途中の surface と log、owner store 内の failed trace・台帳を保全する。server 起動前の失敗やブラウザ接続前の失敗では driver 出力が揃わないことも記録する。

各 pair について git SHA/差分の識別子、Node・Chrome、seed、persona seed、回転モード、版、profile hash、memo hash、モデル同一性、予算、実行順、停止理由を private に残す。v2対v3、repair-first対bypass-enabledで同じ seed/persona/初期画像・公開履歴・生成設定・予算を使い、別の記録・owner store・browser context にする。実モデルの出力が分岐した後は同一材料の比較とみなさず、差を facts の効果と断定しない。

```sh
node dialogue-model/runtime/diagnostics/repair-runs.ts --scan "$OUT_ROOT"
```

`repair-runs.ts` は版・方略・回転別の集計だけを出力する。返答候補集合の同一/絞り込み/拡大・移動/比較不能、同じ特徴文の再提示、Jev の元の行動と採否、見込みとプログラムの progress を参照する。`candidatesBefore` は Jev 自身の行動対象なので、相手の返答候補集合の基準として比較しない。回数、`changed`、`progressing`、同じ集合のいずれか単独で停滞や成功を決めず、公開発話と局所記録を独立に照合する。模擬の6名称・質問紙は提出 smoke で、理解や負担の測定結果には使わない。

再現は元の出力を上書きせず、新規 private directory で同一設定を使う。外部障害と実装・fixture・harness の不整合を切り分け、失敗した局所テストだけを先に確認する。OFF の失敗経路 fixture は、出典ファイルの hash だけが変わったときに統合担当が既存の再採用手順で取り直す（要求本文・挙動の差がないことを確認する）。試運転のために取り直さない。

## 実モデル試運転を始める前の確認

次がすべてそろうまで live を始めない。

1. 研究者の承認: seed、persona seed、人間役条件、試行数、各試行の `limits`、総予算、実行順、停止条件。2026-10-29 の承認（累計 USD 5、使用済み 0.275）を v3 に流用するかどうかも、研究者が明示する。
2. 版: 試運転に使う commit が main に入り、main の CI が成功している。その SHA を private の記録に残す。
3. 日本語: Jev への facts の説明 1 文（`REPAIR_FACTS_GUIDANCE`）の Argon 評価が済んでいる。または、研究者が「Argon 未評価のまま技術試運転する」と明示している。未評価なら、試運転の記録にそのことを書く。
4. 接続: 秘密を表示せずに `/v1/model-policy` を一度確認し、`modelId` と一致している。Keychain の Jev 用の鍵が読める（値は表示しない）。
5. 費用 guard: `GUARD_MODULE` と `SERIALIZER_MODULE` を用意し、人間役 simulator の費用も総予算に含めている。
6. 前回の例（2026-10-30、両方略 × 5 ターン 1 対で 0.047 USD）は参考値で、上限ではない。v3 の facts は呼出しの回数を増やさないが、入力文字数を増やす。

最小の比較の例（採用ではない）: 同じ seed と persona で v2 と v3 をそれぞれ repair-first と bypass-enabled で 1 回ずつ、計 4 試行。順序は研究者が決める。

## 記述する指標（判定の閾値ではない）

各試行について次を記録し、v2 と v3、repair-first と bypass-enabled で並べる。数値の基準は置かない。

- 完走: 停止理由（`simulator_done` / `turn_cap` / budget / エラーコード）、再起動からの復元、提出・質問紙・結果・再読込の可否。
- 安全: 公開面の走査（scanner v3）の違反件数。generationGuard の `internal_field` などの違反、再生成、fallback の件数。facts の英語コードが公開発話に出ていないこと。
- 材料: v3 の各判断で Jev に渡した `repairFacts`（trace と committed jevTurn）。その `replyVsPrevious` と `sameQuestionAsPrevious` の分布。
- 選択: `repair-runs.ts` の `afterSameReply`（返答の候補集合が直前と同じだった後に、Jev が元々選んだ行動）、`originalActions` と `dispositions`、明確化の連続区間の長さ、`repeatedAsk`、`prospect` と `programVsProspect`。
- 発話: 修復ターンの長さ、公開発話が採否後の行動と一致しているか（move_on が棄却された後に移行を述べていないか）。

v3 で defer や move_on が増えても、減っても、それだけで改善や不具合とはしない。同じ候補集合が続いた場面の公開発話を、研究者が独立に読む。1 対の結果から率や効果は主張しない。
