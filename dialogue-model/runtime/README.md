# 対話実験用 AI 接続基盤（試作）

この接続基盤は、AI自身に提示したタングラム画像・公開済み対話履歴・AI自身の判断による作業メモから次の発話を生成します。研究方針の唯一の正本は ../README.md で、実験手続きの採用を意味しません。

**局所問題の部分更新（2026-10-19、研究用 opt-in）：** 図形全体を一括で合意済みにせず、特徴・向き・見立て・名称などの局所問題について、公開発話に基づく同意・否定・保留・再訪を部分更新する。[現行計画の設計方針](../README.md#共通基盤の部分更新採用した設計方針)と[決定記録 0001](../decisions/0001-partial-grounding-state.md)を参照。以下の明示オプションを指定した v2 のみで動作し、既定の実験条件には適用しない。Jev の2軸シャドー機能とは別の処理であり、実験への採用や抽出・分類精度の検証を意味しない。

### 局所問題の部分更新を有効にする（v2・既定オフ）

研究用コードから `createDialogueV2` または `createNamingTaskV2` に次のオプションを渡します。CLI・UI・公開 Worker の設定は変更しません。`extractor` / `classifier` は [共通契約](local-grounding/contract.ts) に従う実装です。

```js
{
  referenceMemory: true,
  localGrounding: { extractor, classifier, timeoutMs: 20_000 },
}
```

`localGrounding` の既定値は `null` で、オフ時にはリクエスト・作業メモ・研究記録に項目を追加しません。有効時は `referenceMemory: true` が必須です。抽出→分類の時間予算は既定20秒（正の有限値で変更可）。timeout・局所処理の失敗は当該claimを反映せず、既存の対話処理を続けます。研究用 `attempts[].localGrounding` には成否、部分数・採用数、棄却理由コード、分類器種別と処理時間を残し、生の応答・プロンプト・画像は残しません。

公開済みの人間発話と、前回公開されたAI発話に字句で確認できる確定済み判断だけを出典とします。新しいclaimは既存の参照グラフ更新に合流し、生成成功後にキューが発話を公開するときだけ確定します。生成失敗・置換・中断されたターンは記憶を更新しません。生成 guard の代替発話が公開された場合は、公開済みの人間発話に由来するclaimも通常どおり確定します。両方略へ同じ局所作業メモを渡し、局所的な支持を図形全体の理解・名称決定に拡張しないよう指示します。

保存記録には有効時だけ `options.localGrounding: true` が入り、claim は既存の `queueState.privateState.graph` と一緒に復元されます。再開時には研究者側から同じ抽出器・分類器を再注入してください。元々オフだった保存試行は、再注入だけではオンになりません。

**判断の権限と観察（2026-10-20採用、未実装）：** 次の対話行動はJevが単独で選び、Lunaは試行の開始時に自分側の全図形を一度観察し、以後はJevが必要と判断したときだけ再観察する。[現行計画](../README.md#判断の権限と観察2026-10-20採用)と[決定0002](../decisions/0002-jev-decision-and-visual-observation.md)を参照。このディレクトリの現行のコード（Lunaの判断から始めるv2、Jevの2軸シャドーと行動の上書き、局所部分更新の試作と評価ハーネス）は、この方針より前の構成であり、新しい構成の実装ではない。

## 公開版（v2）

操作確認用の最新ページは <https://tangram-grounding-experiment.kame-website.workers.dev/> （認証不要）です。公開サーバーはTypeScript Worker + Durable Objectで、内部サービスバインディングを通して既存の研究AI Workerを利用します。ローカル版 `http://127.0.0.1:8787` はMac上でのみ利用できます。公開版の手順は [workers/tangram-experiment/README.md](../../workers/tangram-experiment/README.md) を参照してください。

## 推奨: Cloudflare Worker経由

上流のAIサービスのAPIキーは研究用のCloudflare Workerだけに保存します。クライアントの .env にはWorker接続用トークンだけを持たせます。モデルIDはCloudflare側の DIALOGUE_MODEL が決定し、クライアントからは purpose: dialogue_turn のみを送ります。最初に ../../workers/research-ai-proxy/README.md の接続・設定手順を参照してください。

Node.js 22以上で実行します。

    cp .env.example .env
    # Cloudflare WorkerのURLと接続トークンを設定（モデルはWorker側）
    node --env-file=.env dialogue-model/runtime/cli.mjs --check
    node --env-file=.env dialogue-model/runtime/cli.mjs --show-model
    node --env-file=.env dialogue-model/runtime/cli.mjs --smoke
    node --env-file=.env dialogue-model/runtime/cli.mjs --strategy repair-first --image /path/to/ai-side.png

会話中は /exit で終了します。単発発話は --message 'この図形を何と呼びますか？' で実行できます。repair-first と bypass-enabled の差は判断層の方針文だけにあり、発話生成器の指示は共通です。正式な実験操作化・効果検証は未実施です。

## 従来の直接接続（開発互換性）

RESEARCH_AI_PROVIDER=openai または gemini とし、RESEARCH_AI_MODEL と RESEARCH_AI_API_KEY を設定すれば従来通り直接APIを呼べます。研究用の通常運用はCloudflare経由を推奨します。custom はローカルモックや信頼済みOpenAI互換APIに限定してください。

APIキーをソース、ログ、チャットへ共有しないでください。実対話データを外部APIへ送る前に匿名化してください。従来の接続CLIは対話履歴をメモリ内で保持します。共同命名アプリの画面・提出・暫定採点・任意の研究記録は下記を参照してください。セッション間復旧は未実装です。

npm test でローカルHTTP模擬APIとWorker契約を検証します。本物のAIサービスへの疎通確認とは別です。

## 6図形の共同命名アプリ（予備試験・操作確認用）

実際のタングラム刺激を画像として提示し、AI自身の画像・公開された会話・自身の作業メモで対話します。両者の配置・向きは異なります。同じ整数seed（JavaScriptの安全な整数範囲）を指定すると刺激を再現できます。方略比較では、同じseed、Workerの同じモデル、同じ生成設定を使用してください。方略以外の差を統制する模擬テストはありますが、実際の方略操作の有効性は未検証です。

この手順では、実行形態を次のように呼び分けます。参加者用Web（BASE）は、開始時の割当をサーバー側で管理するWebアプリを指します。

| 呼び方 | 実行する入口 | 用途 |
|---|---|---|
| ローカルWebサーバー | `web/server.mjs` | ローカルのブラウザで参加者用Webを使う。コマンドラインから直接起動する場合と、関数を呼ぶラッパーから起動する場合がある。 |
| Worker版Web | `workers/tangram-experiment/src/index.ts` | WorkerとDurable Objectで参加者用Webを動かす。 |
| 対話CLI | `naming-cli.mjs` | ターミナル上で対話する従来の入口。Webサーバーの起動コマンドとは別。 |

ローカルWebサーバーの起動例:

    node --env-file=/path/to/private/operator.env dialogue-model/runtime/web/server.mjs --port 8787 --base-assignment-file /path/to/private/assignment.json --base-store-root /path/to/private/owners

ブラウザで http://127.0.0.1:8787 を開きます。参加者には方略・seed の開始フォームを表示せず、サーバーが研究者の設定を検証して試行を用意します。人間側画像、公開チャット、自分の6位置への名称入力フォームが表示されます。方略・seed・assignment は参加者の状態に含めません。サーバーは127.0.0.1のみにbindし、同じブラウザの Cookie と保存済み owner を結び付けます。保存先と設定の詳細は下記を参照してください。上のコマンドは起動方法の例であり、実 API への接続や本実験の開始を承認するものではありません。

### BASE Web の設定・保存と研究者操作

ローカルWebサーバーには、リポジトリ外の既存ディレクトリを明示します。`--base-store-root` で指定する保存先ディレクトリそのものと、`--base-assignment-file` で指定する設定ファイルの親ディレクトリを0700にします。設定ファイルと保存先内の owner ファイルは0600にし、symlink・hardlink を使いません。`--base-assignment-file` と `--base-store-root` に既定の保存先や条件はありません。未設定・不正な設定では新規 admission を拒否し、保存先が不正なときは復元も行いません。メモリだけの保存へ切り替えることはありません。

`assignment.json` の合成例です。研究条件として採用された値ではありません。

```json
{"schemaVersion":"base_assignment_config_v1","configId":"b5d3bff2-121e-4573-9fc3-f7d6e43e30ce","revision":1,"strategy":"repair-first","seed":73,"referenceMemory":false}
```

新しい admission のたびに設定を読みます。ファイルを変えても、既存の試行の割当は変わりません。`POST /api/start` の body は `{"version":2}` だけです。参加者が strategy や seed などを追加すると400になり、試行を差し替えません。公開の `/v1/` と旧 API は404です。対話CLI（`naming-cli.mjs`）は別の入口です。

起動用の環境変数 `ADMIN_TOKEN` が未設定なら `/admin` は404です。設定する場合は32〜512文字の空白を含まない ASCII 文字列を、研究者が管理する環境から渡します。token の値をコマンド引数、URL、Cookie、参加者の body、通常ログには含めません。上の `--env-file` は private なファイルのパスだけを渡す例です。実際に誰が token を保持するかは運用者が決めます。連絡先には公開してよい `PARTICIPANT_CONTACT_TEXT` を設定できます。未設定なら暫定の案内文を使い、不正な型・長さ・制御文字などが設定されていれば、ローカルWebサーバーは起動を拒否します。token と連絡先を試行の割当情報へ保存することはありません。

管理者の認証は HTTP の Authorization（Bearer、またはユーザー名 `researcher` の Basic）を使います。parse できる認証情報を伴う要求は、正誤にかかわらず同じ socket 接続元ごとに30回／60秒までです。超えると429と `Retry-After: 60` を返します。これは local プロセス内の制限で、複数プロセスにまたがる保証はありません。クライアントが送った転送元ヘッダーは管理者の識別に使いません。

完了した記録に対する研究者の操作は `POST /admin/record/<recordId>/prepare-next`、JSON body は `{}` です。認証と同一 Origin の確認を通った場合だけ次の試行を作り、最初は201、同じ完了記録への再要求は、同じ after-key（引き継ぎ元の記録IDに結び付けた、次の試行の保存キー）を使い、同じ次の記録IDで200を返します。参加者の画面操作から条件を選び直すことはできません。質問紙が未提出でも技術的には次へ進めますが、その引き継ぎの運用と質問紙の採用は研究者の判断が必要です。

記録を書き出すには、認証後に `GET /admin/record/<recordId>.json` にアクセスします。削除するには、管理画面 `/admin` の一覧から対象の記録の詳細を開き、削除の確認欄にその `<recordId>` を入力して実行します。ローカルWebサーバーの削除は、archive・質問紙・ledger と owner 内の当該 snapshot を同じ更新で取り除き、tombstone と `record_deleted` を残します。遅れた保存で復活させず、削除した試行の割当を新しく作り直しません。次の試行が削除済みの場合、引き継ぎ元への after-key 再要求は404です。現在の試行が削除済みの場合、参加者の start/restore は409です。外部のバックアップや書き出し済みファイル、ディスクの物理的な消去までを保証する処理ではありません。

ローカルWebサーバーは会話・提出・暫定採点・割当を、private な owner container に保存します。`RESEARCH_RUN_DIR` による従来の個別ファイル出力とは別です。保存済み owner と同じ Cookie で再起動後も同じ試行を復元し、メモリの状態が無いことを新規割当の理由にしません。ローカルWebサーバーの既存の30分 idle 期限は維持します。期限切れや削除、壊れた binding は復元しません。質問紙提出前の結果は引き続き伏せます。

`record_deleted` を保存した root は、この marker を理解する更新版だけで開いてください。更新版は従来の有効な記録を移行なしで読みますが、旧版は新 marker を拒否します。旧版へ戻して不明な owner として扱ったり、marker を消して新しい割当を作ったりしてはいけません。異なる版の writer を混在させません。

### local lock の停止・復旧

同じ owner に複数の writer を立てないでください。ローカルWebサーバーをコマンドラインから直接起動した場合は、Ctrl-C（SIGINT）または SIGTERM で新規リクエストの受理を止めます。受理済みの HTTP handler と開始済みの保存の完了を待ち、そのサーバーが保持する store と lock を閉じて exit 0 で終了します。切断された request の handler も完了まで追跡します。二重の signal で処理や期限をやり直すことはありません。programmatic な `main()` や `startNamingServer()` は process の signal handler を自動登録しません。ラッパー側で `drainAndClose()` を待つか、明示的に `attachLocalShutdown()` を使います。

協調停止の既定の期限は30秒です。期限切れや保存・close の失敗では、固定の `shutdown_incomplete` と exit 1 で終了します。保留中の保存の lock を強制的に外しません。これは AI の生成や採点の完走を保証する処理ではなく、開始済みの保存を待つ境界です。受理済みで未完了の queue は、保存済みの範囲で従来の復元処理に委ねます。停止の期限は AI の timeout や研究条件の時間制限を変更しません。event loop が停止している場合の厳密な実時間の保証もありません。

SIGKILL、期限切れなどで lock が残っている場合は API が409、ページが503になることがあります。lock の古さや接続失敗だけでは回収しません。exit 1 のときに成功扱いで次の writer を起動せず、停止を確認してから下記の条件を満たす復旧手順を使います。

強制終了などの後は、単一マシンの共有されていない private 保存先に限り、次の順で手動復旧します。

1. この保存先を使う全 writer と自動再起動を停止し、新しい writer が起動しない排他的な保守区間を確保します。運用者が起動した既知の対象プロセス（PID）と、その子プロセスの終了を確認します。不明な writer が存在する場合や、権限不足により確認・停止ができない場合は中止します。`pkill` は使いません。
2. 正準の0700保存先と、非公開記録から確認した64桁の owner ID を使います。`<ownerId>.owner.json` と `.<ownerId>.lock` は通常ファイル0600・link数1とし、symlink は認めません。
3. 保存先の外に0700の別のバックアップ先ディレクトリを作り、owner と lock のコピーを0600で保存します。owner ファイルと lock ファイルそれぞれの SHA256、および lock ファイルの dev/ino/size を private な記録に残します。
4. writer を止めたまま、owner ファイルの SHA256 と、lock ファイルの dev/ino/size/SHA256 を再確認します。変化があれば中止します。確認したlockの完全なパス1件だけを削除します。owner、tombstone、他のlock、一時ファイルは消しません。ワイルドカードを使いません。
5. writer を1つだけ起動し、同じ Cookie・公開sessionId・保存済み assignment の結び付きを確認します。保存済み preparing は従来どおり `start_interrupted` になり、active へ昇格させません。失敗した場合に別の条件で置き換えません。

この手順は全 writer を止めて新規起動を防ぐ運用が前提です。runtime が未知の writer の不存在を保証する仕組みではありません。共有・複数ホストの保存先や、途中の AI キュー、電源断からの完全復旧は保証しません。稼働中や二重起動時の lock 回収は認めません。

### Worker の BASE 設定

Worker版Webでは `BASE_ASSIGNMENT_JSON` に、上述の `assignment.json` と同形式の設定を JSON 文字列として設定します。`PARTICIPANT_CONTACT_TEXT` は公開してよい連絡先の表示に使います。`ADMIN_TOKEN` は既存の Secret、管理用 limiter は既存の binding です。ローカルWebサーバーの環境変数を Worker に自動転送する仕組みではありません。保存先は Durable Object であり、ローカルWebサーバーの owner ファイルや手動 lock 復旧を流用しません。この説明は deploy や実 API の利用の指示ではありません。

対話CLI:

    node --env-file=.env dialogue-model/runtime/naming-cli.mjs --strategy repair-first --seed 1 --image-dir /path/outside/repository/images

書き出された人間側PNGを画像ビューアーで開いて対話します。`/submit` で上段左から下段右の順に名称を入力し、提出を確定します。`/submit {"上段左":"...",...}` の1行JSON形式も使用できます。`/exit` は提出せず終了します。画像書き出し先もリポジトリ外を指定してください。

非対話の操作確認は `--script /path/outside/repository/turns.jsonl` を追加します。1行につき公開発話のJSON文字列、または `{"utterance":"公開発話"}` を記述します。後続行は、それ以前のAPIリクエストに混入しません。任意の最終行に次の形式で人間の提出を記述できます。

    {"submission":{"上段左":"名前1","上段中":"名前2","上段右":"名前3","下段左":"名前4","下段中":"名前5","下段右":"名前6"}}

提出行がなければ対話だけで終了します。JSONLはリポジトリ外で作成してください。スクリプトは研究者による操作確認の補助であり、実際の参加者との予備試験の代替ではありません。

人間側の提出名称は公開履歴に追加せず、AIにも渡しません。AIの最終提出は、同じAI側画像・公開履歴による別リクエストで6位置のJSONとして取得します。不正な形式の場合だけ1回再要求し、再度不正ならエラーとして照合しません。AIが先に提出しても、人間が提出するまでその名称と採点結果を人間側へ返しません。どちらかが提出を開始した後は対話を再開しません。名称の空欄は未命名として扱い、正式な採点規則を意味しません。

### 研究記録

対話CLI（`naming-cli.mjs`）では、保存する場合だけリポジトリ外の `RESEARCH_RUN_DIR` を設定します。例えば `/Users/your-name/ResearchRuns/naming` のような専用ディレクトリを使います。Gitリポジトリ内、ignore対象ディレクトリ、リポジトリ内へ向くシンボリックリンクは拒否します。ローカルWebサーバーは上記の必須の private owner 保存先を使い、この任意保存の説明とは区別します。

試行ごとにランダムな記録IDのJSONを作り、各操作後に更新します。方略、seed、公開発話、各自の非公開提出、暫定採点、各リクエストの応答モデル名・トークン数・レイテンシ・再試行回数を含みます。判断履歴には各ターンのJudgment、検証・フォールバックの有無、作業メモの更新前後のスナップショットも保存します。対応表 `key` は双方提出後の `scoring` 内にのみ保存し、画像本文・APIキー・プロンプト全文・上流の生エラーは保存しません。途中終了した試行も、最後の確定状態まで記録します。記録には非公開の提出も含まれるので、参加者用画面ではなく研究者が管理してください。

#### 応答レイテンシ（v2、研究者用）

v2 の記録には、AI の各試行（キューの `requestSeq` ごと）の `turnTimings`（開始・終了時刻、成否・置換、判断の試行回数と検証失敗コード、公開前検査の書き直し）と、各上流呼出し `requests[]` の `requestSeq`・エラーコード（`timeout` 等の列挙値だけ）を保存します。判断モデル（active／shadow）の呼出しも `decision_active`／`decision_shadow` として含みます。どれも非公開記録だけに入り、参加者向け状態には出ません。中断からの復元後も引き継がれます。

`v2/latency.ts` の `summarizeLatency(record)` は、記録から数値・段階名・コードだけの要約を作ります（例外を投げない純関数、Worker からも `.ts` で import 可）。各 AI 発話について、最後の人間発話から AI 発話までと、未応答の最初の人間発話から AI 発話までの経過時間、その試行の呼出し（judgment／generation／regeneration／decision）を返します。セッション全体では、段階別の件数・エラー数・p50/p90/p95/最大・合計、最も遅い段階（p50）、タイムアウト数、置換・失敗した試行数を返します。発話本文・モデル名・イベントID・上流の生エラーは含みません。パーセンタイルは最近順位法です。

`npm run naming:web -- --port 8787` と `npm run naming:cli -- --strategy repair-first ...` も利用できます（環境変数は事前設定）。`npm test` はローカル模擬HTTPで、AIへの情報漏れ防止、方略以外の入力一致、提出と採点の順序、エラー秘匿、CLI・Web操作を検証します。実APIでのマルチモーダル認識・対話成立・操作妥当性は別途予備試験が必要です。人数・尺度・時間制限・正式な採点規則はこの実装で確定しません。

### 判断層と発話生成器（操作確認用の実装）

`judgment/schema.mjs` はJSDocの `DialogueJudge` / `Judgment` / `OwnLedger` と実行時バリデータを定義します。`createLunaJudge(client)` は同じ既存クライアントを使い、Workerに `purpose=dialogue_turn` を送信します。モデルIDを独自に決定しません。`createJevJudge()` は未実装を明示するエラーを返すスタブです。Jevの導入・採用を意味しません。

判断フェーズには上流の停滞に備えた時間予算（50秒、両方略共通）があります。接続失敗・タイムアウトのときは既存の安全な判断（accept）に戻して発話を続け、`validation` に `fallback: true` と `connection_*`（または `time_budget`）の失敗コードを残します。発話生成は1回40秒で、停滞か応答前の接続失敗のときだけ1回再試行します。**action の分布などを分析するときは、これらのフォールバックのターンを除外してください**（方略の判断ではなく接続上の代替です）。

通常の1ターンは、判断JSONを得る呼び出しと、その判断から公開発話を生成する呼び出しの2段です。判断は `action / targetSlot / candidateName / discriminatingFeature / note` の5キーに限定し、不正なJSON・列挙値・名称の不正な再割当があれば1回だけ再要求します。再度不正なら、対象や名前の合意を確定しない `accept / targetSlot=null` を既定判断にします。検証理由は固定コードとして記録し、不正なモデル出力本文を記録しません。判断の通信失敗・タイムアウト、または時間予算の不足のときは、再要求をやめて既定判断（参照メモリONで有効な核判断があればそれ）に置き換えます（`connection_*`・`time_budget` として記録）。発話生成は、停滞か応答前の失敗に限り1回再試行し、再試行も失敗したときは公開履歴を保持した接続エラーにします。応答後の失敗（HTTPエラー等）は再試行せずに接続エラーにします。1ターンの最悪時間は、判断50秒＋生成2×40秒＋書き直し40秒＝170秒です（active decision を使う場合は判断モデル呼び出しの約20秒が加わり、約190秒）。

AI自身の6位置ごとに `unassigned / tentative / agreed / deferred` と名称を作業メモとして管理します。これはAI自身の過去判断の記録であり、相手との対応が正しいことを保証しません。名前の付いた枠の改名には `repair` が必要で、誤対応の撤回も明示的な `repair` で行えます。状態は生成発話の文面から逆算せず、検証済み判断からのみ更新します。生成失敗時は公開履歴と作業メモをともに確定しません。

両方略で生成器の指示は同一です。生成器は判断の対話機能、名前候補、弁別的特徴を使って1〜2文の日本語発話を生成し、自分の画面位置を相手に伝えず、回転しても保たれる特徴で対象を参照するよう指示します。方略差は判断方針だけに置き、どちらも同じ質問の反復を避けます。判断の `note` は生成器に渡さず、判断と作業メモを参加者向け状態に含めません。最終提出には自身の作業メモを初期候補として提示しますが、6位置の最終名称はモデルが改めて決定します。

### 通信の再試行とタイムアウト

生成・課金の重複を防ぐため、chat completion の POST は HTTP 429 / 503 と、応答受信前に接続確立失敗と判別できるエラー（`ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` / `UND_ERR_CONNECT_TIMEOUT`）だけを最大2回再試行します。HTTP 502 / 504、要求全体のタイムアウト、接続切断、判別不能なネットワーク障害、応答本文の読取り失敗は、上流で生成済みの可能性があるため再送しません。モデルポリシー照会の GET は従来どおり HTTP 429 / 502 / 503 / 504 とネットワーク障害・タイムアウトを最大2回再試行します。待機は500ms、1000msの指数バックオフです。認証失敗・その他のHTTPエラー・不正な成功JSON・空応答は再試行しません。成功と最終失敗のどちらも `retryCount` を研究記録に残し、HTTP失敗時のステータスも保持します。判断JSONの再要求とHTTP再試行は別々に数えます。

`RESEARCH_AI_TIMEOUT_MS` が未設定なら、画像付きHTTPリクエストは各試行90秒、テキストのみ・モデルポリシー照会は45秒です。明示指定があれば両方にその値を使用します。判断と生成の2呼び出しや再試行を含むターン全体の時間制限ではありません。画像認識、回転を踏まえた参照、自然な命名提案、反復の抑制に実際の改善があるかは、実APIの予備対話で別途確認してください。
