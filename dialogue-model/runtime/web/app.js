const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
let current = null;
let startReady = false;
let reception = null;
let working = false;
let serverBusy = false;
let refreshTimer;
let refreshRequest = null;
let generation = 0;
let stateEpoch = 0;
let sceneSignature = "";
let answers = new Map();
let selected = null;
let selectedTarget = null;
let pending = [];
let sending = false;
let legacyMessages = false;
let followHistory = true;
// Messages (public + local) the reader has seen at the bottom of the log.
let seenMessages = 0;
let preparing = false;
let localStage = "chat";
// After the names are submitted the participant may revisit every stage.
// null follows the default order: names (waiting) -> questionnaire -> results.
let reviewStage = null;
let messageSequence = 0;
let typingTimer;
let openingStart = null;
let openingDisplay = null;
let activitySignature = "";
let activitySince = 0;
let chatStalled = false;
let chatDisconnected = false;
let checking = false;
let showingIncompleteTrial = false;
// An explicit resume of stopped server work is in flight (shown as activity).
let resuming = false;
// Progress at the moment a failed operation put STOPPED in the top notice; the
// notice stays until the server confirms that progress has changed.
let operationStop = null;
let submissionWarning = "";
let restoreComposerOnChange = false;
// Tab-isolated sessions (tab-session.js + /api/sessions). null without that
// script or before a session is chosen; then the single cookie session is used.
let activeTabSessionId = null;
let pendingEmptySessionId = null;
let sessionsReceptionMode = null;
let confirmSnapshot = null;
const tabSession = () => globalThis.TangramTabSession ?? null;
// Without tab-session.js (or on a server without /api/sessions) the single
// cookie session is used and nothing below changes its behavior.
let cookieMode = !globalThis.TangramTabSession;
// The entry screen has no session: it must never read the cookie session's state.
const entryMode = () => !cookieMode && !activeTabSessionId && !reviewing;
// An earlier trial opened from the entry screen belongs to its own session.
const requestSession = () => reviewing?.sessionId ?? activeTabSessionId;
const sessionHeaders = (sessionId) => sessionId ? { "X-Tab-Session": sessionId } : {};
// Presentation/network safeguards only; these never close a research trial or
// cancel backend generation. A stalled state is refreshed, never auto-retried.
const CHAT_STALL_MS = 60000;
const MESSAGE_ACK_MS = 20000;
const STATE_REFRESH_MS = 10000;
const OPENING_DISPLAY_MS = 1000;
const newClientId = () => globalThis.crypto?.randomUUID?.() ??
  `chat-${Date.now().toString(36)}-${++messageSequence}-${Math.random().toString(36).slice(2, 12)}`;
