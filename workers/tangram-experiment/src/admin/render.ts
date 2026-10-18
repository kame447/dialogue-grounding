// Researcher-only admin pages, rendered on the server without any script.
// Every value from a record is escaped; unknown nested values are shown as
// escaped JSON, so new record fields cannot break the page or inject markup.
import type { AdminSummary } from "./summary";
import type { LatencySummary } from "./latency";
import type { AuditEntry } from "./index-store";

export const ADMIN_CSS = `:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;font-size:14px;color:#222;background:#f7f7f4}
body{margin:0;padding:16px 24px 48px}h1{font-size:1.2rem}h2{font-size:1rem;margin-top:28px}
table{border-collapse:collapse;width:100%;background:#fff;font-size:.82rem}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#eee}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:.78rem}.bad{color:#9b2c1f;font-weight:600}.muted{color:#777}
form{margin:12px 0}label{margin-right:12px}a{color:#2a5d8f}.wrap{overflow-x:auto}`;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export function escapeHtml(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char]);
}
const json = (value: unknown) => `<pre>${escapeHtml(value === undefined ? "" : JSON.stringify(value, null, 1))}</pre>`;
const cell = (value: unknown) => `<td>${typeof value === "object" && value !== null ? json(value) : escapeHtml(value)}</td>`;
const row = (values: unknown[]) => `<tr>${values.map(cell).join("")}</tr>`;
const head = (names: string[]) => `<tr>${names.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr>`;
const table = (names: string[], rows: unknown[][]) => rows.length
  ? `<div class="wrap"><table>${head(names)}${rows.map(row).join("")}</table></div>` : `<p class="muted">なし</p>`;
const isPlain = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/admin/style.css"></head>
<body>${body}</body></html>`;
}

export type ListFilter = { status: string; error: "any" | "with" | "without"; memory: "any" | "on" | "off" };
export const STATUS_FILTERS = ["any", "dialogue", "submitting", "completed"] as const;

/** Unknown filter values fall back to "any"; the filter never reaches storage queries. */
export function parseFilter(params: URLSearchParams): ListFilter {
  const status = params.get("status") ?? "any";
  const error = params.get("error");
  const memory = params.get("memory");
  return { status: (STATUS_FILTERS as readonly string[]).includes(status) ? status : "any",
    error: error === "with" || error === "without" ? error : "any", memory: memory === "on" || memory === "off" ? memory : "any" };
}

export function applyFilter(summaries: AdminSummary[], filter: ListFilter): AdminSummary[] {
  return summaries.filter((s) => (filter.status === "any" || s.status === filter.status) &&
    (filter.error === "any" || (filter.error === "with") === s.errorCodes.length > 0) &&
    (filter.memory === "any" || (filter.memory === "on") === s.referenceMemory));
}

const option = (value: string, current: string, label = value) =>
  `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
const ms = (value: number | null | undefined) => typeof value === "number" ? `${Math.round(value)}` : "—";

