const api = async (url, options) => {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const videoFile = document.getElementById("video-file");
const musicFile = document.getElementById("music-file");
const bgFile = document.getElementById("bg-file");
const videoList = document.getElementById("video-list");
const musicList = document.getElementById("music-list");
const bgList = document.getElementById("bg-list");
const videoStatus = document.getElementById("video-status");
const nowPlaying = document.getElementById("now-playing");
const musicSpectrum = document.getElementById("music-spectrum");

let media = { videos: [], music: [], backgrounds: [], playback: {}, backgroundUrl: null };

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return "-";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderNow() {
  const p = media.playback || {};
  if (!p.kind) {
    nowPlaying.textContent = `未在播放\n背景: ${media.backgroundUrl || "无"}`;
    return;
  }
  nowPlaying.textContent = [
    `类型: ${p.kind}`,
    `id: ${p.id}`,
    `音频: ${p.withAudio ? p.audioUrl : "关"}`,
    `频谱弹幕: ${p.spectrum ? "开" : "关"}`,
    `背景: ${media.backgroundUrl || "无"}`,
  ].join("\n");
}

function renderVideos() {
  videoList.innerHTML = "";
  for (const v of media.videos) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <strong>${v.name}</strong>
      <span class="meta">${v.status}${v.frames ? ` · ${v.frames}帧` : ""}${v.duration ? ` · ${fmtDuration(v.duration)}` : ""}</span>
    `;
    if (v.status === "ready") {
      const playAudio = document.createElement("button");
      playAudio.textContent = "播放(含音频)";
      playAudio.onclick = () => playVideo(v.id, true, false);
      const playSilent = document.createElement("button");
      playSilent.textContent = "仅弹幕";
      playSilent.className = "ghost";
      playSilent.onclick = () => playVideo(v.id, false, false);
      const playSpec = document.createElement("button");
      playSpec.textContent = "播放+频谱";
      playSpec.onclick = () => playVideo(v.id, true, true);
      row.append(playAudio, playSilent, playSpec);
    } else if (v.status === "error") {
      const err = document.createElement("span");
      err.className = "error";
      err.textContent = v.error || "转换失败";
      row.append(err);
    }
    videoList.append(row);
  }
}

function renderMusic() {
  musicList.innerHTML = "";
  for (const m of media.music) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <strong>${m.name}</strong>
      <span class="meta">${fmtDuration(m.duration)}</span>
    `;
    const play = document.createElement("button");
    play.textContent = "播放";
    play.onclick = () => playMusic(m.id);
    row.append(play);
    musicList.append(row);
  }
}

function renderBackgrounds() {
  bgList.innerHTML = "";
  for (const b of media.backgrounds) {
    const row = document.createElement("div");
    row.className = "item";
    const img = document.createElement("img");
    img.src = b.url;
    img.alt = b.name;
    const name = document.createElement("strong");
    name.textContent = b.name;
    const apply = document.createElement("button");
    apply.textContent = media.backgroundUrl === b.url ? "使用中" : "设为背景";
    apply.disabled = media.backgroundUrl === b.url;
    apply.onclick = async () => {
      await api("/api/haha/background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: b.id }),
      });
      await refresh();
    };
    row.append(img, name, apply);
    bgList.append(row);
  }
}

function renderAll() {
  renderVideos();
  renderMusic();
  renderBackgrounds();
  renderNow();
}

async function refresh() {
  media = await api("/api/haha/media");
  renderAll();
}

async function upload(kind, fileInput, statusEl) {
  const file = fileInput.files?.[0];
  if (!file) throw new Error("请先选择文件");
  const body = new FormData();
  body.append("file", file);
  if (statusEl) statusEl.textContent = "上传中…";
  const data = await api(`/api/haha/upload/${kind}`, { method: "POST", body });
  fileInput.value = "";
  if (statusEl) {
    statusEl.textContent =
      kind === "video" ? "已上传，正在转换为弹幕帧…" : "上传完成";
  }
  await refresh();
  return data;
}

async function playVideo(id, withAudio, spectrum) {
  await api("/api/haha/play/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, withAudio, spectrum }),
  });
  await refresh();
}

async function playMusic(id) {
  await api("/api/haha/play/music", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, spectrum: musicSpectrum.checked }),
  });
  await refresh();
}

document.getElementById("video-upload").onclick = async () => {
  try {
    await upload("video", videoFile, videoStatus);
  } catch (err) {
    videoStatus.textContent = err.message;
    videoStatus.classList.add("error");
  }
};

document.getElementById("music-upload").onclick = async () => {
  try {
    await upload("music", musicFile);
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById("bg-upload").onclick = async () => {
  try {
    await upload("background", bgFile);
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById("bg-clear").onclick = async () => {
  await api("/api/haha/background", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: null }),
  });
  await refresh();
};

document.getElementById("stop-all").onclick = async () => {
  await api("/api/haha/stop", { method: "POST" });
  await refresh();
};

function connectLive() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "media") {
        if (data.action === "catalog" || data.action === "play" || data.action === "stop" || data.action === "background") {
          refresh().catch(() => {});
        }
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => setTimeout(connectLive, 1000);
  ws.onerror = () => ws.close();
}

refresh().catch((err) => {
  videoStatus.textContent = err.message;
  videoStatus.classList.add("error");
});
connectLive();
setInterval(() => refresh().catch(() => {}), 4000);