const draftKey = "joint-naming-v2-draft";
const trialIdentity = (trial) => trial?.sessionId ?? trial?.trialId;
// UI drafts stay in this browser tab, never in API requests or research records.
function storeDraft() {
  // An earlier trial opened for review never touches the active trial's draft.
  if (!trialIdentity(current) || reviewing) return;
  try { sessionStorage.setItem(draftKey, JSON.stringify({ trial: trialIdentity(current), stage: localStage, review: reviewStage, answers: [...answers] })); } catch { /* Storage may be disabled. */ }
}
function clearDraft() {
  if (reviewing) return;
  try { sessionStorage.removeItem(draftKey); } catch { /* Storage may be disabled. */ }
}
function restoreDraft(trial, composer = "") {
  if (reviewing) return;
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    if (!draft || draft.trial !== trialIdentity(trial)) { clearDraft(); return; }
    const ids = new Set((trial.scene ?? trial.humanScene)?.shapes?.map((shape) => shape.id));
    answers = new Map((Array.isArray(draft.answers) ? draft.answers : []).filter((entry) => Array.isArray(entry) && ids.has(entry[0]) &&
      (entry[1] === null || (typeof entry[1] === "string" && entry[1].trim() && entry[1].length <= 200))));
    localStage = draft.stage === "names" ? "names" : "chat";
    reviewStage = STAGES.includes(draft.review) ? draft.review : null;
  } catch { /* Ignore unavailable or invalid browser drafts. */ }
  finally { if (composer) $("utterance").value = composer; }
}
const defaultContact = "実験の案内に記載された連絡先へお問い合わせください。";
const contact = document.querySelector?.('meta[name="participant-contact"]')?.content || defaultContact;
// Participant copy for neutral or participant-actionable outcomes only. Any
// other failure (AI, scoring, records, transport, an unreadable response or an
// unknown code) is shown as STOPPED; its cause stays in error.code and the
// server's private records, never on the page.
const STOPPED = "進行を確認できません。実験担当者にお知らせください。";
const errors = {
  trial_unavailable: "試行を開始できませんでした。" + contact,
  reception_not_approved: "この画面を開いたまま、開始の案内があるまでお待ちください。",
  protocol_unconfigured: "この画面を開いたまま、開始の案内があるまでお待ちください。",
  reception_conflict: "画面が更新されたため、直前の操作を完了できませんでした。現在の表示を確認し、必要ならもう一度操作してください。",
  reception_unavailable: "受付を確認できませんでした。" + contact,
  reception_finished: "すべての課題が完了しました。ご協力ありがとうございました。",
  reception_required: "受付を確認できませんでした。" + contact,
  questionnaire_required: "アンケートを提出すると、次の課題を開始できます。",
  busy: "処理中です。完了までお待ちください。",
  rate_limited: "短時間に送信が集中しています。1分ほど待ってからもう一度送信してください。",
  invalid_questionnaire: "アンケートの回答を確認してください。すべての質問に回答が必要です。",
  questionnaire_submitted: "このアンケートは提出済みです。",
  trial_not_completed: "試行が完了してからアンケートに回答できます。",
  trial_interrupted: "この試行は強制終了されました。",
  trial_changed: "画面を現在の試行に更新したため、直前の操作は送信されませんでした。画面と入力欄を確認し、必要ならもう一度操作してください。",
  not_found: "この試行は表示できません。保存期間が過ぎたか、このブラウザの試行ではありません。",
};
const knownOutcome = (code) => typeof errors[code] === "string";
const participantMessage = (code) => knownOutcome(code) ? errors[code] : STOPPED;
async function api(path, body, signal, sessionId) {
  if (body !== undefined && ["/api/message", "/api/retry", "/api/interrupt", "/api/names", "/api/ai-submit"].includes(path)) {
    body = { ...body, expectedRecordId: Object.hasOwn(body, "expectedRecordId") ? body.expectedRecordId : current?.sessionId };
    if (path === "/api/names" && requestSession() && !Object.hasOwn(body, "expectedEventCount")) body.expectedEventCount = events().length;
  }
  const headers = sessionHeaders(sessionId === undefined ? requestSession() : sessionId);
  const response = await fetch(path, body === undefined ? (signal || headers["X-Tab-Session"] ? { ...(headers["X-Tab-Session"] ? { headers } : {}), ...(signal ? { signal } : {}) } : {}) : {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
  });
  // A proxy error page is not JSON; it is an unreadable response, not a message.
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) {
    if (response.status === 409 && value?.error === "trial_changed" && body?.expectedRecordId === current?.sessionId) restoreComposerOnChange = true;
    const error = new Error(participantMessage(value?.error));
    error.status = response.status;
    error.code = typeof value?.error === "string" ? value.error : undefined;
    throw error;
  }
  return value;
}
const scene = () => current?.scene ?? current?.humanScene;
const submitted = () => Boolean(current?.submitted ?? current?.humanSubmitted);
const dialogueOpen = () => Boolean(current && !submitted() && (!current.status || current.status === "dialogue"));
// A result is published by the server only after both final submissions. Never
// infer completion from the local names, transcript, or a successful POST alone.
const resultsReady = () => Boolean(submitted() && current?.result && current?.aiSubmitted !== false);
// Completion does not depend on the result being sent: a server may withhold
// it until the questionnaire is submitted.
const trialCompleted = () => resultsReady() || Boolean(submitted() && (current?.status === "completed" || current?.resultLocked === true));
// Researcher decision (2026-10-19): matches, AI names and the score stay
// hidden until this record's questionnaire is submitted; a draft never
// unlocks them. The server withholds `result` (resultLocked) until then; a
// result that was not sent is never shown. Only a server without the
// questionnaire API (which also has no lock) shows a received result directly.
const resultsUnlocked = () => resultsReady() && current?.resultLocked !== true && ["submitted", "unavailable"].includes(surveyAvailability());
const participantStage = () => resolveStage({ localStage, reviewStage, submitted: submitted(), completed: trialCompleted(), survey: surveyAvailability() });
const chatOpen = () => dialogueOpen() && participantStage() === "chat";
const canEditComposer = () => chatOpen() && !reviewing && !showingIncompleteTrial;
const canSendMessage = () => canEditComposer() && !working && !recoveryPending() && !openingPending();
const aiThinking = () => current?.aiStatus === "thinking" || serverBusy;
function svgNode(tag, attributes = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
function closeDialog(id, restore = true) {
  const dialog = $(id);
  if (id === "confirm-dialog") confirmSnapshot = null;
  if (dialog.open) dialog.close();
  if (restore) (id === "name-dialog" ? selectedTarget : $("review-names"))?.focus({ preventScroll: true });
}
function resetLocal() {
  clearOpeningDisplay();
  closeDialog("name-dialog", false);
  closeDialog("confirm-dialog", false);
  localStage = "chat"; reviewStage = null; resetSurvey();
  answers = new Map(); selected = null; selectedTarget = null;
  pending = []; sceneSignature = ""; followHistory = true; seenMessages = 0;
  clearTimeout(typingTimer); activitySignature = ""; activitySince = 0;
  chatStalled = false; chatDisconnected = false; checking = false; submissionWarning = "";
  $("utterance").value = "";
  $("history").replaceChildren();
  $("history").historySignature = undefined;
  $("board").replaceChildren();
  $("confirm-scene").replaceChildren();
  $("figure-preview").replaceChildren();
  $("result-body").replaceChildren();
  $("confirm-list").replaceChildren();
  $("result-list").replaceChildren();
  $("result-list").summarySignature = undefined;
  $("name-list").replaceChildren();
  $("name-list").namesSignature = undefined;
  $("figure-name").value = "";
}
function rowFor(id) {
  return current?.result?.figures?.find((row) => row.human?.slot === id);
}
function addScene(target, interactive) {
  const data = scene();
  target.replaceChildren();
  if (!data?.shapes?.length) return;
  target.setAttribute("viewBox", `0 0 ${data.width} ${data.height}`);
  for (const shape of data.shapes) {
    const path = svgNode("path", { d: shape.path, class: "silhouette" });
    if (interactive) {
      path.setAttribute("role", "button");
      path.setAttribute("tabindex", "0");
      path.setAttribute("aria-haspopup", "dialog");
      path.addEventListener("click", () => openFigure(shape, path));
      path.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
          event.preventDefault(); openFigure(shape, path);
        }
      });
    }
    target.append(path);
    // Label positions are derived from this participant's geometry only.
    let box;
    try { box = path.getBBox(); } catch { /* No layout in a DOM-only test. */ }
    // A closed dialog has no SVG layout: getBBox can return all zeroes. Use
    // the same figure on the visible participant board, never that zero box.
    if (!(box?.width > 0 && box?.height > 0)) {
      const ownPath = [...$("board").querySelectorAll("path")].find((node) => node.sceneShape?.id === shape.id);
      try { box = ownPath?.getBBox(); } catch { box = null; }
    }
    if (!(box?.width > 0 && box?.height > 0)) box = null;
    const x = shape.centroid?.x ?? (box ? box.x + box.width / 2 : data.width / 2);
    const y = box ? Math.min(data.height - 42, box.y + box.height + 26) : (shape.centroid?.y ?? data.height / 2) + 80;
    const label = svgNode("text", { x, y, class: "shape-name", "text-anchor": "middle", "aria-hidden": "true" });
    target.append(label);
    // References stay local; opaque IDs are never inserted into visible labels/attributes.
    path.shapeName = label;
    path.sceneShape = shape;
  }
  updateSceneLabels(target);
}
const displayName = (name) => [...name].length > 24 ? [...name].slice(0, 24).join("") + "…" : name;
function updateSceneLabels(target) {
  for (const path of target.querySelectorAll("path")) {
    const shape = path.sceneShape;
    if (!shape) continue;
    const hasAnswer = answers.has(shape.id);
    const answer = answers.get(shape.id);
    const name = hasAnswer ? answer === null ? "未合意・わからない" : answer : "";
    // AI names and matches appear only on the results stage, so the
    // questionnaire and the read-only review are answered before seeing them.
    const result = renderedStage === "results" && resultsUnlocked() ? rowFor(shape.id) : null;
    path.setAttribute("aria-label", result ? `図形。あなた：${result.human.rawName || "未合意・わからない"}。AI：${result.ai?.rawName || "未合意・わからない"}。${result.matched ? "一致" : "不一致"}` :
      name ? `図形。メモ：${name}。選択して拡大・修正` : "図形を選択して拡大・名前を入力");
    const label = path.shapeName;
    label.replaceChildren();
    if (result) {
      ["あなた：" + displayName(result.human.rawName || "未合意・わからない"), "AI：" + displayName(result.ai?.rawName || "未合意・わからない") + (result.matched ? " · 一致" : " · 不一致")].forEach((text, i) => {
        const line = svgNode("tspan", { x: label.getAttribute("x"), dy: i ? "1.3em" : "0" });
        line.textContent = text; label.append(line);
      });
    } else label.textContent = displayName(name);
  }
}
function openFigure(shape, target) {
  selected = shape; selectedTarget = target;
  $("figure-name").value = answers.get(shape.id) ?? "";
  $("name-error").textContent = "";
  const preview = $("figure-preview");
  preview.replaceChildren(svgNode("path", { d: shape.path, class: "preview-shape" }));
  const data = scene();
  let box;
  try { box = target.getBBox(); } catch { /* Use board frame until layout is available. */ }
  preview.setAttribute("viewBox", box?.width > 0 ? `${box.x - 24} ${box.y - 24} ${box.width + 48} ${box.height + 48}` : `0 0 ${data.width} ${data.height}`);
  $("figure-name").disabled = !dialogueOpen();
  $("name-unknown").disabled = !dialogueOpen();
  $("name-form").querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = !dialogueOpen(); button.textContent = participantStage() === "names" ? "名前を保存" : "メモを保存"; });
  $("name-dialog").showModal();
  $("figure-name").focus({ preventScroll: true });
}
function saveAnswer(value) {
  if (!selected || !dialogueOpen()) return;
  answers.set(selected.id, value);
  updateSceneLabels($("board"));
  updateNameCount(); renderNameList(); storeDraft();
  closeDialog("name-dialog");
}
function updateNameCount() {
  const count = scene()?.shapes?.filter((shape) => answers.has(shape.id)).length ?? 0;
  $("name-count").textContent = scene()?.shapes?.length ? `入力済み ${count} / ${scene().shapes.length}` : "";
}
function renderNameList() {
  const signature = JSON.stringify([scene(), [...answers], submitted()]);
  if ($("name-list").namesSignature === signature) return;
  $("name-list").namesSignature = signature;
  $("name-list").replaceChildren();
  for (const path of $("board").querySelectorAll("path")) {
    const shape = path.sceneShape;
    const button = document.createElement("button");
    button.type = "button"; button.className = "name-choice";
    button.nameChoiceShapeId = shape.id;
    if (selectedTarget?.nameChoiceShapeId === shape.id) selectedTarget = button;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("data-empty", String(!answers.has(shape.id)));
    const label = document.createElement("span");
    label.textContent = answers.has(shape.id) ? answers.get(shape.id) ?? "未合意・わからない" : "名前を入力";
    button.append(thumbnail(path), label);
    button.addEventListener("click", () => { openFigure(shape, path); selectedTarget = button; });
    $("name-list").append(button);
  }
}
function thumbnail(path) {
  const node = svgNode("svg", { "aria-hidden": "true", focusable: "false" });
  let box;
  try { box = path.getBBox(); } catch { /* Use participant frame without layout. */ }
  node.setAttribute("viewBox", box?.width > 0 ? `${box.x - 12} ${box.y - 12} ${box.width + 24} ${box.height + 24}` : `0 0 ${scene().width} ${scene().height}`);
  node.append(svgNode("path", { d: path.sceneShape.path, class: "preview-shape" }));
  return node;
}
// Readable text beside each thumbnail: scene labels shrink to a few pixels on
// a phone. The text repeats only what the scene labels already show.
function renderSummary(target, text) {
  target.replaceChildren();
  for (const path of $("board").querySelectorAll("path")) {
    if (!path.sceneShape) continue;
    const item = document.createElement("div"); item.className = "summary-item";
    const label = document.createElement("span"); label.textContent = text(path.sceneShape);
    item.append(thumbnail(path), label);
    target.append(item);
  }
}
const resultSummary = (shape) => {
  const row = rowFor(shape.id);
  return row ? `あなた：${row.human.rawName || "未合意・わからない"}\nAI：${row.ai?.rawName || "未合意・わからない"} · ${row.matched ? "一致" : "不一致"}` : "";
};
function renderStage(focus = false) {
  const stage = participantStage();
  const wasHidden = $("conversation-stage").hidden;
  $("conversation-stage").hidden = stage !== "chat";
  $("name-stage").hidden = stage !== "names";
  $("results").hidden = stage !== "results";
  $("questionnaire-stage").hidden = stage !== "questionnaire";
  const surveyState = surveyAvailability();
  for (const [id, active, complete] of [["step-chat", stage === "chat", submitted() || stage !== "chat"],
    ["step-names", stage === "names", submitted()], ["step-questionnaire", stage === "questionnaire", surveyState === "submitted"],
    ["step-results", stage === "results", false]]) {
    $(id).setAttribute("data-state", active ? "active" : complete ? "complete" : "upcoming");
    // aria-current=false keeps the inactive stages out of the current-step state.
    $(id).setAttribute("aria-current", active ? "step" : "false");
  }
  // An older deployment without the questionnaire API keeps the planned label.
  if (surveyState === "unavailable" && stage !== "questionnaire") $("step-questionnaire").setAttribute("data-state", "planned");
  $("step-questionnaire-note").textContent = surveyState === "unavailable" ? "利用できません" : "試行用";
  renderReviewBar(stage);
  updateSceneLabels($("board"));
  // A display:none log loses its offset; returning to the chat shows the newest.
  if (stage === "chat" && wasHidden) followToBottom(); else updateFollowPill();
  if (focus) stageFocusTarget(stage).focus({ preventScroll: true });
}
function stageFocusTarget(stage) {
  // A read-only chat has no composer to focus; its log is focusable instead.
  return stage === "names" ? $("names-title") : stage === "results" ? $("results-title") : stage === "questionnaire" ? $("questionnaire-title") :
    chatOpen() ? $("utterance") : $("history");
}
function changeStage(stage) {
  if (!current || working || openingPending()) return;
  if (submitted()) {
    // Review navigation never changes the submission; the questionnaire draft
    // lives outside the stage and survives every switch.
    if (stage === "results" && trialCompleted() && !resultsUnlocked() && surveyAvailability() !== "pending") stage = "questionnaire";
    if (!allowedStages({ submitted: true, completed: trialCompleted(), survey: surveyAvailability() }).includes(stage)) return;
    flushSurveyDraft();
    reviewStage = stage; storeDraft(); setControls(); renderStage(true); return;
  }
  if (sending || pending.some((item) => item.status === "queued")) return;
  localStage = stage; storeDraft(); setControls(); renderStage(true);
}
function eventsFor(trial) {
  return trial?.events ?? (trial?.publicHistory ?? []).map((item, i) => ({ id: i, speaker: item.role === "assistant" ? "ai" : "human", text: item.content }));
}
const events = () => eventsFor(current);
const openingPending = () => Boolean(openingDisplay && openingDisplay.recordId === trialIdentity(current) && !reviewing);
const visibleEvents = () => openingPending() ? events().slice(1) : events();
function clearOpeningDisplay() {
  if (!openingDisplay) return;
  clearTimeout(openingDisplay.timer);
  globalThis.cancelAnimationFrame?.(openingDisplay.frame);
  openingDisplay = null;
}
function prepareOpeningDisplay() {
  if (openingDisplay && (!dialogueOpen() || reviewing || events().length !== 1 || events()[0]?.id !== openingDisplay.eventId)) clearOpeningDisplay();
  if (!openingStart || reviewing || openingStart.sessionId !== requestSession() || !current || trialIdentity(current) === openingStart.previousTrialId) return;
  openingStart = null;
  const first = events()[0];
  if (current.openingMode === "scripted_v1" && dialogueOpen() && events().length === 1 && first?.speaker === "ai") {
    openingDisplay = { recordId: trialIdentity(current), eventId: first.id, timer: null, frame: null, scheduled: false };
  }
}
function scheduleOpeningDisplay() {
  const display = openingDisplay;
  if (!display || display.scheduled) return;
  display.scheduled = true;
  const reveal = () => {
    if (openingDisplay !== display || trialIdentity(current) !== display.recordId) return;
    clearOpeningDisplay(); renderHistory(); setControls();
  };
  const countdown = () => {
    if (openingDisplay === display) display.timer = setTimeout(reveal, OPENING_DISPLAY_MS);
  };
  // Start the brief dots after the new scene has had a frame to paint.
  if (typeof globalThis.requestAnimationFrame === "function") {
    display.frame = globalThis.requestAnimationFrame(() => {
      if (openingDisplay === display) display.frame = globalThis.requestAnimationFrame(countdown);
    });
  } else countdown();
}
function reconciles(item, event) {
  if (event.speaker !== "human") return false;
  // clientId works before the POST acknowledgement; eventId supports receipts
  // from servers that do not include the optional clientId in their events.
  if (event.clientId && event.clientId === item.clientId) return true;
  return item.eventId !== undefined && event.id === item.eventId;
}
// Like an ordinary chat app: while following, the newest message stays at the
// bottom and older ones are pushed up. A reader who scrolled up is never moved;
// a pill offers the jump instead. Only explicit actions resume following.
const AT_BOTTOM_PX = 40;
const messageCount = () => visibleEvents().length + pending.length;
function updateFollowPill() {
  if (followHistory) seenMessages = messageCount();
  $("new-messages").hidden = followHistory || messageCount() <= seenMessages || participantStage() !== "chat";
}
function keepPosition(scrollTop) {
  const log = $("history");
  if (followHistory) log.scrollTo({ top: log.scrollHeight, behavior: "instant" });
  else if (scrollTop !== undefined) log.scrollTop = scrollTop;
  updateFollowPill();
}
function followToBottom() {
  followHistory = true; keepPosition();
}
// The AI's reply in progress: a transient AI bubble at the end of the log. It
// is display only, never an event, a pending message or a counted message.
// #chat-status announces the wait, so the bubble is hidden from screen readers.
// A history rebuild detaches it; renderProgress puts it back at the end.
const typingBubble = (() => {
  const li = document.createElement("li"); li.className = "ai typing-message"; li.setAttribute("aria-hidden", "true");
  const who = document.createElement("strong"); who.textContent = "AI";
  const dots = document.createElement("div"); dots.className = "typing-indicator";
  dots.append(...[0, 1, 2].map(() => document.createElement("span")));
  li.append(who, dots); return li;
})();
function renderTyping(show) {
  const log = $("history");
  if (show === (log.children[log.children.length - 1] === typingBubble)) return;
  if (show) log.append(typingBubble); else typingBubble.remove();
  // A following reader sees the bubble come and go; a reader who scrolled up stays put.
  keepPosition();
}
// ---- Participant-facing progress (display layer) ----------------------------
// Failures are shown by state, never by cause. The trial has stopped when the
// server reports a failure, or when something is awaited (an AI reply, a send
// acknowledgement, the final submission or a failed state read) without
// confirmed progress for CHAT_STALL_MS; without a trial (waiting for the
// reception) only a lasting failed state read counts. A shorter interruption
// stays invisible while polling recovers it. The participant sees STOPPED where
// the current screen shows it, with one recovery action in the trial view;
// nothing is retried automatically.
const recoveryPending = () => Boolean(current?.dialogueRecovery && current.dialogueRecovery !== "active");
const dialogueFailed = () => Boolean(dialogueOpen() && current?.aiStatus === "error" && !resuming);
const submissionFailed = () => Boolean(submitted() && !trialCompleted() && !resuming &&
  (current?.finalError || ["scoring_error", "submission_error"].includes(current?.status)));
