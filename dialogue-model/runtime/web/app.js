const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
let current = null;
let working = false;
let serverBusy = false;
let composing = false;
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
let preparing = false;
const errors = {
  ai_unavailable: "AIに接続できませんでした。公開された会話を確認してください。メッセージは自動で再送しません。",
  scoring_error: "採点でエラーが発生しました。提出内容を保持しています。採点を再試行できます。",
  invalid_ai_submission: "AIの最終提出を検証できませんでした。研究者がこの試行を確認してください。",
  repository_output_forbidden: "記録先はリポジトリ外に設定してください。",
  record_write_failed: "研究記録を保存できませんでした。研究者が保存先を確認してください。",
  invalid_seed: "Seedを安全な整数で入力してください。",
  busy: "処理中です。完了を待ってください。",
};
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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
  answers = new Map(); selected = null; selectedTarget = null;
  pending = []; sceneSignature = ""; followHistory = true;
  $("utterance").value = "";
  $("history").replaceChildren();
  $("history").historySignature = undefined;
  $("board").replaceChildren();
  $("confirm-scene").replaceChildren();
  $("figure-preview").replaceChildren();
  $("result-body").replaceChildren();
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
  updateNameCount();
  closeDialog("name-dialog");
}
function updateNameCount() {
  const count = scene()?.shapes?.filter((shape) => answers.has(shape.id)).length ?? 0;
  $("name-count").textContent = scene()?.shapes?.length ? `回答 ${count} / ${scene().shapes.length}` : "";
}
function events() {
  return current?.events ?? (current?.publicHistory ?? []).map((item, i) => ({ id: i, speaker: item.role === "assistant" ? "ai" : "human", text: item.content }));
}
function renderHistory() {
  const log = $("history");
  const oldSignature = log.historySignature;
  const publicEvents = events();
  pending = pending.filter((item) => item.eventId === undefined || !publicEvents.some((event) => event.id === item.eventId));
  const signature = JSON.stringify([publicEvents, pending.map(({ text, status }) => ({ text, status }))]);
  if (oldSignature === signature) return;
  log.historySignature = signature;
  log.replaceChildren();
  const items = [...publicEvents, ...pending.map((item) => ({ speaker: "human", text: item.text, pending: item.status }))];
  for (const item of items) {
    const li = document.createElement("li");
    li.className = item.speaker === "ai" ? "ai" : "human";
    const who = document.createElement("strong"); who.textContent = item.speaker === "ai" ? "AI" : "あなた";
    const body = document.createElement("p"); body.textContent = item.text;
    li.append(who, body);
    if (item.pending) {
      const status = document.createElement("small");
      status.textContent = item.pending === "failed" ? "送信を確認できません。公開された会話を確認してください。自動では再送しません。" : item.pending === "accepted" ? "受理済み・会話を更新中…" : "送信中…";
      li.append(status); li.className += " pending";
    }
    log.append(li);
  }
  if (followHistory) log.scrollTo({ top: log.scrollHeight, behavior: "auto" });
}
function render(state) {
  const trial = state.trial;
  if (trial?.trialId !== current?.trialId) { generation++; resetLocal(); }
  // Events are append-only; a state response started earlier must not remove newer events.
  if (trial && current?.trialId === trial.trialId && (trial.events?.length ?? 0) < (current?.events?.length ?? 0)) return;
  current = trial; serverBusy = Boolean(state.busy);
  $("setup").hidden = Boolean(trial) && !preparing;
  $("trial").hidden = !trial || preparing;
  if (!trial) { setControls(); return; }
  const data = scene();
  const nextSignature = JSON.stringify(data);
  if (nextSignature !== sceneSignature) { sceneSignature = nextSignature; addScene($("board"), true); }
  if (trial.humanSubmission) for (const [id, name] of Object.entries(trial.humanSubmission)) answers.set(id, name || null);
  $("scene-status").textContent = data?.shapes?.length ? "" : "図形を準備しています。表示されるまでお待ちください。";
  updateSceneLabels($("board")); updateNameCount(); renderHistory();
  $("submission-status").textContent = trial.status === "submission_error" ? errors.invalid_ai_submission :
    trial.status === "scoring_error" ? errors.scoring_error : trial.result ? "双方の提出が完了しました。" :
      submitted() ? "あなたの回答を確定しました。AIの提出を待っています。" : "名前のメモはこの画面だけに保存されています。";
  $("results").hidden = !trial.result;
  $("result-body").textContent = trial.result ? "図形を選択すると、拡大して確認できます。" : "";
  $("new-trial").hidden = !trial.result && !["completed", "submission_error"].includes(trial.status);
  retrySubmission.hidden = !canRetrySubmission();
  retrySubmission.textContent = trial.status === "scoring_error" ? "採点を再試行" : "AIの提出を再試行";
  setControls(); scheduleRefresh();
}
function setControls() {
  $("chat-status").textContent = aiThinking() ? "AIが考えています… 続けて送信できます" : "";
  $("chat").querySelectorAll("textarea,button").forEach((node) => { node.disabled = working || !dialogueOpen(); });
  $("setup").querySelectorAll("input,select,button").forEach((node) => { node.disabled = working; });
  $("review-names").disabled = working || sending || pending.some((item) => item.status === "queued") || !dialogueOpen() || !scene()?.shapes?.length;
  $("confirm-submit").disabled = working || sending || !dialogueOpen();
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
    try { const state = await api("/api/state"); if (epoch === generation && requestEpoch === stateEpoch) render(state); }
    catch { $("notice").textContent = "状態を更新できませんでした。通信を確認しています。メッセージは自動で再送しません。"; }
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
        if (legacyMessages) state = await api("/api/turn", { utterance: item.text });
        else {
          try { state = await api("/api/message", { text: item.text }); }
          catch (error) {
            // An explicit missing endpoint is the only safe fallback. Never replay an ambiguous failure.
            if (![404, 405].includes(error.status)) throw error;
            legacyMessages = true;
            state = await api("/api/turn", { utterance: item.text });
          }
        }
        if (epoch !== generation) break;
        if (state?.trial !== undefined) { pending = pending.filter((message) => message !== item); render(state); }
        else { item.eventId = state.eventId; item.status = "accepted"; await refreshState(); }
      } catch (error) {
        if (epoch !== generation) break;
        item.status = "failed"; $("notice").textContent = error.message;
        // A failed request may still have reached the server. Refresh, never auto resend.
        await refreshState();
      }
      renderHistory();
    }
  } finally {
    sending = false; setControls(); scheduleRefresh();
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
  const log = $("history"); followHistory = log.scrollHeight - log.scrollTop - log.clientHeight < 64;
});
$("setup").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  operate(async () => {
    const state = await api("/api/start", { strategy: data.get("strategy"), seed: Number(data.get("seed")),
      visualAid: data.get("visualAid") === "on", referenceMemory: data.get("referenceMemory") === "on", version: 2 });
    generation++; resetLocal(); preparing = false; return state;
  });
});
$("chat").addEventListener("submit", (event) => {
  event.preventDefault();
  if (working || !dialogueOpen()) return;
  const text = $("utterance").value;
  if (!text.trim()) return;
  pending.push({ text, status: "queued" });
  $("utterance").value = ""; followHistory = true; renderHistory();
  $("utterance").focus({ preventScroll: true }); drainMessages();
});
$("utterance").addEventListener("compositionstart", () => { composing = true; });
$("utterance").addEventListener("compositionend", () => { composing = false; });
$("utterance").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
  event.preventDefault(); if (!event.repeat && !working && dialogueOpen()) $("chat").requestSubmit();
});
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
  if (working || sending || !dialogueOpen()) return;
  if (!scene()?.shapes?.length || scene().shapes.some((shape) => !answers.has(shape.id))) {
    $("submission-status").textContent = "未回答の図形があります。図形を選んで名前か「未合意・わからない」を入力してください。"; return;
  }
  addScene($("confirm-scene"), false);
  $("confirm-dialog").showModal(); $("confirm-cancel").focus({ preventScroll: true });
});
$("confirm-cancel").addEventListener("click", () => closeDialog("confirm-dialog"));
$("confirm-submit").addEventListener("click", () => {
  if (working || sending || !dialogueOpen()) return;
  const names = Object.fromEntries(scene().shapes.map((shape) => [shape.id, answers.get(shape.id)]));
  closeDialog("confirm-dialog");
  operate(() => api("/api/names", { names, confirm: true }));
});
$("new-trial").addEventListener("click", () => {
  preparing = true; clearTimeout(refreshTimer);
  $("setup").hidden = false; $("trial").hidden = true; $("setup").elements.seed.focus();
});
operate(() => api("/api/state"));
