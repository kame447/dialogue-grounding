const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
let current = null;
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
let messageSequence = 0;
let typingTimer;
let activitySignature = "";
let activitySince = 0;
let chatStalled = false;
let chatDisconnected = false;
let checkingChat = false;
let retryingAI = false;
let submissionWarning = "";
// Presentation/network safeguards only; these never close a research trial or
// cancel backend generation. A stalled state is refreshed, never auto-retried.
const CHAT_STALL_MS = 60000;
const MESSAGE_ACK_MS = 20000;
const STATE_REFRESH_MS = 10000;
const newClientId = () => globalThis.crypto?.randomUUID?.() ??
  `chat-${Date.now().toString(36)}-${++messageSequence}-${Math.random().toString(36).slice(2, 12)}`;
const draftKey = "joint-naming-v2-draft";
const trialIdentity = (trial) => trial?.sessionId ?? trial?.trialId;
// UI drafts stay in this browser tab, never in API requests or research records.
function storeDraft() {
  if (!trialIdentity(current)) return;
  try { sessionStorage.setItem(draftKey, JSON.stringify({ trial: trialIdentity(current), stage: localStage, answers: [...answers] })); } catch { /* Storage may be disabled. */ }
}
function clearDraft() {
  try { sessionStorage.removeItem(draftKey); } catch { /* Storage may be disabled. */ }
}
function restoreDraft(trial) {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    if (!draft || draft.trial !== trialIdentity(trial)) { clearDraft(); return; }
    const ids = new Set((trial.scene ?? trial.humanScene)?.shapes?.map((shape) => shape.id));
    answers = new Map((Array.isArray(draft.answers) ? draft.answers : []).filter((entry) => Array.isArray(entry) && ids.has(entry[0]) &&
      (entry[1] === null || (typeof entry[1] === "string" && entry[1].trim() && entry[1].length <= 200))));
    localStage = draft.stage === "names" ? "names" : "chat";
  } catch { /* Ignore unavailable or invalid browser drafts. */ }
}
const errors = {
  ai_unavailable: "AIに接続できませんでした。公開された会話を確認してください。メッセージは自動で再送しません。",
  scoring_error: "採点でエラーが発生しました。提出内容を保持しています。採点を再試行できます。",
  invalid_ai_submission: "AIの最終提出を検証できませんでした。研究者がこの試行を確認してください。",
  repository_output_forbidden: "記録先はリポジトリ外に設定してください。",
  record_write_failed: "研究記録を保存できませんでした。研究者が保存先を確認してください。",
  invalid_seed: "Seedを安全な整数で入力してください。",
  busy: "処理中です。完了を待ってください。",
  rate_limited: "短時間に送信が集中しています。1分ほど待ってからもう一度送信してください。",
};
async function api(path, body, signal) {
  const response = await fetch(path, body === undefined ? (signal ? { signal } : {}) : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(errors[value.error] || "操作を完了できませんでした。研究者が試行状態を確認してください。");
    error.status = response.status;
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
const participantStage = () => resultsReady() ? "results" : submitted() ? "names" : localStage;
const chatOpen = () => dialogueOpen() && participantStage() === "chat";
const aiThinking = () => current?.aiStatus === "thinking" || serverBusy;
function svgNode(tag, attributes = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
function closeDialog(id, restore = true) {
  const dialog = $(id);
  if (dialog.open) dialog.close();
  if (restore) (id === "name-dialog" ? selectedTarget : $("review-names"))?.focus({ preventScroll: true });
}
function resetLocal() {
  closeDialog("name-dialog", false);
  closeDialog("confirm-dialog", false);
  localStage = "chat";
  answers = new Map(); selected = null; selectedTarget = null;
  pending = []; sceneSignature = ""; followHistory = true; seenMessages = 0;
  clearTimeout(typingTimer); activitySignature = ""; activitySince = 0;
  chatStalled = false; chatDisconnected = false; checkingChat = false; submissionWarning = "";
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
    const result = rowFor(shape.id);
    path.setAttribute("aria-label", result ? `図形。あなた：${result.human.rawName || "未合意"}。AI：${result.ai?.rawName || "未合意"}。${result.matched ? "一致" : "不一致"}` :
      name ? `図形。メモ：${name}。選択して拡大・修正` : "図形を選択して拡大・名前を入力");
    const label = path.shapeName;
    label.replaceChildren();
    if (result) {
      ["あなた：" + displayName(result.human.rawName || "未合意"), "AI：" + displayName(result.ai?.rawName || "未合意") + (result.matched ? " · 一致" : " · 不一致")].forEach((text, i) => {
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
  $("name-form").querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = !dialogueOpen(); });
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
  $("name-count").textContent = scene()?.shapes?.length ? `回答 ${count} / ${scene().shapes.length}` : "";
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
  return row ? `あなた：${row.human.rawName || "未合意"}\nAI：${row.ai?.rawName || "未合意"} · ${row.matched ? "一致" : "不一致"}` : "";
};
function renderStage(focus = false) {
  const stage = participantStage();
  const wasHidden = $("conversation-stage").hidden;
  $("conversation-stage").hidden = stage !== "chat";
  $("name-stage").hidden = stage !== "names";
  $("results").hidden = stage !== "results";
  for (const [id, active, complete] of [["step-chat", stage === "chat", stage !== "chat"],
    ["step-names", stage === "names", stage === "results"], ["step-results", stage === "results", false]]) {
    $(id).setAttribute("data-state", active ? "active" : complete ? "complete" : "upcoming");
    // aria-current=false keeps the inactive stages out of the current-step state.
    $(id).setAttribute("aria-current", active ? "step" : "false");
  }
  // A display:none log loses its offset; returning to the chat shows the newest.
  if (stage === "chat" && wasHidden) followToBottom(); else updateFollowPill();
  if (focus) (stage === "names" ? $("names-title") : stage === "results" ? $("results-title") : $("utterance")).focus({ preventScroll: true });
}
function changeStage(stage) {
  if (!current || submitted() || working || sending || pending.some((item) => item.status === "queued")) return;
  localStage = stage; storeDraft(); setControls(); renderStage(true);
}
function eventsFor(trial) {
  return trial?.events ?? (trial?.publicHistory ?? []).map((item, i) => ({ id: i, speaker: item.role === "assistant" ? "ai" : "human", text: item.content }));
}
const events = () => eventsFor(current);
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
const messageCount = () => events().length + pending.length;
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
function renderChatActivity() {
  const failed = pending.some((item) => item.status === "failed");
  // A retry in flight is shown as AI activity, not as the error it replaces.
  const aiError = current?.aiStatus === "error" && !retryingAI;
  const waiting = Boolean(current && !submitted() && (aiThinking() || retryingAI || pending.some((item) => item.status !== "failed")));
  const signature = JSON.stringify([trialIdentity(current), events().at(-1)?.id, current?.aiStatus, retryingAI]);
  clearTimeout(typingTimer);
  if (!waiting) { activitySignature = ""; chatStalled = false; }
  else {
    if (signature !== activitySignature) { activitySignature = signature; activitySince = Date.now(); chatStalled = false; }
    const remaining = CHAT_STALL_MS - (Date.now() - activitySince);
    if (remaining <= 0) chatStalled = true;
    else if (!failed && !aiError && !chatDisconnected) typingTimer = setTimeout(renderChatActivity, remaining);
  }
  const showDots = waiting && !failed && !aiError && !chatStalled && !chatDisconnected;
  $("typing-indicator").hidden = !showDots;
  $("chat-recovery").hidden = !(aiError || chatStalled || chatDisconnected);
  $("chat-recovery-message").textContent = aiError ? "返答を取得できませんでした。" : "会話の更新を確認できません。";
  $("retry-chat").textContent = aiError ? "AIの返答を再試行" : "状態を確認";
  $("retry-chat").disabled = working || checkingChat || sending || !chatOpen();
  $("chat-status").textContent = failed ? "送信を確認できません。メッセージの再送ボタンで再試行できます。" :
    aiError ? "AIの返答を取得できませんでした。再試行できます。" :
      chatStalled || chatDisconnected ? "会話の更新を確認できません。状態を確認してください。" :
        showDots ? "AIが返答を作成しています" : "";
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
  const signature = JSON.stringify([publicEvents, pending.map(({ text, status, clientId }) => ({ text, status, clientId }))]);
  if (log.historySignature !== signature) {
    log.historySignature = signature;
    log.replaceChildren();
    // Keep the server's append-only order; unacknowledged local drafts follow.
    const items = [...publicEvents, ...pending.map((item) => ({ ...item, speaker: "human", local: item }))];
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
          explanation.textContent = "送信を確認できません。自動では再送しません。";
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
  renderChatActivity();
  keepPosition(scrollTop);
}
function render(state) {
  const trial = state.trial;
  if (trialIdentity(trial) !== trialIdentity(current)) { generation++; resetLocal(); if (trial) restoreDraft(trial); }
  // Events are append-only; a state response started earlier must not remove newer events.
  if (trial && trialIdentity(current) === trialIdentity(trial) && (trial.events?.length ?? 0) < (current?.events?.length ?? 0)) return;
  current = trial; serverBusy = Boolean(state.busy);
  $("setup").hidden = Boolean(trial) && !preparing;
  $("trial").hidden = !trial || preparing;
  if (!trial) { setControls(); return; }
  const data = scene();
  const nextSignature = JSON.stringify(data);
  if (nextSignature !== sceneSignature) { sceneSignature = nextSignature; addScene($("board"), true); }
  if (trial.humanSubmission) for (const [id, name] of Object.entries(trial.humanSubmission)) answers.set(id, name || null);
  $("scene-status").textContent = data?.shapes?.length ? "" : "図形を準備しています。表示されるまでお待ちください。";
  updateSceneLabels($("board")); updateNameCount(); renderNameList(); renderHistory();
  // Polling must not erase the unanswered-figure warning before it is resolved.
  if (submitted() || data?.shapes?.every((shape) => answers.has(shape.id))) submissionWarning = "";
  $("submission-status").textContent = submissionWarning || (trial.status === "submission_error" || trial.finalError === "invalid_ai_submission" ? errors.invalid_ai_submission :
    trial.status === "scoring_error" ? errors.scoring_error : trial.result ? "双方の提出が完了しました。" :
      submitted() ? "あなたの回答を確定しました。AIの提出を待っています。" : "メモはこのブラウザのタブに保存されます。相手には届きません。");
  const previousStage = $("results").hidden === false ? "results" : null;
  renderStage();
  if (resultsReady() && previousStage !== "results") $("results-title").focus({ preventScroll: true });
  $("result-body").textContent = resultsReady() ? "図形を選択すると、拡大して確認できます。" : "";
  const summarySignature = resultsReady() ? JSON.stringify([sceneSignature, current.result.figures]) : "";
  if ($("result-list").summarySignature !== summarySignature) {
    $("result-list").summarySignature = summarySignature;
    if (resultsReady()) renderSummary($("result-list"), resultSummary); else $("result-list").replaceChildren();
  }
  $("new-trial").hidden = !trial.result && !["completed", "submission_error"].includes(trial.status);
  retrySubmission.hidden = !canRetrySubmission();
  retrySubmission.textContent = trial.status === "scoring_error" ? "採点を再試行" : "AIの提出を再試行";
  setControls(); scheduleRefresh();
}
function setControls() {
  renderChatActivity();
  $("history").querySelectorAll("button").forEach((node) => { node.disabled = working || sending || !chatOpen(); });
  for (const id of ["utterance", "send-message"]) $(id).disabled = working || !chatOpen();
  $("setup").querySelectorAll("input,select,button").forEach((node) => { node.disabled = working; });
  $("finish-conversation").disabled = working || sending || pending.some((item) => item.status === "queued") || !dialogueOpen() || !scene()?.shapes?.length;
  $("back-to-chat").disabled = working || submitted();
  $("review-names").disabled = working || aiThinking() || sending || pending.some((item) => item.status === "queued") || !dialogueOpen() || !scene()?.shapes?.length;
  $("confirm-submit").disabled = working || aiThinking() || sending || !dialogueOpen();
  $("new-trial").disabled = working || serverBusy;
  retrySubmission.disabled = working || serverBusy || !canRetrySubmission();
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (current && !preparing) refreshTimer = setTimeout(() => refreshState(), aiThinking() || pending.length ? 700 : 2000);
}
async function refreshState() {
  if (refreshRequest) return refreshRequest;
  const epoch = generation;
  const requestEpoch = stateEpoch;
  refreshRequest = (async () => {
    try { const state = await boundedRequest("/api/state", undefined, STATE_REFRESH_MS); if (epoch === generation && requestEpoch === stateEpoch) { chatDisconnected = false; render(state); } }
    catch { if (epoch === generation) { chatDisconnected = true; renderChatActivity(); } }
    finally { refreshRequest = null; scheduleRefresh(); }
  })();
  return refreshRequest;
}
async function operate(action) {
  if (working) return;
  stateEpoch++;
  working = true; setControls();
  try { const state = await action(); if (state?.trial !== undefined) render(state); $("notice").textContent = ""; }
  catch (error) { $("notice").textContent = error.message; await refreshState(); }
  finally { working = false; setControls(); }
}
async function boundedRequest(path, body, timeoutMs = MESSAGE_ACK_MS) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    return await Promise.race([api(path, body, controller?.signal), new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort(); reject(new Error("通信を確認できませんでした。"));
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function drainMessages() {
  if (sending) return;
  sending = true;
  const epoch = generation;
  try {
    for (const item of pending.filter((message) => message.status === "queued")) {
      if (epoch !== generation) break;
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
      } catch {
        if (epoch !== generation) break;
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
function canRetrySubmission() {
  return Boolean(submitted() && (current?.status === "scoring_error" || (current?.status === "submitting" && !current?.aiSubmitted)));
}
const retrySubmission = document.createElement("button");
retrySubmission.type = "button"; retrySubmission.hidden = true;
retrySubmission.addEventListener("click", () => { if (!working && !serverBusy && canRetrySubmission()) operate(() => api("/api/ai-submit", {})); });
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
$("setup").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  operate(async () => {
    const state = await api("/api/start", { strategy: data.get("strategy"), seed: Number(data.get("seed")),
      referenceMemory: data.get("referenceMemory") === "on", version: 2 });
    generation++; clearDraft(); resetLocal(); preparing = false; return state;
  });
});
$("chat").addEventListener("submit", (event) => {
  event.preventDefault();
  if (working || !chatOpen()) return;
  const text = $("utterance").value;
  if (!text.trim()) return;
  pending.push({ text, clientId: newClientId(), status: "queued" });
  $("utterance").value = ""; followHistory = true; renderHistory();
  $("utterance").focus({ preventScroll: true }); drainMessages();
});
// Textarea Enter (including IME) is left to native multiline editing. Sending
// is an explicit form action; no keydown handler turns Enter into a request.
$("retry-chat").addEventListener("click", async () => {
  if (working || checkingChat || sending || !chatOpen()) return;
  if (current?.aiStatus === "error" && !serverBusy) {
    retryingAI = true; renderChatActivity();
    try { await operate(() => api("/api/retry", {})); } finally { retryingAI = false; renderChatActivity(); }
  } else {
    checkingChat = true; renderChatActivity();
    try { await refreshState(); } finally { checkingChat = false; renderChatActivity(); }
  }
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
    submissionWarning = "未回答の図形があります。図形を選んで名前か「未合意・わからない」を入力してください。";
    $("submission-status").textContent = submissionWarning; return;
  }
  addScene($("confirm-scene"), false);
  renderSummary($("confirm-list"), (shape) => answers.get(shape.id) ?? "未合意・わからない");
  $("confirm-dialog").showModal(); $("confirm-cancel").focus({ preventScroll: true });
});
$("confirm-cancel").addEventListener("click", () => closeDialog("confirm-dialog"));
$("confirm-submit").addEventListener("click", () => {
  if (working || sending || aiThinking() || !dialogueOpen()) return;
  const names = Object.fromEntries(scene().shapes.map((shape) => [shape.id, answers.get(shape.id)]));
  closeDialog("confirm-dialog");
  operate(() => api("/api/names", { names, confirm: true }));
});
$("new-trial").addEventListener("click", () => {
  preparing = true; clearTimeout(refreshTimer);
  $("setup").hidden = false; $("trial").hidden = true; $("setup").elements.seed.focus();
});
operate(() => api("/api/state"));
