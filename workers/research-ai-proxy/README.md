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

Wrangler設定の UPSTREAM_PROVIDER は openai または gemini とし、実際に利用するAPIに合わせます。デフォルトの openai は実験で使うモデルの採用を意味しません。MAX_COMPLETION_TOKENS はリクエストあたりの出力制限（推論モデルでは推論トークンを含む）です。現在の研究設定は 8192（Worker側の上限も 8192）で、1024 では gpt-6-luna の画像付き判断JSONが推論だけで上限に達し本文が空になる事例を確認しました。上限到達で本文が空の場合は再試行しても同じ結果になるため、HTTP 422 `upstream_output_limit` を返します。比較条件では同じ値を使ってください。

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

Workerは認証付き POST /v1/chat/completions、GET /v1/model-policy、GET /health と、既定OFFの比較専用 POST /v1/decisions・GET /v1/decision-policy を提供します。公開CORSは設定せず、上流の宛先とモデルを固定しています。リクエスト最大18MiB、メッセージ最大256件、PNG/JPEG/WebPのbase64画像のみ対応し、外部の画像URLは受け付けません。

WorkerはAPIキー、対話本文、画像をログに残す処理を持たず、Observabilityも無効にしています。ただしCloudflare基盤側やAIプロバイダのログ・保存ポリシーまで否定できるわけではありません。実データを送る前に匿名化、外部サービス利用条件を確認してください。

外部API利用量の日次上限は未実装です。接続用トークンの秘匿とプロバイダ側の支出上限を併用してください。必要に応じてStudyPlannerのDurable Objectクォータ設計を参考に、研究用として独立導入してください。

.env、.dev.vars、WranglerのローカルファイルはGitに追加しません。npm test で模擬APIを使った接続契約を検証します。

## OpenRouter Decisions 比較（研究用・既定OFF）

Jev 1.14 と GPT-6 Luna Decisions は OpenRouter `POST /api/alpha/decisions` を使い、通常の Chat Completions と別の型付き回答を返します。Workerの `POST /v1/decisions` に `{"purpose":"decision_jev","state":"公開済みの対話情報と、自分の画像から得た根拠"}` または `decision_luna` を指定すると、同一の9行動の選択問題を固定モデルに送ります。モデルIDと設問はWorker管理で、クライアントからの任意モデル・質問は拒否します。現段階では画像の直接送信は行わず、`state` は最大2万文字のテキストのみです。

応答は `action` と各行動の `probabilities`、課金記録等に限定しています。この選択は診断・比較用であり、既存のLunaによる対象・名称・弁別特徴の生成や発話生成を自動的に置き換えません。`agree` はモデルが選んだだけでは成立させず、図形同定と共同採用の証拠を別途確認します。実験比較の条件・閾値は未承認です。

OpenRouterの研究用APIキーはローカルのmacOSキーチェーンに `service=dialogue-grounding-openrouter-api-key`、`account=research` として保存されています。Cloudflare WorkerはMacのキーチェーンを直接読めないため、Wranglerにログインしたうえで、研究用Worker専用Secretとして一度だけ転送します（値は表示しません）。

```sh
cd ~/Developer/dialogue-grounding
npx wrangler login
security find-generic-password -a research -s dialogue-grounding-openrouter-api-key -w |
  npx wrangler secret put OPENROUTER_DECISIONS_API_KEY --config workers/research-ai-proxy/wrangler.jsonc
```

上記の前にCloudflare認証とWorkerアクセス権を確認してください。既存の `UPSTREAM_API_KEY` と `DIALOGUE_MODEL` は変更しません。公開接続を有効にするには `workers/research-ai-proxy/wrangler.jsonc` の `RESEARCH_DECISIONS_ENABLED` を `true` にして研究用Workerをデプロイします。デプロイ前は動作しません。初期値は `false` です。秘密キーの値はGitやログに記録しません。

研究用Workerが有効化された後、研究データを一切使わない固定の合成対話で、双方のモデルの応答を並べて確認できます。

```sh
node --env-file=.env dialogue-model/runtime/diagnostics/compare-decisions.mjs --fixture
```

上記CLIは既存の `RESEARCH_AI_PROVIDER=cloudflare` と `RESEARCH_PROXY_TOKEN` の接続設定を使います。2種類の合成事例を両モデルへ同一入力で送り、判断とコストだけを表示します。実験用のアノテーションや正解対応表は送らないでください。APIの模擬テストと有料の実疎通は分けて記録してください。

## モデル変更の方法（Laplansと同じ用途ルーティング）

Worker側の DIALOGUE_MODEL が dialogue_turn 用モデルを一元管理します。研究用Node.jsアプリは目的（purpose: dialogue_turn）と発話だけを送り、具体的なmodel値を選びません。Workerは対応表を使って上流モデルを決め、クライアントが勝手に別のモデル名を添えても採用しません。

Cloudflare Dashboardの Worker > Settings > Variables and Secrets から DIALOGUE_MODEL の通常変数を変更できます。コード修正・API Secret更新・クライアント変更は不要です。ただし wrangler.jsonc はデプロイ時の設定の正本となるため、Dashboardで値を変えた後は同ファイルも追随させてください。さもないと後のデプロイで以前の値に戻る可能性があります。

リポジトリから管理する場合は wrangler.jsonc の DIALOGUE_MODEL を編集して npm run deploy:research-proxy を実行します。設定値 gpt-6-luna は研究用AIの指定モデルです。正式実験を行う際はモデル設定を固定し、実行記録にも保持してください。プロバイダ自体を openai から gemini に変更する場合には UPSTREAM_PROVIDER も変更し、対応する上流APIキーにSecretを更新する必要があります。

node --env-file=.env dialogue-model/runtime/cli.mjs --show-model で実際のWorkerが現在採用しているモデルと設定完了状態を表示できます。このコマンドは上流AIを呼ばず、推論課金を発生させません。条件比較では同じモデルバージョンを使用し、実験実施中にモデルを変更しないでください。
