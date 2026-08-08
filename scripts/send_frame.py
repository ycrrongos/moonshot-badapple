#!/usr/bin/env python3
"""Send one ASCII/braille frame (or a scrolling danmaku) to the local replica."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://127.0.0.1:8787")
    parser.add_argument("--mode", choices=("frame", "danmaku"), default="frame")
    parser.add_argument("--duration-ms", type=int, default=None)
    parser.add_argument("--lane", type=int, default=None)
    parser.add_argument("text", nargs="?", help="content; omit to read stdin")
    args = parser.parse_args()

    content = args.text if args.text is not None else sys.stdin.read()
    payload = {"content": content, "mode": args.mode}
    if args.duration_ms is not None:
        payload["durationMs"] = args.duration_ms
    if args.lane is not None:
        payload["lane"] = args.lane

    req = urllib.request.Request(
        f"{args.host.rstrip('/')}/api/messages",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        print(res.read().decode())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
