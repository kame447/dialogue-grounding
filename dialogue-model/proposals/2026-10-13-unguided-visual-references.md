# 参照対話を妨げないUIへの修正指示（2026-10-13）
status: requested implementation; source of truth is researcher feedback.
Working copy: /Users/Shogo/Developer/dialogue-grounding-referential-ui
Git branch: feat/experiment-unlabeled-scattered-ui-20261013
Base: feat/experiment-human-ai-redesign-20261013 / PR #4
Existing demo service to update AFTER tests: dg-tangram-ai-demo only. Do not change previous dg-tangram-live-demo or any other Workers/projects.

## 研究者の要求（最優先・省略不可）
> 「余計な説明が多い」「会話と図形の画面は一つにするべき」「図形1とかの番号はつけてはいけない」「配置も綺麗にしてはいけない」

これらは単なる美観の好みではなく、**タングラム参照対話を成立させるための実験操作の妥当性**。画面が番号・行列・位置対応を先に教えてしまうと、見立て・位置・方向を用いた自発的参照と修復／やり過ごしが観測できなくなる。学術原本 read-only: /Users/Shogo/Research/dialogue-grounding/private-sources/originals/HCS2026_Iida.pdf の2ページ「図1 タングラム命名課題で提示された図形配置の例」を確認する。同一6図形は参加者間で異なる配置・向きにある。学術原本をコピーしたりGitに載せない。

## P0: Participant task UI
1. PC・スマホ**両方**で、同じ画面に6図形と会話スレッド＋送信欄を常時表示する。図形と会話のタブ切替/hiddenを廃止。スマホはコンパクトな無駄のない縦方向の図形領域とチャット領域を一体として表示。ソフトウェアキーボード表示中も送信欄を操作でき、図形は最低限視認できる。デスクトップは左右並列のままでよいが統一されたワークスペース。
2. **図形の可視番号・名前・共有IDを一切表示しない**。NG例：「図形1〜6」「図形Nは鳥」「左から1番目」「図形2を拡大」「図形1の名前」。導入文、ツールチップ、プレースホルダー、画面本文、拡大ダイアログ、名前入力、確認画面、結果画面、MockAI発話、テストサンプル、ARIA accessibility labelsもチェック。内部のopaque slot/idの存在は可、しかし会話・表示へ持ち出さない。手順の番号1..4は図形識別とは別だが説明が多ければ短縮。
3. **6図形を整然と3x2や2x3のグリッドで並べない**。元課題のようにランダムな2次元位置、バラバラな向きでキャンバス上に散在させる。対象の選択は図形そのものの輪郭と見立て、位置・向きの対話で行う。画面上の整列線、均一なカード枠、タイル番号はなし。配置は不規則だが**重ならず・切れず・判別できる大きさ**。縦横幅の異なる図形も描画面積を適切に保つ。意図しない見やすい対称配置や単純な左→右の自明な列にしない。
4. 参加者とAIには同一6図形を**異なる不規則配置・向き**で提示。セッションのseedから決定論的に座標/回転を生成または固定し、ページ再読込で変えない。AI側の認識用画像/幾何情報と人間側の描画を同じcanonical referentに結び付ける一方、相手の配置・内部IDを人間へ漏らさない。CSSだけでhuman画面を回転してAI入力に反映しない設計は避け、将来VLM接続時の座標・向き契約も明記。
5. **名称提出画面も図形番号を排除**し、各シルエットに紐付くテキスト入力を提供。できれば命名対話と同じ散在配置を保つか、シルエットに直接名前を付けられる自然な方式にする。変わる場合は参加者の連続した参照を妨げない。6つのユニーク名入力を検証し、裏のslot識別子で一致評価する。回答前にAIの提出や正解を見せない。結果画面のサムネイルに番号を付けない。
6. 説明を削ぎ落とす。開始画面は「6つの図形の名前をAIと決めてください」程度、主要操作のみ。現在の4段階のチュートリアル・注意書き・重複状態表示・長い段落は簡素化。重要な「実モデル未接続」「DEMO」は簡潔に明示し続けるが毎応答・各カードで繰り返さない。

