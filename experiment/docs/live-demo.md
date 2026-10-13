# 2台で試す（人間同士のライブ通信DEMO）

> **過去の資料（legacy）。** 人間2人向けの旧DEMO（別Worker `dg-tangram-live-demo`）の説明です。このブランチの新Worker `dg-tangram-ai-demo` には人間同士のルームはありません。現行の構成は [`agent-protocol.md`](agent-protocol.md) と [`../README.md`](../README.md) を参照してください。

公開URL: https://dg-tangram-live-demo.kame-website.workers.dev

人間2人が別々の端末で会話し、同じ6図形に共通の名前を付けるまでを確認する通信DEMOです。AIは接続していません。AI調整のA/B研究とは別の機能で、ここでのやりとりは研究データとして扱いません。正式な同意手続きもないため、研究参加や本実験に使ってはいけません。

## 2台での使い方

1. PC1で `https://dg-tangram-live-demo.kame-website.workers.dev/#/live` を開き、「ルームを作成」を押します。
2. 招待リンクが2つ表示されます。「参加者2の招待リンク」をコピーし、もう1台（PC2やスマホ）へ送ります。
3. PC1は「参加者1としてこの端末で入る」を押します。PC2は受け取ったリンクを開きます。
4. 2人がそろうとチャットが始まります。2人とも同じ6図形を見ていますが、並び順は端末ごとに違います。名前は会話でだけ共有できます。
5. どちらかが「会話を終了する」を押すと、2人とも会話に戻れなくなります。各自が6図形の名前を確定し、3問に答えます。
6. 先に終えた人は、相手が終わるまで待ちます。2人とも終わると、両者の名前と一致数（DEMO結果）が表示されます。

招待リンクを知っている人は誰でもその席に入れます。リンクは相手にだけ送ってください。同じリンクを別のタブや端末で開くと、新しい方が席を引き継ぎ、古い方は切断表示になります。

## 構成

| 部分 | 場所 | 役割 |
| --- | --- | --- |
| Worker | `worker/index.ts` | `POST /api/rooms`（ルーム作成）、`GET /api/rooms/:id/ws`（WebSocket）、`GET /api/health`。それ以外の `/api/*` は404。それ以外のパスは静的アセット（`dist/`）を返す |
| Durable Object `LiveRoom` | `worker/room.ts` | 1ルーム＝1オブジェクト。WebSocket Hibernation API で2席を中継し、状態をSQLite版のDOストレージに保存する |
| ルーム規則 | `worker/roomCore.ts` | Cloudflare APIに依存しない純粋な状態機械。単体テストの対象 |
| 共通プロトコル | `src/live/protocol.ts` | ブラウザとサーバーで共有するメッセージ型・上限値・検証 |
| 画面 | `src/live/` | `#/live`（ロビー）と `#/live/<roomId>/<token>`（ルーム） |

ルーム規則は「席（p1/p2）からのメッセージ」だけを扱います。将来AIを相手にする場合も、サーバー側のAI実装が同じプロトコルで片方の席に座れば、画面側は変えずに済みます。画像の認識と「今確認するか」の判断は単一のVLM、自然文の生成は別の部品、という構想です。ブラウザ側の差し替え口は `src/live/transport.ts` の `LiveTransport` です。

## セキュリティと保存期間

- **ID とトークン**: ルームIDは128bit、席ごとの参加トークンは192bitの乱数です。DOにはトークンのSHA-256だけを保存します。
- **トークンの渡し方**: トークンは招待URLのハッシュ部分（`#/live/...`）にあるため、サーバーのアクセスログやRefererには載りません。WebSocket接続後、最初の `hello` フレームで送ります。
- **置かない窓口**: ルーム一覧、会話ログの取得、研究者用のAPIはありません。研究者デモ画面（`#/researcher`）はブラウザ内のモックデモ用で、ライブルームのデータには触れません。
- **画面に出さないもの**: 図形は席ごとのランダムなスロットキーで扱い、刺激ID・セット名・相手の並び順は送りません。相手の名前と一致結果は、2人とも名前と質問紙を終えるまで送りません。
- **入力の制限**: チャット1件300文字、1ルーム400件、10秒あたり8件、1フレーム4KB、名前40文字、コメント500文字まで。ルーム作成はIPごとに毎分10件（isolate単位のベストエフォート）です。
- **Originと応答ヘッダー**: `Origin` が自ホストと異なる作成要求とWebSocket接続は拒否します。CORSヘッダーは返しません。APIの応答は `no-store` です。
- **表示**: チャット本文はReactのテキストとして描画し、HTMLとしては解釈しません。
- **保存期間**: ルームは作成から24時間で失効します。DOのアラームで全データを削除し、接続を閉じます。
- **ログ**: Workers Logs（observability）は無効にしています。

## デプロイ手順（このプロジェクト専用）

```bash
cd experiment
npm ci
npm run build                 # tsc（UI + worker）と vite build
npx wrangler deploy           # wrangler.jsonc の name = dg-tangram-live-demo
```

- `wrangler.jsonc` で定義するのは、新規Worker `dg-tangram-live-demo` とそのDOクラス `LiveRoom` だけです。route、カスタムドメイン、KV、D1、R2は使いません。公開先は workers.dev だけで、プレビューURLは無効です。
- 認証は、このMacのwrangler OAuthログインを使います。APIトークンや秘密値は使わず、`.dev.vars` もありません。
- ローカル確認は `npm run worker:dev` で行います。http://127.0.0.1:8788 で、ローカルのDOシミュレーションを使います。
- 削除するときは `npx wrangler delete dg-tangram-live-demo` を実行します（このWorkerだけが対象）。

## 運用と課金

- Workers Free の範囲で動く構成です（SQLite版Durable Object、静的アセット）。新しい課金契約、ドメイン購入、アカウント設定の変更はしていません。
- 無料枠の上限に達した場合は、課金されずにリクエストが失敗するだけです。
- 公開URLは誰でも開けます。不特定多数への告知は想定していません。

## テスト

- `npx vitest run worker`: ルーム規則とトークン（席ごとの並び、漏洩なし、段階の非巻き戻し、長さとレートの制限、名前の検証、待機と結果の開示）
- `npx vitest run src/live`: 画面（各段階の描画、送信失敗と再送、相手終了時の入力停止、切断理由、結果の非表示）
- `npm run e2e:live`: ローカルの `wrangler dev` に対して2つのブラウザコンテキストで通信します（PC 1280×800 と Pixel 7）
- `LIVE_BASE_URL=https://dg-tangram-live-demo.kame-website.workers.dev npm run e2e:live`: 公開URLに対して同じE2Eを実行します

## 未対応

- 正式な同意、参加者ID、研究データとしての保存・書き出し、研究者による監視画面
- 多ラウンド、2条件の比較（ルーム規則は1ラウンドに限定。拡張は別途議論）
- AI席の実装（プロトコル上の席として差し替える想定のみ）
- 強いレート制限（isolate単位のベストエフォートのみ）、不正利用の監視
- スクリーンリーダー実機での確認
