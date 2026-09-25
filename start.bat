@echo off
chcp 65001 >nul
rem 在 Windows 上启动 Diffusion 桥接服务。额外参数会原样传入，例如 --lan
cd /d "%~dp0"
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
