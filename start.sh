#!/usr/bin/env bash
# 启动 Diffusion 桥接服务（同时提供网页界面）。支持 Termux、Linux、macOS。
#   bash start.sh                      仅本机访问：http://127.0.0.1:8765
#   bash start.sh --workspace ~/proj   启动后直接打开某个项目
#   bash start.sh --lan                允许配对后的手机使用这台电脑上的项目
set -e
cd "$(dirname "$0")"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "需要 Python 3.10 或更高版本。"
  echo "Termux 安装方法：pkg install python"
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "CodeMirror 6 是 Diffusion 的正式编辑器，需要 pnpm 9 或更高版本。"
  echo "请先安装 Node.js 20+ 和 pnpm，然后执行：pnpm install"
  exit 1
fi
pnpm build:cm6
exec "$PY" bridge/main.py --open "$@"
