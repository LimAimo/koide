@echo off
chcp 65001 >nul
rem 在 Windows 上启动 Diffusion 桥接服务。额外参数会原样传入，例如 --lan
cd /d "%~dp0"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo CodeMirror 6 是 Diffusion 的正式编辑器，需要 Node.js 20+ 和 pnpm 9+。
  echo 请先安装依赖并执行：pnpm install
  pause
  exit /b 1
)
call pnpm build:cm6
if errorlevel 1 (
  echo CodeMirror 6 构建失败。
  pause
  exit /b 1
)
where python >nul 2>nul
if %errorlevel%==0 (
  python bridge\main.py --open %*
) else (
  py -3 bridge\main.py --open %*
)
if errorlevel 1 (
  echo.
  echo 启动失败：请确认已安装 Python 3.10 或更高版本。
  pause
)
