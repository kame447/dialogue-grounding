#!/usr/bin/env node
const args = process.argv.slice(2);
const option = (key) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
const base = option("--base"),
  room = option("--room"),
  token = process.env.DG_AGENT_TOKEN || option("--token"),
  name = option("--name") || "stub",
  once = args.includes("--once");
if (!base || !room || !token) {
  console.error(
    "Usage: node agent/stub-agent.mjs --base URL --room ID --token TOKEN [--name stub] [--once]",
  );
  process.exit(2);
}
const path = `/api/agent/rooms/${room}/ws`,
  url = new URL(path, base);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
let stopping = false,
  attempt = 0,
  done = false,
  socket;
const log = (event) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
function decide(snapshot, event) {
  if (event.type === "chat" && event.message?.from === "partner")
    return {
      type: "chat",
      clientId: `stub-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: [
        "（外部エージェント・スタブ）メッセージを受け取りました。",
        "図形の名前を一緒に考えましょう。",
      ].join(""),
    };
  if (event.type === "snapshot" && snapshot?.phase === "naming" && !done)
    return {
      type: "submit_names",
      names: Object.fromEntries(
        // Post-conversation answers: a name, or null = "not agreed / don't know".
        snapshot.figures.map((f, i) => [f.slot, i === 0 ? null : `スタブ名-${f.slot.slice(0, 6)}`]),
      ),
    };
  return null;
}
function connect() {
  if (stopping) return;
  socket = new WebSocket(url);
  let snapshot = null;
  socket.addEventListener("open", () => {
    attempt = 0;
    socket.send(
      JSON.stringify({ type: "hello", protocol: 2, token, agent: name }),
    );
    log({ event: "connected", room });
  });
  socket.addEventListener("message", (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type === "snapshot") snapshot = data.state;
    if (data.type === "error") {
      log({ event: "error", code: data.code });
      if (["bad_token", "not_found", "expired"].includes(data.code)) {
        stopping = true;
        process.exitCode = 1;
        socket.close();
      }
      return;
    }
    log({
      event: data.type,
      ...(data.code ? { code: data.code } : {}),
      ...(data.state ? { phase: data.state.phase } : {}),
      ...(data.message ? { text: data.message.text } : {}),
    });
    if (data.type === "deleted") {
      stopping = true;
      process.exitCode = 1;
      socket.close();
      return;
    }
    if (data.type === "snapshot" && data.state.phase === "naming" && !done) {
      const response = decide(snapshot, data);
      if (response) {
        done = true;
        socket.send(JSON.stringify(response));
        if (once)
          setTimeout(() => {
            stopping = true;
            socket.close(1000, "complete");
          }, 100);
      }
    }
    if (data.type === "chat") {
      const response = decide(snapshot, data);
      if (response)
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify(response));
        }, 500);
    }
  });
  socket.addEventListener("close", (e) => {
    log({ event: "closed", code: e.code });
    if (stopping) return;
    if (once && done) {
      stopping = true;
      return;
    }
    const wait = Math.min(30000, 500 * 2 ** Math.min(attempt++, 6));
    setTimeout(connect, wait);
  });
  socket.addEventListener("error", () => log({ event: "socket_error" }));
}
process.on("SIGINT", () => {
  stopping = true;
  socket?.close(1000, "interrupt");
});
connect();
