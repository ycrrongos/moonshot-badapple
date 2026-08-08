import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import { join, extname } from "path";
import { randomUUID } from "crypto";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Media /haha control helpers: uploads, convert, playback loops.
 */
export function createMediaHub({
  rootDir,
  broadcast,
  ingestFixedFrame,
  clearDanmaku,
}) {
  const uploadsDir = join(rootDir, "uploads");
  const jobsDir = join(rootDir, "data", "jobs");
  const scriptsDir = join(rootDir, "scripts");

  const catalog = {
    videos: [],
    music: [],
    backgrounds: [],
  };

  const playback = {
    kind: null, // video | music | null
    id: null,
    withAudio: false,
    spectrum: false,
    audioUrl: null,
    startedAt: null,
    stop: null,
  };

  let backgroundUrl = null;

  async function ensureDirs() {
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.mkdir(jobsDir, { recursive: true });
  }

  function publicUrl(filename) {
    return `/uploads/${filename}`;
  }

  function mediaSnapshot() {
    return {
      videos: catalog.videos,
      music: catalog.music,
      backgrounds: catalog.backgrounds,
      backgroundUrl,
      playback: {
        kind: playback.kind,
        id: playback.id,
        withAudio: playback.withAudio,
        spectrum: playback.spectrum,
        audioUrl: playback.audioUrl,
        startedAt: playback.startedAt,
      },
    };
  }

  function emitMedia(action, extra = {}) {
    broadcast({
      type: "media",
      action,
      backgroundUrl,
      ...extra,
      playback: mediaSnapshot().playback,
    });
  }

  async function probeDuration(filePath) {
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", filePath],
        { timeout: 60_000 },
      );
      const n = Number(stdout.trim());
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  async function extractAudio(videoPath, outPath) {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", outPath],
      { timeout: 600_000 },
    );
  }

  function convertVideoToFrames(videoPath, cacheDir) {
    return new Promise((resolve, reject) => {
      const args = [
        join(scriptsDir, "badapple_advanced.py"),
        "prepare",
        "--video",
        videoPath,
        "--cache",
        cacheDir,
        "--force",
        "--fps",
        "10",
        "--width",
        "56",
        "--height",
        "20",
      ];
      const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => {
        err += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(err.trim() || `convert exit ${code}`));
      });
    });
  }

  async function addVideo(file) {
    const id = randomUUID();
    const ext = extname(file.originalname || "").toLowerCase() || ".mp4";
    const videoName = `${id}${ext}`;
    const videoPath = join(uploadsDir, videoName);
    await fs.rename(file.path, videoPath);

    const cacheDir = join(jobsDir, id);
    const audioName = `${id}.mp3`;
    const audioPath = join(uploadsDir, audioName);

    const entry = {
      id,
      name: file.originalname || videoName,
      videoUrl: publicUrl(videoName),
      audioUrl: null,
      cacheDir: `data/jobs/${id}`,
      status: "converting",
      error: null,
      duration: null,
      frames: 0,
      createdAt: Date.now(),
    };
    catalog.videos.unshift(entry);
    emitMedia("catalog");

    (async () => {
      try {
        await convertVideoToFrames(videoPath, cacheDir);
        try {
          await extractAudio(videoPath, audioPath);
          entry.audioUrl = publicUrl(audioName);
        } catch (err) {
          console.warn("[haha] extract audio failed", err.message);
        }
        const meta = JSON.parse(await fs.readFile(join(cacheDir, "meta.json"), "utf8"));
        const files = (await fs.readdir(cacheDir)).filter((f) => f.endsWith(".txt"));
        entry.frames = files.length;
        entry.duration = await probeDuration(videoPath);
        entry.fps = meta.fps;
        entry.status = "ready";
      } catch (err) {
        entry.status = "error";
        entry.error = String(err.message || err);
        console.error("[haha] convert failed", err);
      }
      emitMedia("catalog");
    })();

    return entry;
  }

  async function addMusic(file) {
    const id = randomUUID();
    const ext = extname(file.originalname || "").toLowerCase() || ".mp3";
    const name = `${id}${ext}`;
    const dest = join(uploadsDir, name);
    await fs.rename(file.path, dest);
    const entry = {
      id,
      name: file.originalname || name,
      audioUrl: publicUrl(name),
      duration: await probeDuration(dest),
      createdAt: Date.now(),
    };
    catalog.music.unshift(entry);
    emitMedia("catalog");
    return entry;
  }

  async function addBackground(file) {
    const id = randomUUID();
    const ext = extname(file.originalname || "").toLowerCase() || ".png";
    const name = `bg-${id}${ext}`;
    const dest = join(uploadsDir, name);
    await fs.rename(file.path, dest);
    const entry = {
      id,
      name: file.originalname || name,
      url: publicUrl(name),
      createdAt: Date.now(),
    };
    catalog.backgrounds.unshift(entry);
    emitMedia("catalog");
    return entry;
  }

  function stopPlayback({ keepBackground = true } = {}) {
    if (typeof playback.stop === "function") {
      try {
        playback.stop();
      } catch {
        /* ignore */
      }
    }
    playback.kind = null;
    playback.id = null;
    playback.withAudio = false;
    playback.spectrum = false;
    playback.audioUrl = null;
    playback.startedAt = null;
    playback.stop = null;
    clearDanmaku();
    emitMedia("stop", { keepBackground });
  }

  async function playVideo(id, { withAudio = true, spectrum = false } = {}) {
    const entry = catalog.videos.find((v) => v.id === id);
    if (!entry) throw new Error("视频不存在");
    if (entry.status !== "ready") throw new Error(entry.status === "converting" ? "视频仍在转换中" : "视频不可用");

    stopPlayback();
    const cacheDir = join(rootDir, entry.cacheDir);
    const files = (await fs.readdir(cacheDir))
      .filter((f) => f.endsWith(".txt"))
      .sort();
    if (!files.length) throw new Error("没有可用帧");

    const meta = JSON.parse(await fs.readFile(join(cacheDir, "meta.json"), "utf8"));
    const fps = Number(meta.fps) || 10;
    const interval = 1000 / fps;
    const durationMs = Math.max(100, Math.round(interval + 30));
    let index = 0;
    let timer = null;
    let cancelled = false;

    playback.kind = "video";
    playback.id = id;
    playback.withAudio = Boolean(withAudio && entry.audioUrl);
    playback.spectrum = Boolean(spectrum);
    playback.audioUrl = playback.withAudio ? entry.audioUrl : null;
    playback.startedAt = Date.now();
    playback.stop = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };

    emitMedia("play", {
      audioUrl: playback.audioUrl,
      withAudio: playback.withAudio,
      spectrum: playback.spectrum,
      kind: "video",
      id,
    });

    const tick = async () => {
      if (cancelled) return;
      if (index >= files.length) {
        stopPlayback();
        return;
      }
      try {
        const text = await fs.readFile(join(cacheDir, files[index]), "utf8");
        ingestFixedFrame(text.trimEnd(), { x: 50, y: 45, durationMs });
      } catch (err) {
        console.error("[haha] frame read", err);
      }
      index += 1;
      timer = setTimeout(tick, interval);
    };
    tick();
    return mediaSnapshot().playback;
  }

  function playMusic(id, { spectrum = true } = {}) {
    const entry = catalog.music.find((m) => m.id === id);
    if (!entry) throw new Error("音乐不存在");
    stopPlayback();
    playback.kind = "music";
    playback.id = id;
    playback.withAudio = true;
    playback.spectrum = Boolean(spectrum);
    playback.audioUrl = entry.audioUrl;
    playback.startedAt = Date.now();
    playback.stop = () => {};
    emitMedia("play", {
      audioUrl: entry.audioUrl,
      withAudio: true,
      spectrum: playback.spectrum,
      kind: "music",
      id,
    });
    return mediaSnapshot().playback;
  }

  function setBackground(id) {
    if (!id) {
      backgroundUrl = null;
      emitMedia("background");
      return null;
    }
    const entry = catalog.backgrounds.find((b) => b.id === id);
    if (!entry) throw new Error("背景不存在");
    backgroundUrl = entry.url;
    emitMedia("background");
    return backgroundUrl;
  }

  return {
    uploadsDir,
    ensureDirs,
    mediaSnapshot,
    addVideo,
    addMusic,
    addBackground,
    playVideo,
    playMusic,
    stopPlayback,
    setBackground,
    get backgroundUrl() {
      return backgroundUrl;
    },
  };
}
