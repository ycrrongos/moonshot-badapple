#!/usr/bin/env python3
"""Bad Apple → 本地倒计时 frame 弹幕播放器.

用法:
  # 1) 先把视频放到 media/badapple.mp4（或用 --video 指定）
  # 2) 预渲染帧缓存（可选，但推荐）
  python3 scripts/badapple.py prepare --video media/badapple.mp4

  # 3) 开播（默认打到本机 80 端口）
  python3 scripts/badapple.py play --host http://172.30.30.209

默认不会自动播放；需要显式执行 play。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VIDEO = ROOT / "media" / "badapple.mp4"
DEFAULT_CACHE = ROOT / "media" / "badapple_frames"
DEFAULT_HOST = "http://127.0.0.1"

# Braille dot bit order (Unicode U+2800)
# 1 4
# 2 5
# 3 6
# 7 8
DOT_MAP = (
    (0x01, 0x08),
    (0x02, 0x10),
    (0x04, 0x20),
    (0x40, 0x80),
)


def require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise SystemExit("需要系统安装 ffmpeg / ffprobe")


def probe_fps(video: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=r_frame_rate",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            str(video),
        ],
        text=True,
    ).strip()
    if "/" in out:
        num, den = out.split("/", 1)
        return float(num) / float(den)
    return float(out)


def frame_to_braille(gray: np.ndarray, threshold: int, invert: bool) -> str:
    """Convert HxW grayscale to braille text. Each cell is 2x4 pixels."""
    h, w = gray.shape
    # pad to multiples of 2x4
    pad_h = (4 - h % 4) % 4
    pad_w = (2 - w % 2) % 2
    if pad_h or pad_w:
        gray = np.pad(gray, ((0, pad_h), (0, pad_w)), mode="constant", constant_values=0)

    if invert:
        bits = gray < threshold
    else:
        bits = gray >= threshold

    rows = []
    for y in range(0, bits.shape[0], 4):
        chars = []
        for x in range(0, bits.shape[1], 2):
            value = 0
            block = bits[y : y + 4, x : x + 2]
            for dy in range(4):
                for dx in range(2):
                    if block[dy, dx]:
                        value |= DOT_MAP[dy][dx]
            chars.append(chr(0x2800 + value))
        rows.append("".join(chars))
    return "\n".join(rows)


def iter_video_frames(video: Path, width: int, height: int, fps: float | None):
    require_ffmpeg()
    # height/width here are pixel sizes before braille packing
    vf = [f"scale={width}:{height}:flags=lanczos", "format=gray"]
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video),
    ]
    if fps:
        cmd += ["-r", str(fps)]
    cmd += [
        "-vf",
        ",".join(vf),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    assert proc.stdout is not None
    frame_size = width * height
    try:
        while True:
            buf = proc.stdout.read(frame_size)
            if len(buf) < frame_size:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape((height, width))
    finally:
        proc.stdout.close()
        proc.wait()


def post_frame(host: str, content: str, timeout: float = 5.0) -> None:
    url = host.rstrip("/") + "/api/messages"
    payload = json.dumps({"content": content, "mode": "frame"}).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        res.read()


def cmd_prepare(args: argparse.Namespace) -> int:
    video = Path(args.video)
    if not video.is_file():
        raise SystemExit(f"找不到视频: {video}")

    cache = Path(args.cache)
    if cache.exists() and any(cache.iterdir()) and not args.force:
        raise SystemExit(f"缓存目录已存在: {cache}（加 --force 可覆盖）")

    if cache.exists() and args.force:
        shutil.rmtree(cache)
    cache.mkdir(parents=True, exist_ok=True)

    src_fps = probe_fps(video)
    out_fps = args.fps or min(src_fps, 15.0)
    # braille cells: width_chars x height_chars → pixels = chars*2 x chars*4
    px_w = args.width * 2
    px_h = args.height * 4

    meta = {
        "video": str(video.resolve()),
        "fps": out_fps,
        "width_chars": args.width,
        "height_chars": args.height,
        "threshold": args.threshold,
        "invert": args.invert,
    }
    (cache / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        f"prepare: {video.name} → {cache} | {args.width}x{args.height} cells @ {out_fps:.3f}fps",
        flush=True,
    )

    count = 0
    for gray in iter_video_frames(video, px_w, px_h, out_fps):
        text = frame_to_braille(gray, args.threshold, args.invert)
        (cache / f"{count:06d}.txt").write_text(text + "\n", encoding="utf-8")
        count += 1
        if count % 50 == 0:
            print(f"  rendered {count} frames", flush=True)

    print(f"done: {count} frames", flush=True)
    return 0


def load_cached_frames(cache: Path) -> tuple[dict, list[Path]]:
    meta_path = cache / "meta.json"
    if not meta_path.is_file():
        raise SystemExit(f"缓存无效，缺少 meta.json: {cache}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    frames = sorted(cache.glob("*.txt"))
    if not frames:
        raise SystemExit(f"缓存为空: {cache}")
    return meta, frames


def cmd_play(args: argparse.Namespace) -> int:
    host = args.host
    cache = Path(args.cache)

    if args.video:
        # live convert path
        video = Path(args.video)
        if not video.is_file():
            raise SystemExit(f"找不到视频: {video}")
        src_fps = probe_fps(video)
        out_fps = args.fps or min(src_fps, 15.0)
        px_w = args.width * 2
        px_h = args.height * 4
        frame_iter = (
            frame_to_braille(gray, args.threshold, args.invert)
            for gray in iter_video_frames(video, px_w, px_h, out_fps)
        )
        fps = out_fps
        total = None
        print(f"play(live): {video} → {host} @ {fps:.3f}fps", flush=True)
    else:
        meta, files = load_cached_frames(cache)
        fps = args.fps or float(meta["fps"])
        total = len(files)
        frame_iter = (p.read_text(encoding="utf-8").rstrip("\n") for p in files)
        print(f"play(cache): {cache} ({total} frames) → {host} @ {fps:.3f}fps", flush=True)

    if args.dry_run:
        first = next(frame_iter, "")
        print("--- first frame preview ---")
        print(first)
        print("--- dry-run: not sending ---")
        return 0

    interval = 1.0 / fps
    start = time.perf_counter()
    sent = 0
    try:
        for text in frame_iter:
            target = start + sent * interval
            now = time.perf_counter()
            if target > now:
                time.sleep(target - now)
            # skip-to-realtime if we fell behind too much
            behind = time.perf_counter() - (start + sent * interval)
            if behind > interval * 2:
                skip = int(behind // interval)
                for _ in range(skip):
                    try:
                        next(frame_iter)
                        sent += 1
                    except StopIteration:
                        break
            try:
                post_frame(host, text)
            except urllib.error.URLError as err:
                raise SystemExit(f"发送失败: {err}") from err
            sent += 1
            if sent % 30 == 0:
                extra = f"/{total}" if total else ""
                print(f"  sent {sent}{extra}", flush=True)
    except KeyboardInterrupt:
        print(f"\nstopped at frame {sent}", flush=True)
        return 130

    print(f"finished: {sent} frames", flush=True)
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    cache = Path(args.cache)
    if cache.is_dir() and (cache / "meta.json").is_file():
        meta, frames = load_cached_frames(cache)
        print(json.dumps({"cache": str(cache), "frames": len(frames), **meta}, ensure_ascii=False, indent=2))
    else:
        print(f"no cache at {cache}")
    video = Path(args.video)
    if video.is_file():
        print(f"video: {video} fps={probe_fps(video):.3f}")
    else:
        print(f"video missing: {video}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Bad Apple braille frame player")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--video", default=str(DEFAULT_VIDEO), help="源视频路径")
    common.add_argument("--cache", default=str(DEFAULT_CACHE), help="帧缓存目录")
    common.add_argument("--width", type=int, default=60, help="braille 字符宽度（默认 60）")
    common.add_argument("--height", type=int, default=22, help="braille 字符高度（默认 22）")
    common.add_argument("--fps", type=float, default=None, help="输出帧率（默认 min(源fps,15)）")
    common.add_argument("--threshold", type=int, default=128, help="二值化阈值 0-255")
    common.add_argument("--invert", action="store_true", help="反色（黑底白字视频常用）")

    prep = sub.add_parser("prepare", parents=[common], help="预渲染帧到缓存")
    prep.add_argument("--force", action="store_true", help="覆盖已有缓存")
    prep.set_defaults(func=cmd_prepare)

    play = sub.add_parser("play", parents=[common], help="按帧推送到 /api/messages mode=frame")
    play.add_argument("--host", default=DEFAULT_HOST, help="目标站点，如 http://172.30.30.209")
    play.add_argument(
        "--from-video",
        dest="from_video",
        action="store_true",
        help="不读缓存，直接从视频实时转换发送",
    )
    play.add_argument("--dry-run", action="store_true", help="只预览第一帧，不发送")
    play.set_defaults(func=cmd_play)

    info = sub.add_parser("info", parents=[common], help="查看视频/缓存信息")
    info.set_defaults(func=cmd_info)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # play 默认走缓存；只有 --from-video 才强制用视频实时转
    if args.cmd == "play" and not args.from_video:
        args.video = None
    elif args.cmd == "play" and args.from_video:
        args.video = args.video  # keep

    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
