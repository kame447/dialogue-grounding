import type { LatencySummary } from "./latency.ts";

type Data = Record<string, any>;
type Entry = { label: string; value: Data };
type EventRow = { event: Data; entries: Entry[]; responseTo: number | null; responseMs: number | null };
const obj = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown): Data[] => Array.isArray(value) ? value.filter(obj) : [];
const number = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Turn index is the triggering HUMAN seq, not the AI reply seq or requestSeq.
 * Requests and provider receipts are associated through the recorded attempt identity.
 * Missing/contradictory identities remain unlinked; never join by array position. */
export function buildTurnSheet(r: Data, latency: LatencySummary) {
  const rows: EventRow[] = records(r.events).map(event => ({ event, entries: [], responseTo: null, responseMs: null }));
  const unmatched: Entry[] = [];
  const unique = (items: EventRow[]) => items.length === 1 ? items[0] : undefined;
  const bySeq = (seq: unknown) => number(seq) ? unique(rows.filter(row => row.event.seq === seq)) : undefined;
  const byId = (id: unknown) => typeof id === "string" && id ? unique(rows.filter(row => row.event.id === id)) : undefined;
  const humanFor = (value: Data) => {
    const byTurn = bySeq(value.turnIndex);
    const row = value.lastEventId == null ? byTurn : byId(value.lastEventId);
    if (row?.event.speaker !== "human" || (value.turnIndex != null && byTurn !== row)) return undefined;
    return row;
  };
  const requestRows = new Map<number, Set<EventRow | undefined>>();
  const register = (id: unknown, row: EventRow | undefined) => {
    if (!number(id)) return;
    const set = requestRows.get(id) ?? new Set<EventRow | undefined>();
    set.add(row); requestRows.set(id, set);
  };
  const requestRow = (id: unknown) => {
    const set = number(id) ? requestRows.get(id) : undefined;
    return set?.size === 1 ? [...set][0] : undefined;
  };
  const add = (row: EventRow | undefined, label: string, value: Data) => {
    (row?.entries ?? unmatched).push({ label, value });
  };
  const timings = records(r.turnTimings);
  const sourceEntries = [["judgments", "確定判断"], ["attempts", "実行試行"], ["jevTraces", "Jev処理"], ["groundingShadow", "影判定"]] as const;
  const attemptId = (value: Data) => value.attemptNumber ?? value.jevTurn?.attemptNumber;
  for (const value of timings) register(value.requestSeq, humanFor(value));
  for (const [key] of sourceEntries) for (const value of records(r[key])) register(attemptId(value), humanFor(value));

  // A published reply must be associated with a unique, returned request.
  // Do not move a failed/superseded attempt or a contradictory publication to another utterance.
  const replies = new Map<number, Set<EventRow>>();
  for (const turn of latency.turns) {
    const ai = bySeq(turn.aiSeq), human = requestRow(turn.requestSeq);
    if (ai?.event.speaker !== "ai") continue;
    ai.responseMs = turn.fromTriggerMs;
    if (!human || !number(human.event.seq) || human.event.seq >= ai.event.seq || !number(turn.requestSeq)) continue;
    const traces = records(r.jevTraces).filter(t => attemptId(t) === turn.requestSeq);
    const judgments = records(r.judgments).filter(t => attemptId(t) === turn.requestSeq);
    if (traces.some(t => t.status !== "committed" || typeof t.publicSpeech === "string" && t.publicSpeech !== ai.event.text ||
        number(t.aiPublic?.pending?.aiSeq) && t.aiPublic.pending.aiSeq !== ai.event.seq) ||
        judgments.some(j => j.status !== "committed" || number(j.aiPublic?.aiSeq) && j.aiPublic.aiSeq !== ai.event.seq)) continue;
    const set = replies.get(turn.requestSeq) ?? new Set<EventRow>();
    set.add(ai); replies.set(turn.requestSeq, set);
  }
  const replyFor = (id: unknown) => {
    const set = number(id) ? replies.get(id) : undefined;
    return set?.size === 1 ? [...set][0] : undefined;
  };
  for (const [id] of replies) {
    const ai = replyFor(id), human = requestRow(id);
    if (ai && human) ai.responseTo = human.event.seq;
  }
  for (const value of timings) add(replyFor(value.requestSeq) ?? humanFor(value), "実行時刻", value);
  for (const [key, label] of sourceEntries) {
    for (const value of records(r[key])) {
      const human = humanFor(value), reply = replyFor(attemptId(value));
      if (key === "jevTraces") {
        const { local, humanReferent, aiPublic, ...action } = value;
        const identity = { turnIndex: value.turnIndex, lastEventId: value.lastEventId, attemptNumber: value.attemptNumber, status: value.status };
        add(human, "人間発話の解釈", { ...identity, local, humanReferent });
        // The application recorded during this turn concerns the previous AI utterance.
        const application = aiPublic?.application;
        const previousAi = bySeq(application?.aiSeq);
        if (obj(application) && number(application.aiSeq)) {
          if (value.status !== "committed") add(human, "前のAI発話のメモリ反映試行（未確定）", { ...identity, application });
          else add(previousAi?.event.speaker === "ai" && human && previousAi.event.seq < human.event.seq ? previousAi : undefined,
            "AI発話のメモリ反映", { ...application, appliedAtTurn: human?.event.seq });
        }
        const { application: _previousApplication, ...aiAnalysis } = obj(aiPublic) ? aiPublic : {};
        add(reply ?? human, reply ? "Jev処理" : "AI応答試行（未公開・対応未確定）", { ...action, ...(aiPublic ? { aiPublic: aiAnalysis } : {}) });
      } else if (key === "judgments" || key === "attempts") {
        add(reply ?? human, label, value);
      } else add(human, label, value);
    }
  }
  // The production usage ledger aggregates POSTs by phase and is not a per-turn
  // call list. Only real recorded per-turn evidence is shown here.
  const humanPhases = new Set(["local_extraction", "local_classification", "local", "human_referent"]);
  const callRow = (id: unknown, phase: unknown) => humanPhases.has(String(phase)) ? requestRow(id) : replyFor(id) ?? requestRow(id);
  for (const value of records(r.requests)) add(callRow(value.requestSeq, value.kind), "外部要求", value);
  for (const value of records(r.jevLedger?.sends)) add(callRow(value.turn, value.phase), "API送信記録", value);
  for (const value of records(r.deferredAiExtractionTimings)) {
    const ai = byId(value.eventId);
    add(ai?.event.speaker === "ai" && replyFor(value.requestSeq) === ai ? ai : undefined, "AI発話後の分類時間", value);
  }
  // New records have {status, records}; the old array representation is still readable.
  for (const value of records(Array.isArray(r.aiPublicSettlement) ? r.aiPublicSettlement : r.aiPublicSettlement?.records)) {
    const ai = bySeq(value.aiSeq);
    add(ai?.event.speaker === "ai" && value.status !== "unpublished" &&
      replyFor(value.attemptNumber) === ai && requestRow(value.attemptNumber) === humanFor(value) ? ai : undefined, "AI発話の検証", value);
  }
  if (obj(r.aiPublicSettlement) && r.aiPublicSettlement.status === "error") add(undefined, "AI発話の検証", r.aiPublicSettlement);
  return { rows, unmatched };
}

