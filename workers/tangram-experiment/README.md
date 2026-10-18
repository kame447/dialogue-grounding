# タングラム共同命名 v2（Cloudflare公開版）

操作確認用URL：<https://tangram-grounding-experiment.kame-website.workers.dev/>

このページは6図形の共同命名課題のプロトタイプであり、正式な実験プロトコルではありません。研究目的・比較条件は [研究計画の正本](../../dialogue-model/README.md) を参照してください。

## 構成

公開サーバーのエントリポイントは `src/index.ts`（TypeScript）です。Cloudflare Workers と Durable Object で試行・対話・非公開AI判断・提出と暫定採点を扱います。対話ロジックは既存の `dialogue-model/runtime/v2/` のJavaScriptモジュールを再利用します。現段階で研究用コアロジックは全面的にはTypeScriptへ移行していません。

静的アセットは `build-assets.mjs` で既存のHTML/JS/CSSだけを `dist/` にコピーします。公開ワーカーから研究データ、 `.env`、内部コードを配信しません。

AIは同一Cloudflareアカウント内のサービスバインディング `AI_PROXY` を通して呼び出します。既存の `dialogue-grounding-ai-proxy` に `InternalResearchProxy` という内部エントリポイントを追加し、モデル選択、接続認証、上流APIキーは従来のAI Worker内で保持します。

公開ページは認証なしで開けます。実験参加者の操作を妨げない範囲でBot由来の大量アクセスのみ抑制します。APIキーは公開されず、Cloudflare内部の既存AI Workerだけが保持します。

## デプロイ

```sh
npm ci
npm run build:tangram
npx tsc -p workers/research-ai-proxy/tsconfig.json
npx tsc -p workers/tangram-experiment/tsconfig.json
npm test
npm run deploy:research-proxy  # 内部エントリポイント変更時のみ
npm run deploy:tangram
```

公開Workerへのアクセスコード登録は不要です。AIプロキシのSecretをこの公開Workerに複製する必要もありません。旧版v1はローカルNodeサーバーの `/v1/` で利用できますが、公開URLではv2のみを提供します。

## 緩いBot対策

公開ページにはログイン・CAPTCHA・会話時間制限・総発話回数制限を設けません。CloudflareのRate Limiting bindingを使用し、短時間に異常な回数の操作が起こった場合だけHTTP 429を返します。

- 試行開始：同じIPから40回／60秒
- AIを利用する操作（発話送信・再試行・名前提出など）：同じブラウザセッションで30回／60秒、同じIPで120回／60秒、Cloudflare拠点全体で300回／60秒
- 画面表示、画像やスクリプト取得、会話履歴更新（GET `/api/state`）：制限なし

同じネットワークを共有する被験者にも影響しにくいよう余裕を設けています。429の際は `Retry-After: 60` を返します。検索エンジンに対しては `robots.txt` と `X-Robots-Tag: noindex` を返します。これは検索対策であり、アクセス遮断ではありません。レート制限はCloudflare拠点ごとの概算カウンターであり、世界的な厳密な上限や支出上限にはなりません。

## 制限

操作確認用です。正式な同意取得、質問紙、参加者管理、研究データの確実なエクスポート機能は未実装です。試行データは個別のDurable Objectに格納しますが、同じブラウザで新しい試行を開始すると現在の試行が置き換わります。研究倫理とデータ保持方針、実験条件を確定するまでは一般募集に使用しないでください。
