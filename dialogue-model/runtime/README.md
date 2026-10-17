# 対話実験用 AI 接続基盤（試作）

この接続基盤は、AI自身に提示したタングラム画像と公開済み対話履歴から次の発話を生成します。研究方針の唯一の正本は ../README.md で、実験手続きの採用を意味しません。

## 推奨: Cloudflare Worker経由

上流のAIサービスのAPIキーは研究用のCloudflare Workerだけに保存します。クライアントの .env にはWorker接続用トークンだけを持たせます。モデルIDはCloudflare側の DIALOGUE_MODEL が決定し、クライアントからは purpose: dialogue_turn のみを送ります。最初に ../../workers/research-ai-proxy/README.md の接続・設定手順を参照してください。

Node.js 22以上で実行します。

    cp .env.example .env
    # Cloudflare WorkerのURLと接続トークンを設定（モデルはWorker側）
    node --env-file=.env dialogue-model/runtime/cli.mjs --check
    node --env-file=.env dialogue-model/runtime/cli.mjs --show-model
    node --env-file=.env dialogue-model/runtime/cli.mjs --smoke
    node --env-file=.env dialogue-model/runtime/cli.mjs --strategy repair-first --image /path/to/ai-side.png

会話中は /exit で終了します。単発発話は --message 'この図形を何と呼びますか？' で実行できます。repair-first と bypass-enabled の差は現時点ではプロンプト指示のみで、正式な実験操作化・効果検証は未実施です。

## 従来の直接接続（開発互換性）

RESEARCH_AI_PROVIDER=openai または gemini とし、RESEARCH_AI_MODEL と RESEARCH_AI_API_KEY を設定すれば従来通り直接APIを呼べます。研究用の通常運用はCloudflare経由を推奨します。custom はローカルモックや信頼済みOpenAI互換APIに限定してください。

APIキーをソース、ログ、チャットへ共有しないでください。実対話データを外部APIへ送る前に匿名化してください。従来の接続CLIは対話履歴をメモリ内で保持します。共同命名アプリの画面・提出・暫定採点・任意の研究記録は下記を参照してください。セッション間復旧は未実装です。

npm test でローカルHTTP模擬APIとWorker契約を検証します。本物のAIサービスへの疎通確認とは別です。

## 6図形の共同命名アプリ（予備試験・操作確認用）

実際のタングラム刺激を画像として提示し、AI自身の画像と公開された会話だけで対話します。両者の配置・向きは異なります。同じ整数seed（JavaScriptの安全な整数範囲）を指定すると刺激を再現できます。方略比較では、同じseed、Workerの同じモデル、同じ生成設定を使用してください。方略以外の差を統制する模擬テストはありますが、実際の方略操作の有効性は未検証です。

ローカルWeb UI:

    node --env-file=.env dialogue-model/runtime/web/server.mjs --port 8787 --hide-strategy

ブラウザで http://127.0.0.1:8787 を開き、研究者が方略と整数seedを選んで開始します。開始後は人間側画像、公開チャット、自分の6位置への名称入力フォームが表示されます。`--hide-strategy` は試行状態のAPI応答からも方略名を除きます。開始画面は研究者用なので、設定後に参加者へ渡してください。サーバーは127.0.0.1のみにbindし、同じブラウザのCookieで試行を保持します。サーバー再起動時の復旧はありません。

対話CLI:

    node --env-file=.env dialogue-model/runtime/naming-cli.mjs --strategy repair-first --seed 1 --image-dir /path/outside/repository/images

書き出された人間側PNGを画像ビューアーで開いて対話します。`/submit` で上段左から下段右の順に名称を入力し、提出を確定します。`/submit {"上段左":"...",...}` の1行JSON形式も使用できます。`/exit` は提出せず終了します。画像書き出し先もリポジトリ外を指定してください。

非対話の操作確認は `--script /path/outside/repository/turns.jsonl` を追加します。1行につき公開発話のJSON文字列、または `{"utterance":"公開発話"}` を記述します。後続行は、それ以前のAPIリクエストに混入しません。任意の最終行に次の形式で人間の提出を記述できます。

    {"submission":{"上段左":"名前1","上段中":"名前2","上段右":"名前3","下段左":"名前4","下段中":"名前5","下段右":"名前6"}}

提出行がなければ対話だけで終了します。JSONLはリポジトリ外で作成してください。スクリプトは研究者による操作確認の補助であり、実際の参加者との予備試験の代替ではありません。

人間側の提出名称は公開履歴に追加せず、AIにも渡しません。AIの最終提出は、同じAI側画像・公開履歴による別リクエストで6位置のJSONとして取得します。不正な形式の場合だけ1回再要求し、再度不正ならエラーとして照合しません。AIが先に提出しても、人間が提出するまでその名称と採点結果を人間側へ返しません。どちらかが提出を開始した後は対話を再開しません。名称の空欄は未命名として扱い、正式な採点規則を意味しません。

### 研究記録

既定では会話・提出・採点をディスクに保存しません。保存する場合だけ、リポジトリ外の `RESEARCH_RUN_DIR` を `.env` に設定します。例えば `/Users/your-name/ResearchRuns/naming` のような専用ディレクトリを使います。Gitリポジトリ内、ignore対象ディレクトリ、リポジトリ内へ向くシンボリックリンクは拒否します。

試行ごとにランダムな記録IDのJSONを作り、各操作後に更新します。方略、seed、公開発話、各自の非公開提出、暫定採点、各リクエストの応答モデル名・トークン数・レイテンシを含みます。対応表 `key` は双方提出後の `scoring` 内にのみ保存し、画像本文・APIキー・プロンプト全文・上流の生エラーは保存しません。途中終了した試行も、最後の確定状態まで記録します。記録には非公開の提出も含まれるので、参加者用画面ではなく研究者が管理してください。

`npm run naming:web -- --port 8787` と `npm run naming:cli -- --strategy repair-first ...` も利用できます（環境変数は事前設定）。`npm test` はローカル模擬HTTPで、AIへの情報漏れ防止、方略以外の入力一致、提出と採点の順序、エラー秘匿、CLI・Web操作を検証します。実APIでのマルチモーダル認識・対話成立・操作妥当性は別途予備試験が必要です。人数・尺度・時間制限・正式な採点規則はこの実装で確定しません。