type Format = { escape: (value: unknown) => string; time: (value: unknown) => string };
const scalar = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
const values = (items: unknown[]) => items.map(scalar).filter(Boolean).join(" / ");
const scoreText = (scores: unknown) => obj(scores) ? Object.entries(scores)
  .filter(([,v]) => typeof v === "number" && Number.isFinite(v))
  .sort((a,b) => b[1] - a[1]).slice(0, 3).map(([k,v]) => k + ": " + Number(v.toFixed(3))).join(" / ") : "";
const targetText = (v: unknown) => obj(v) ? v.kind === "single" ? scalar(v.figureId) : v.kind === "multiple" && Array.isArray(v.figureIds) ? v.figureIds.map(scalar).join(", ") : scalar(v.kind) : scalar(v);

export function renderTurnSheet(record: Data, latency: LatencySummary, {escape, time}: Format): string {
  const { rows, unmatched } = buildTurnSheet(record, latency);
  const line = (label: string, value: unknown) => scalar(value) ? '<div><span class="muted">' + escape(label) + '：</span>' + escape(value) + '</div>' : "";
  const empty = '<span class="muted">—</span>';
  const details = (entries: Entry[]) => entries.map(({label,value}) => '<details class="turn-entry"><summary>' +
    escape([label, number(value.attemptNumber ?? value.requestSeq ?? value.jevTurn?.attemptNumber) ? '#' + (value.attemptNumber ?? value.requestSeq ?? value.jevTurn?.attemptNumber) : "", scalar(value.status ?? value.outcome ?? value.kind ?? value.phase)].filter(Boolean).join(" · ")) +
    '</summary><pre>' + escape(JSON.stringify(value, null, 2)) + '</pre></details>').join("");
  const render = (row: EventRow, index: number) => {
    const e = row.event;
    const traces = row.entries.filter(x => x.label === "Jev処理" || x.label === "AI応答試行（未公開・対応未確定）").map(x => x.value);
    const interpretations = row.entries.filter(x => x.label === "人間発話の解釈").map(x => x.value);
    const aiAnalysis = traces.flatMap(t => obj(t.aiPublic) ? [t.aiPublic] : []);
    const applications = row.entries.filter(x => x.label === "AI発話のメモリ反映" || x.label === "AI発話の検証").map(x => x.value);
    const postTimings = row.entries.filter(x => x.label === "AI発話後の分類時間").map(x => x.value);
    const judgments = row.entries.filter(x => x.label === "確定判断").map(x => x.value);
    const attempts = row.entries.filter(x => x.label === "実行試行").map(x => x.value)
      .filter(a => !traces.some(t => number(t.attemptNumber) && t.attemptNumber === a.attemptNumber));
    const shadows = row.entries.filter(x => x.label === "影判定").map(x => x.value);
    const humanCandidate = interpretations.map(t => line("試行", t.attemptNumber) +
      line("人間の参照先（上位3・未校正）", scoreText(t.humanReferent?.scores) || t.humanReferent?.status)).join("");
    const candidate = humanCandidate || traces.map(t => {
      const d = records(t.decisions).at(-1);
      return line("試行", t.attemptNumber) +
        line("選択対象", targetText(d?.target)) + line("実行対象", targetText(t.executed?.target ?? t.finalAction?.targetSlot)) +
        line("再観察", Array.isArray(t.reobservations) ? t.reobservations.length + "回" : "");
    }).join("") || judgments.map(j => line("対象", targetText(j.jevTurn?.executed?.target ?? j.jevTurn?.decision?.target ?? j.judgment?.targetSlot))).join("") ||
      attempts.map(a => line("試行対象", a.judgment?.targetSlot)).join("");
    const humanClassification = interpretations.map(t => {
      const local = t.local;
      const segments = records(local?.extractor?.segments);
      return line("発話分類", local?.classifier?.status ?? local?.localStatus) + records(local?.classifier?.verdicts).map(v => {
        const segment = segments.find(s => s.segmentId === v.segmentId);
        return line("機能", values([segment?.quote, v.act, segment?.aspect]));
      }).join("");
    }).join("");
    const aiClassification = aiAnalysis.map(a => {
      const pending = a.pending;
      const stage = a.stages?.ai_function;
      return line("公開発話の分類", pending?.status ?? (stage?.status === "not_called" ? "未実行" : stage?.status)) +
        records(stage?.choices).map(v => line("機能", values([v.segmentId, v.act]))).join("") +
        records(pending?.candidates).map(v => line("公開発話の論点", values([v.quote, v.act, v.aspect]))).join("");
    }).join("");
    const decision = (traces.map(t => {
      const publication = t.generatedPublication;
      const finalIntervention = publication?.recovery?.intervention ?? t.intervention;
      const handling = finalIntervention?.schemaVersion === "jev_intervention_v2" ? finalIntervention.handling : null;
      const executed = handling && publication?.continuation ? null : publication?.recovery?.executed ?? t.executed;
      const purpose = executed?.visualPurpose;
      const features = records(publication?.visualFeatures?.sources);
      const issue = executed?.issue;
      const destination = executed?.destination;
      const close = publication?.close;
      const extraRows = handling ? records(finalIntervention.extras) : [];
      return '<div class="turn-block">' + (e.speaker === "human" ? line("AI応答試行", t.status) : "") + line("試行", t.attemptNumber) + line("選択", values(records(t.decisions).map(d => d.action))) +
        line("方略介入", values([t.intervention?.disposition, t.intervention?.reasonCode])) +
        (handling ? line("論点の扱い", values([handling.class, handling.via, handling.initiator])) +
          line("採否の根拠", values([finalIntervention.disposition, finalIntervention.reasonCode, handling.anchor?.kind,
            handling.anchor?.turn ?? handling.anchor?.sourceTurn])) +
          line("判断の表明の状況", handling.commitmentState) +
          line("仮定の代替", handling.alternative) +
          line("実行した論点", values([issue?.kind, issue?.sourceTurn])) +
          line("移る先", values([destination?.kind, destination?.figureId, destination?.issue?.kind, destination?.issue?.sourceTurn])) : "") +
        (close ? line("終了の相談", values([close.initiator, close.unresolved ? "未解決あり" : "未解決なし"])) : "") +
        extraRows.map(extra => line("追加の扱い", values([extra.original?.action, targetText(extra.original?.target), extra.reasonCode,
          extra.executed?.action, extra.original?.issue?.sourceTurn ?? extra.original?.visualPurpose?.sourceTurn]))).join("") +
        (t.status === "committed" ? records(publication?.parts).map(part => line("公開文の範囲", values([part.item, part.start, part.end]))).join("") : "") +
        line("実行", handling ? t.finalAction?.action : t.executed?.action ?? t.finalAction?.action) + line("実行名", t.executed ? t.executed.name : t.finalAction ? t.finalAction.candidateName : null) +
        line("実行特徴", t.executed ? t.executed.feature : t.finalAction ? t.finalAction.discriminatingFeature : null) +
        line("判断の目的", values([purpose?.kind, purpose?.sourceTurn ? "発話 " + purpose.sourceTurn : null])) +
        (t.status === "committed" ? features.map(feature => line("公開した特徴・観察の出所",
          values([feature.quote, feature.source?.figureId, Array.isArray(feature.source?.path) ? feature.source.path.join(" / ") : null]))).join("") : "") +
        line("修復見込み", values([t.repairProspect?.prospect, t.repairProspect?.basis])) + '</div>';
    }).join("") || judgments.map(j => line("確定行動", j.judgment?.action) + line("名前", j.judgment?.candidateName) + line("特徴", j.judgment?.discriminatingFeature) + line("判断メモ", j.judgment?.note)).join("") ||
      attempts.map(a => line("試行判断", a.judgment?.action)).join("")) + aiClassification;
    const humanExecution = interpretations.map(t => line("局所処理", values([t.local?.localStatus,t.local?.classifier?.status])) +
      line("採用・棄却", t.local?.verification ? values([Array.isArray(t.local.verification.accepted) ? "採用 " + t.local.verification.accepted.length : "", Array.isArray(t.local.verification.rejected) ? "棄却 " + t.local.verification.rejected.length : ""]) : "")).join("");
    const execution = [...traces, ...attempts].map(t => {
      const errors = [t.errorCode,t.errorPhase,t.observationErrorCode,t.decisionRejectionCode,t.generationErrorCode,
        ...(Array.isArray(t.generationGuard?.violations) ? t.generationGuard.violations : []),
        ...(Array.isArray(t.validation?.failures) ? t.validation.failures : [])].map(scalar).filter(Boolean);
      return '<div class="turn-block">' + line("結果", values([t.attemptNumber, t.status])) + line("判断差分", values([t.activeJudge?.lunaAction,t.activeJudge?.finalAction])) +
        line("局所処理", values([t.local?.localStatus, t.local?.classifier?.status])) +
        line("採用・棄却", t.local?.verification ? values([Array.isArray(t.local.verification.accepted) ? "採用 " + t.local.verification.accepted.length : "", Array.isArray(t.local.verification.rejected) ? "棄却 " + t.local.verification.rejected.length : ""]) : "") +
        line("メモリ", t.memory ? values([typeof t.memory.opsApplied === "number" ? "更新 " + t.memory.opsApplied : "", Array.isArray(t.memory.rejected) ? t.memory.rejected.join(", ") : t.memory.rejected]) : "") +
        (errors.length ? '<div class="bad">' + escape([...new Set(errors)].join(", ")) + '</div>' : "") +
        line("再生成・代替", values([t.generationRetried || t.generationGuard?.regenerated ? "再生成" : "", t.generationGuard?.fallback ? "代替" : ""])) + '</div>';
    }).join("") + shadows.map(g => line("影判定（未校正）", values([g.status,g.identification?.level,g.nameAgreement?.level,g.error]))).join("");
    const callLine = (phase: string, v: Data) => '<div>' + escape(values([phase, v.status, v.model, typeof v.latencyMs === "number" ? Math.round(v.latencyMs) + " ms" : "", v.error ?? v.errorCode])) + '</div>';
    const recordedJevCalls = interpretations.map(t => {
      const h = t.humanReferent, c = t.local?.classifier;
      return (obj(h) ? callLine("Jev・参照先推定", h) : "") + (obj(c) && c.kind === "jev_local_test" && c.status !== "not_called" ? callLine("Jev・人間発話分類", c) : "");
    }).join("") + traces.map(t => records(t.decisions).map(d => {
      const evidence = d.evidence;
      if (!obj(evidence)) return "";
      const stages = records(evidence.stages);
      return stages.length ? stages.map(v => callLine("Jev・" + scalar(v.stage), v)).join("") : callLine("Jev・判断", evidence);
    }).join("") + records(t.decisionFailure?.evidence?.stages).map(v => callLine("Jev・" + scalar(v.stage), v)).join("") +
      records(t.draftActs).map(v => callLine("Jev・発話案分類", v)).join("") +
      records(t.draftSharedClaims).map(v => callLine("Jev・発話案検証", v)).join("")).join("") +
      aiAnalysis.map(a => ["ai_function", "ai_support"].map(phase => {
        const stage = a.stages?.[phase];
        return obj(stage) && (stage.calls > 0 || stage.status === "error") ? callLine("Jev・" + phase, stage) : "";
      }).join("")).join("");
    const postStatus = postTimings.map(v => line("発話後の分類", v.status) +
      line("分類時間", typeof v.startedAtMs === "number" && typeof v.finishedAtMs === "number" ? Math.round(v.finishedAtMs-v.startedAtMs) + " ms" : "")).join("");
    const applicationStatus = applications.map(v => line("AI発話の検証・反映", values([v.status, v.sourceStatus, v.appliedAtTurn]))).join("");
    const calls = row.entries.filter(x => x.label === "外部要求" || x.label === "API送信記録").map(({value:v}) =>
      '<div>' + escape(values([v.kind ?? v.phase, v.status, v.model, typeof v.latencyMs === "number" ? Math.round(v.latencyMs) + " ms" : "", v.errorCode])) + '</div>').join("");
    const timing = row.entries.filter(x => x.label === "実行時刻").map(({value:v}) => line("要求", values([v.requestSeq, v.outcome,
      typeof v.startedAtMs === "number" && typeof v.endedAtMs === "number" ? Math.round(v.endedAtMs-v.startedAtMs) + " ms" : "", v.errorCode])) + line("入力発話", Array.isArray(v.pendingEventIds) ? v.pendingEventIds.map((id:unknown) => rows.find(r => r.event.id === id && r.event.speaker === "human")?.event.seq).filter(number).join(", ") : "")).join("");
    const link = row.responseTo === null ? "" : '<a href="#utterance-' + row.responseTo + '">入力：発話 ' + row.responseTo + '</a>';
    const id = number(e.seq) && rows.filter(r => r.event.seq === e.seq).length === 1 ? ' id="utterance-' + e.seq + '"' : "";
    const detailId = "turn-detail-" + index;
    const detailPanel = row.entries.length ? '<button type="button" class="turn-open" popovertarget="' + detailId + '">詳細 (' + row.entries.length + ')</button>' +
      '<div popover="auto" id="' + detailId + '" class="turn-popover"><div class="turn-popover-head"><h3>発話 ' + escape(e.seq) +
      ' の処理記録</h3><button type="button" popovertarget="' + detailId + '" popovertargetaction="hide">閉じる</button></div>' +
      '<p class="utterance">' + escape(e.text) + '</p>' + details(row.entries) + '</div>' : empty;
    return '<tr' + id + '><td class="seq">' + escape(e.seq) + '</td><td class="speaker">' +
      escape(e.speaker === "human" ? "人間" : e.speaker === "ai" ? "AI" : e.speaker) + '</td><td class="when">' + time(e.at) + '</td><td class="utterance">' +
      escape(e.text) + (e.origin ? line("由来", e.origin) : "") + '</td><td>' + (candidate || empty) + '</td><td>' + (humanClassification + decision || empty) +
      '</td><td>' + (humanExecution + execution + postStatus + applicationStatus + link || empty) + (row.responseMs === null ? "" : line("応答", Math.round(row.responseMs) + " ms")) +
      '</td><td>' + (timing + calls + recordedJevCalls || empty) + '</td><td>' + detailPanel + '</td></tr>';
  };
  if (!rows.length && !unmatched.length) return '<p class="muted">なし</p>';
  return (rows.length ? '<div class="turn-sheet"><table><thead><tr>' + ["No.", "話者", "時刻（JST）", "公開発話", "参照先・再観察", "発話分類・判断・方略", "処理結果・検証", "モデル呼び出し・時間", "保存された詳細"].map(h => '<th scope="col">' + escape(h) + '</th>').join("") +
    '</tr></thead><tbody>' + rows.map(render).join("") + '</tbody></table></div>' : "") +
    (unmatched.length ? '<details class="turn-detail unlinked"><summary>発話に対応づけられない処理・セッション共通処理（' + unmatched.length + '件）</summary>' + details(unmatched) + '</details>' : "");
}
