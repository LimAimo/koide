# Koide Native 构建说明

当前应用版本：`1.4.0-alpha.1`（工程能力开发预览，尚未发布）。开发分支保持 `dev/1.0.0`。

## 工具链

CI 使用：

- Node.js 22；
- pnpm 9.15；
- Rust stable；
- Java 21；
- Android SDK Platform 36；
- Android Build Tools 36.0.0；
- Android NDK `27.3.13750724`；
- Tauri CLI 2.11.5；
- Windows target：`x86_64-pc-windows-msvc`；
- Android target：`aarch64-linux-android`。

## 安装依赖

```bash
corepack enable
pnpm install
pnpm build:cm6
```

CodeMirror 6 是正式编辑器。Tauri 的 `beforeDevCommand` 与 `beforeBuildCommand` 也会自动执行编辑器构建。

## Windows

```bash
pnpm --filter @diffusion/native exec tauri build --bundles nsis
```

产物位于 `apps/native/src-tauri/target/release/` 与其 `bundle/nsis/` 子目录。`diffusion-native` 仍是内部二进制名，用于兼容既有工程结构；对外产品名和发行文件名使用 Koide。

## Android ARM64

```bash
pnpm --filter @diffusion/native exec tauri android init
pnpm --filter @diffusion/native exec tauri icon koide-icon.svg
pnpm --filter @diffusion/native exec tauri android build --debug --apk --target aarch64
```

Android 的 `versionName` 来自 `tauri.conf.json`，当前 `versionCode` 为 `10401`，高于 RC.1 的 `10001` 与此前开发包的 `10000`。后续 RC 与正式版都必须继续递增安装版本码，不能在去掉 `-rc.2` 时降回 `10000`。CI 会使用 `apksigner verify` 检查 APK 签名。

当前自动构建使用调试签名以保证产物可安装；应用商店或公开生产分发应另外配置正式签名密钥。

## 测试

```bash
pnpm build:cm6
node --test tests/web/*.test.mjs
python3 -m unittest discover -s tests/bridge -v
node scripts/check-native-parity.mjs
cd apps/native/src-tauri && cargo test --lib --locked
```

Linux 上运行 Tauri Core 测试需要 GTK/WebKit 开发库。

## CI / Release

`.github/workflows/build.yml` 是 0.9.0 起唯一的主构建工作流：

1. 构建 CodeMirror 6 并运行 Web/UI 回归；
2. 运行可选 Bridge 的兼容回归；
3. 检查 Runtime API / Native dispatch 对齐并运行 Rust tests；
4. 构建 Android ARM64 APK；
5. 构建 Windows x64 NSIS / portable EXE；
6. 只有 `main` 上全部门禁通过，且版本为纯 `X.Y.Z` 正式版本号时，才创建 `v<version>` 正式 GitHub Release。

候选版使用 `-rc.N` 标识。开发分支构建只提供 Actions 产物；正式 Release 步骤也会跳过预发布版本，不自动创建候选版 Release、修改既有 Release/Tag 或合并 main。RC 发行需要用户另外确认。

## 版本同步范围

| 来源 | 当前值 / 用途 |
|---|---|
| 根目录、Native、Web、CodeMirror 的 `package.json` | `1.4.0-alpha.1` |
| `apps/native/src-tauri/tauri.conf.json` | `1.4.0-alpha.1`；用于安装包与 CI 产物文件名 |
| Native / SAF / Feedback 的 `Cargo.toml` 与 `Cargo.lock` 自有包条目 | `1.4.0-alpha.1`；第三方依赖版本不随应用更改 |
| Native Core `hello.version` | 编译时读取 `CARGO_PKG_VERSION`，不再维护重复常量 |
| CodeMirror `version` 导出 | 构建时读取自己的 `package.json`，不再维护重复常量 |
| `bridge/app.py` 的 `VERSION` | `1.4.0-alpha.1`；用于 Bridge 握手、HTTP 信息与启动提示 |
| `pyproject.toml` | `1.4.0a1`，对应 Python 包版本格式 |
| Android `bundle.android.versionCode` | `10401`；每次安装包版本迭代递增 |

版本更新时同步上述文件及 README、CHANGELOG、STATUS、能力审计和本页；保持历史 CHANGELOG 与历史分支引用原样。设置页继续读取 Runtime 的 `hello.version`，不另写界面版本常量。

版本格式参考：[Tauri 配置](https://v2.tauri.app/reference/config/#version)、[Python 包版本规范](https://packaging.python.org/en/latest/specifications/version-specifiers/#pre-releases)。
