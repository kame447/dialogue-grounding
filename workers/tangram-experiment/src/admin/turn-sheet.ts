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
  for (const value of records(r.turnTimings)) {
    const row = humanFor(value);
    register(value.requestSeq, row);
    add(row, "実行時刻", value);
  }
  for (const [key, label] of [["judgments", "確定判断"], ["attempts", "実行試行"], ["jevTraces", "Jev処理"], ["groundingShadow", "影判定"], ["aiPublicSettlement", "AI発話の検証"]] as const) {
    for (const value of records(r[key])) {
      const row = humanFor(value);
      register(value.attemptNumber ?? value.jevTurn?.attemptNumber, row);
      add(row, label, value);
    }
  }
  for (const value of records(r.requests)) add(requestRow(value.requestSeq), "外部要求", value);
  for (const value of records(r.jevLedger?.sends)) add(requestRow(value.turn), "API送信記録", value);
  for (const turn of latency.turns) {
    const ai = bySeq(turn.aiSeq), human = requestRow(turn.requestSeq);
    if (ai?.event.speaker !== "ai") continue;
    ai.responseMs = turn.fromTriggerMs;
    if (human && number(human.event.seq) && human.event.seq < ai.event.seq) ai.responseTo = human.event.seq;
  }
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
    const traces = row.entries.filter(x => x.label === "Jev処理").map(x => x.value);
    const judgments = row.entries.filter(x => x.label === "確定判断").map(x => x.value);
    const attempts = row.entries.filter(x => x.label === "実行試行").map(x => x.value)
      .filter(a => !traces.some(t => number(t.attemptNumber) && t.attemptNumber === a.attemptNumber));
    const shadows = row.entries.filter(x => x.label === "影判定").map(x => x.value);
    const candidate = traces.map(t => {
      const h = t.humanReferent, d = records(t.decisions).at(-1);
      return line("試行", t.attemptNumber) + line("人間の参照先（上位3・未校正）", scoreText(h?.scores) || h?.status) +
        line("選択対象", targetText(d?.target)) + line("実行対象", targetText(t.executed?.target ?? t.finalAction?.targetSlot)) +
        line("再観察", Array.isArray(t.reobservations) ? t.reobservations.length + "回" : "");
    }).join("") || judgments.map(j => line("対象", targetText(j.jevTurn?.executed?.target ?? j.jevTurn?.decision?.target ?? j.judgment?.targetSlot))).join("") ||
      attempts.map(a => line("試行対象", a.judgment?.targetSlot)).join("");
    const decision = traces.map(t => {
      return '<div class="turn-block">' + line("試行", t.attemptNumber) + line("選択", values(records(t.decisions).map(d => d.action))) +
        line("方略介入", values([t.intervention?.disposition, t.intervention?.reasonCode])) +
        line("実行", t.executed?.action ?? t.finalAction?.action) + line("実行名", t.executed ? t.executed.name : t.finalAction ? t.finalAction.candidateName : null) +
        line("実行特徴", t.executed ? t.executed.feature : t.finalAction ? t.finalAction.discriminatingFeature : null) +
        line("修復見込み", values([t.repairProspect?.prospect, t.repairProspect?.basis])) + '</div>';
    }).join("") || judgments.map(j => line("確定行動", j.judgment?.action) + line("名前", j.judgment?.candidateName) + line("特徴", j.judgment?.discriminatingFeature) + line("判断メモ", j.judgment?.note)).join("") ||
      attempts.map(a => line("試行判断", a.judgment?.action)).join("");
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
    const calls = row.entries.filter(x => x.label === "外部要求" || x.label === "API送信記録").map(({value:v}) =>
      '<div>' + escape(values([v.kind ?? v.phase, v.status, v.model, typeof v.latencyMs === "number" ? Math.round(v.latencyMs) + " ms" : "", v.errorCode])) + '</div>').join("");
    const timing = row.entries.filter(x => x.label === "実行時刻").map(({value:v}) => line("要求", values([v.requestSeq, v.outcome,
      typeof v.startedAtMs === "number" && typeof v.endedAtMs === "number" ? Math.round(v.endedAtMs-v.startedAtMs) + " ms" : "", v.errorCode])) + line("入力発話", Array.isArray(v.pendingEventIds) ? v.pendingEventIds.map((id:unknown) => rows.find(r => r.event.id === id && r.event.speaker === "human")?.event.seq).filter(number).join(", ") : "")).join("");
    const link = row.responseTo === null ? "" : '<a href="#utterance-' + row.responseTo + '">発話 ' + row.responseTo + ' の処理</a>';
    const id = number(e.seq) && rows.filter(r => r.event.seq === e.seq).length === 1 ? ' id="utterance-' + e.seq + '"' : "";
    const detailId = "turn-detail-" + index;
    const detailPanel = row.entries.length ? '<button type="button" class="turn-open" popovertarget="' + detailId + '">詳細 (' + row.entries.length + ')</button>' +
      '<div popover="auto" id="' + detailId + '" class="turn-popover"><div class="turn-popover-head"><h3>発話 ' + escape(e.seq) +
      ' の処理記録</h3><button type="button" popovertarget="' + detailId + '" popovertargetaction="hide">閉じる</button></div>' +
      '<p class="utterance">' + escape(e.text) + '</p>' + details(row.entries) + '</div>' : empty;
    return '<tr' + id + '><td class="seq">' + escape(e.seq) + '</td><td class="speaker">' +
      escape(e.speaker === "human" ? "人間" : e.speaker === "ai" ? "AI" : e.speaker) + '</td><td class="when">' + time(e.at) + '</td><td class="utterance">' +
      escape(e.text) + (e.origin ? line("由来", e.origin) : "") + '</td><td>' + (candidate || empty) + '</td><td>' + (decision || empty) +
      '</td><td>' + (execution || link || empty) + (row.responseMs === null ? "" : line("応答", Math.round(row.responseMs) + " ms")) +
      '</td><td>' + (timing + calls || empty) + '</td><td>' + detailPanel + '</td></tr>';
  };
  if (!rows.length && !unmatched.length) return '<p class="muted">なし</p>';
  return (rows.length ? '<div class="turn-sheet"><table><thead><tr>' + ["No.", "話者", "時刻（JST）", "公開発話", "参照先・再観察", "判断・方略", "処理結果・検証", "モデル呼び出し・時間", "保存された詳細"].map(h => '<th scope="col">' + escape(h) + '</th>').join("") +
    '</tr></thead><tbody>' + rows.map(render).join("") + '</tbody></table></div>' : "") +
    (unmatched.length ? '<details class="turn-detail unlinked"><summary>発話に対応づけられない処理・セッション共通処理（' + unmatched.length + '件）</summary>' + details(unmatched) + '</details>' : "");
}
