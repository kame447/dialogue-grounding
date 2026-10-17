const $ = (id) => document.getElementById(id);
let current = null;
let working = false;
let serverBusy = false;
let refreshTimer;
const errors = {
  ai_unavailable: "AIに接続できませんでした。公開対話は直前の確定状態を保持しています。",
  invalid_ai_submission: "AIの最終提出を検証できませんでした。この試行は照合できません。",
  repository_output_forbidden: "記録先はリポジトリ外に設定してください。",
  record_write_failed: "研究記録を保存できませんでした。研究者が保存先を確認してください。",
  invalid_seed: "Seedを安全な整数で入力してください。",
  busy: "処理中です。完了を待ってください。",
};
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(errors[value.error] || "操作を完了できませんでした。研究者が設定や試行状態を確認してください。");
  return value;
}
function render({ trial, busy = false }) {
  current = trial;
  serverBusy = busy;
  clearTimeout(refreshTimer);
  if (busy) refreshTimer = setTimeout(() => operate(() => api("/api/state")), 1000);
  $("setup").hidden = Boolean(trial);
  $("trial").hidden = !trial;
  if (!trial) return;
  if (!$("board").getAttribute("src")) $("board").src = "/api/image";
  $("history").replaceChildren(...trial.publicHistory.map((item) => {
    const li = document.createElement("li");
    li.className = item.role === "assistant" ? "ai" : "human";
    const who = document.createElement("strong");
    who.textContent = item.role === "assistant" ? "AI" : "あなた";
    li.append(who, document.createTextNode(item.content));
    return li;
  }));
  $("history").scrollTop = $("history").scrollHeight;
  if (!$("names").children.length) {
    trial.slots.forEach((slot) => {
      const label = document.createElement("label");
      label.textContent = slot;
      const input = document.createElement("input");
      input.name = slot;
      input.maxLength = 200;
      input.autocomplete = "off";
      label.append(input);
      $("names").append(label);
    });
  }
  if (trial.humanSubmission) trial.slots.forEach((slot) => { $("submission").elements[slot].value = trial.humanSubmission[slot]; });
  $("submission-status").textContent = trial.status === "submission_error" ? "AIの提出エラーにより照合できません。研究者がこの試行を確認してください。" :
    trial.result ? "双方の提出が完了しました。" : trial.humanSubmitted ? "あなたの提出を確定しました。" :
      trial.aiSubmitted ? "AIは提出済みです。内容はあなたの提出後に表示されます。" : "あなたの名称は公開対話に送信されません。";
  $("new-trial").hidden = !["completed", "submission_error"].includes(trial.status);
  $("results").hidden = !trial.result;
  if (trial.result) renderResult(trial.result);
  setControls();
}
function renderResult(result) {
  $("result-body").replaceChildren();
  const p = document.createElement("p");
  p.textContent = "暫定採点（provisional）: " + (result.success ? "6図形の名称が一致し、名称の重複はありません。" : "一致・不一致および未命名を下で確認してください。");
  $("result-body").append(p);
  // The scoring module owns normalization and figure correspondence.
  const rows = result.figures;
  if (Array.isArray(rows)) {
    const table = document.createElement("table");
    const head = document.createElement("tr");
    ["あなたの位置", "あなたの名称", "AIの名称", "暫定照合"].forEach((text) => { const th = document.createElement("th"); th.textContent = text; head.append(th); });
    table.append(head);
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [row.human?.slot ?? "", row.human?.rawName ?? "", row.ai?.rawName ?? "", row.matched ? "一致" : "不一致"].forEach((text) => {
        const td = document.createElement("td"); td.textContent = text; tr.append(td);
      });
      table.append(tr);
    });
    $("result-body").append(table);
  }
  const details = document.createElement("details");
  const summary = document.createElement("summary"); summary.textContent = "暫定採点の詳細";
  const pre = document.createElement("pre"); pre.textContent = JSON.stringify(result, null, 2);
  details.append(summary, pre); $("result-body").append(details);
}
function setControls() {
  document.querySelectorAll("button").forEach((button) => { button.disabled = working || serverBusy; });
  $("chat").querySelectorAll("textarea,button").forEach((control) => { control.disabled = working || serverBusy || current?.status !== "dialogue"; });
  $("submission").querySelectorAll("input,button").forEach((control) => { control.disabled = working || serverBusy || current?.humanSubmitted || current?.status === "submission_error"; });
}
async function operate(action) {
  if (working) return;
  working = true; $("notice").textContent = "処理中…"; setControls();
  try { render(await action()); $("notice").textContent = ""; }
  catch (error) {
    $("notice").textContent = error.message;
    try { render(await api("/api/state")); } catch { /* Keep the last confirmed state. */ }
  } finally { working = false; setControls(); }
}
$("setup").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  operate(async () => {
    const state = await api("/api/start", { strategy: data.get("strategy"), seed: Number(data.get("seed")) });
    $("board").removeAttribute("src");
    $("names").replaceChildren();
    return state;
  });
});
$("chat").addEventListener("submit", (event) => {
  event.preventDefault();
  const utterance = $("utterance").value;
  operate(async () => { const state = await api("/api/turn", { utterance }); $("utterance").value = ""; return state; });
});
$("submission").addEventListener("submit", (event) => {
  event.preventDefault();
  const submission = Object.fromEntries(new FormData(event.target));
  operate(() => api("/api/submit", { submission }));
});
$("new-trial").addEventListener("click", () => {
  $("setup").hidden = false;
  $("trial").hidden = true;
  $("setup").elements.seed.focus();
});
operate(() => api("/api/state"));
