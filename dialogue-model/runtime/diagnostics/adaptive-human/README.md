# 適応的人間役の技術診断

研究計画の正本は [dialogue-model/README.md](../../../README.md)。この診断は研究条件・尺度・参加者モデルの採用を決めない。mock の返答や主観値は実モデルの理解・共同採用の oracle に使わない。

`simulator.ts` は公開の human/ai 発話、seed から別に作った persona、人間のブラウザ上の盤面 PNG/JPEG だけを受け取る純粋な mock と入力・出力検証を持つ。top-level と入れ子の余分な key、アクセサ、継承 object を拒否する。課題指示はコード内で共通に固定し、割当の seed は入力にしない。A/B は `createPersona()` の同じ seed と同じ初期の可視画像・履歴・生成設定で始める。mock は視覚を解釈しないため、特徴を公開履歴から反復して確認するだけで、画像に見えた特徴を作らない。名前の説明を確認しても、対象の一致や共同採用を確定しない。理解度は非校正の診断用仮値であり、正答確率ではない。

`live.ts` の `liveHuman({baseUrl, apiKey, timeoutMs, maxCompletionTokens}, fetchImpl?)` は既存の `runtime/client.mjs` を使う。POST は `purpose=dialogue_turn`、`model` 欄なし。環境変数・鍵ファイルは読まない。親が Worker 接続設定と費用 guard を用意し、実 API の実行は親だけが行う。出力は `utterance/done/private` の閉じた JSON で検証する。送信前の whitelist と、ブラウザからの材料の取り出しは別の境界である。許可した文字列に秘密を埋め込む呼び出し元まで validator が検出するものではない。

`harness.ts` の `driveParticipant()` は、起動済み参加者サーバーと CDP Chrome の loopback origin、保存先、persona、simulator を受け取る。公開 state から発話本文と speaker だけを取り出し、`#board` の画面上の領域だけを撮影する。scene metadata、event ID、サーバーの private record は simulator に渡さない。毎ターン AI の返答・idle を待ち、その後に任意の `beforeSimulatorTurn: () => Promise<void>` を await する。親はこのフックで未決済の費用予約がなくなるのを待てる。harness は台帳を読まない。

対話の停止は simulator の `done` または技術的な `maxTurns`（既定4）で区別して記録する。mock は自動的に全6図形の理解を宣言しないので、通常は `turn_cap` で終わる。続く6名称は「合成の名前1〜6」、質問紙は仮の中間選択4で、提出の技術 smoke に限る。名称一致率や質問紙得点を理解・負担の測定結果として使わない。これはブラウザの再読込までの確認で、サーバープロセスの再起動の試験ではない。

## オフライン実行

Node は `~/.local/share/fnm/node-versions/v22.23.4/installation/bin/node`。既存 P1 fixture と同じ初回観察キャッシュを合成で用意し、`prepareParticipantJev` と `runtime/web/server.mjs` のサーバーを使う。これは `--participant-jev-config` の P1 配線と同じ factory を偽 transport 付きで準備する経路であり、CLI の実接続は行わない。偽の Luna/Jev は native fetch を呼ばず、credentials も合成リテラル。Chrome は独立 profile と自動 port を使用する。

```sh
node dialogue-model/runtime/diagnostics/adaptive-human/run.ts \
  --out /private/tmp/adaptive-human-private-run \
  --chrome '/path/to/Google Chrome for Testing'
node --test tests/adaptive-human.test.ts
node --test tests/adaptive-human-http.test.ts
ADAPTIVE_HUMAN_CHROME='/path/to/Google Chrome for Testing' \
  node --test tests/adaptive-human-e2e.test.ts
```

E2E は Chrome または `ADAPTIVE_HUMAN_CDP=http://127.0.0.1:<port>` の指定時だけ実行する。後者は親が起動した Chrome に接続し、そのプロセスは止めない。`ADAPTIVE_HUMAN_KEEP=1` を付けると、合成資料の一時出力を残して診断の path を表示する。型は `./node_modules/.bin/tsc -p tsconfig.runtime.json`。HTTP focused test は Chrome なしで、偽の P1 server 起動、初期の公開AI挨拶を含む mock の1往復、state、6名称提出、質問紙、review 解放、同一試行の再取得と管理 export を検証する。ブラウザ操作を確認したという意味にはしない。

親が使う1行コマンド（`node` は指定版の PATH を設定済みとする）:

```sh
node dialogue-model/runtime/diagnostics/adaptive-human/run.ts --mode offline --out "$OUT_DIR" --cdp "$CDP_ORIGIN" --turns 3 --persona-seed 20261027
node --env-file="$ENV_FILE" --import "$GUARD_MODULE" dialogue-model/runtime/diagnostics/adaptive-human/run.ts --mode live --app "$APP_ORIGIN" --cdp "$CDP_ORIGIN" --out "$OUT_DIR" --turns 4 --persona-seed 20261027 --before-turn-module "$SERIALIZER_MODULE"
```

offline は `--cdp` の代わりに `--chrome <executable>` でも起動できる。live は、親が P1 参加者サーバーと Chrome を先に起動する。`ENV_FILE` と guard は親だけが準備・読み込みし、この子では実行しない。`SERIALIZER_MODULE` は引数なしの async 関数を default export する親のモジュールで、未決済予約が0になるまで待つ。省略時のフックは何もしない。guard 用の予算・台帳・stage 環境変数は親が既存の runbook に従って付ける。

保存する資料（ディレクトリ0700、ファイル0600）:

- `surfaces.private.json`: scanner v3 / `scan-live.mjs` と同じ `{label,phase,status,text}[]`。state、review locked/unlocked、質問紙、records、再読込を含む公開面9件。
- `page.public.html`: 結果表示後の再読込ページ。公開DOMの追加走査用。
- `human.private.json`: persona と各ターンの非公開の信念・不確かさ・質問・変化。公開面資料には含めない。
- `DRIVER-LOG.json`: 発話本文や秘密を含まない段階・回数・停止理由。
- オフラインでは `assignment.json`、`participant-jev.json`、`record.private.json` も保存し、既存 `scan-live.mjs <out> <assignment> <config>` に渡せる。実試行の researcher record は親が既存の管理経路で別途 export する。

scanner の実行と研究上の自然さ・条件差の評価は別の検証。harness 自体の成功を scanner v3 の合格や研究上の成功とはみなさない。
