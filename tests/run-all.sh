#!/usr/bin/env bash
# 运行全部测试。需要 Python 3.10+ 和 Node 20+（Node 只用于测试，应用本身既不需要构建也不需要 Node）。
set -e
cd "$(dirname "$0")/.."
echo "== 桥接服务（Python）=="; python3 -m unittest tests.bridge.test_workspace tests.bridge.test_e2e tests.bridge.test_providers tests.bridge.test_git tests.bridge.test_extras
echo "== Diffusion 引擎与编辑器（Node）=="; node --test tests/web/engine.test.mjs tests/web/editor.test.mjs tests/web/features.test.mjs tests/web/qr.test.mjs tests/web/runtime.test.mjs
echo "== 界面集成测试（真实界面代码 + 真实桥接服务）=="; node --test tests/web/ui-integration.test.mjs
