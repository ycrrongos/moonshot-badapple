#!/usr/bin/env python3
"""拉取原站 http://46.62.212.36/ 的弹幕。

用法:
  # 拉最近 N 条（默认 30）
  python3 scripts/fetch_remote_danmaku.py

  # 持续监听 WebSocket 实时弹幕
  python3 scripts/fetch_remote_danmaku.py watch

  # 保存到文件
  python3 scripts/fetch_remote_danmaku.py --limit 100 --out media/remote_danmaku.json
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

DEFAULT_HOST = "http://46.62.212.36"


def fetch_messages(host: str, limit: int) -> list[dict]:
    url = f"{host.rstrip('/')}/api/messages?{urllib.parse.urlencode({'limit': limit})}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as res:
        data = json.loads(res.read().decode())
    return data.get("messages") or []


def fmt_time(ms: int | None) -> str:
    if not isinstance(ms, (int, float)):
        return "-"
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone()
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def print_messages(messages: list[dict]) -> None:
    for msg in messages:
        created = fmt_time(msg.get("createdAt"))
        content = (msg.get("content") or "").replace("\n", "\\n")
        print(f"[{created}] {msg.get('id', '?')[:8]}  {content}")


def cmd_list(args: argparse.Namespace) -> int:
    try:
        messages = fetch_messages(args.host, args.limit)
    except urllib.error.URLError as err:
        raise SystemExit(f"请求失败: {err}") from err

    if args.out:
        path = args.out
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"host": args.host, "messages": messages}, f, ensure_ascii=False, indent=2)
        print(f"saved {len(messages)} messages → {path}", file=sys.stderr)
    else:
        print_messages(messages)
        print(f"# total {len(messages)}", file=sys.stderr)
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    try:
        import websockets
    except ImportError:
        raise SystemExit("watch 需要 websockets：pip install websockets") from None

    import asyncio

    host = args.host.rstrip("/")
    parsed = urllib.parse.urlparse(host)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    ws_url = f"{scheme}://{parsed.netloc}/api/live"

    # 先拉一轮历史
    try:
        history = fetch_messages(host, args.limit)
        if history:
            print("## history", file=sys.stderr)
            print_messages(list(reversed(history)))
            print("## live", file=sys.stderr)
    except urllib.error.URLError as err:
        print(f"history failed: {err}", file=sys.stderr)

    async def run() -> None:
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(ws_url) as ws:
                    print(f"connected {ws_url}", file=sys.stderr)
                    backoff = 1.0
                    async for raw in ws:
                        try:
                            data = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if data.get("type") == "danmaku" and data.get("message"):
                            print_messages([data["message"]])
                        elif data.get("type") == "danmaku_deleted":
                            print(f"# deleted {data.get('id')}", file=sys.stderr)
            except Exception as err:  # noqa: BLE001 — reconnect loop
                print(f"ws error: {err}; retry in {backoff:.0f}s", file=sys.stderr)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nstopped", file=sys.stderr)
        return 130
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Fetch danmaku from the original countdown site")
    p.add_argument("--host", default=DEFAULT_HOST, help="原站地址")
    p.add_argument("--limit", type=int, default=30, help="历史条数上限")
    p.add_argument("--out", default=None, help="保存 JSON 路径")
    sub = p.add_subparsers(dest="cmd")

    watch = sub.add_parser("watch", help="WebSocket 实时监听")
    watch.set_defaults(func=cmd_watch)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "cmd", None) == "watch":
        return args.func(args)
    return cmd_list(args)


if __name__ == "__main__":
    raise SystemExit(main())
