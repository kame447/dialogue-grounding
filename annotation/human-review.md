# Human Review

## 基本方針

Jev の判定は一次判定です。研究用の最終ラベルは人間が確定します。

strict research mode では、全発話と全 span を最終的に人間が確認します。モデルは確認順序の最適化、候補提示、競合箇所の可視化に使用します。

assist mode では、低信頼事例だけを重点的に確認する運用も可能ですが、これは研究用 gold annotation を作るモードとは分けます。

## review queue

review queue は、モデルが「分からない」と返した事例だけではなく、構造的に危険な事例を含めます。

概念レベルで並列な review trigger として、低い top-1 confidence、top-1 と top-2 の margin が小さい Choice、P2/P3/P4 の競合、M4 と局所問題 identity の不一致、episode boundary の競合、span 範囲 validator の失敗、生成モデルと Jev の不一致、同一規則の再判定での不安定性を扱います。

## reviewer へ見せる情報

レビュー画面では、原発話、必要な前後文脈、active episode、active local issue、前状態、Jev の候補分布、生成モデルの候補、適用された運用基準の抜粋を分離して表示します。

人間にはモデルの最終候補を先に見せない blind review mode も評価用に用意する価値があります。これにより automation bias の影響を調べられます。

## 基準更新

個別事例の裁定から一般化可能な新ルールが得られた場合、まず ruleset を更新します。

その後、更新前後で regression benchmark 全体を再実行し、他事例への副作用を確認します。

個別発話の正解例を ruleset に直接埋め込むことは禁止します。

## 最終確定

model prediction、reviewer decision、final label は別フィールドで保持します。

上書き保存によってモデルの元判定を失わないようにします。

将来、独立二重符号化を行う場合は、reviewer A と reviewer B の独立判定を保持し、協議後 final を別に記録します。