const chatWaiting = () => Boolean(current && !submitted() && (aiThinking() || resuming || pending.some((item) => item.status !== "failed")));
const progressStopped = () => Boolean(!reviewing && (chatStalled || (current && (dialogueFailed() || submissionFailed()))));
// Where the trial view itself shows the stop (beside the composer or the
// submission); anywhere else the top notice shows it.
const stopShownInView = () => progressStopped() && Boolean(current) && participantStage() === (submitted() ? "names" : "chat");
const progressSignature = () => JSON.stringify([trialIdentity(current), events().at(-1)?.id, current?.aiStatus,
  submitted(), current?.status, current?.aiSubmitted, current?.finalError, current?.dialogueRecovery]);
function renderProgress() {
  const failed = pending.some((item) => item.status === "failed");
  const awaited = Boolean(!reviewing && (current ? !trialCompleted() && (submitted() || chatWaiting() || chatDisconnected) : chatDisconnected));
  const signature = progressSignature() + resuming;
  clearTimeout(typingTimer);
  if (!awaited) { activitySignature = ""; chatStalled = false; }
  else {
    if (signature !== activitySignature) { activitySignature = signature; activitySince = Date.now(); chatStalled = false; }
    const remaining = CHAT_STALL_MS - (Date.now() - activitySince);
    if (remaining <= 0) chatStalled = true;
    else if (!dialogueFailed() && !submissionFailed()) typingTimer = setTimeout(renderProgress, remaining);
  }
  const stopped = progressStopped();
  const showDots = (chatWaiting() || openingPending()) && !failed && !stopped;
  renderTyping(showDots);
  $("chat-recovery").hidden = !stopped;
  const recovery = current?.dialogueRecovery;
  const stoppedMessage = !recovery || recovery === "active" || submitted() ? STOPPED :
    recovery === "paused" || recovery === "unavailable" ? "会話を中断しました。" : "";
  $("chat-recovery-message").textContent = stoppedMessage;
  $("retry-chat").textContent = recovery === "retry" || recovery === "paused" ? "再開" : "状態を確認";
  $("retry-chat").hidden = recovery === "unavailable";
  $("retry-chat").disabled = working || checking || sending || !chatOpen();
  $("interrupt-chat").hidden = recovery !== "retry" || !dialogueFailed();
  $("interrupt-chat").disabled = working || checking || sending || !chatOpen();
  $("leave-incomplete-trial").textContent = "試行を中断";
  $("leave-incomplete-trial").hidden = recovery !== "unavailable" || !dialogueFailed();
  $("leave-incomplete-trial").disabled = working || checking || sending || !chatOpen();
  const status = $("chat-status");
  const statusMessage = failed ? "送信を確認できませんでした。送り直すには、そのメッセージの「再送」を押してください。" :
    stopped ? stoppedMessage : showDots ? "AIが返答を作成しています" : "";
  if (status.textContent !== statusMessage) status.textContent = statusMessage;
  if (current) {
    $("submission-status").textContent = submissionWarning || (!submitted() ? "" : stopped ? STOPPED :
      trialCompleted() ? "双方の提出が完了しました。" : "名前を提出しました。AIの提出を待っています。");
  }
  retrySubmission.hidden = !(submitted() && stopped);
  retrySubmission.disabled = working || checking;
  if (!reviewing) {
    if (stopped && !stopShownInView()) $("notice").textContent = stoppedMessage;
    else if ($("notice").textContent === STOPPED && (stopped || operationStop !== progressSignature())) {
      $("notice").textContent = ""; operationStop = null;
    }
  }
}
// The one recovery action. It first re-reads the state, which is idempotent.
// Only a stop that the refreshed server state itself reports resumes the same
// retained work: /api/retry re-runs the pending turn without re-enqueuing any
// message, and /api/ai-submit is single-flight with one stored AI submission.
// A stall while the server still reports work in progress is only re-read.
async function checkProgress() {
  if (working || checking || sending) return;
  checking = true; renderProgress();
  const trial = trialIdentity(current);
  try {
    // Only a fresh state of the same trial decides; a failed read resumes nothing.
    if (!await refreshState() || trialIdentity(current) !== trial) return;
    const path = dialogueOpen() ? (current?.aiStatus === "error" && current?.dialogueRecovery !== "unavailable" && !serverBusy ? "/api/retry" : null)
      : submitted() && !trialCompleted() && (submissionFailed() || !current?.aiSubmitted) ? "/api/ai-submit" : null;
    if (path && !reviewing) {
      resuming = true; renderProgress();
      const recovery = path === "/api/retry" && Boolean(current?.dialogueRecovery);
      await operate(() => recovery ? boundedRequest(path, {}, CHAT_STALL_MS) : api(path, {}), { recovery });
    }
  } finally {
    checking = false; resuming = false; renderProgress();
    if (current?.dialogueRecovery === "active" && pending.some(item => item.status === "queued")) drainMessages();
  }
}
function retryMessage(item) {
  if (working || sending || !chatOpen() || item.status !== "failed" || !pending.includes(item)) return;
  // Reuse the exact id and text. The server deduplicates even an ambiguous
  // acknowledgement failure; only this explicit click retries the request.
  item.status = "queued"; followHistory = true; renderHistory(); drainMessages();
}
function renderHistory() {
  const log = $("history");
  const scrollTop = log.scrollTop;
  const publicEvents = events();
  pending = pending.filter((item) => !publicEvents.some((event) => reconciles(item, event)));
  const shownEvents = visibleEvents();
  const signature = JSON.stringify([shownEvents, pending.map(({ text, status, clientId }) => ({ text, status, clientId }))]);
  if (log.historySignature !== signature) {
    log.historySignature = signature;
    log.replaceChildren();
    // Keep the server's append-only order; unacknowledged local drafts follow.
    const items = [...shownEvents, ...pending.map((item) => ({ ...item, speaker: "human", local: item }))];
    for (const item of items) {
      const li = document.createElement("li");
      li.className = item.speaker === "ai" ? "ai" : "human";
      const who = document.createElement("strong"); who.textContent = item.speaker === "ai" ? "AI" : "あなた";
      const body = document.createElement("p"); body.textContent = item.text;
      li.append(who, body);
      if (item.local) {
        li.className += " pending";
        if (item.status === "failed") {
          const status = document.createElement("small"); status.className = "message-failure";
          const mark = document.createElement("span"); mark.textContent = "!"; mark.setAttribute("aria-hidden", "true");
          const explanation = document.createElement("span"); explanation.className = "sr-only";
          explanation.textContent = "送信を確認できませんでした。自動では再送されないため、「再送」を押してください。";
          const retry = document.createElement("button"); retry.type = "button"; retry.className = "retry-message";
          retry.textContent = "再送"; retry.setAttribute("aria-label", "このメッセージを再送");
          retry.disabled = working || sending || !chatOpen();
          retry.addEventListener("click", () => retryMessage(item.local));
          status.append(mark, explanation, retry); li.append(status);
        }
      }
      log.append(li);
    }
  }
  renderProgress();
  keepPosition(scrollTop);
}
function renderStartStage(state) {
  reception = state.reception ?? null;
  const next = Boolean(state.trial && trialCompleted() && reception?.status === "in_progress");
  // The plan waits for this trial's questionnaire: show the next step, but it cannot start yet.
  const awaitingSurvey = Boolean(state.trial && trialCompleted() && reception?.status === "questionnaire");
  startReady = !state.interrupted && (reception ? (!state.trial && reception.status === "ready") || next : !state.trial);
  $("start-stage").hidden = Boolean(state.trial) && !next && !awaitingSurvey;
  $("trial-progress").hidden = !state.trial;
  $("start-trial").hidden = state.interrupted === true;
  $("start-trial").textContent = next || awaitingSurvey ? "次の課題を開始" : "スタート";
  $("reception-number").hidden = !reception?.number;
  $("reception-number").textContent = reception?.number ? `受付番号 ${reception.number}` : "";
  $("start-message").textContent = state.interrupted ? errors.trial_interrupted : !reception ? "案内を確認してから、スタートを押してください。"
    : awaitingSurvey ? errors.questionnaire_required : next ? "前の課題が終わったら、「次の課題を開始」を押してください。" : reception.status === "ready" ? "準備ができました。スタートを押してください。"
      : reception.status === "finished" ? "すべての課題が完了しました。ご協力ありがとうございました。" : "この画面を開いたまま、開始の案内があるまでお待ちください。";
}
function canStart() {
  return startReady && (!current || trialCompleted() && reception?.status === "in_progress") && !working && !serverBusy && !reviewing;
}
function render(state) {
  if (showingIncompleteTrial) return;
  const trial = state.trial;
  if (trialIdentity(trial) !== trialIdentity(current)) {
    // A poll can observe the switch before the in-flight POST returns 409.
    // Keep unconfirmed text editable; names restore only for their own trial.
    const composer = (restoreComposerOnChange || sending || working) && !reviewing ? [...pending.filter((item) => item.status !== "accepted").map((item) => item.text), $("utterance").value].filter(Boolean).join("\n") : "";
    restoreComposerOnChange = false;
    generation++; resetLocal();
    if (trial) restoreDraft(trial, composer);
    else $("utterance").value = composer;
  }
  // Events and trial lifecycle are monotonic: a stale poll response started earlier
  // must never drop newer events or regress a submitted/completed trial back to dialogue.
  if (trial && trialIdentity(current) === trialIdentity(trial)) {
    if ((trial.events?.length ?? 0) < (current?.events?.length ?? 0)) return;
    const incomingSubmitted = Boolean(trial.submitted ?? trial.humanSubmitted);
    const incomingCompleted = Boolean(incomingSubmitted && (trial.status === "completed" || trial.resultLocked === true || (trial.result && trial.aiSubmitted !== false)));
    if (submitted() && !incomingSubmitted) return;
    if (trialCompleted() && !incomingCompleted) return;
  }
  if (confirmSnapshot && $("confirm-dialog").open && (!trial || trialIdentity(trial) !== confirmSnapshot.identity || eventsFor(trial).length !== confirmSnapshot.eventCount)) {
    closeDialog("confirm-dialog", false);
    $("notice").textContent = participantMessage("trial_changed");
  }
  current = trial; serverBusy = Boolean(state.busy);
  prepareOpeningDisplay();
  // Refresh the watchdog only when a server response confirms ongoing work.
  // Repainting the UI must not renew a report received before polling stopped.
  if (state.busy === true && !chatDisconnected && !dialogueFailed() && !submissionFailed()) {
    activitySince = Date.now(); chatStalled = false;
  }
  if (!reviewing && recoveryPending()) localStage = "chat";
  renderStartStage(state);
  $("trial").hidden = !trial || preparing;
  if (!trial) { loadRecords(); renderRecords(); setControls(); scheduleRefresh(); return; }
  const data = scene();
  const nextSignature = JSON.stringify(data);
  if (nextSignature !== sceneSignature) { sceneSignature = nextSignature; addScene($("board"), true); }
  if (trial.humanSubmission) for (const [id, name] of Object.entries(trial.humanSubmission)) answers.set(id, name || null);
  $("scene-status").textContent = data?.shapes?.length ? "" : "図形を準備しています。表示されるまでお待ちください。";
  updateSceneLabels($("board")); updateNameCount(); renderNameList(); renderHistory();
  // Polling must not erase the unanswered-figure warning before it is resolved.
  if (submitted() || data?.shapes?.every((shape) => answers.has(shape.id))) submissionWarning = "";
  if (trialCompleted()) loadSurvey();
  loadRecords();
  const previousStage = renderedStage;
  renderStage();
  // A server-driven move (a published result) announces the stage it opens.
  if (trialCompleted() && previousStage !== participantStage() && ["questionnaire", "results"].includes(participantStage())) stageFocusTarget(participantStage()).focus({ preventScroll: true });
  renderSurvey(); renderRecords();
  renderResults();
  setControls(); scheduleRefresh(); scheduleOpeningDisplay();
}
// Nothing of the result is put into the page while it is locked.
function renderResults() {
  $("result-body").textContent = resultsUnlocked() ? "図形を選択すると、拡大して確認できます。" : "";
  const summarySignature = resultsUnlocked() ? JSON.stringify([sceneSignature, current.result.figures]) : "";
  if ($("result-list").summarySignature !== summarySignature) {
    $("result-list").summarySignature = summarySignature;
    if (resultsUnlocked()) renderSummary($("result-list"), resultSummary); else $("result-list").replaceChildren();
  }
}
function setControls() {
  renderLeave();
  $("start-trial").disabled = !canStart();
  renderProgress();
  $("history").querySelectorAll("button").forEach((node) => { node.disabled = working || sending || !chatOpen() || recoveryPending(); });
  $("utterance").disabled = !canEditComposer();
  $("send-message").disabled = !canSendMessage();
  $("finish-conversation").disabled = working || sending || pending.some((item) => item.status === "queued") || !dialogueOpen() || recoveryPending() || openingPending() || !scene()?.shapes?.length;
  $("back-to-chat").disabled = working;
  $("finish-conversation").hidden = submitted();
  $("chat").hidden = submitted();
  $("review-names").hidden = submitted();
  $("names-title-text").textContent = submitted() ? "提出した名前" : "名前を決める";
  $("back-to-chat").textContent = submitted() ? "会話を見る" : "会話に戻る";
  $("names-help").textContent = submitted() ? "提出済みの名前です。変更はできません。図形を選ぶと拡大して確認できます。" : "会話で共有した名前を確認してください。図形を選ぶと修正できます。";
  $("review-names").disabled = working || aiThinking() || sending || pending.some((item) => item.status === "queued") || !dialogueOpen() || openingPending() || !scene()?.shapes?.length;
  $("confirm-submit").disabled = working || aiThinking() || sending || !dialogueOpen();
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (showingIncompleteTrial || document.visibilityState === "hidden") return;
  if (reception?.status === "interrupted") return;
  if (!current && reception && !reviewing) { refreshTimer = setTimeout(() => refreshState(), 5000); return; }
  if (current && !preparing && !reviewing) refreshTimer = setTimeout(() => refreshState(), aiThinking() || pending.length ? 700 : 2000);
}
async function refreshState() {
  if (showingIncompleteTrial) return false;
  if (refreshRequest) return refreshRequest;
  if (entryMode()) return false;
  const epoch = generation;
  const requestEpoch = stateEpoch;
  refreshRequest = (async () => {
    try {
      const state = await boundedRequest("/api/state", undefined, STATE_REFRESH_MS);
      if (epoch !== generation || requestEpoch !== stateEpoch || reviewing) return false;
      chatDisconnected = false; render(state); return true;
    } catch { if (epoch === generation) { chatDisconnected = true; renderProgress(); } return false; }
    finally { refreshRequest = null; scheduleRefresh(); }
  })();
  return refreshRequest;
}
async function operate(action, { recovery = false } = {}) {
  if (working) return;
  stateEpoch++;
  working = true; setControls();
  try {
    const state = await action();
    stateEpoch++;
    if (state?.trial !== undefined) render(state);
    $("notice").textContent = "";
  }
  catch (error) {
    // A failed resume shows the stop it was resuming, not activity.
    resuming = false;
    await refreshState();
    // A stop the trial view already shows is not repeated at the top.
    $("notice").textContent = !knownOutcome(error?.code) && (recovery || stopShownInView()) ? "" : participantMessage(error?.code);
    operationStop = $("notice").textContent === STOPPED ? progressSignature() : null;
  }
  finally { working = false; setControls(); }
}
async function boundedRequest(path, body, timeoutMs = MESSAGE_ACK_MS) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    return await Promise.race([api(path, body, controller?.signal), new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort(); reject(Object.assign(new Error(STOPPED), { code: "timeout" }));
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function drainMessages() {
  if (sending || recoveryPending()) return;
  sending = true;
  const epoch = generation;
  try {
    for (const item of pending.filter((message) => message.status === "queued")) {
      if (epoch !== generation || recoveryPending()) break;
      item.status = "sending"; renderHistory(); setControls();
      try {
        let state;
        if (legacyMessages) state = await boundedRequest("/api/turn", { utterance: item.text });
        else {
          try { state = await boundedRequest("/api/message", { text: item.text, clientId: item.clientId }); }
          catch (error) {
            // Only an explicit missing endpoint permits the existing legacy
            // fallback. Timeouts or ambiguous failures are never replayed.
            if (![404, 405].includes(error.status)) throw error;
            legacyMessages = true;
            state = await boundedRequest("/api/turn", { utterance: item.text });
          }
        }
        if (epoch !== generation) break;
        item.eventId = state.eventId ?? item.eventId;
        if (legacyMessages && state?.trial) {
          const human = eventsFor(state.trial).filter((event) => event.speaker === "human").at(-1);
          if (human?.text === item.text) item.eventId = human.id;
        }
        item.status = "accepted";
        if (state?.trial !== undefined) render(state);
        else await refreshState();
      } catch (error) {
        if (epoch !== generation) break;
        if (error.code === "trial_changed") $("notice").textContent = participantMessage(error.code);
        if (pending.includes(item)) item.status = "failed";
        renderHistory(); setControls();
        // The server may already have accepted it. Refresh without resending.
        await refreshState();
      }
      renderHistory();
    }
  } finally {
    sending = false; renderHistory(); setControls(); scheduleRefresh();
    if (pending.some((item) => item.status === "queued")) drainMessages();
  }
}
// ---- Questionnaire and review after submission ----------------------------
// The questionnaire items are PROVISIONAL trial items (試行用・研究者未承認),
// defined by the server per record. The UI renders them generically, never
// totals them, and never changes names, the conversation or scoring.
const STAGES = ["chat", "names", "questionnaire", "results"];
let renderedStage = null;
let reviewing = null;
let survey = { recordId: null, status: "idle", form: null, questionnaire: null };
let surveyAnswers = {};
let surveyComment = "";
let surveyRevision = 0;
let surveySyncedRevision = 0;
let surveyToken = 0;
let surveyTimer;
let surveySave = null;
let surveySaveError = false;
let surveySubmitting = false;
let surveyMessage = "";
let surveySignature = "";
let records = { loadedFor: null, items: [], token: 0 };
// Debounced so typing stays well under the per-cookie questionnaire limiter.
const SURVEY_SAVE_MS = 2000;
const SURVEY_RETRY_MS = 10000;
// Pure: before submission only the editable chat and names; afterwards the
// read-only chat and names, the questionnaire once the trial is completed,
// and the results only after that questionnaire is submitted.
function allowedStages({ submitted, completed, survey }) {
  if (!submitted) return ["chat", "names"];
  return ["chat", "names", ...(completed && survey !== "unavailable" ? ["questionnaire"] : []),
    ...(completed && ["submitted", "unavailable"].includes(survey) ? ["results"] : [])];
}
// Pure: an explicit review choice wins while allowed; otherwise the default
// order is names (waiting for the AI) -> questionnaire -> results.
function resolveStage({ localStage, reviewStage, submitted, completed, survey }) {
  if (!submitted) return localStage === "names" ? "names" : "chat";
  if (allowedStages({ submitted, completed, survey }).includes(reviewStage)) return reviewStage;
  if (!completed) return "names";
  return survey === "unavailable" || survey === "submitted" ? "results" : "questionnaire";
}
// Pure: a submitted server response is final; unsynced edits in this browser
// are newer than any server draft; otherwise the server draft is used.
function pickSurveyDraft(local, server) {
  if (server?.status === "submitted") return server;
  if (local && local.synced === false) return local;
  return server ?? local ?? null;
}
function missingSurveyItems(form, values) {
  return (form?.items ?? []).filter((item) => item.required !== false && !Number.isInteger(values?.[item.id])).map((item) => item.id);
}
function normalizeSurveyForm(form) {
  if (!form || typeof form !== "object" || !Array.isArray(form.items) || !form.items.length) return null;
  const items = [];
  for (const item of form.items) {
    const text = item?.text ?? item?.label;
    const min = item?.min ?? form.scale?.min ?? 1, max = item?.max ?? form.scale?.max ?? 7;
    if (typeof item?.id !== "string" || typeof text !== "string" || !Number.isInteger(min) || !Number.isInteger(max) || min >= max || max - min > 10) return null;
    items.push({ id: item.id, text, min, max, required: item.required !== false,
      minLabel: String(item.minLabel ?? item.lowLabel ?? ""), maxLabel: String(item.maxLabel ?? item.highLabel ?? "") });
  }
  const maxLength = form.comment?.maxLength ?? form.commentMaxLength ?? 2000;
  return { items, notice: typeof form.notice === "string" ? form.notice : "", commentMaxLength: Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 2000 };
}
function sanitizeSurveyAnswers(form, values) {
  const clean = {};
  for (const item of form.items) {
    const value = values?.[item.id];
    if (Number.isInteger(value) && value >= item.min && value <= item.max) clean[item.id] = value;
  }
  return clean;
}
// A save or submit carries the draft version it was based on, so another tab's
// newer answers are never overwritten (409 trial_changed re-reads the server copy).
let surveyBaseUpdatedAt = null;
const surveyBody = (submit) => ({ answers: fullSurveyAnswers(), comment: surveyComment, submit,
  ...(requestSession() ? { expectedUpdatedAt: surveyBaseUpdatedAt } : {}) });
function surveyConflict(recordId) {
  removeLocalSurvey(recordId);
  surveyMessage = "別の画面で回答が更新されたため、最新の回答を表示しました。";
  loadSurvey(true);
}
const recordPath = (recordId, leaf) => `/api/records/${encodeURIComponent(recordId)}/${leaf}`;
const surveyKey = (recordId) => `joint-naming-survey:${recordId}`;
// Browser fallback only: the server draft is the primary copy. Removed on submit.
function readLocalSurvey(recordId) {
  try {
    const value = JSON.parse(localStorage.getItem(surveyKey(recordId)));
    return value && typeof value === "object" && value.answers && typeof value.answers === "object" ? value : null;
  } catch { return null; }
}
function writeLocalSurvey(recordId, synced) {
  if (!recordId) return;
  try { localStorage.setItem(surveyKey(recordId), JSON.stringify({ answers: surveyAnswers, comment: surveyComment, synced, baseUpdatedAt: surveyBaseUpdatedAt })); } catch { /* Storage may be disabled. */ }
}
function removeLocalSurvey(recordId) {
  try { localStorage.removeItem(surveyKey(recordId)); } catch { /* Storage may be disabled. */ }
}
// Browser copies of records this cookie no longer lists (expired, deleted or
// another participant's) are removed, so no answer outlives its record.
function pruneLocalSurveys(recordIds) {
  try {
    const keep = new Set(recordIds.map(surveyKey));
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("joint-naming-survey:") && !keep.has(key)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch { /* Storage may be disabled. */ }
}
function resetSurvey() {
  clearTimeout(surveyTimer); surveyToken++;
  survey = { recordId: null, status: "idle", form: null, questionnaire: null };
  surveyAnswers = {}; surveyComment = ""; surveyBaseUpdatedAt = null; surveyRevision = 0; surveySyncedRevision = 0;
  surveySave = null; surveySaveError = false; surveySubmitting = false; surveyMessage = ""; surveySignature = "";
  records = { loadedFor: null, items: [], token: records.token + 1 };
}
// "pending" before a result, "loading" until the form arrives, then
// "open", "submitted" or "unavailable" (an older server without the API).
function surveyAvailability() {
  if (!trialCompleted()) return "pending";
  if (survey.recordId !== trialIdentity(current) || ["idle", "loading"].includes(survey.status)) return "loading";
  if (survey.status === "unavailable") return "unavailable";
  return survey.questionnaire?.status === "submitted" ? "submitted" : "open";
}
const surveyEditable = () => survey.status === "ready" && survey.recordId === trialIdentity(current) &&
  survey.questionnaire?.status !== "submitted" && !surveySubmitting;
function loadSurvey(force = false) {
  const recordId = trialIdentity(current);
  if (!recordId || !trialCompleted()) return;
  if (!force && survey.recordId === recordId && !["idle", "error"].includes(survey.status)) return;
  const token = ++surveyToken;
  if (survey.recordId !== recordId || survey.status !== "ready") survey = { recordId, status: "loading", form: null, questionnaire: null };
  renderSurvey();
  (async () => {
    try {
      const value = await boundedRequest(recordPath(recordId, "questionnaire"), undefined, STATE_REFRESH_MS);
      if (token !== surveyToken) return;
      const form = normalizeSurveyForm(value?.form);
      if (!form) { survey = { recordId, status: "unavailable", form: null, questionnaire: null }; }
      else applySurvey(recordId, form, value.questionnaire ?? null);
    } catch (error) {
      if (token !== surveyToken) return;
      survey = { recordId, status: [404, 405].includes(error.status) ? "unavailable" : "error", form: null, questionnaire: null };
    }
    const before = renderedStage;
    renderStage();
    if (before !== renderedStage && reviewStage === null && ["questionnaire", "results"].includes(renderedStage)) stageFocusTarget(renderedStage).focus({ preventScroll: true });
    renderSurvey(); renderResults(); setControls();
  })();
}
function applySurvey(recordId, form, questionnaire) {
  survey = { recordId, status: "ready", form, questionnaire: questionnaire && typeof questionnaire === "object" ? questionnaire : null };
  surveySignature = "";
  if (survey.questionnaire?.status === "submitted") {
    surveyBaseUpdatedAt = survey.questionnaire.updatedAt ?? null;
    surveyAnswers = sanitizeSurveyAnswers(form, survey.questionnaire.answers);
    surveyComment = String(survey.questionnaire.comment ?? "");
    removeLocalSurvey(recordId); return;
  }
  const local = readLocalSurvey(recordId);
  const chosen = pickSurveyDraft(local, survey.questionnaire);
  // Keep the base revision the unsynced local draft actually edited from so
  // reloading cannot borrow another tab's newer updatedAt and overwrite it.
  surveyBaseUpdatedAt = chosen && chosen === local
    ? (Object.hasOwn(local, "baseUpdatedAt") ? local.baseUpdatedAt : null)
    : (survey.questionnaire?.updatedAt ?? null);
  surveyAnswers = sanitizeSurveyAnswers(form, chosen?.answers);
  surveyComment = String(chosen?.comment ?? "").slice(0, form.commentMaxLength);
  surveySyncedRevision = surveyRevision;
  // Edits that never reached the server (closed tab, offline) are sent now.
  if (chosen && chosen === local) { surveyRevision++; scheduleSurveySave(0); }
}
function surveyChanged() {
  surveyRevision++; surveyMessage = "";
  writeLocalSurvey(survey.recordId, false);
  scheduleSurveySave(); renderSurveyStatus();
}
const fullSurveyAnswers = () => Object.fromEntries(survey.form.items.map((item) => [item.id, surveyAnswers[item.id] ?? null]));
function scheduleSurveySave(delay = SURVEY_SAVE_MS) {
  clearTimeout(surveyTimer);
  surveyTimer = setTimeout(() => saveSurveyDraft(), delay);
}
function flushSurveyDraft() {
  if (surveyEditable() && surveyRevision !== surveySyncedRevision) saveSurveyDraft();
}
async function saveSurveyDraft() {
  clearTimeout(surveyTimer);
  if (surveySave) { await surveySave; }
  if (!surveyEditable() || surveyRevision === surveySyncedRevision) return;
  const recordId = survey.recordId, revision = surveyRevision, token = surveyToken;
  const body = surveyBody(false);
  renderSurveyStatus();
  surveySave = (async () => {
    try {
      const value = await boundedRequest(recordPath(recordId, "questionnaire"), body);
      if (token !== surveyToken) return;
      surveySaveError = false;
      surveySyncedRevision = Math.max(surveySyncedRevision, revision);
      if (value?.questionnaire && typeof value.questionnaire === "object") {
        survey.questionnaire = value.questionnaire;
        surveyBaseUpdatedAt = value.questionnaire.updatedAt ?? surveyBaseUpdatedAt;
      }
      // The browser copy exists only while unsynced: the server copy follows
      // the record's retention and deletion, a browser copy would not.
      if (surveyRevision === revision) removeLocalSurvey(recordId);
      else writeLocalSurvey(recordId, false);
    } catch (error) {
      if (token !== surveyToken) return;
      if (error.code === "questionnaire_submitted") { loadSurvey(true); return; }
      if (error.status === 409 && error.code === "trial_changed") { surveyConflict(recordId); return; }
      // The browser copy stays; the next edit or the timer retries.
      surveySaveError = true; scheduleSurveySave(SURVEY_RETRY_MS);
    }
  })();
  try { await surveySave; } finally { surveySave = null; }
  if (token !== surveyToken) return;
  renderSurveyStatus();
  if (!surveySaveError && surveyRevision !== surveySyncedRevision) scheduleSurveySave();
}
async function submitSurvey() {
  if (!surveyEditable() || working) return;
  const missing = missingSurveyItems(survey.form, surveyAnswers);
  if (missing.length) {
    surveyMessage = `未回答の質問が${missing.length}問あります。すべての質問に回答してください。`;
    renderSurveyStatus();
    $("questionnaire-items").querySelectorAll("input").find((node) => node.surveyItemId === missing[0])?.focus();
    return;
  }
  const recordId = survey.recordId, token = surveyToken;
  surveySubmitting = true; clearTimeout(surveyTimer); surveyMessage = ""; renderSurvey();
  if (surveySave) await surveySave;
  try {
    const value = await boundedRequest(recordPath(recordId, "questionnaire"), surveyBody(true));
    if (token !== surveyToken) return;
    if (value?.questionnaire?.status !== "submitted") throw new Error("questionnaire_not_submitted");
    survey.questionnaire = value.questionnaire;
    surveyBaseUpdatedAt = value.questionnaire.updatedAt ?? surveyBaseUpdatedAt;
    surveySyncedRevision = surveyRevision;
    removeLocalSurvey(recordId);
    surveySubmitting = false;
    reviewStage = "results"; storeDraft();
    records.loadedFor = null; loadRecords();
    setControls(); renderStage(true); renderSurvey(); renderResults();
    // A server that withholds the result until submission sends it now.
    if (!current?.result) {
      if (reviewing) reloadReview(recordId); else refreshState();
    }
  } catch (error) {
    if (token !== surveyToken) return;
    surveySubmitting = false;
    if (error.code === "questionnaire_submitted") loadSurvey(true);
    else if (error.status === 409 && error.code === "trial_changed") { surveyConflict(recordId); renderSurvey(); return; }
    // Answers stay on screen and in this browser; nothing is cleared on failure.
    surveyMessage = `${participantMessage(error.code)} 入力した回答はこの画面に残っています。`;
    renderSurvey();
  }
}
function renderSurveyStatus() {
  const submittedSurvey = survey.questionnaire?.status === "submitted";
  $("questionnaire-status").textContent = surveyMessage || (submittedSurvey ? "アンケートは提出済みです。ご協力ありがとうございました。" :
    surveySubmitting ? "提出しています…" :
      surveySaveError ? "入力した回答はこの画面に残っています。" :
        surveyRevision !== surveySyncedRevision ? "途中の回答を保存しています…" :
          "途中の回答は自動で保存されます。提出するまで何度でも変更できます。");
}
function renderSurvey() {
  const status = survey.recordId === trialIdentity(current) ? survey.status : "loading";
  const form = status === "ready" ? survey.form : null;
  const submittedSurvey = survey.questionnaire?.status === "submitted";
  $("questionnaire-notice").textContent = form?.notice ?? "";
  $("questionnaire-loading").textContent = !trialCompleted() ? "AIの提出が終わり、試行が完了するとアンケートに回答できます。" :
    status === "error" ? "アンケートを表示できませんでした。上の「アンケート」をもう一度選んでください。" :
      status === "unavailable" ? "この試行ではアンケートを表示できません。" : status === "ready" ? "" : "アンケートを読み込んでいます…";
  $("questionnaire-form").hidden = !form;
  $("questionnaire-to-results").hidden = !resultsUnlocked();
  $("questionnaire-lock").hidden = !trialCompleted() || resultsUnlocked();
  renderSurveyPrompt();
  if (!form) return;
  const signature = JSON.stringify([survey.recordId, form]);
  if (surveySignature !== signature) {
    surveySignature = signature;
    const container = $("questionnaire-items");
    container.replaceChildren();
    form.items.forEach((item, index) => {
      const fieldset = document.createElement("fieldset"); fieldset.className = "questionnaire-item";
      const legend = document.createElement("legend"); legend.textContent = `${index + 1}. ${item.text}`;
      const scale = document.createElement("div"); scale.className = "likert";
      for (let value = item.min; value <= item.max; value++) {
        const label = document.createElement("label"); label.className = "likert-option";
        const input = document.createElement("input");
        input.type = "radio"; input.name = `q-${index}`; input.value = String(value);
        input.setAttribute("type", "radio"); input.setAttribute("name", `q-${index}`); input.setAttribute("value", String(value));
        input.surveyItemId = item.id; input.surveyValue = value;
        input.checked = surveyAnswers[item.id] === value;
        input.addEventListener("change", () => {
          if (!surveyEditable()) return;
          surveyAnswers = { ...surveyAnswers, [item.id]: value }; surveyChanged();
        });
        const text = document.createElement("span"); text.textContent = String(value);
        label.append(input, text); scale.append(label);
      }
      const anchors = document.createElement("div"); anchors.className = "likert-anchors"; anchors.setAttribute("aria-hidden", "true");
      const low = document.createElement("span"); low.textContent = `${item.min}：${item.minLabel}`;
      const high = document.createElement("span"); high.textContent = `${item.max}：${item.maxLabel}`;
      anchors.append(low, high);
      // Screen readers hear the anchors with the group, not as loose text.
      legend.setAttribute("aria-label", `${index + 1}. ${item.text}（${item.min}：${item.minLabel}、${item.max}：${item.maxLabel}）`);
      fieldset.append(legend, scale, anchors); container.append(fieldset);
    });
    $("questionnaire-comment").value = surveyComment;
    $("questionnaire-comment").setAttribute("maxlength", String(form.commentMaxLength));
  }
  const editable = surveyEditable();
  for (const input of $("questionnaire-items").querySelectorAll("input")) {
    input.disabled = !editable;
    if (!editable) input.checked = surveyAnswers[input.surveyItemId] === input.surveyValue;
  }
  $("questionnaire-comment").disabled = !editable;
  $("questionnaire-submit").hidden = submittedSurvey;
  $("questionnaire-submit").disabled = !editable || working;
  renderSurveyStatus();
}
function renderSurveyPrompt() {
  const open = surveyAvailability() === "open";
  $("survey-prompt").hidden = !open || renderedStage === "questionnaire";
  if (!open) return;
  const started = Object.keys(surveyAnswers).length > 0 || Boolean(surveyComment);
  $("open-survey").textContent = started ? "アンケートの回答を再開する" : "アンケートに回答する";
  $("survey-prompt-detail").textContent = reviewing ? "以前の試行のアンケートです。提出するまで回答・変更できます。" :
    started ? "途中の回答は保存されています。提出するまで変更できます。" : "この試行について、いくつかの質問に回答してください。";
}
function renderReviewBar(stage) {
  renderedStage = stage;
  const show = submitted();
  $("review-bar").hidden = !show;
  $("exit-review").hidden = !reviewing;
  $("exit-review").textContent = reviewing?.fromEntry ? "受付に戻る" : "現在の試行に戻る";
  if (!show) { $("survey-prompt").hidden = true; return; }
  const surveyState = surveyAvailability();
  const surveyText = surveyState === "submitted" ? "アンケートも提出済みです。" : surveyState === "pending" ? "試行が完了するとアンケートと結果を表示します。" :
    surveyState === "unavailable" ? "" : "アンケートは提出するまで回答・変更できます。結果はアンケートの提出後に表示します。";
  $("review-notice").textContent = (reviewing ? "以前の試行を表示しています。名前と会話は閲覧のみで、変更できません。" :
    "名前を提出しました。名前と会話はもう変更できません（閲覧のみ）。") + surveyText;
  const allowed = allowedStages({ submitted: true, completed: trialCompleted(), survey: surveyState });
  const locked = trialCompleted() && !resultsUnlocked();
  for (const button of $("stage-nav").querySelectorAll("button")) {
    const target = button.getAttribute("data-stage");
    // A locked 結果 tab stays pressable and leads to the questionnaire.
    button.disabled = working || !(allowed.includes(target) || (target === "results" && locked));
    button.setAttribute("aria-current", target === stage ? "true" : "false");
    if (target === "results") button.setAttribute("aria-label", locked ? "結果（アンケートの提出後に表示）" : "結果");
  }
  renderSurveyPrompt();
}
// This browser's earlier trials stay reachable from every screen, also while
// a newer trial is active (from GET /api/records, cookie-scoped).
function loadRecords(force = false) {
  const key = trialIdentity(current) ?? "none";
  if (reviewing || (!force && records.loadedFor === key)) return;
  const token = ++records.token;
  records.loadedFor = key;
  (async () => {
    let items = [];
    let loaded = false;
    try {
      const value = await boundedRequest("/api/records", undefined, STATE_REFRESH_MS);
      if (Array.isArray(value?.records)) {
        items = value.records.filter((item) => item && typeof item.recordId === "string");
        loaded = true;
      }
    } catch { /* An older server has no record list; only the active trial is shown. */ }
    if (token !== records.token) return;
    // Only cookie-wide lists may prune shared localStorage; tab-scoped lists
    // only know one session and would otherwise erase another tab's draft.
    if (loaded && cookieMode) pruneLocalSurveys(items.map((item) => item.recordId));
    records.items = items; renderRecords();
  })();
}
function formatRecordTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "以前の試行";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function earlierRecords() {
  return reviewing ? [] : records.items.filter((item) => !item.active && item.recordId !== trialIdentity(current) && item.status === "completed");
}
function renderRecords() {
  const others = showingIncompleteTrial ? [] : earlierRecords();
  const history = $("record-history");
  history.hidden = !others.length;
  const unanswered = others.filter((item) => item.questionnaire !== "submitted").length;
  history.setAttribute("data-pending", String(unanswered > 0));
  $("record-summary").textContent = unanswered ? `このブラウザの以前の試行（アンケート未回答 ${unanswered}件）` : `このブラウザの以前の試行（${others.length}件）`;
  const signature = JSON.stringify(others);
  if ($("record-list").recordsSignature === signature) return;
  // Opened once when something is unanswered and there is room for it; later
  // the participant's own toggle wins.
  if (unanswered && $("record-list").recordsSignature === undefined && renderedStage !== "chat") history.open = true;
  $("record-list").recordsSignature = signature;
  $("record-list").replaceChildren();
  for (const item of others) {
    const row = document.createElement("li");
    const pendingSurvey = item.questionnaire !== "submitted";
    if (pendingSurvey) row.className = "needs-survey";
    const label = document.createElement("span");
    label.textContent = `${formatRecordTime(item.startedAt)} の試行 · ${item.questionnaire === "draft" ? "アンケート回答途中" : pendingSurvey ? "アンケート未回答" : "アンケート回答済み"}`;
    const actions = document.createElement("span"); actions.className = "record-actions";
    const view = document.createElement("button"); view.type = "button"; view.className = "secondary";
    view.textContent = "会話を見る"; view.addEventListener("click", () => openRecord(item.recordId, "chat"));
    actions.append(view);
    if (pendingSurvey) {
      const answer = document.createElement("button"); answer.type = "button";
      answer.textContent = item.questionnaire === "draft" ? "アンケートを再開" : "アンケートに回答";
      answer.addEventListener("click", () => openRecord(item.recordId, "questionnaire"));
      actions.append(answer);
    }
    row.append(label, actions); $("record-list").append(row);
  }
}
// An earlier, completed trial is shown read-only in the same screens. Polling
// pauses so the active trial's state never replaces it; the active trial's
// name memo (tab storage) and unsent composer text are kept for the return.
let stashedComposer = null;
async function openRecord(recordId, stage, origin = {}) {
  if (working || reviewing) return;
  if (sending || pending.length) { $("notice").textContent = "送信中または未送信のメッセージがあります。送信を確認してから以前の試行を開いてください。"; return; }
  flushSurveyDraft();
  await operate(async () => {
    const sessionId = origin.sessionId ?? activeTabSessionId;
    const review = await api(recordPath(recordId, "review"), undefined, undefined, sessionId);
    if (!review || review.recordId !== recordId || !review.scene?.shapes?.length) throw Object.assign(new Error("not_found"), { code: "not_found" });
    const text = $("utterance").value;
    stashedComposer = text ? { trial: trialIdentity(current), text } : null;
    clearTimeout(refreshTimer); stateEpoch++;
    reviewing = { recordId, sessionId, fromEntry: Boolean(origin.fromEntry) }; $("entry-stage").hidden = true;
    preparing = false;
    return { busy: false, trial: reviewTrial(recordId, review) };
  });
  if (reviewing?.recordId === recordId) {
    if (stage === "questionnaire") loadSurvey();
    reviewStage = stage; setControls(); renderStage(true);
  }
}
function reviewTrial(recordId, review) {
  return { version: 2, sessionId: recordId, status: "completed", submitted: true, aiSubmitted: true, aiStatus: "idle", resultLocked: review.resultLocked === true,
    scene: review.scene, events: Array.isArray(review.events) ? review.events : [], humanSubmission: review.humanSubmission ?? {}, result: review.result ?? null };
}
async function reloadReview(recordId) {
  try {
    const review = await api(recordPath(recordId, "review"));
    if (reviewing?.recordId !== recordId || review?.recordId !== recordId || !review.scene?.shapes?.length) return;
    render({ busy: false, trial: reviewTrial(recordId, review) });
  } catch { /* The submitted questionnaire stays; results appear on the next open. */ }
}
function exitReview() {
  if (!reviewing || working) return;
  flushSurveyDraft();
  if (reviewing.fromEntry) { reviewing = null; showEntry(); return; }
  reviewing = null;
  operate(async () => {
    const state = await api("/api/state");
    render(state);
    if (stashedComposer && stashedComposer.trial === trialIdentity(current) && !$("utterance").value) $("utterance").value = stashedComposer.text;
    stashedComposer = null;
    loadRecords(true);
    return state;
  });
}
const retrySubmission = document.createElement("button");
retrySubmission.type = "button"; retrySubmission.hidden = true; retrySubmission.textContent = "状態を確認";
retrySubmission.addEventListener("click", checkProgress);
$("submission").append(retrySubmission);
$("history").addEventListener("scroll", () => {
  const log = $("history"); followHistory = log.scrollHeight - log.scrollTop - log.clientHeight < AT_BOTTOM_PX;
  updateFollowPill();
});
$("new-messages").addEventListener("click", () => { followToBottom(); $("history").focus({ preventScroll: true }); });
// The keyboard, a rotated phone or a growing composer shrink the log; keep a
// following reader at the bottom. The phone layout fits the visual viewport,
// so the composer stays above an on-screen keyboard.
if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (followHistory) keepPosition(); }).observe($("history"));
const viewport = globalThis.visualViewport;
if (viewport) {
  const fitViewport = () => {
    // Pinch zoom also shrinks the visual viewport; only a keyboard or a
    // rotation should resize the layout, so ignore zoomed states.
    if (Math.abs((viewport.scale ?? 1) - 1) >= 0.01) return;
    document.documentElement.style.setProperty("--viewport-height", `${Math.round(viewport.height)}px`);
    if (followHistory) keepPosition();
  };
  viewport.addEventListener("resize", fitViewport); fitViewport();
}
$("chat").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canSendMessage()) return;
  const text = $("utterance").value;
  if (!text.trim()) return;
  pending.push({ text, clientId: newClientId(), status: "queued" });
  $("utterance").value = ""; followHistory = true; renderHistory();
  $("utterance").focus({ preventScroll: true }); drainMessages();
});
// Shift+Enter remains native multiline input. Plain Enter uses the same
// form action as the send button, except during IME confirmation.
let composingUtterance = false;
let settlingComposition = false;
let compositionTimer;
$("utterance").addEventListener("compositionstart", () => {
  clearTimeout(compositionTimer);
  composingUtterance = true;
  settlingComposition = false;
});
$("utterance").addEventListener("compositionend", () => {
  composingUtterance = false;
  settlingComposition = true;
  clearTimeout(compositionTimer);
  compositionTimer = setTimeout(() => { settlingComposition = false; }, 0);
});
$("utterance").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
      event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      composingUtterance || settlingComposition) return;
  event.preventDefault();
  if (!event.repeat) $("chat").requestSubmit();
});
$("retry-chat").addEventListener("click", () => { if (chatOpen()) checkProgress(); });
$("interrupt-chat").addEventListener("click", () => {
  if (chatOpen() && dialogueFailed() && current?.dialogueRecovery === "retry" && !checking && !sending) {
    operate(() => boundedRequest("/api/interrupt", {}), { recovery: true });
  }
});
$("leave-incomplete-trial").addEventListener("click", () => {
  if (working || checking || sending || !chatOpen() || !dialogueFailed() || current?.dialogueRecovery !== "unavailable") return;
  // The server already recorded the pending turn. Leaving only changes this screen.
  showingIncompleteTrial = true;
  generation++;
  clearTimeout(refreshTimer);
  clearTimeout(typingTimer);
  for (const id of ["trial", "trial-progress", "record-history"]) $(id).hidden = true;
  $("notice").textContent = "";
  $("incomplete-stage").hidden = false;
  $("incomplete-title").focus();
});
$("finish-conversation").addEventListener("click", () => changeStage("names"));
$("back-to-chat").addEventListener("click", () => changeStage("chat"));
$("name-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("figure-name").value.trim();
  if (!value || value.length > 200) { $("name-error").textContent = "名前を200文字以内で入力するか、「未合意・わからない」を選んでください。"; return; }
  saveAnswer(value);
});
$("name-unknown").addEventListener("click", () => saveAnswer(null));
$("name-cancel").addEventListener("click", () => closeDialog("name-dialog"));
$("name-dialog").addEventListener("cancel", () => { selectedTarget?.focus({ preventScroll: true }); });
$("submission").addEventListener("submit", (event) => {
  event.preventDefault();
  if (working || sending || aiThinking() || !dialogueOpen()) return;
  if (!scene()?.shapes?.length || scene().shapes.some((shape) => !answers.has(shape.id))) {
    submissionWarning = "名前が未入力の図形があります。図形を選択し、名前を入力するか「未合意・わからない」を選んでください。";
    $("submission-status").textContent = submissionWarning; return;
  }
  addScene($("confirm-scene"), false);
  renderSummary($("confirm-list"), (shape) => answers.get(shape.id) ?? "未合意・わからない");
  confirmSnapshot = { recordId: current?.sessionId, identity: trialIdentity(current), eventCount: events().length };
  $("confirm-dialog").showModal(); $("confirm-cancel").focus({ preventScroll: true });
});
$("confirm-cancel").addEventListener("click", () => closeDialog("confirm-dialog"));
$("confirm-submit").addEventListener("click", () => {
  if (working || sending || aiThinking() || !dialogueOpen()) return;
  const snapshot = confirmSnapshot;
  const names = Object.fromEntries(scene().shapes.map((shape) => [shape.id, answers.get(shape.id)]));
  closeDialog("confirm-dialog");
  reviewStage = null;
  const expectation = snapshot ? { ...(snapshot.recordId !== undefined ? { expectedRecordId: snapshot.recordId } : {}), ...(requestSession() ? { expectedEventCount: snapshot.eventCount } : {}) } : {};
  operate(() => api("/api/names", { names, confirm: true, ...expectation }));
});
for (const button of $("stage-nav").querySelectorAll("button")) {
  button.addEventListener("click", () => {
    const stage = button.getAttribute("data-stage");
    if (stage === "questionnaire") loadSurvey();
    if (stage === "results" && trialCompleted() && !resultsUnlocked()) {
      surveyMessage = "アンケートの提出後に結果を表示します。"; renderSurveyStatus();
    }
    changeStage(stage);
  });
}
$("open-survey").addEventListener("click", () => { loadSurvey(); changeStage("questionnaire"); });
$("questionnaire-to-names").addEventListener("click", () => changeStage("names"));
$("questionnaire-to-results").addEventListener("click", () => changeStage("results"));
$("exit-review").addEventListener("click", exitReview);
$("questionnaire-form").addEventListener("submit", (event) => { event.preventDefault(); submitSurvey(); });
$("questionnaire-comment").addEventListener("input", () => {
  if (!surveyEditable()) return;
  surveyComment = $("questionnaire-comment").value.slice(0, survey.form.commentMaxLength); surveyChanged();
});
// Closing or hiding the tab sends a pending draft; the browser copy remains
// either way and is resent after a reload.
const sendSurveyOnHide = () => {
  if (!surveyEditable() || surveyRevision === surveySyncedRevision) return;
  try {
    fetch(recordPath(survey.recordId, "questionnaire"), { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", ...sessionHeaders(requestSession()) },
      body: JSON.stringify(surveyBody(false)) }).catch(() => {});
  } catch { /* The browser copy is resent after reload. */ }
};
globalThis.addEventListener?.("pagehide", sendSurveyOnHide);
document.addEventListener?.("visibilitychange", () => {
  if (document.visibilityState === "hidden") { sendSurveyOnHide(); clearTimeout(refreshTimer); }
  else { if (reception) refreshState(); else scheduleRefresh(); }
});
$("start-trial").addEventListener("click", () => {
  if (!canStart()) return;
  const expectation = reception ? { expectedReceptionRevision: reception.revision, ...(current ? { expectedRecordId: current.sessionId } : {}) } : {};
  const attempt = { previousTrialId: trialIdentity(current), sessionId: requestSession() };
  openingStart = attempt;
  operate(() => api("/api/start", { version: 2, ...expectation })).finally(() => {
    if (openingStart === attempt) openingStart = null;
  });
});
// ---- Entry screen and tab-isolated sessions -------------------------------
// A new tab starts here, never inside another participant's conversation. The
// list shows only the server state of each session (reception number, time,
// state, questionnaire): no conversation, names, answers or internal IDs.
const SESSION_STATES = {
  waiting: ["受付待ち", [["開く", "resume"]]],
  ready: ["開始可能", [["開く", "resume"]]],
  in_progress: ["実施中", [["再開", "resume"]]],
  submitting: ["提出中", [["再開", "resume"]]],
  questionnaire_waiting: ["アンケート待ち", [["アンケートへ", "resume"]]],
  ready_next: ["次の課題待ち", [["再開", "resume"]]],
  finished: ["終了", [["閲覧", "view"]]],
  cancelled: ["取消済み", []],
  interrupted: ["強制終了", [["閲覧", "view"]]],
  unavailable: ["確認不可", []],
};
const sessionTime = (session) => session.updatedAt || session.createdAt ? formatRecordTime(session.updatedAt || session.createdAt) : "";
const completedRecords = (session) => (Array.isArray(session.records) ? session.records : [])
  .filter((item) => item?.status === "completed" && typeof item.recordId === "string")
  .sort((a, b) => String(a.startedAt ?? a.updatedAt ?? "").localeCompare(String(b.startedAt ?? b.updatedAt ?? "")) || a.recordId.localeCompare(b.recordId));
