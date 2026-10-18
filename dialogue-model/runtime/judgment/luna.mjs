import { ACTIONS, FOLLOW_UP_ACTIONS, SAFE_JUDGMENT, validateJudgment, validateOwnLedger, JudgmentValidationError } from "./schema.mjs";
import { STRATEGIES, taskInstructionsFor, JUDGE_POLICIES, ownImageMessage, ownRotationMessage, publicMessages } from "./instructions.mjs";
import { summarizeForJudge, ReferenceGraphError } from "../memory/reference-graph.mjs";
import { MEMORY_INSTRUCTIONS, stageMemory } from "./memory.mjs";
import { CANDIDATE_CONFLICT_INSTRUCTIONS, CONFLICT_RETRY_HINTS, CandidateConflictError, splitConflict, validateCandidateConflict } from "../v2/candidate-conflict.ts";

// Robustness bound, identical for both strategies: one upstream stall must not
// fail the whole reply. Each attempt gets the remaining budget; a validation
// retry needs a minimum window; otherwise the existing safe fallback applies.
export const JUDGE_TIME_BUDGET_MS = 50000;
export const JUDGE_MIN_RETRY_MS = 12000;

const judgeInstructionsFor = (version) => [
  "【非公開の対話判断】次の公開発話を生成するために、対話上の判断をJSONだけで返してください。これは対話相手への発話ではありません。",
  "必須キーは action, targetSlot, candidateName, discriminatingFeature, note の5個です。任意キーとしてfollowUpを追加できます。action は " + ACTIONS.join(" | ") + " です。",
  version === 2
    ? "targetSlot はownLedgerのキーにある自分専用の内部参照IDの1つ、またはnull。相手と共有された位置名・図形番号ではありません。candidateName は名称文字列またはnull。discriminatingFeature は候補を区別する画像上の特徴1つ、またはnull。note は短い作業メモまたはnullで、相手には公開されません。"
    : "targetSlot は自分の6位置の1つ、またはnull。candidateName は名称文字列またはnull。discriminatingFeature は候補を区別する画像上の特徴1つ、またはnull。note は短い作業メモまたはnullで、相手には公開されません。",
  "propose_name は対象と名前候補を選ぶ、agree は対象の名前に合意する、confirm は対象を区別する特徴で確かめる、repair は自分の対応の取り違え・合意済み名を訂正する、defer は保留、revisit は保留対象へ戻る、move_on は別対象へ進む、accept は相手の発言を受け止める、close は対話終了を相談する判断です。",
  "ownLedger は自分の過去判断を記録した作業メモで、相手との正しい対応を保証しません。tentativeの同じ対象の名前を言い換える・相手の呼び名に合わせるだけなら、agreeで新しいcandidateNameを指定し、repairは選ばないでください。まだ相談中の言い換えは同じtargetSlotのconfirmやpropose_nameでも扱えます。repairは自分の対応の取り違え・合意済み名の訂正に限り、別の対象への付け替えにも必要です。誤対応を取り消すrepairではcandidateName=nullで自分の枠を空にできます。",
  "confirm・propose_name・agreeではcandidateNameに対象の名前候補を保持できます。confirmでまだ照合中でも、話題の名前候補があればtargetSlotとcandidateNameを記録してください。confirmの候補名は仮の記憶であり、名称への合意を意味しません。",
  version === 2
    ? "agreeは名称への合意です。共通教示の合意条件（対象の同定と、相手がその名前を使う意図）を満たすときだけ選び、targetSlotとcandidateNameを指定してください。相手が名前を出しても対象の同定が不十分なら、agreeではなく、その名前を候補として保持するpropose_name、confirm、accept、または方略に応じてdefer・move_onを選べます。propose_nameには対象枠と名称が必要です。既存の名前にagreeする場合のcandidateNameはnullでも構いません。"
    : "相手が提案した名前を受け入れる・同意するときは、confirmやacceptではなく必ずagreeを選び、対象のtargetSlotとcandidateNameを指定してください。propose_nameには対象枠と名称が必要です。既存の名前にagreeする場合のcandidateNameはnullでも構いません。",
  ...(version === 2 ? [
    "名称提案のない大まかな見立てや挨拶・相槌にはacceptを選べます。acceptでは名称合意を作らず、candidateNameはnullにしてください。対応しそうな対象や名前を実際に提案するときだけpropose_nameを使い、曖昧さや食い違いの根拠がなければconfirmを挟まず、discriminatingFeature=nullで短い全体の見立てに進めます。",
    "agreeの前に、自分の画像と公開対話から対象を1つに絞れるか確かめてください。相手が述べた形の特徴があれば、自分の対象に実際にあるかを自分の画像で確かめてください。対象を絞れないときはagreeしないでください。対象と名称採用の意思が明確なら追加の確認質問や特徴の付加は不要です。",
    "作業メモでまだunassignedかdeferredの対象には、その返答でagreeできません。相手が名前を出していても、相手の見立てを短く受け止め、自分の画像の全体の見立てと結び付けて理解を表し、必要なら自分の見立ても1つ返してください。名前はpropose_nameの候補として保持できます。discriminatingFeatureは原則nullとし、共通教示の分析トリガーがあるときだけ1特徴を入れてください。tentativeの対象でも、公開対話から対象を1つに絞れ、相手がその名前を使う意図を示し、曖昧さや矛盾が残っていない場合だけagreeしてください。内部に候補が複数あるだけでconfirmにせず、まだ名前を確定しない見立ての共有を続けられます。deferredの対象はrevisitしてから扱ってください。",
    "相手の返答が相槌だけ（はい・うん・それ等）のときにagreeできるのは、自分の直前の名称提案が相手が導入または受け入れた対象についてのもので、その提案への受入れと読め、公開対話に曖昧さや矛盾が残っていないときだけです。識別特徴の付加は条件ではありません。対象や名称採用の意思が不明ならacceptとし、分析トリガーがあるときだけconfirmを選べます。新たな特徴を付け足すことで合意の根拠を代用しないでください。",
  ] : []),
  "followUpは不要なら省略またはnull、必要ならaction, targetSlot, candidateName, discriminatingFeatureだけを持つ1個のオブジェクトです。followUp.actionは " + FOLLOW_UP_ACTIONS.join(" | ") + " のいずれかで、noteや入れ子のfollowUpは含めないでください。",
  version === 2
    ? "相手の発話に現在の対象への合意と次の対象への移行・提案依頼が含まれる場合は、主actionで先に合意を扱い、followUpで次の対象への提案や確認を扱えます。具体的に次の対象の提案を任されたら、自分の画像と公開対話から対象と候補名を判断し、合意だけで止めずにfollowUpで応じてください。"
    : "相手の発話に現在の対象への合意と次の対象への移行・提案依頼が含まれる場合は、主actionで先に合意を扱い、followUpで次の対象への提案や確認を扱えます。次の提案を求められたら、自分の画像と公開対話から対象と候補名を判断し、合意だけで止めずにfollowUpで応じてください。",
  "主actionの後にfollowUpを適用します。followUpにも同じ対象・候補名・弁別的特徴の制約と同名重複禁止が適用されます。tentativeの同じ対象の言い換えはconfirmやpropose_nameで扱えますが、合意済み名の変更や対象の付け替えにはrepairが必要です。1回の返答に必要な追加判断だけを選び、方略に応じた確認や保留の選択を維持してください。",
  "ownJudgmentHistoryの直前までの対象と名前候補を確認してください。同じ対象について話し続けているときは直前のtargetSlotを維持し、その対象を別の枠と解釈し直す場合はrepairで明示してください。別の対象へ話題が移った場合と混同しないでください。",
  "同じ名前を同時に2つの枠へ記録しないでください。名前を別枠へ移す必要がある場合は、まず元の枠をrepairとcandidateName=nullで明示的に空にし、その後に対象を照合して割り当て直してください。",
  version === 2
    ? "confirmを選ぶのは共通教示の分析トリガーがある場面だけです。相手が迷い・曖昧さ・食い違いを表明したか特徴・詳細を求めた、公開対話の矛盾が未解決、または名前を確定しようとする時点で対象を1つに絞れず誤った合意の実害があるときに検討してください。内部の候補数だけはトリガーではありません。confirmには型の制約としてdiscriminatingFeatureが必要ですが、そのために確認自体や画像にない特徴を作らないでください。トリガーがあるときは、自分の画像で観察できる、問題を解く特徴1つを選び、一度に1特徴ずつ扱ってください。相手の説明の単なる言い換えや、候補同士で違いのない特徴にしないでください。回転しても変わりにくい特徴を自分の画像で確かめてください。"
    : "confirmにはdiscriminatingFeatureが必要です。相手の説明に当てはまりうる自分の候補が複数あるとき、それらを互いに区別する、自分の画像で観察できる特徴を1つ選んでください。相手の説明の単なる言い換えや、候補同士で違いのない特徴にしないでください。回転しても変わりにくい尖りの数・細長さ・くぼみなどを自分の画像で確かめてください。",
  "主判断とfollowUpのdiscriminatingFeatureには、自分の画面の向きに依存する上下左右・右向き・上端・下端などの語を使わないでください。回転しても変わらない、尖りの数や大小・くぼみ・細長さ・四角の有無・部分同士のつながりから、候補を区別する特徴を1つ選んでください。相手の向きを表す語は、自分の同じ向きに固定せず回転を考慮して解釈してください。",
  version === 2
    ? "相手から具体的に次の提案を任された場合や対話の流れに合う場合は、画像から未命名の対象の短い全体の見立てと名前を提案できます。挨拶や漠然とした開始の相談ではacceptで相手に見立てから始めてもらう選択もあり、対象や名前を埋めるためだけにpropose_nameやfollowUpを作らないでください。画像にない特徴・図形を推測で作らないでください。"
    : "相手から名称が出るのを待つだけにせず、画像から未命名の対象の名前を提案できます。画像にない特徴・図形を推測で作らないでください。",
  "同じ質問を繰り返さず、公開応答に合わせて判断を更新してください。どの方略でも、見立ての完全一致と対象の識別を区別してください。",
  "各名称は200文字以内、特徴は400文字以内、メモは1000文字以内。説明文・Markdown・上記以外の追加キーは返さないでください。",
].join("\n");

