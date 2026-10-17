# 対話実験用 AI 接続基盤（試作）

この接続基盤は、AI自身に提示したタングラム画像と公開済み対話履歴から次の発話を生成します。研究方針の唯一の正本は ../README.md で、実験手続きの採用を意味しません。

## 推奨: Cloudflare Worker経由

上流のAIサービスのAPIキーは研究用のCloudflare Workerだけに保存します。クライアントの .env にはWorker接続用トークンだけを持たせます。最初に ../../workers/research-ai-proxy/README.md の接続・設定手順を参照してください。

Node.js 22以上で実行します。

    cp .env.example .env
    # Cloudflare WorkerのURL、同じモデルID、接続トークンを設定
    node --env-file=.env dialogue-model/runtime/cli.mjs --check
    node --env-file=.env dialogue-model/runtime/cli.mjs --smoke
    node --env-file=.env dialogue-model/runtime/cli.mjs --strategy repair-first --image /path/to/ai-side.png

会話中は /exit で終了します。単発発話は --message 'この図形を何と呼びますか？' で実行できます。repair-first と bypass-enabled の差は現時点ではプロンプト指示のみで、正式な実験操作化・効果検証は未実施です。

## 従来の直接接続（開発互換性）

RESEARCH_AI_PROVIDER=openai または gemini とし、RESEARCH_AI_MODEL と RESEARCH_AI_API_KEY を設定すれば従来通り直接APIを呼べます。研究用の通常運用はCloudflare経由を推奨します。custom はローカルモックや信頼済みOpenAI互換APIに限定してください。

APIキーをソース、ログ、チャットへ共有しないでください。実対話データを外部APIへ送る前に匿名化してください。対話履歴はメモリ内でのみ保持し、実験UI、正解管理、採点、セッション間復旧は未実装です。

npm test でローカルHTTP模擬APIとWorker契約を検証します。本物のAIサービスへの疎通確認とは別です。
