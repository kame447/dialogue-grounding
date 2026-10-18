# タングラム共同命名 v2（Cloudflare公開版）

操作確認用URL：<https://tangram-grounding-experiment.kame-website.workers.dev/>

このページは6図形の共同命名課題のプロトタイプであり、正式な実験プロトコルではありません。研究目的・比較条件は [研究計画の正本](../../dialogue-model/README.md) を参照してください。

## 構成

公開サーバーのエントリポイントは `src/index.ts`（TypeScript）です。Cloudflare Workers と Durable Object で試行・対話・非公開AI判断・提出と暫定採点を扱います。対話ロジックは既存の `dialogue-model/runtime/v2/` のJavaScriptモジュールを再利用します。現段階で研究用コアロジックは全面的にはTypeScriptへ移行していません。

静的アセットは `build-assets.mjs` で既存のHTML/JS/CSSだけを `dist/` にコピーします。公開ワーカーから研究データ、 `.env`、内部コードを配信しません。

AIは同一Cloudflareアカウント内のサービスバインディング `AI_PROXY` を通して呼び出します。既存の `dialogue-grounding-ai-proxy` に `InternalResearchProxy` という内部エントリポイントを追加し、モデル選択、接続認証、上流APIキーは従来のAI Worker内で保持します。

アクセスにはHTTP Basic認証を使います。ユーザー名 `research`、パスワードは `EXPERIMENT_ACCESS_CODE`（Cloudflare Worker Secret）です。パスワードをソースに書き込まないでください。

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

初回は `npx wrangler secret put EXPERIMENT_ACCESS_CODE --config workers/tangram-experiment/wrangler.jsonc` を用いてアクセス用パスワードを登録します。AIプロキシのSecretをこの公開Workerに複製する必要はありません。旧版v1はローカルNodeサーバーの `/v1/` で利用できますが、公開URLではv2のみを提供します。

## 制限

操作確認用です。正式な同意取得、質問紙、参加者管理、研究データの確実なエクスポート機能は未実装です。試行データは個別のDurable Objectに格納しますが、同じブラウザで新しい試行を開始すると現在の試行が置き換わります。研究倫理とデータ保持方針、実験条件を確定するまでは一般募集に使用しないでください。
