# エージェント接続プロトコル（DEMO）

## 接続

- 外部エージェント用ルームを `POST /api/rooms` に `{ "mode": "external" }` で作成する。応答の `agentToken` は研究者コンソールに一度だけ表示し、人間参加者 URL に含めない。
- 人間: `GET /api/rooms/{roomId}/ws`。エージェント: `GET /api/agent/rooms/{roomId}/ws`。どちらも WebSocket 接続後、`{"type":"hello","protocol":2,"token":"…"}` を送る。エージェントは任意で `agent` ラベルを加えられる。
- 参加者 URL は hash に human token を保持する。human token は agent port で拒否され、agent token は human port で拒否される。保存するのは SHA-256 hash のみ。
- 推奨: `DG_AGENT_TOKEN` 環境変数で token を渡す。コマンドライン引数はシェル履歴やプロセス一覧に残る可能性がある。Node 22 以上、依存なしのスタブ: `node agent/stub-agent.mjs --base https://host --room ID --name stub --once`。

## メッセージと状態

サーバーイベント: `snapshot`, `chat`, `partner_typing`, `error`, `replaced`, `deleted`, `pong`。クライアント: `hello`, `chat` (`clientId` 付き), `typing`, `end_chat`, `submit_names`, `ping`。human 専用: `submit_survey`, `use_mock`, `delete_room`。AI は survey、モード切替、削除を送れない。

```mermaid
stateDiagram-v2
  [*] --> waiting_ai: external / human join
  waiting_ai --> chat: AI hello
  [*] --> waiting_human: external / AI join
  waiting_human --> chat: human join
  chat --> naming: either end_chat
  naming --> survey: human submit_names
  naming --> done: AI submit_names
  survey --> waiting_ai_names: human submit_survey
  waiting_ai_names --> results: AI names submitted
  survey --> results: AI already done
```

mock mode は人間 join と同時に chat を開始する。外部 AI が一度も接続しておらず、人間が `waiting_ai` の間だけ `use_mock` で切替可能。

## アクセス境界

| 情報 | 人間 | 外部AI |
|---|---|---|
| AI token | 不可 | 自身が保持 |
| AI の figure 順/slot | 不可 | 可（自身の snapshot） |
| AI judgement | 現在は存在しない | 現在は存在しない |
| 会話履歴 | 可 | 可 |
| 人間の名前 | 自身の確定名のみ | 不可 |
| 人間の survey | 可 | 不可 |
| 比較結果 | survey 提出後の results で可 | 送信しない |

human snapshot に刺激ID、set/seed、AI slot/order、token/hash、mode 内部情報を含めない。agent snapshot に人間の名前と survey は含めない。結果は human phase が `results` になった後だけ公開する。

## 模擬AIと将来の接続

## 図形の配置契約（散在・番号なし）

図形はどの画面にも番号・名前・枠を付けません。各席は同じ6図形を、席ごとに異なる不規則な位置・向きで散在した1枚のシーン（`SCENE` = 400×300 単位、原点左上・y下向き）として受け取ります。snapshot の各 figure は `slot`（席ごとの opaque キー）、`polygons`（0..100 の正規化座標・未回転）、`placement`（`x`,`y`＝正規化 bbox 中心のシーン座標、`rotation`＝時計回りの度、`scale`）を持ちます。シーン座標は `world = (x, y) + R(rotation)·scale·(p − c)`（c は polygons の bbox 中心）で、`src/stimuli/scene.ts` の `worldPolygons()` / `sceneSvg()` が唯一の実装です。描画側で CSS 回転を足さないでください。将来 VLM には `sceneSvg(snapshot.figures)` をラスタライズした画像を渡し、返答や命名は自席の `slot` で行います。

配置はサーバーがルームの seed と席から決定論的に生成するため、再読込・再接続で変わりません（ストレージに追加データなし・DO migration 不要）。生成は重なり・はみ出しなし、図形間の最小間隔、整列（同一行/列に4つ以上、または3つずつ2列）を棄却し、試行回数に上限（`PLACEMENT_BUDGET`）があります。1席あたり実測数 ms。人間の図形クリック（拡大・命名）はローカル操作で、サーバーにも AI にも送られません。

## 模擬AIと将来の接続

模擬AIは図形を見ず、参照も解決しない固定文の応答です（冒頭は「こんにちは。図形の名前を考えましょう。」、以降は発話内容に依存しない短い促し）。番号を解析・要求することはありません。名前提出は、6名が必要な状態機械のために AI slot ごとの「未判定」プレースホルダーを入れるだけで、模擬AIモードでは一致を計算・表示しません（`results.scored = false`）。一致は外部エージェントが自分で提出した場合にのみ算出します。

将来のマルチモーダル接続口は `worker/partners/types.ts` の `PartnerAdapter` です。`PartnerTurnInput` は AI order の opaque slot 付き figures、会話履歴、公開 stage cue を受けます。将来 VLM が `PartnerJudgement.checkNow` と応答を返す形を想定しています。現在は実装も外部モデル API 呼出しもありません。

## 制限と削除

ルーム寿命は作成時刻から30日、DO alarm で全データを削除します。人間は任意フェーズで `delete_room` を送って即時削除できます。最大 frame 8 KiB、発話300文字、ルーム400発話、各席10秒あたり8発話、作成元 IP あたり毎分10ルームです。human 接続は同一 Origin のみ（Origin 欠落は許容）、agent 接続は Origin 欠落を許容し、ある場合は同一 host のみです。
