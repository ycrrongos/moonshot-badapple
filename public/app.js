const api = async (url, options) => {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const page = document.getElementById("page");
const timerEl = document.getElementById("timer");
const layer = document.getElementById("danmaku-layer");
const frameLayer = document.getElementById("frame-layer");
const framePre = document.getElementById("frame-pre");
const form = document.getElementById("message-form");
const contentEl = document.getElementById("content");
const sendBtn = document.getElementById("send-btn");
const advancedBtn = document.getElementById("advanced-btn");
const noticeEl = document.getElementById("notice");
const themeToggle = document.getElementById("theme-toggle");
const fullscreenBtn = document.getElementById("fullscreen");
const placeLayer = document.getElementById("place-layer");
const placePreview = document.getElementById("place-preview");
const placeSeconds = document.getElementById("place-seconds");
const placeConfirm = document.getElementById("place-confirm");
const placeCancel = document.getElementById("place-cancel");

let targetTime = Date.now() + 3600_000;
let theme = localStorage.getItem("countdown-theme") || "dark-orange";
let laneCursor = 0;
const nodes = new Map();
let sending = false;
let placing = false;
let placeX = 50;
let placeY = 40;

function applyTheme(next) {
  theme = next;
  page.classList.remove("theme-dark-orange", "theme-orange-white");
  page.classList.add(`theme-${theme}`);
  themeToggle.textContent = theme === "dark-orange" ? "切换为橙底白字" : "切换为黑底橙字";
  localStorage.setItem("countdown-theme", theme);
}

function showNotice(text) {
  if (!text) {
    noticeEl.hidden = true;
    noticeEl.textContent = "";
    return;
  }
  noticeEl.hidden = false;
  noticeEl.textContent = text;
}

function renderTimer(ms) {
  const parts = [
    Math.floor(ms / 3_600_000),
    Math.floor(ms / 60_000) % 60,
    Math.floor(ms / 1000) % 60,
    ms % 1000,
  ];
  const labels = ["小时", "分钟", "秒", "毫秒"];
  timerEl.innerHTML = parts
    .map((value, i) => {
      const pad = i === 3 ? 3 : 2;
      const segment = `<div class="timer-segment"><div class="timer-value">${String(value).padStart(pad, "0")}</div><div class="time-label">${labels[i]}</div></div>`;
      const colon = i < 3 ? `<div class="timer-colon">:</div>` : "";
      return segment + colon;
    })
    .join("");
}

function markDone(id) {
  api(`/api/messages/${id}/done`, { method: "POST" }).catch(() => {});
}

function removeNode(id, notifyServer) {
  const el = nodes.get(id);
  if (el) {
    el.remove();
    nodes.delete(id);
  }
  if (notifyServer) markDone(id);
}

function spawnDanmaku(message) {
  if (nodes.has(message.id)) return;

  const el = document.createElement("div");
  el.className = "danmaku";
  el.dataset.id = message.id;
  el.textContent = message.content;

  const durationMs = message.durationMs || 10000;
  const lane = Number.isInteger(message.lane) ? message.lane % 12 : laneCursor++ % 12;
  el.style.top = `${6 + (lane % 12) * 7}vh`;
  el.style.animationDuration = `${durationMs}ms`;

  el.addEventListener("animationend", () => removeNode(message.id, true));
  layer.appendChild(el);
  nodes.set(message.id, el);
}

function spawnFixed(message) {
  if (nodes.has(message.id)) return;

  const el = document.createElement("div");
  el.className = "danmaku fixed";
  el.dataset.id = message.id;
  el.textContent = message.content;
  el.style.left = `${Number(message.x) || 50}%`;
  el.style.top = `${Number(message.y) || 40}%`;

  const durationMs = Math.min(10000, Math.max(100, Number(message.durationMs) || 3000));
  layer.appendChild(el);
  nodes.set(message.id, el);
  setTimeout(() => removeNode(message.id, true), durationMs);
}

function showFrame(message) {
  framePre.textContent = message.content;
  frameLayer.hidden = false;
}

function clearAll() {
  for (const el of nodes.values()) el.remove();
  nodes.clear();
  framePre.textContent = "";
  frameLayer.hidden = true;
}

function syncAdvancedButton() {
  advancedBtn.hidden = !contentEl.value.trim() || placing;
}

function setPlacePosition(xPercent, yPercent) {
  placeX = Math.min(100, Math.max(0, xPercent));
  placeY = Math.min(100, Math.max(0, yPercent));
  placePreview.style.left = `${placeX}%`;
  placePreview.style.top = `${placeY}%`;
}

function openPlacement() {
  const content = contentEl.value;
  if (!content.trim() || placing) return;
  placing = true;
  form.hidden = true;
  syncAdvancedButton();
  placePreview.textContent = content;
  setPlacePosition(50, 40);
  placeLayer.hidden = false;
}

function closePlacement() {
  placing = false;
  placeLayer.hidden = true;
  form.hidden = false;
  syncAdvancedButton();
}

function bindPlacementDrag() {
  let dragging = false;

  const onMove = (clientX, clientY) => {
    if (!dragging) return;
    const x = (clientX / window.innerWidth) * 100;
    const y = (clientY / window.innerHeight) * 100;
    setPlacePosition(x, y);
  };

  placePreview.addEventListener("pointerdown", (event) => {
    dragging = true;
    placePreview.classList.add("dragging");
    placePreview.setPointerCapture(event.pointerId);
    onMove(event.clientX, event.clientY);
  });

  placePreview.addEventListener("pointermove", (event) => {
    onMove(event.clientX, event.clientY);
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    placePreview.classList.remove("dragging");
    try {
      placePreview.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  placePreview.addEventListener("pointerup", endDrag);
  placePreview.addEventListener("pointercancel", endDrag);
}

async function bootstrap() {
  applyTheme(theme === "orange-white" ? "orange-white" : "dark-orange");
  try {
    const cfg = await api("/api/config");
    targetTime = Date.parse(cfg.targetTime);
    if (!localStorage.getItem("countdown-theme") && cfg.theme) {
      applyTheme(cfg.theme === "orange-white" ? "orange-white" : "dark-orange");
    }
  } catch (err) {
    showNotice(err.message);
  }

  // 不拉历史；只在 WebSocket hello 里同步当前仍在显示的弹幕
  api("/api/visit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screenWidth: screen.width,
      screenHeight: screen.height,
      pixelRatio: devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      touchPoints: navigator.maxTouchPoints,
      referrer: document.referrer,
    }),
  }).catch(() => {});
}

function applyLiveMessage(message) {
  if (!message?.id) return;
  if (message.mode === "fixed") spawnFixed(message);
  else spawnDanmaku(message);
}

function connectLive() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "hello") {
        if (Array.isArray(data.messages)) data.messages.forEach(applyLiveMessage);
        if (data.frame) showFrame(data.frame);
        if (data.config?.targetTime) targetTime = Date.parse(data.config.targetTime);
      }
      if (data.type === "danmaku") spawnDanmaku(data.message);
      if (data.type === "fixed") spawnFixed(data.message);
      if (data.type === "frame") showFrame(data.message);
      if (data.type === "danmaku_deleted") removeNode(data.id, false);
      if (data.type === "clear") clearAll();
      if (data.type === "config" && data.config?.targetTime) {
        targetTime = Date.parse(data.config.targetTime);
      }
    } catch (err) {
      console.error("Invalid live event", err);
    }
  };

  ws.onclose = () => setTimeout(connectLive, 1000);
  ws.onerror = () => ws.close();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = contentEl.value;
  if (!content.trim() || sending || placing) return;
  sending = true;
  sendBtn.disabled = true;
  advancedBtn.disabled = true;
  showNotice("");
  try {
    await api("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, mode: "danmaku" }),
    });
    contentEl.value = "";
    syncAdvancedButton();
  } catch (err) {
    showNotice(err.message);
  } finally {
    sending = false;
    sendBtn.disabled = false;
    advancedBtn.disabled = false;
  }
});

contentEl.addEventListener("input", syncAdvancedButton);
contentEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

advancedBtn.addEventListener("click", openPlacement);
placeCancel.addEventListener("click", closePlacement);

placeConfirm.addEventListener("click", async () => {
  const content = contentEl.value;
  let seconds = Number(placeSeconds.value);
  if (!Number.isFinite(seconds)) seconds = 3;
  seconds = Math.min(10, Math.max(0.1, seconds));
  placeSeconds.value = String(seconds);

  if (!content.trim() || sending) return;
  sending = true;
  placeConfirm.disabled = true;
  showNotice("");
  try {
    await api("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        mode: "fixed",
        x: placeX,
        y: placeY,
        durationMs: Math.round(seconds * 1000),
      }),
    });
    contentEl.value = "";
    closePlacement();
  } catch (err) {
    showNotice(err.message);
  } finally {
    sending = false;
    placeConfirm.disabled = false;
  }
});

themeToggle.addEventListener("click", () => {
  applyTheme(theme === "dark-orange" ? "orange-white" : "dark-orange");
});

fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

bindPlacementDrag();
setInterval(() => renderTimer(Math.max(0, targetTime - Date.now())), 10);
syncAdvancedButton();
bootstrap();
connectLive();
