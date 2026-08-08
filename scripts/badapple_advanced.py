#!/usr/bin/env python3
"""用「高级弹幕」(mode=fixed) 推送 Bad Apple —— 纯命令行，不改/不嵌入网页.

流程:
  1. 将视频放到 media/badapple.mp4（或 --video）
  2. 预渲染（推荐）:
       python3 scripts/badapple_advanced.py prepare
  3. 需要开播时再执行（现在先别跑）:
       python3 scripts/badapple_advanced.py play --host http://172.30.30.209

每一帧作为一条固定位置高级弹幕发送；服务端播完即删，不落盘。
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
DEFAULT_CACHE = ROOT / "media" / "badapple_advanced_frames"
DEFAULT_HOST = "http://127.0.0.1"

# Braille dots (U+2800):
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
    h, w = gray.shape
    pad_h = (4 - h % 4) % 4
    pad_w = (2 - w % 2) % 2
    if pad_h or pad_w:
        gray = np.pad(gray, ((0, pad_h), (0, pad_w)), mode="constant", constant_values=0)

    bits = gray < threshold if invert else gray >= threshold
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
        f"scale={width}:{height}:flags=lanczos,format=gray",
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


def post_fixed(
    host: str,
    content: str,
    *,
    x: float,
    y: float,
    duration_ms: int,
    timeout: float = 5.0,
) -> None:
    """发送高级弹幕；duration 需落在服务端允许的 100..10000 ms。"""
    duration_ms = int(min(10000, max(100, duration_ms)))
    url = host.rstrip("/") + "/api/messages"
    payload = {
        "content": content,
        "mode": "fixed",
        "x": x,
        "y": y,
        "durationMs": duration_ms,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
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
    # 高级弹幕最短 0.1s，超过 10fps 会叠帧，默认压到 10
    out_fps = args.fps or min(src_fps, 10.0)
    px_w = args.width * 2
    px_h = args.height * 4

    meta = {
        "video": str(video.resolve()),
        "fps": out_fps,
        "width_chars": args.width,
        "height_chars": args.height,
        "threshold": args.threshold,
        "invert": args.invert,
        "x": args.x,
        "y": args.y,
        "mode": "fixed",
    }
    (cache / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        f"prepare: {video.name} → {cache} | {args.width}x{args.height} @ {out_fps:.3f}fps (fixed)",
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

    if args.from_video:
        video = Path(args.video)
        if not video.is_file():
            raise SystemExit(f"找不到视频: {video}")
        src_fps = probe_fps(video)
        out_fps = args.fps or min(src_fps, 10.0)
        px_w = args.width * 2
        px_h = args.height * 4
        x, y = args.x, args.y
        frame_iter = (
            frame_to_braille(gray, args.threshold, args.invert)
            for gray in iter_video_frames(video, px_w, px_h, out_fps)
        )
        fps = out_fps
        total = None
        print(f"play(live/fixed): {video} → {host} @ {fps:.3f}fps pos=({x},{y})", flush=True)
    else:
        meta, files = load_cached_frames(cache)
        fps = args.fps or float(meta["fps"])
        x = args.x if args.x is not None else float(meta.get("x", 50))
        y = args.y if args.y is not None else float(meta.get("y", 45))
        total = len(files)
        frame_iter = (p.read_text(encoding="utf-8").rstrip("\n") for p in files)
        print(
            f"play(cache/fixed): {cache} ({total} frames) → {host} @ {fps:.3f}fps pos=({x},{y})",
            flush=True,
        )

    # 略长于帧间隔，减少闪烁；仍受 100..10000 限制
    duration_ms = args.duration_ms
    if duration_ms is None:
        duration_ms = max(100, int(1000 / fps) + 30)

    if args.dry_run:
        first = next(frame_iter, "")
        print(f"durationMs={duration_ms} x={x} y={y}")
        print("--- first frame preview (stdout only, not sent) ---")
        print(first)
        print("--- dry-run: not sending ---")
        return 0

    interval = 1.0 / fps
    start = time.perf_counter()
    sent = 0
    try:
        pending = frame_iter
        for text in pending:
            target = start + sent * interval
            now = time.perf_counter()
            if target > now:
                time.sleep(target - now)

            behind = time.perf_counter() - (start + sent * interval)
            if behind > interval * 2:
                skip = int(behind // interval)
                for _ in range(skip):
                    try:
                        next(pending)
                        sent += 1
                    except StopIteration:
                        break

            try:
                post_fixed(host, text, x=x, y=y, duration_ms=duration_ms)
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
    p = argparse.ArgumentParser(description="Bad Apple via advanced/fixed danmaku (CLI only)")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--video", default=str(DEFAULT_VIDEO))
    common.add_argument("--cache", default=str(DEFAULT_CACHE))
    common.add_argument("--width", type=int, default=56, help="braille 字符宽")
    common.add_argument("--height", type=int, default=20, help="braille 字符高")
    common.add_argument("--fps", type=float, default=None, help="默认 min(源fps,10)")
    common.add_argument("--threshold", type=int, default=128)
    common.add_argument("--invert", action="store_true", help="反色")
    common.add_argument("--x", type=float, default=50.0, help="固定位置 X%%（0-100）")
    common.add_argument("--y", type=float, default=45.0, help="固定位置 Y%%（0-100）")

    prep = sub.add_parser("prepare", parents=[common], help="预渲染帧缓存")
    prep.add_argument("--force", action="store_true")
    prep.set_defaults(func=cmd_prepare)

    play = sub.add_parser("play", parents=[common], help="按帧发送高级弹幕（先别跑）")
    play.add_argument("--host", default=DEFAULT_HOST)
    play.add_argument("--from-video", action="store_true", help="不读缓存，实时转码发送")
    play.add_argument("--duration-ms", type=int, default=None, help="每帧固定时长，默认约 1/fps+30ms")
    play.add_argument("--dry-run", action="store_true", help="只在终端预览第一帧，不请求接口")
    play.set_defaults(func=cmd_play)

    info = sub.add_parser("info", parents=[common], help="查看视频/缓存")
    info.set_defaults(func=cmd_info)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # play 且未指定 --x/--y 覆盖时，从 cache meta 读；argparse 已给默认 50/45
    # 对 cache 路径：若用户显式传了与默认相同的 x/y，仍可用 meta —— 上面 play 分支已处理 from_video
    if args.cmd == "play" and not args.from_video:
        # 允许 CLI 覆盖；用 None 哨兵区分“未改默认”太麻烦，直接以当前值为准
        pass
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
