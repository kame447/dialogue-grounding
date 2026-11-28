# 研究者の追加指示：Opus・Terra同一担当内での並列評価と合議
担当は c、対応する Terra は SturdyLangmuir、統括親は CherryCurie。
全30項目中、親が既に独立観察した 8 項目は保存済み結果を再利用し、残り 22 項目をあなたが独立に評価する。今回に限り、研究者は複数Opusの並列評価を明示的に指示した。
最初に ORRERY Mail で親 CherryCurie へ importance=high の連絡を送る：「研究者の追加指示で4組の同一担当内合議に変更。親の保存済み36項目を割当へ再利用済み。親は現在の観察途中分を必要なら保存し、以降の逐次観察ではなく各ペアの合意成果の統合・品質確認に専念してください。割当正本は /Users/Shogo/Research/dialogue-grounding/private-runs/2026-11-28-construal-consensus-CherryCurie/paired-review-v1/assignment.json。私はc担当で、SturdyLangmuirと合議します。」作業を止めて返信を待たず、自分の独立観察を開始する。
## 第1段階（独立観察）
- このディレクトリの pending-items.json の全項目を対象に、silhouette と regions の実画像を必ず両方開き、表示方向のまま評価する。items.json には全30項目の確定幾何情報がある。分割・面積・形・接続・領域IDは変更禁止。
- 第1段階の結果を保存するまで、completed-parent-observations.json、対応Terraの回答、旧AI案、mapping.jsonなどを見ない。入力画像と幾何情報だけから判断する。第1段階の成果を独立に固定した後でのみ既存親結果とTerra結果を読む。
- 見立ては具体的な普通名詞（犬、猫、ペンギン、フライ返しなど）と姿勢・方向を候補0〜3件、部分IDと形からの根拠・反証を添える。動物、鳥、道具等の分類名だけでは不十分。無理な具体化をせず、見立てなしも許容する。
- 形式は round1-independent.json = {"observer":"あなたのORRERY名","model":"claude-opus-5-5","effort":"max","viewedImages":true,"items":[{"item":"item-01","silhouetteImpression":"…","candidates":[{"rank":1,"noun":"…","posture":"…","direction":"…","confidence":"高|中|低","parts":[{"id":"P1","role":"…","evidence":"…"}],"evidence":"…","weaknesses":"…"}],"noConstrual":false,"noConstrualReason":"","uncertainty":"…"}]}。各候補の parts は全P IDを含み、対応しない部分は対応なしと理由を書く。pending-items.json の対象IDだけ出力。途中で小分けに保存してもよい。画像未確認の場合は捏造せず報告。
## 第2段階（同じ担当のTerraとの合議）
- 自分の独立結果を確定保存してから completed-parent-observations.json（再利用する親の独立観察）と /Users/Shogo/Research/dialogue-grounding/private-runs/2026-11-28-construal-consensus-CherryCurie/images-v1/terra-c/round1-observations.json（Terraの独立観察）を読む。全30項目で照合し、親結果を消さず、双方の案・根拠・反証を尊重する。旧案は参照不要。
- 対応Terra SturdyLangmuir に ORRERY Mail で、自分がこのグループの合議担当であること、round1-independent.json と completed-parent-observations.json のパス、具体的な争点とレビュー依頼を送る。Terraが独立観察の後の相互検討として読んでよいことを明記。Terraが反論・支持・修正案を送り返したら、双方で必要な再観察をし合意案を作る。返信待ち中も候補の突合、反証、記録整形を並行する。親に全件の再評価をさせない。
- 最終成果は paired-consensus.json に全30項目をitem-01〜item-30の順で含める。各項目に item, opusSource (parent/reviewer), opusIndependent（独立回答）, terraIndependent（独立回答）, consensusCandidates（上記候補形式、0〜3件）, noConstrual, noConstrualReason, agreementStatus（合意/一部合意/未合意）、discussion（採用・不採用の理由とTerraとのやり取りの根拠）を含める。未返信・意見の不一致を合意と偽らない。根拠が弱い具体名は落とす。
- 同じ担当同士の合議が完了したら、成果のパス、30件の被覆数、合意状態別件数、見立てなし件数、残留論点をCherryCurieへ ORRERY Mail (high) で報告。親の統合を助けるためJSON構造とID・P ID・候補を機械検証する。必要なら reservation を正規に取得する。拒否は回避せず親へ知らせる。
- 自分のディレクトリにのみ成果を書き、Terraの既存結果、親の保存済み回答、他の担当の結果を編集しない。人手確定分割、実験runtime、本番、現在の確認ページや状態ファイルには触れない。親が全体統合と確認画面への反映を行う。