## P0: MockAI and task validity
- 旧MockAIは「図形NはX」の番号をregexで抜いて対応表へ転記していた。番号を消す以上、この振舞いは**必ず撤去**。図形番号を使うよう求める返答や入力例は厳禁。
- Mockは図形を見ておらず参照解決もできないと明示する。自由な形の見立て・対話文を受け付けて自然な短い確認/促しを出せるが、理解した対象・正しい共有名を推測したふりをしない。
- 実モデル未接続中のmockに事前にhumanの内部figure slot/canonical correspondenceを使って完全一致を捏造させない。可能なら模擬AIモードでは一致率スコアを表示せず「命名操作と質問紙の確認用」と明示し、外部AI agentが本当に独立して対象同定して提出したときに限って対応一致を算出/表示。現行mockの状態機械が6名提出を必須にするなら独立の未判定placeholder(固有値)を用い、科学的成功率を主張しない。テストはこの境界を検証。
- 実験開始時にhumanの選択・ホバーしたfigure slotをAIへ勝手に送らない。図形クリックは**ローカル拡大のみ**。参照手がかりは自然言語と画像・相互行為から得るべき。

## UI specifics
- 依頼はUI改修優先。紙系白/濃い文字/落ち着いた青の現行パレット、低装飾、研究用プロトタイプの雰囲気を維持。画像生成や過剰な装飾不要。余白を削減し図形+会話領域に面積配分。
- 固定topbar、チャットの自動スクロール/未読、送信欄のkeyboard対応、safe-area、320px/390px、desktop1440px、図形拡大を再確認。
- 画面に同一図形を並べたメニューや番号付き選択肢を新たに作らない。位置を参照するときは参加者が自然に「右上の鳥っぽいの」等と話す。

## Test / evidence
- 非表示まで含め participant DOMに「図形[1-6]」「図形N」表示なし、AIの発話にも番号誘導なし、フォーム/結果/zoomにも番号なしを確認。
- 画像の不規則配置を簡易幾何検証: 6個が互いに重ならず、同一行・同一列に全員揃っていない。異なる端末/seatで配置・回転が異なり、再読み込み/セッション復帰で不変。スマホでも6図形とチャットが同一画面に見える（表示タブで一方をhiddenにしない）。
- Mock 6図形の命名入力・自由会話→名の独立提出→アンケート→結果/データ削除、外部エージェントstubの通信/命名も回帰テスト。バックエンドの30日TTL、別seat token、レート、個人情報保護、受信データの漏洩を維持。test commands npm run build/npm test/npm run e2e:ai; legacyを崩さない場合はnpm run e2e。
- **ブラウザで実際にレンダリング**: intro, simultaneous chat+irregular figures, zoom, name-submission, resultの 1440x900、390x844、320x640 スクリーンショットを保存・目視検査。ユーザーが指摘した違反が残るスクショで合格としない。
- テストを通してからのみ現行 Worker dg-tangram-ai-demo を更新して公開URLをブラウザで確認。**別WorkerやLaplansへ触れない**。これまでのdemoルームの30日保持に配慮し、破壊的なDO migration/resetは禁止。ユーザーの現行公開URLをできる限り維持。
- ブランチをpushし PRを base=feat/experiment-human-ai-redesign-20261013 で作る。mainをマージしない。ユーザーに公開URL・変更点・未接続であることを短く報告する。

## Orrery operational
- 専用cloneを使用。親Opus 5.5はレイアウト/統合/ブラウザ QAを主導、必要ならOrrery公式/delegate GPT-6 Luna low子1〜2体でbackend contract/mock/E2E等を切り出す。低推論でよい。Orrery Mailと予約を使い、別の代理エージェントへ勝手に置換しない。
- 過去clone(/Users/Shogo/Developer/dialogue-grounding-ai-ui、dialogue-grounding-ui、dialogue-grounding-docs、dialogue-grounding)、StudyPlanner、Laplans、orrery-telemetry、同時実装中のbranch、他Cloudflare Workerにwrite禁止。git作業・npm installはこのclone内のみ。
