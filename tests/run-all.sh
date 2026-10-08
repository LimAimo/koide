#!/usr/bin/env bash
# 兼容已有 Bash 入口；统一通过跨平台 pnpm 脚本构建编辑器并发现全部 Web / Bridge 测试。
set -e
cd "$(dirname "$0")/.."
pnpm test