// v2 only: where each of the AI's own opaque ids lies in its own image (pixels).
// Never a cross-board mapping; absent (no message) in v1.
export function ownAnchorMessage(anchors, ledger) {
  if (anchors === null) return [];
  if (!Array.isArray(anchors) || anchors.length !== Object.keys(ledger).length ||
      !anchors.every((a) => a && Object.hasOwn(ledger, a.id) && a.bbox && a.centroid)) throw new Error("Invalid own anchors");
  const rows = anchors.map(({ id, bbox, centroid }) => ({ id, bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h }, centroid: { x: centroid.x, y: centroid.y } }));
  return [{ role: "system", content: "自分の画像内の各図形の内部参照ID（非公開。画像のピクセル範囲。相手の画面とは無関係で、相手に言わない）:\n" + JSON.stringify(rows) }];
}

/**
 * candidateConflict (v2 only, default off) is a researcher-unapproved opt-in
 * intervention: Luna also returns a private candidate list, kept only in
 * diagnostics, never returned. Conflict-block problems never replace a valid act.
 * A connection failure or timeout of a judge call (AIConnectionError) ends the
 * judge phase with the same fallback as two invalid replies; other errors throw.
 * @returns {import('./schema.mjs').DialogueJudge & {getDiagnostics(): Record<string, unknown>[]}}
 */