export function renderList(summaries: AdminSummary[], filter: ListFilter, next: string | null, audit: AuditEntry[],
  retentionDays: number, deleted = false): string {
  const query = (extra: Record<string, string>) => "?" + new URLSearchParams({ status: filter.status, error: filter.error, memory: filter.memory, ...extra });
  const rows = summaries.map((s) => `<tr><td><a href="/admin/record/${escapeHtml(s.recordId)}">${escapeHtml(s.recordId.slice(0, 8))}</a></td>
<td>${escapeHtml(s.updatedAt)}</td><td>${escapeHtml(s.strategy)}</td><td>${s.referenceMemory ? "ON" : "OFF"}</td><td>${escapeHtml(s.utteranceStyle)}</td>
<td>${escapeHtml(s.status)}</td><td${s.aiStatus === "error" ? ' class="bad"' : ""}>${escapeHtml(s.aiStatus)}</td>
<td>${s.counts.humanMessages}/${s.counts.aiMessages}</td><td>${s.counts.committedTurns}/${s.counts.attempts}</td><td>${s.counts.requestErrors}</td>
<td${s.errorCodes.length ? ' class="bad"' : ""}>${escapeHtml(s.errorCodes.join(", "))}</td>
<td>${ms(s.latency.turn.p50Ms)} / ${ms(s.latency.turn.p95Ms)}</td><td>${escapeHtml(s.latency.slowestPhase?.phase ?? "")}</td></tr>`).join("");
  return page("実験ログ（研究者用）", `<h1>実験ログ（研究者用・読み取り専用）</h1>
<form method="get" action="/admin"><label>状態 <select name="status">${STATUS_FILTERS.map((v) => option(v, filter.status)).join("")}</select></label>
<label>エラー <select name="error">${option("any", filter.error, "すべて")}${option("with", filter.error, "あり")}${option("without", filter.error, "なし")}</select></label>
<label>参照メモリ <select name="memory">${option("any", filter.memory, "すべて")}${option("on", filter.memory, "ON")}${option("off", filter.memory, "OFF")}</select></label>
<button>絞り込み</button></form>
${deleted ? `<p class="bad">記録を削除しました。</p>` : ""}
<p class="muted">試行ごとの一覧（同じブラウザの過去の試行も含む）。更新が新しい順に ${PAGE_LIMIT_NOTE}。絞り込みはこのページ内に適用します。記録は最終更新から ${retentionDays} 日後に自動削除されます。</p>
${summaries.length ? `<div class="wrap"><table>${head(["記録", "更新", "方略", "メモリ", "発話様式", "状態", "AI", "人/AI発話", "確定/試行", "要求エラー", "エラーコード", "応答 p50/p95 ms", "最遅段階"])}${rows}</table></div>` : `<p class="muted">該当なし</p>`}
${next ? `<p><a href="/admin${escapeHtml(query({ after: next }))}">次のページ →</a></p>` : ""}
<h2>削除の記録（内容なし）</h2>${table(["削除日時", "理由", "記録IDのハッシュ"], audit.map((a) => [a.deletedAt, a.reason, a.recordHash]))}`);
}
const PAGE_LIMIT_NOTE = "1ページ100件";

function latencySection(latency: LatencySummary): string {
  const phases = Object.entries(latency.byPhase).map(([phase, p]) => [phase, p.count, p.errors, ms(p.p50Ms), ms(p.p90Ms), ms(p.p95Ms), ms(p.maxMs), ms(p.totalMs)]);
  const turns = latency.turns.map((t) => [t.aiSeq, t.requestSeq, ms(t.fromTriggerMs), ms(t.fromFirstPendingMs), ms(t.runMs),
    t.calls.map((c) => `${c.phase} ${Math.round(c.latencyMs)}ms ${c.status}${c.errorCode ? " " + c.errorCode : ""}`).join("\n"),
    t.judgeRetries, t.validationFailures.join(", "), [t.judgeFallback && "judge_fallback", t.guardRegenerated && "guard_regenerated",
      t.guardFallback && "guard_fallback"].filter(Boolean).join(", "), t.supersededBefore]);
  return `<h2>遅延</h2><p>要求 ${latency.requests}・エラー ${latency.errors}・タイムアウト ${latency.timeouts}・応答 p50 ${ms(latency.turn.p50Ms)} ms / p95 ${ms(latency.turn.p95Ms)} ms（${latency.turn.count} 回）・最初の未応答から p50 ${ms(latency.firstPending.p50Ms)} ms</p>
${table(["段階", "回数", "エラー", "p50", "p90", "p95", "max", "合計 ms"], phases)}
${latency.turns.length ? `<h2>ターン別の遅延</h2>${table(["AI seq", "要求 seq", "最新の発話から ms", "最初の未応答から ms", "実行 ms", "呼び出し", "判断再試行", "検証失敗", "代替・書き直し", "直前の中断"], turns)}` : ""}`;
}