function sessionRow(session) {
  const [baseLabel, baseActions] = SESSION_STATES[session.status] ?? SESSION_STATES.unavailable;
  const unanswered = session.status === "finished" && session.hasUnansweredQuestionnaire === true;
  const row = document.createElement("li"); row.setAttribute("data-status", SESSION_STATES[session.status] ? session.status : "unavailable");
  const meta = document.createElement("span"); meta.className = "session-meta";
  const number = document.createElement("span"); number.textContent = [session.reception?.number ? `受付番号 ${session.reception.number}` : "", sessionTime(session)].filter(Boolean).join(" · ") || "受付";
  const state = document.createElement("span"); state.className = "status-badge"; state.textContent = unanswered ? "終了・アンケート未回答" : baseLabel;
  meta.append(number, state);
  const actions = document.createElement("span"); actions.className = "record-actions";
  const add = (label, handler, primary) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
    if (!primary) button.className = "secondary";
    button.addEventListener("click", handler); actions.append(button);
  };
  for (const [label, kind] of baseActions) {
    if (kind === "resume" && session.resumable !== false) add(label, () => resumeSession(session.sessionId), true);
    // A finished session is only viewed; it is never bound to this tab or resumed.
    if (kind === "view") {
      const done = completedRecords(session);
      if (done.length === 1) {
        add(label, () => openRecord(done[0].recordId, "chat", { sessionId: session.sessionId, fromEntry: true }), false);
        if (done[0].questionnaire !== "submitted") add("アンケート", () => openRecord(done[0].recordId, "questionnaire", { sessionId: session.sessionId, fromEntry: true }), true);
      } else {
        done.forEach((item, index) => {
          const prefix = `${index + 1}回目`;
          add(`${prefix}を見る`, () => openRecord(item.recordId, "chat", { sessionId: session.sessionId, fromEntry: true }), false);
          if (item.questionnaire !== "submitted") add(`${prefix}アンケート`, () => openRecord(item.recordId, "questionnaire", { sessionId: session.sessionId, fromEntry: true }), true);
        });
      }
    }
  }
  row.append(meta, actions);
  return row;
}
function renderEntry(sessions) {
  const sorted = [...sessions].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")));
  $("session-history").hidden = !sorted.length;
  $("session-list").replaceChildren(...sorted.map(sessionRow));
  $("new-session").disabled = sessionsReceptionMode === "unavailable";
  if (sessionsReceptionMode === "unavailable") $("notice").textContent = errors.reception_unavailable;
  $("entry-stage").hidden = false;
}
// Forget the bound session and the screen of the previous participant.
function leaveSession() {
  openingStart = null;
  try { tabSession()?.clear(); } catch { /* The tab keeps no binding. */ }
  activeTabSessionId = null; reviewing = null; current = null; reception = null; startReady = false; preparing = false;
  generation++; stateEpoch++; clearTimeout(refreshTimer); clearTimeout(typingTimer);
  resetLocal(); clearDraft();
  $("notice").textContent = "";
  $("session-history").open = false;
  for (const id of ["start-stage", "trial", "trial-progress", "record-history", "entry-stage", "survey-prompt", "review-bar"]) $(id).hidden = true;
  setControls();
}
async function loadSessions() {
  const value = await api("/api/sessions", undefined, undefined, null);
  sessionsReceptionMode = ["on", "off", "unavailable"].includes(value?.receptionMode) ? value.receptionMode : "off";
  const list = Array.isArray(value?.sessions) ? value.sessions.filter((item) => item && typeof item.sessionId === "string") : [];
  const browserRecordIds = list.flatMap((item) => [
    ...(typeof item.activeRecordId === "string" ? [item.activeRecordId] : []),
    ...(Array.isArray(item.records) ? item.records.map((r) => r?.recordId).filter((id) => typeof id === "string") : []),
  ]);
  if (trialIdentity(current)) browserRecordIds.push(trialIdentity(current));
  pruneLocalSurveys(browserRecordIds);
  return list;
}
async function showEntry() {
  leaveSession();
  try { renderEntry(await loadSessions()); }
  catch (error) { $("notice").textContent = participantMessage(error.code); }
}
function bindSession(sessionId) {
  try { tabSession()?.bind(sessionId); } catch { /* The binding is only a reload convenience. */ }
  activeTabSessionId = sessionId;
}
// An explicit choice: a new session and, when receptions are on, a new reception.
async function newSession() {
  if (working) return;
  stateEpoch++; working = true; $("new-session").disabled = true; setControls();
  let reusedId = pendingEmptySessionId;
  const createdNow = !reusedId;
  let state = { trial: null };
  try {
    if (createdNow) {
      const created = await api("/api/sessions", {}, undefined, null);
      if (typeof created?.sessionId !== "string") throw new Error("session_unavailable");
      reusedId = created.sessionId;
      pendingEmptySessionId = reusedId;
      state = created.state ?? { trial: null };
    }
    bindSession(reusedId);
    $("entry-stage").hidden = true; $("notice").textContent = "";
    if (sessionsReceptionMode === "on" || (sessionsReceptionMode === null && state.reception)) {
      try { state = await api("/api/reception", {}); }
      catch (error) { if (error.status !== 404) throw error; }
    } else if (!createdNow) {
      state = await api("/api/state");
    }
    pendingEmptySessionId = null;
    render(state);
  } catch (error) {
    // Keep the already-created empty child for retry without stranding the user on a blank page.
    try { tabSession()?.clear(); } catch { /* No binding to forget. */ }
    activeTabSessionId = null;
    $("entry-stage").hidden = false;
    $("new-session").disabled = false;
    $("notice").textContent = participantMessage(error?.code);
  } finally { working = false; setControls(); }
}
// An explicit resume binds this tab to that session and shows its server state.
async function resumeSession(sessionId) {
  if (working) return;
  stateEpoch++; working = true; setControls();
  try {
    const state = await api("/api/state", undefined, undefined, sessionId);
    pendingEmptySessionId = null;
    bindSession(sessionId);
    $("entry-stage").hidden = true; $("notice").textContent = "";
    render(state);
  } catch (error) {
    $("notice").textContent = participantMessage(error?.code);
    try { renderEntry(await loadSessions()); } catch { /* The list stays as shown. */ }
  } finally { working = false; setControls(); }
}
// "受付に戻る" before the end, "新しく始める" once the participant is done.
let leaveAction = null;
function renderLeave() {
  const done = Boolean(activeTabSessionId && !reviewing && !working && (reception?.status === "finished" ||
    (current && trialCompleted() && !reception && ["submitted", "unavailable"].includes(surveyAvailability()))));
  const back = Boolean(activeTabSessionId && !reviewing && !current && (!reception || reception.status !== "finished"));
  leaveAction = done ? "new" : back ? "back" : null;
  $("leave-session").hidden = !leaveAction;
  $("leave-session").textContent = leaveAction === "new" ? "新しく始める" : "受付に戻る";
  $("leave-session").disabled = working;
}
async function startupAdmission() {
  const state = await api("/api/state");
  if (!state.reception) return state;
  try { return await api("/api/reception", {}); }
  catch (error) { if (error.status === 404) return state; throw error; }
}
// An explicit record link never starts an unrelated trial, even on a clean browser.
async function resumeLinkedRecord(recordId, TS) {
  try { TS?.clear(); } catch { /* No binding to retain. */ }
  clearDraft();
  try {
    if (!TS || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(recordId)) throw new Error('not_found');
    const sessions = await loadSessions();
    const matches = sessions.filter(session => session.resumable === true && session.activeRecordId === recordId);
    if (matches.length !== 1) throw new Error('not_found');
    const sessionId = matches[0].sessionId;
    const state = await api('/api/state', undefined, undefined, sessionId);
    if (state?.trial?.sessionId !== recordId) throw new Error('trial_changed');
    bindSession(sessionId);
    $("entry-stage").hidden = true;
    $("notice").textContent = "";
    render(state); setControls();
    // Following ordinary reloads and transitions uses the tab binding, not a stale record link.
    try { globalThis.history?.replaceState(globalThis.history.state, '', globalThis.location.pathname + globalThis.location.search); } catch { /* The binding still works. */ }
  } catch {
    $("notice").textContent = "この試行を開けませんでした。受付一覧から開き直してください。";
  }
}
async function startup() {
  const TS = tabSession();
  const linked = globalThis.location?.hash?.startsWith('#resume=') ? globalThis.location.hash.slice(8) : null;
  if (linked !== null) {
    try { await TS?.resolve(); } catch { /* Fail closed rather than creating a trial. */ }
    await resumeLinkedRecord(linked, TS);
    return;
  }
  // Without tab-session.js the single cookie session is used as before.
  if (!TS) { cookieMode = true; operate(startupAdmission); return; }
  let resolved = null;
  try { resolved = await TS.resolve(); } catch { /* A tab that cannot be resolved starts fresh. */ }
  if (resolved?.kind === "restored" && typeof resolved.sessionId === "string") {
    // Same tab, reload: keep this tab's session where it was.
    try {
      const state = await api("/api/state", undefined, undefined, resolved.sessionId);
      activeTabSessionId = resolved.sessionId;
      let next = state;
      if (!state.trial && state.reception && !state.reception.number) {
        try { next = await api("/api/reception", {}); } catch (error) { if (error.status !== 404) throw error; }
      }
      render(next); setControls();
      return;
    } catch (error) {
      if (![401, 403, 404, 410].includes(error.status)) {
        // A passing failure keeps the binding and tries again.
        $("notice").textContent = participantMessage(error.code);
        setTimeout(startup, 5000); return;
      }
      try { TS.clear(); } catch { /* No binding to forget. */ }
    }
  }
  clearDraft();
  let sessions;
  try { sessions = await loadSessions(); }
  catch (error) {
    // An older server has no session list: the single cookie session as before.
    if ([404, 405].includes(error.status)) { cookieMode = true; operate(startupAdmission); return; }
    $("notice").textContent = participantMessage(error.code); return;
  }
  // The first visit of a browser keeps the QR experience: a number right away.
  if (!sessions.length && sessionsReceptionMode !== "unavailable") { await newSession(); return; }
  renderEntry(sessions);
}
$("new-session").addEventListener("click", newSession);
$("leave-session").addEventListener("click", async () => {
  if (working || !leaveAction) return;
  const action = leaveAction;
  if (action === "back") { showEntry(); return; }
  leaveSession(); sessionsReceptionMode = null;
  try { await loadSessions(); } catch { /* Falls back to the new state's reception. */ }
  await newSession();
});
startup();
