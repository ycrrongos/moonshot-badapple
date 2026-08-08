import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "public");
const PORT = Number(process.env.PORT) || 80;
const REMOTE_HOST = (process.env.REMOTE_HOST || "http://46.62.212.36").replace(/\/$/, "");
const REMOTE_IP = REMOTE_HOST.replace(/^https?:\/\//, "").split("/")[0];
const REMOTE_RELAY = process.env.REMOTE_RELAY !== "0";
const REMOTE_POLL_MS = Math.max(2000, Number(process.env.REMOTE_POLL_MS) || 5000);
const QR_ROTATE_MS = Math.max(5000, Number(process.env.QR_ROTATE_MS) || 30_000);

function detectLocalIp() {
  if (process.env.LOCAL_IP) return process.env.LOCAL_IP;
  const nets = networkInterfaces();
  const found = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      found.push(net.address);
    }
  }
  return found.find((ip) => ip.startsWith("172.30."))
    || found.find((ip) => ip.startsWith("172."))
    || found[0]
    || "127.0.0.1";
}

function writeQrSvg(filename, url) {
  try {
    execFileSync("qrencode", ["-t", "SVG", "-o", join(publicDir, filename), url], { stdio: "ignore" });
  } catch (err) {
    console.warn(`[qr] qrencode failed for ${url}:`, err?.message || err);
  }
}

function refreshQrTargets() {
  const localIp = detectLocalIp();
  writeQrSvg("qr-remote.svg", `http://${REMOTE_IP}/`);
  writeQrSvg("qr-local.svg", `http://${localIp}/`);
  writeQrSvg("qr-code.svg", `http://${REMOTE_IP}/`);
  state.qrTargets = [
    { ip: REMOTE_IP, qr: "/qr-remote.svg", label: "remote" },
    { ip: localIp, qr: "/qr-local.svg", label: "local" },
  ];
  state.localIp = localIp;
  return state.qrTargets;
}

const state = {
  targetTime: process.env.TARGET_TIME || "2026-08-09T06:30:00.000Z",
  theme: "dark-orange",
  /** @type {Map<string, any>} 仅内存中的“正在显示”弹幕，播完即删，不落盘 */
  active: new Map(),
  timers: new Map(),
  frame: null,
  remoteSeen: new Set(),
  remoteStatus: { enabled: REMOTE_RELAY, host: REMOTE_HOST, connected: false, lastError: null },
  localIp: "127.0.0.1",
  qrTargets: [],
  qrRotateMs: QR_ROTATE_MS,
};

refreshQrTargets();

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
  res.json({
    targetTime: state.targetTime,
    theme: state.theme,
    remote: state.remoteStatus,
    localIp: state.localIp,
    qrRotateMs: state.qrRotateMs,
    qrTargets: state.qrTargets,
  });
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

function rememberRemoteId(id) {
  if (!id || state.remoteSeen.has(id)) return false;
  state.remoteSeen.add(id);
  if (state.remoteSeen.size > 5000) {
    const drop = [...state.remoteSeen].slice(0, 1000);
    for (const key of drop) state.remoteSeen.delete(key);
  }
  return true;
}

/** 把原站弹幕灌进本地队列并广播（不落盘，播完即删） */
function ingestRemoteMessage(remote, { durationMs = 10000 } = {}) {
  if (!remote?.content || !String(remote.content).trim()) return false;
  const remoteId = remote.id || `${remote.createdAt}:${remote.content}`;
  if (!rememberRemoteId(remoteId)) return false;

  const message = {
    id: randomUUID(),
    content: String(remote.content),
    createdAt: remote.createdAt || Date.now(),
    mode: "danmaku",
    durationMs,
    lane: undefined,
    x: undefined,
    y: undefined,
    source: "remote",
    remoteId,
  };
  state.active.set(message.id, message);
  scheduleExpiry(message);
  broadcast({ type: "danmaku", message: publicMessage(message) });
  return true;
}

async function pollRemoteHistory() {
  try {
    const res = await fetch(`${REMOTE_HOST}/api/messages?limit=30`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    // 原站列表是新→旧；从旧到新灌入，避免首屏顺序颠倒
    let n = 0;
    for (const msg of messages.slice().reverse()) {
      if (ingestRemoteMessage(msg)) n += 1;
    }
    if (n) console.log(`[remote] polled ${n} new message(s)`);
    state.remoteStatus.lastError = null;
  } catch (err) {
    state.remoteStatus.lastError = String(err?.message || err);
  }
}

function connectRemoteLive() {
  const wsUrl = REMOTE_HOST.replace(/^http/, "ws") + "/api/live";
  let socket;
  let retryTimer;
  let closed = false;

  const scheduleRetry = () => {
    if (closed) return;
    state.remoteStatus.connected = false;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, 1500);
  };

  const open = () => {
    socket = new WebSocket(wsUrl);
    socket.on("open", () => {
      state.remoteStatus.connected = true;
      state.remoteStatus.lastError = null;
      console.log(`[remote] live connected ${wsUrl}`);
      pollRemoteHistory();
    });
    socket.on("message", (raw) => {
      try {
        const data = JSON.parse(String(raw));
        if (data.type === "danmaku" && data.message) {
          ingestRemoteMessage(data.message);
        } else if (data.type === "danmaku_deleted" && data.id) {
          // 原站删了也不强行清本地；本地仍按飞行时长过期
          rememberRemoteId(data.id);
        }
      } catch (err) {
        console.error("[remote] bad event", err);
      }
    });
    socket.on("close", scheduleRetry);
    socket.on("error", (err) => {
      state.remoteStatus.lastError = String(err?.message || err);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });
  };

  open();
  setInterval(pollRemoteHistory, REMOTE_POLL_MS);
}

server.listen(PORT, () => {
  console.log(`local countdown: http://127.0.0.1:${PORT}`);
  console.log(`[qr] rotate every ${QR_ROTATE_MS}ms: ${state.qrTargets.map((t) => t.ip).join(" ↔ ")}`);
  // 网卡变化时刷新本地二维码
  setInterval(() => {
    const prev = state.localIp;
    refreshQrTargets();
    if (state.localIp !== prev) console.log(`[qr] local ip → ${state.localIp}`);
  }, 60_000);
  if (REMOTE_RELAY) {
    console.log(`[remote] relaying from ${REMOTE_HOST}`);
    connectRemoteLive();
  } else {
    console.log("[remote] relay disabled (REMOTE_RELAY=0)");
  }
});
