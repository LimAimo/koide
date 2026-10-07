"""Koide 兼容桥接服务入口。

    python bridge/main.py                     # 仅本机访问，http://127.0.0.1:8765
    python bridge/main.py --workspace ~/proj  # 启动后直接打开某个项目
    python bridge/main.py --lan               # 允许已配对的局域网设备连接
"""
from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import socket
import subprocess
import sys
import webbrowser
from pathlib import Path

if __package__ in (None, ""):                       # allow `python bridge/main.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "bridge"

from bridge.app import VERSION, BridgeApp          # noqa: E402
from bridge.server import serve                    # noqa: E402


def lan_ips() -> list[str]:
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips)


def open_browser(url: str) -> None:
    if shutil.which("termux-open-url"):
        subprocess.Popen(["termux-open-url", url])
    else:
        webbrowser.open(url)


async def amain(args) -> None:
    root = Path(__file__).resolve().parent.parent
    web_dir = Path(args.web_dir) if args.web_dir else (root / "dist" if (root / "dist").is_dir() else root / "apps" / "web")
    data_dir = Path(args.data_dir or os.environ.get("DIFFUSION_HOME") or Path.home() / ".diffusion-ide")
    host = "0.0.0.0" if args.lan else args.host
    app = BridgeApp(data_dir, web_dir, Path(__file__).resolve().parent, lan=args.lan,
                    allow_self_modify=args.allow_self_modify, port=args.port)
    server = await serve(app, host, args.port)

    if args.workspace:
        await app.rpc_workspace_open({"path": args.workspace}, None)

    url = f"http://127.0.0.1:{args.port}"
    print(f"\n  Diffusion 桥接服务 {VERSION}")
    print(f"  网页地址 : {url}")
    print(f"  数据目录 : {data_dir}")
    print(f"  网页目录 : {web_dir}")
    if args.workspace:
        print(f"  项目目录 : {Path(args.workspace).expanduser().resolve()}")
    if args.lan:
        code = app.devices.new_code()
        for ip in lan_ips():
            print(f"  局域网   : http://{ip}:{args.port}    配对码 {code}（5 分钟内有效）")
            print(f"  一键配对 : http://{ip}:{args.port}/#pair={code}   （手机上打开这个链接即可自动配对）")
        print("  局域网模式已开启：只有完成配对的设备才能连接，可在「设置 - Python 桥接」中随时撤销。")
    else:
        print("  当前仅本机可访问（127.0.0.1）。想让手机连接这台电脑，请加上 --lan 参数。")
    print("  按 Ctrl+C 停止服务。\n")
    if args.open:
        open_browser(url)
    try:
        async with server:
            await server.serve_forever()
    finally:
        await app.shutdown()


def main() -> None:
    ap = argparse.ArgumentParser(description="Koide 兼容桥接服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--workspace", help="启动时直接打开这个文件夹")
    ap.add_argument("--lan", action="store_true", help="监听所有网卡，并要求设备先配对")
    ap.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    ap.add_argument("--web-dir", help="使用其他网页目录（例如构建好的 dist/）")
    ap.add_argument("--data-dir", help="密钥、检查点和回收站的存放位置（默认 ~/.diffusion-ide）")
    ap.add_argument("--allow-self-modify", action="store_true",
                    help="允许智能体修改桥接服务本身（每次仍需你确认）")
    args = ap.parse_args()
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("\n  桥接服务已停止。")
    except OSError as e:
        print(f"\n  启动失败：{e}\n  端口 {args.port} 是否已被另一个桥接服务占用？", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
