# Active judge アダプタと E2E 手順の独立監査

**エンジニアリング用・研究者未承認。** 正本は [../../README.md](../../README.md)。起点は `d590846`、対象仕様は `E2E-ACTIVE-JUDGE-PLAN.md`。この監査は安全な配線・診断の条件を扱い、方略効果や判断モデルの独立した優劣を実証しない。

## 第1段階：仕様への批判

1. **P1：型検証は共有同定の証拠ではない。** `agreeEvidence` は unassigned/deferred を拒むが、tentative は特徴のない仮名提案でも作れる。Luna が confirm を選び、候補がまだ曖昧な tentative に対して Decisions が agree を返すと、元の仕様では型検証に通り、合意へ格上げできる。Decisions の agree を Luna 自身の検証済み agree と同じ対象の場合だけ適格にする、などの明示的な保守的ゲートが必要。これは Luna の誤同定を解消せず、安全性の証明でもない。
2. **P2：再順位付けは独立したモデル判断ではない。** 必須項目がない行動を除くと、Luna が渡した名前・特徴・対象によって実行可能な選択肢が変わる。accept は通りやすく、confirm は特徴が必要である。ゼロ確率の行動まで走査すると、モデルが全く支持しない行動を作る。有限な正の確率だけを対象とし、同率の順序を固定・記録し、安全な accept を明示的に区別する。選択確率の再校正や妥当性は主張しない。
3. **P2：混合条件と方略差を分離して記録する。** 呼出し失敗時の Luna fallback、候補棄却後の rerank、支持行動がない safe_accept は別の出来事である。要求したモデル、実際の供給モデル、raw action、Luna action、最終 action、棄却理由、再順位付け／fallback、費用・遅延を区別する。fallback 率を隠したまま Jev 条件の成績と呼ばない。repair-first/bypass-enabled の同じ情報入力と共通の制約を保ち、repair や confirm への一律の置換で条件差を消さない。
4. **P1：対象・名前の供給元を固定する。** Decisions は action だけを選び、返却された targetSlot、candidateName、feature、followUp、reference、note などを状態や生成器へ合流させない。画像・相手専用情報・正解表・未来の公開発話・採点を入力しない。Luna の action も渡さない。作業メモは正解ではない。
5. **P2：followUp と reference は異なる責務。** action が変わるなら followUp を除く。同じ action でも既存の主判断→後続判断の検証を省略しない。reference は人間発話の解釈として既存の検証を通し、生成成功かつキューの現行スナップショットであるときだけ ledger/履歴と一緒に確定する。safe_accept が合意や仮名を書き込まないよう名前を null にする。失敗・キャンセル時の解釈や生成文から状態を逆算しない。
6. **P1：active 待機はキャンセル・single-flight と整合させる。** active は公開発話の行動を決めるため shadow と異なり待機が必要。ただし待機中に新しい人間発話が来たら、古いスナップショットの生成・状態確定を止める。abort を fallback 用 catch で握りつぶさない。閉じたキューや古いスナップショットから ledger、graph、最終提出、採点を更新しない。生の例外や hostile payload を公開ログへ出さない。
7. **P1：モードを参加者経路から隔離する。** 起動時の研究者設定だけで有効化し、/api/start の値では切り替えられない。v1・既定OFF・既存 shadow の動作は維持する。active モード・モデル名・確率・棄却理由・作業メモを画面/API状態へ出さない。応答時間の違いから条件を推測する可能性は残るので、完全な盲検とは呼ばない。

## 第1段階で採用された工学的制約

親 WildBose は ORRERY #6187 で、active の agree は **Luna自身の検証済み主actionも同じtargetSlotへのagreeの場合だけ**適格とする規則を採用した。Lunaがconfirm等なら `agree_ineligible` として正の確率の次候補へ進む。逆にLunaのagreeをDecisionsがconfirm等に変えることは許す。したがって、この構成のDecisionsは**合意を拒否・遅延できるが、自分から合意を開始できない**。E2Eで合意の開始能力をモデル間比較できないことを明記する。Lunaの誤合意が残る可能性もある。

同時に、正の確率だけを再順位付けし同率をWorkerの行動順で処理すること、不正な決定応答は検証済みのLuna判断へfallbackすることが確認された。これらは研究上の承認ではない。

## E2E 手順と解釈上の限界

