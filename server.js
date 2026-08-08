import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 80;

const state = {
  targetTime: process.env.TARGET_TIME || "2026-08-09T06:30:00.000Z",
  theme: "dark-orange",
  /** @type {Map<string, any>} 仅内存中的“正在显示”弹幕，播完即删，不落盘 */
  active: new Map(),
  timers: new Map(),
  frame: null,
};

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(join(__dirname, "public")));

function publicMessage(msg) {
  return {
    id: msg.id,
    content: msg.content,
    createdAt: msg.createdAt,
    mode: msg.mode,
    durationMs: msg.durationMs,
    lane: msg.lane,
    x: msg.x,
    y: msg.y,
  };
}

function clearTimer(id) {
  const t = state.timers.get(id);
  if (t) clearTimeout(t);
  state.timers.delete(id);
}

function forgetMessage(id, broadcastDelete = true) {
  const existed = state.active.delete(id);
  clearTimer(id);
  if (existed && broadcastDelete) {
    broadcast({ type: "danmaku_deleted", id });
  }
  return existed;
}

function scheduleExpiry(message) {
  clearTimer(message.id);
  const ttl = Math.max(100, Number(message.durationMs) || 10000) + 300;
  const timer = setTimeout(() => forgetMessage(message.id, true), ttl);
  state.timers.set(message.id, timer);
}

app.get("/api/config", (_req, res) => {
  res.json({ targetTime: state.targetTime, theme: state.theme });
});

app.post("/api/config", (req, res) => {
  if (typeof req.body?.targetTime === "string") state.targetTime = req.body.targetTime;
  if (req.body?.theme === "orange-white" || req.body?.theme === "dark-orange") {
    state.theme = req.body.theme;
  }
  broadcast({ type: "config", config: { targetTime: state.targetTime, theme: state.theme } });
  res.json({ ok: true, targetTime: state.targetTime, theme: state.theme });
});

app.post("/api/visit", (_req, res) => {
  res.status(204).end();
});

/** 只返回当前仍在屏幕上的弹幕（内存），不提供历史 */
app.get("/api/messages", (_req, res) => {
  const messages = [...state.active.values()].map(publicMessage);
  res.json({ messages, frame: state.frame ? publicMessage(state.frame) : null });
});

app.post("/api/messages", (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  if (!content.trim()) {
    return res.status(400).json({ error: "弹幕不能为空" });
  }

  const rawMode = req.body?.mode;
  const mode =
    rawMode === "frame" ? "frame" : rawMode === "fixed" || rawMode === "advanced" ? "fixed" : "danmaku";

  let durationMs = Number(req.body?.durationMs);
  if (mode === "fixed") {
    if (!Number.isFinite(durationMs)) durationMs = 3000;
    durationMs = Math.min(10000, Math.max(100, durationMs));
  } else if (mode === "danmaku") {
    if (!Number.isFinite(durationMs) || durationMs <= 0) durationMs = 10000;
  }

  const lane = Number(req.body?.lane);
  let x = Number(req.body?.x);
  let y = Number(req.body?.y);
  if (mode === "fixed") {
    if (!Number.isFinite(x)) x = 50;
    if (!Number.isFinite(y)) y = 40;
    x = Math.min(100, Math.max(0, x));
    y = Math.min(100, Math.max(0, y));
  } else {
    x = undefined;
    y = undefined;
  }

  const message = {
    id: randomUUID(),
    content,
    createdAt: Date.now(),
    mode,
    durationMs: mode === "frame" ? undefined : durationMs,
    lane: mode === "danmaku" && Number.isInteger(lane) && lane >= 0 ? lane : undefined,
    x,
    y,
  };

  if (mode === "frame") {
    state.frame = message;
    broadcast({ type: "frame", message: publicMessage(message) });
    return res.status(201).json({ ok: true, message: publicMessage(message) });
  }

  state.active.set(message.id, message);
  scheduleExpiry(message);
  broadcast({ type: mode === "fixed" ? "fixed" : "danmaku", message: publicMessage(message) });
  res.status(201).json({ ok: true, message: publicMessage(message) });
});

/** 客户端显示结束后回调：从内存删除 */
app.post("/api/messages/:id/done", (req, res) => {
  const ok = forgetMessage(req.params.id, true);
  res.json({ ok });
});

app.delete("/api/messages/:id", (req, res) => {
  const ok = forgetMessage(req.params.id, true);
  res.json({ ok });
});

app.post("/api/clear", (_req, res) => {
  for (const id of [...state.active.keys()]) forgetMessage(id, false);
  state.frame = null;
  broadcast({ type: "clear" });
  res.json({ ok: true });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/live" });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "hello",
      config: { targetTime: state.targetTime, theme: state.theme },
      messages: [...state.active.values()].map(publicMessage),
      frame: state.frame ? publicMessage(state.frame) : null,
    }),
  );
});

server.listen(PORT, () => {
  console.log(`local countdown: http://127.0.0.1:${PORT}`);
});