/** Full researcher view of one stored record: public events, judged acts, traces, requests and scoring. */
export function renderDetail(record: unknown, summary: AdminSummary, latency: LatencySummary, retentionDays: number): string {
  const r = isPlain(record) ? record : {};
  const events = list(r.events).filter(isPlain).map((e) => [e.seq, e.speaker, e.at, e.origin ?? "", e.text]);
  const judgments = list(r.judgments).filter(isPlain).map((j) => [j.turnIndex, j.judgment?.action, j.judgment?.targetSlot,
    j.judgment?.candidateName, j.judgment?.discriminatingFeature, j.judgment?.followUp ?? null, j.activeJudge ?? null]);
  // errorCode/errorPhase/errorStatus/errorElapsedMs and generationRetried are written by the v2 turn on failure.
  const attempts = list(r.attempts).filter(isPlain).map((a) => [a.turnIndex, a.status,
    a.errorCode ? [a.errorCode, a.errorPhase, a.errorStatus === null || a.errorStatus === undefined ? "" : "HTTP " + a.errorStatus,
      a.errorElapsedMs === undefined ? "" : ms(a.errorElapsedMs) + " ms"].filter((part) => part !== "" && part !== undefined).join(" / ") : "",
    a.generationRetried === true ? "あり" : "", a.validation ?? null, a.memory ?? null,
    a.generationGuard ?? null, a.activeJudge ?? null, a.decisionShadow ?? null, a.utteranceStyle ?? null]);
  const requests = list(r.requests).filter(isPlain).map((q, i) => [i + 1, q.kind, q.status, q.httpStatus ?? "", q.errorCode ?? "",
    ms(q.latencyMs), q.retryCount ?? "", q.model ?? ""]);
  return page(`記録 ${summary.recordId.slice(0, 8)}`, `<p><a href="/admin">← 一覧</a></p>
<h1>記録 ${escapeHtml(summary.recordId)}</h1>
${table(["項目", "値"], [["Durable Object", summary.objectId], ["開始", summary.startedAt], ["更新", summary.updatedAt], ["方略", summary.strategy],
  ["参照メモリ", summary.referenceMemory ? "ON" : "OFF"], ["発話様式", summary.utteranceStyle], ["状態", summary.status], ["AI", summary.aiStatus],
  ["キュー", r.queueState ? { errorCode: r.queueState.errorCode ?? null, pending: list(r.queueState.pendingHumanEventIds).length, closed: r.queueState.closed ?? false } : null],
  ["最終エラー", r.finalError ?? null], ["エラーコード", summary.errorCodes.join(", ")], ["件数", summary.counts]])}
${latencySection(latency)}
<h2>公開発話</h2>${table(["seq", "話者", "時刻", "由来", "本文"], events)}
<h2>確定した判断（ターンごと）</h2>${table(["ターン", "行為", "対象", "名前", "弁別特徴", "followUp", "active 判断"], judgments)}
<h2>実行の記録（中断・失敗を含む）</h2>${table(["ターン", "状態", "エラー（コード / 段階 / HTTP / 経過）", "生成の再試行", "検証", "参照メモリ", "生成ガード", "active 判断", "影の判断", "発話様式"], attempts)}
<h2>外部要求</h2>${table(["#", "段階", "結果", "HTTP", "コード", "ms", "再送", "モデル"], requests)}
<h2>提出と採点</h2>${table(["項目", "値"], [["人間の提出", r.humanSubmission ?? null], ["AIの提出", r.aiSubmission ?? null],
  ["診断", r.diagnostics ?? null], ["採点", r.scoring ?? null]])}
<h2>削除</h2><p class="muted">この記録は最終更新から ${retentionDays} 日後に自動削除されます。今すぐ削除する場合は、記録IDを確認欄に入力してください。削除は取り消せません。</p>
<form method="post" action="/admin/record/${escapeHtml(summary.recordId)}/delete"><label>確認（記録ID） <input name="confirm" autocomplete="off" required></label>
<button>この記録を削除</button></form>`);
}

export function renderMessage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/admin">一覧へ</a></p>`);
}
