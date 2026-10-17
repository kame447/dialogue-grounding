# Research AI Proxy on Cloudflare Workers

このWorkerは研究用 dialogue-grounding のAI接続専用です。StudyPlanner本番Workerとは独立しています。

接続経路は、研究用Node.js対話プログラム → 認証付きCloudflare Worker → OpenAI/Gemini互換API です。上流のAPIキーはWorker側だけが保持します。

## 初回デプロイ

Node.js 22以上、Cloudflare Wranglerのログインが必要です。リポジトリのルートから次を実行します。

    npm ci
    npm run deploy:research-proxy

デプロイ直後はSecret未設定のためWorkerはAI転送を受け付けません。以下のSecretをCloudflare DashboardのWorker > Settings > Variables and Secrets、またはWranglerで登録します。

    npx wrangler secret put RESEARCH_PROXY_TOKEN --config workers/research-ai-proxy/wrangler.jsonc
    npx wrangler secret put UPSTREAM_API_KEY --config workers/research-ai-proxy/wrangler.jsonc

RESEARCH_PROXY_TOKEN は32文字以上のランダムな接続用トークンで、クライアントの .env にも同一値を設定します。UPSTREAM_API_KEY はプロバイダの本物のAPIキーで、Cloudflareにのみ登録します。使用モデルはSecretではなく、Cloudflare Workerの通常設定 DIALOGUE_MODEL（workers/research-ai-proxy/wrangler.jsonc）で変更します。ローカルの .env にはモデル名を記入しません。

Wrangler設定の UPSTREAM_PROVIDER は openai または gemini とし、実際に利用するAPIに合わせます。デフォルトの openai は実験で使うモデルの採用を意味しません。MAX_COMPLETION_TOKENS はリクエストあたりの出力制限です。比較条件では同じ値を使ってください。

## クライアントの .env

    RESEARCH_AI_PROVIDER=cloudflare
    RESEARCH_AI_BASE_URL=https://<worker>.<subdomain>.workers.dev/v1
    RESEARCH_PROXY_TOKEN=<Cloudflare側と同じ接続用トークン>

上流APIキーをローカル .env に書く必要はありません。

    node --env-file=.env dialogue-model/runtime/cli.mjs --check
    node --env-file=.env dialogue-model/runtime/cli.mjs --show-model
    node --env-file=.env dialogue-model/runtime/cli.mjs --smoke
    node --env-file=.env dialogue-model/runtime/cli.mjs --strategy repair-first --image /path/to/ai-image.png

比較用方略は repair-first と bypass-enabled です。実験の最終的な方略操作化や閾値は別途確定が必要です。

## 契約と保護

Workerは認証付き POST /v1/chat/completions、GET /v1/model-policy、GET /health のみを提供します。公開CORSは設定せず、上流の宛先とモデルを固定しています。リクエスト最大18MiB、メッセージ最大256件、PNG/JPEG/WebPのbase64画像のみ対応し、外部の画像URLは受け付けません。

WorkerはAPIキー、対話本文、画像をログに残す処理を持たず、Observabilityも無効にしています。ただしCloudflare基盤側やAIプロバイダのログ・保存ポリシーまで否定できるわけではありません。実データを送る前に匿名化、外部サービス利用条件を確認してください。

外部API利用量の日次上限は未実装です。接続用トークンの秘匿とプロバイダ側の支出上限を併用してください。必要に応じてStudyPlannerのDurable Objectクォータ設計を参考に、研究用として独立導入してください。

.env、.dev.vars、WranglerのローカルファイルはGitに追加しません。npm test で模擬APIを使った接続契約を検証します。

## モデル変更の方法（Laplansと同じ用途ルーティング）

Worker側の DIALOGUE_MODEL が dialogue_turn 用モデルを一元管理します。研究用Node.jsアプリは目的（purpose: dialogue_turn）と発話だけを送り、具体的なmodel値を選びません。Workerは対応表を使って上流モデルを決め、クライアントが勝手に別のモデル名を添えても採用しません。

Cloudflare Dashboardの Worker > Settings > Variables and Secrets から DIALOGUE_MODEL の通常変数を変更できます。コード修正・API Secret更新・クライアント変更は不要です。ただし wrangler.jsonc はデプロイ時の設定の正本となるため、Dashboardで値を変えた後は同ファイルも追随させてください。さもないと後のデプロイで以前の値に戻る可能性があります。

リポジトリから管理する場合は wrangler.jsonc の DIALOGUE_MODEL を編集して npm run deploy:research-proxy を実行します。初期値 gpt-4o-mini は接続テスト用の暫定値であり、研究本実験のモデル確定ではありません。プロバイダ自体を openai から gemini に変更する場合には UPSTREAM_PROVIDER も変更し、対応する上流APIキーにSecretを更新する必要があります。

node --env-file=.env dialogue-model/runtime/cli.mjs --show-model で実際のWorkerが現在採用しているモデルと設定完了状態を表示できます。このコマンドは上流AIを呼ばず、推論課金を発生させません。条件比較では同じモデルバージョンを使用し、実験実施中にモデルを変更しないでください。