- 人間役は対話中に AI 盤面・正解表・内部メモ・途中採点を見ない。分析者役との権限分離を保ち、人間役に途中の raw action、rerank、fallback や誤りの位置を知らせない。
- 一致数は双方の非公開提出後に採点できる。ターン数・文字数・各typed action数・再順位付け／fallback数・Luna提案との相違・待ち時間・費用は既存記録から計算できる。
- typed agree の回数と、本当に同じ図形への命名が成立した回数は別。途中の誤合意・誤修復の判定は、人間役へフィードバックせず、終了後に盲検化した基準で分析する。採点結果を知った人間役が途中で修正すると成功率が汚染される。
- 人間役の「全て合意した」という停止と、AIの全件解決は一致しない。事前に最大時間／ターン等の診断上の停止規則を明示し、未解決・時間切れも記録する。成功するまで無制限に続けた結果を固定時間の成功率と比較しない。
- 同じ役が同じ seed を2条件で使うと図形・見立て・名前を学習する。順序固定・人間役=AI・少数セッションの影響を記録する。別seedでも刺激差が加わる。現在の小規模E2Eで因果的な方略差・モデル優劣を結論しない。
- 比較対象は **Lunaによる画像・履歴解釈＋Decisions行動選択＋保守的ゲート／rerank／fallback＋Luna生成器** の混成パイプライン。Luna の候補抽出に依存し、agree の格上げも制限されるため、Luna から独立した判断モデルの評価ではない。

## 第2段階：実装と敵対的テスト

対象は GrayLavoisier worktree の `d590846` 上の実装スナップショット。ソースは編集・複写せず読み取り専用で監査した。**採用された2件の修正を確認し、現時点で未解消の阻害的指摘はない。** これはコード境界の確認であり、画像同定や自然な対話の品質保証ではない。

| 指摘 | 再現条件と影響 | 最終実装・確認 |
| --- | --- | --- |
| P1・合意の先取り | tentative に対して Luna=confirm、Decisions=agree。元仕様の型検証だけでは合意へ格上げできる。 | `v2/active-judge.mjs:73` の `agree_ineligible` ゲートで棄却。unassigned/tentative/agreed/deferred × 両方略の独立テストで ledger 不変を確認。逆方向の agree→confirm は可能。 |
| P2・壊れた確率分布 | 各値の範囲検査だけでは全0・総和1.5・選択行動の確率0を受理し、safe_accept や選択行動へ進む。検証済み Luna への fallback と診断が異なる。 | `v2/active-judge.mjs:21` で全9値・総和 [0.98,1.02]・選択行動の正の支持を検証。不正応答は `invalid_response` として Luna と有効な followUp を維持。Jev型の総和0.99は受理。±0.02は親が実応答の丸めを確認して指定した工学的許容値で、確率校正や科学的な採用基準ではない。 |

追加で次の境界を確認した。

- `v2/active-judge.mjs:60` は Luna の対象・名前・特徴・note だけを合成に使う。Decisions の hostile な同名フィールド、followUp、reference、任意診断キーは合流しない。確率記録も9行動に限定される。目的・モデルのネットワーク検証は既存 Decisions client/Worker が担当し、このアダプタはその代替ではない。
- `v2/active-judge.mjs:64` は action 変更時の followUp を除外。同じ action と接続失敗 fallback では検証済み followUp を保持。`safe_accept` は対象・名前を持たず ledger を変えない。正の支持だけを再順位付けし、同率は Worker 順で決定する。
- `v2/dialogue-v2.mjs:173` の abort 検査は接続例外の catch の外にある。待機中に中断された呼出しが成功／失敗しても古い生成を始めない。新しい人間発話を待機中に追加する独立キューテストでは Decisions が2回、生成・状態確定は現行スナップショットの1回だけとなり、最初の入力に未来発話は入らない。
- `v2/dialogue-v2.mjs:178` の参照メモリ再準備は確定前の同じ graph を使う。生成失敗時は ledger/graph/判断履歴を維持し、再実行成功時だけ解釈を一度適用する。生の失敗本文は attempts に残らない。
- `v2/naming-task-v2.mjs:96` はモードを研究記録の options に保存し、参加者状態へ追加しない。`web/server.mjs:130` は起動時オプションだけをv2へ渡す。参加者の `/api/start` に activeDecision 等を追加しても有効化・変更できず、v1 factory にも渡らない。画面・応答・状態にモード／モデル／確率／棄却理由が出ないことを確認した。

独立テストは `tests/active-judge-audit.test.mjs` の11件。GrayLavoisier のソースを読むよう import URL だけメモリ上で置き換えて実行し、**11/11成功、失敗・skip・todoなし**。さらに GrayLavoisier worktree の `npm test` を独立に実行し、**590/590成功、失敗・cancel・skip・todoなし**（ログ `/tmp/brisk-active-gray-full.tap`）。590件にはこの新規11件は未統合のため含まれない。親で統合後の全件実行が必要。

実API・keychain・wrangler・Cloudflareは呼び出していない。モックで検証できるのは呼出し・状態・公開境界であり、モデルが指示どおり同定するか、利用者が違和感なく対話できるか、実際の相互命名の成功率は E2E で別途確認する。
