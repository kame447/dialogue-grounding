# Research AI Proxy on Cloudflare Workers

このWorkerは研究用 dialogue-grounding のAI接続専用です。StudyPlanner本番Workerとは独立しています。

接続経路は、研究用Node.js対話プログラム → 認証付きCloudflare Worker → OpenAI/Gemini互換API です。上流のAPIキーはWorker側だけが保持します。

## 初回デプロイ

Node.js 22以上、Cloudflare Wranglerのログインが必要です。リポジトリのルートから次を実行します。

    npm ci
    npm run deploy:research-proxy

デプロイ直後はSecret未設定のためWorkerはAI転送を受け付けません。以下のSecretをCloudflare DashboardのWorker > Settings > Variables and Secrets、またはWranglerで登録します。

    npx wrangler secret put RESEARCH_PROXY_TOKEN --config workers/research-ai-proxy/wrangler.jsonc
    npx wrangler secret put RESEARCH_AI_MODEL --config workers/research-ai-proxy/wrangler.jsonc
    npx wrangler secret put UPSTREAM_API_KEY --config workers/research-ai-proxy/wrangler.jsonc

RESEARCH_PROXY_TOKEN は32文字以上のランダムな接続用トークンで、クライアントの .env にも同一値を設定します。RESEARCH_AI_MODEL は画像対応モデルの具体的なIDで、クライアントにも同じ値を設定します。UPSTREAM_API_KEY はプロバイダの本物のAPIキーで、Cloudflareにのみ登録します。

Wrangler設定の UPSTREAM_PROVIDER は openai または gemini とし、実際に利用するAPIに合わせます。デフォルトの openai は実験で使うモデルの採用を意味しません。MAX_COMPLETION_TOKENS はリクエストあたりの出力制限です。比較条件では同じ値を使ってください。

## クライアントの .env

    RESEARCH_AI_PROVIDER=cloudflare
    RESEARCH_AI_BASE_URL=https://<worker>.<subdomain>.workers.dev/v1
    RESEARCH_AI_MODEL=<Cloudflare側と同じモデルID>
    RESEARCH_PROXY_TOKEN=<Cloudflare側と同じ接続用トークン>

上流APIキーをローカル .env に書く必要はありません。

    node --env-file=.env dialogue-model/runtime/cli.mjs --check
    node --env-file=.env dialogue-model/runtime/cli.mjs --smoke
    node --env-file=.env dialogue-model/runtime/cli.mjs --strategy repair-first --image /path/to/ai-image.png

比較用方略は repair-first と bypass-enabled です。実験の最終的な方略操作化や閾値は別途確定が必要です。

## 契約と保護

Workerは認証付き POST /v1/chat/completions と GET /health のみを提供します。公開CORSは設定せず、上流の宛先とモデルを固定しています。リクエスト最大18MiB、メッセージ最大256件、PNG/JPEG/WebPのbase64画像のみ対応し、外部の画像URLは受け付けません。

WorkerはAPIキー、対話本文、画像をログに残す処理を持たず、Observabilityも無効にしています。ただしCloudflare基盤側やAIプロバイダのログ・保存ポリシーまで否定できるわけではありません。実データを送る前に匿名化、外部サービス利用条件を確認してください。

外部API利用量の日次上限は未実装です。接続用トークンの秘匿とプロバイダ側の支出上限を併用してください。必要に応じてStudyPlannerのDurable Objectクォータ設計を参考に、研究用として独立導入してください。

.env、.dev.vars、WranglerのローカルファイルはGitに追加しません。npm test で模擬APIを使った接続契約を検証します。