export function createLunaJudge(client, { candidateConflict = false, timeBudgetMs = JUDGE_TIME_BUDGET_MS,
  minRetryMs = JUDGE_MIN_RETRY_MS, now = () => Date.now() } = {}) {
  if (!client || typeof client.complete !== "function") throw new Error("A chat client is required");
  if (typeof candidateConflict !== "boolean") throw new Error("Invalid candidate conflict option");
  if (![timeBudgetMs, minRetryMs].every((ms) => Number.isSafeInteger(ms) && ms > 0) || typeof now !== "function") {
    throw new Error("Invalid judge time budget");
  }
  const diagnostics = [];
  return {
    getDiagnostics() { return structuredClone(diagnostics); },
    async judge({ image = null, rotationImage = null, referenceContext = null, publicHistory, strategy, ownLedger, ownJudgmentHistory = [], version = 1, ownAnchors = null }) {
      if (!STRATEGIES.includes(strategy)) throw new Error("Unsupported dialogue strategy");
      if (candidateConflict && version !== 2) throw new Error("Candidate conflict requires version 2");
      const taskInstructions = taskInstructionsFor(version);
      const ledger = validateOwnLedger(ownLedger);
      const previous = ownJudgmentHistory.map(({ action, targetSlot, candidateName = null }) => {
        if (!ACTIONS.includes(action) || !(targetSlot === null || Object.hasOwn(ledger, targetSlot)) ||
            !(candidateName === null || (typeof candidateName === "string" && candidateName.trim().length > 0 && candidateName.length <= 200)) ||
            (targetSlot === null && candidateName !== null)) throw new Error("Invalid own judgment history");
        return { action, targetSlot, candidateName: candidateName?.trim() ?? null };
      });
      const publicTurns = referenceContext?.publicTurns.map(({ turn, speaker, text }) => ({ turn, speaker, text }));
      if (referenceContext) stageMemory(referenceContext.graph, referenceContext.turn, null, publicTurns);
      const messages = [
        { role: "system", content: taskInstructions },
        { role: "system", content: JUDGE_POLICIES[strategy] },
        { role: "system", content: judgeInstructionsFor(version) },
        ...(candidateConflict ? [{ role: "system", content: CANDIDATE_CONFLICT_INSTRUCTIONS }] : []),
        ...(referenceContext ? [{ role: "system", content: MEMORY_INSTRUCTIONS }] : []),
        ...ownImageMessage(image), ...ownRotationMessage(rotationImage),
        ...ownAnchorMessage(ownAnchors, ledger),
        { role: "system", content: "AI自身の作業メモ（公開発話ではない）:\n" + JSON.stringify({ ownLedger: ledger, ownJudgmentHistory: previous }) },
        ...(referenceContext ? [{ role: "system", content: "AI自身の参照メモと公開発話の出典番号（非公開・正解表ではない）:\n" + JSON.stringify({
          ownReferences: JSON.parse(summarizeForJudge(referenceContext.graph)), currentTurn: referenceContext.turn,
          publicTurns: publicTurns.map(({ turn, speaker }) => ({ turn, speaker })),
        }) }] : []),
        ...publicMessages(publicHistory),
      ];
      const failures = [];
      // Opt-in conflict problems never discard a valid act: they are recorded privately.
      const conflictOutcome = (present, raw, judgment) => {
        if (!present) return { conflict: null, conflictError: "invalid_conflict", nonDiscriminating: false };
        try { return { conflict: validateCandidateConflict(raw, { ownIds: Object.keys(ledger), judgment }), conflictError: null, nonDiscriminating: false }; }
        catch (error) {
          const code = error instanceof CandidateConflictError ? error.code : "invalid_conflict";
          return { conflict: null, conflictError: code, nonDiscriminating: code === "non_discriminating_feature" };
        }
      };
      let validCore = null, memoryFailure = false, rawConflict, conflictPresent = false, pending = null;
      // Diagnostics count the upstream calls actually made (a budget skip or a
      // connection failure ends the phase early).
      const started = now();
      let calls = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = timeBudgetMs - (now() - started);
        if (attempt && remaining < minRetryMs) { failures.push("time_budget"); break; }
        let response;
        calls++;
        try {
          response = await client.complete(attempt ? [...messages,
          { role: "system", content: "前回の判断は検証できませんでした。検証理由: " + failures.at(-1) + "。tentativeの同じ対象の言い換えはagree/confirm/propose_nameで新しい名前を指定できます。合意済み名の訂正や対象の付け替えはrepairを使ってください。同名が別枠にある場合は元の枠をrepairとcandidateName=nullで空にしてから再割当してください。" + (failures.at(-1) === "agree_requires_shared_identification" ? version === 2 ? "作業メモでunassignedかdeferredの対象にはまだagreeできません。全体の見立てで理解を示すpropose_nameやaccept、または方略に応じたdefer・move_on・revisitを選んでください。discriminatingFeatureは原則nullで、共通教示の分析トリガーがあるときだけ1特徴を添えるかconfirmを選んでください。" : "作業メモでunassignedかdeferredの対象にはまだagreeできません。識別特徴1つを添えたpropose_name、confirm、accept、または方略に応じたdefer・move_on・revisitを選んでください。" : "") + (candidateConflict ? CONFLICT_RETRY_HINTS[failures.at(-1)] ?? "" : "") + "上記JSON形式と制約を守って再提出してください。" }] : messages,
        { phase: "judgment", timeoutMs: Math.max(1, remaining) });
        } catch (error) {
          if (error?.name !== "AIConnectionError") throw error;
          failures.push("connection_" + (typeof error.code === "string" ? error.code : "error"));
          break;
        }
        // A retry that never produced a reply keeps attempt 1's memory fallback.
        validCore = null; memoryFailure = false; rawConflict = undefined; conflictPresent = false;
        try {
          let parsed = JSON.parse(response.text);
          if (candidateConflict) {
            const split = splitConflict(parsed);
            parsed = split.core; rawConflict = split.conflict; conflictPresent = split.present;
          }
          if (referenceContext) {
            const core = { ...parsed }; delete core.reference;
            validCore = validateJudgment(core, { ownLedger: ledger, agreeEvidence: version === 2 });
          }
          let judgment;
          try {
            judgment = validateJudgment(parsed, { ownLedger: ledger, agreeEvidence: version === 2 });
            if (referenceContext) stageMemory(referenceContext.graph, referenceContext.turn, judgment.reference, publicTurns);
          } catch (error) {
            memoryFailure = Boolean(referenceContext && validCore);
            throw error;
          }
          const outcome = candidateConflict ? conflictOutcome(conflictPresent, rawConflict, judgment) : null;
          // A non-discriminating feature gets one corrective retry; the valid act is kept either way.
          if (outcome?.nonDiscriminating && attempt === 0) {
            pending = { judgment, outcome };
            failures.push(outcome.conflictError);
            continue;
          }
          diagnostics.push({ attempts: attempt + 1, fallback: false, failures, ...(referenceContext ? { memoryFallback: false } : {}), ...(outcome ?? {}) });
          return judgment;
        } catch (error) {
          const code = error instanceof JudgmentValidationError || error instanceof ReferenceGraphError ? error.code : "invalid_json";
          failures.push(memoryFailure ? "memory_" + code : code);
        }
      }
      if (pending) {
        diagnostics.push({ attempts: calls, fallback: false, failures, ...(referenceContext ? { memoryFallback: false } : {}), ...pending.outcome });
        return pending.judgment;
      }
      if (memoryFailure && validCore) {
        diagnostics.push({ attempts: calls, fallback: false, failures, memoryFallback: true,
          ...(candidateConflict ? conflictOutcome(conflictPresent, rawConflict, validCore) : {}) });
        return { ...validCore, reference: null };
      }
      diagnostics.push({ attempts: calls, fallback: true, failures, ...(referenceContext ? { memoryFallback: false } : {}),
        ...(candidateConflict ? { conflict: null, conflictError: null, nonDiscriminating: false } : {}) });
      return { ...SAFE_JUDGMENT, ...(referenceContext ? { reference: null } : {}) };
    },
  };
}
