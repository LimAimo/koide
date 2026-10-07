# Koide Native 构建说明

当前应用版本：`1.0.0`。

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

产物位于 `apps/native/src-tauri/target/release/` 与其 `bundle/nsis/` 子目录。`diffusion-native` 仍是内部二进制名，用于兼容既有工程结构；对外产品名和发行文件名使用 Koide。NSIS 安装器使用简体中文；不指定 `--bundles` 时也生成简体中文 MSI。

Windows 需要 MSVC Build Tools、Windows SDK 和 WebView2 Runtime。构建脚本包含 Common Controls v6 manifest，Rust 测试与程序启动均使用相同的系统组件声明。0.10.0 已在本机完成 x64 EXE / MSI / NSIS 构建和真实 WebView2 启动检查；1.0.0 的界面、构建与校验记录见 [界面验收](RESPONSIVE_VALIDATION.md)。

## Android ARM64

```bash
pnpm --filter @diffusion/native exec tauri android init
pnpm --filter @diffusion/native exec tauri icon koide-icon.svg
pnpm --filter @diffusion/native exec tauri android build --debug --apk --target aarch64
```

Android 1.0.0 的 `versionName` 来自 `tauri.conf.json`，当前 `versionCode` 为 `1000000`。CI 会使用 `apksigner verify` 检查 APK 签名。本轮本机未构建 Android APK 或进行真机验收，不能用 Windows / 手机浏览器测试替代。

当前自动构建使用调试签名以保证产物可安装；应用商店或公开生产分发应另外配置正式签名密钥。

## 测试

```bash
pnpm build:cm6
pnpm test
pnpm test:browser
cd apps/native/src-tauri && cargo test --lib --locked
```

Linux 上运行 Tauri Core 测试需要 GTK/WebKit 开发库。

Windows 浏览器回归默认使用已安装的 Edge；其他平台先运行 `pnpm exec playwright install --with-deps chromium`。Windows 发行版可再运行 `node tests/browser/native-smoke.mjs apps/native/src-tauri/target/release/diffusion-native.exe`。真实浏览器测试创建临时项目，Native 启动检查只读，详见 [浏览器回归说明](../tests/browser/README.md)。

## CI / Release

`.github/workflows/build.yml` 是 0.9.0 起唯一的主构建工作流：

1. 构建 CodeMirror 6 和 TypeScript 语言 Worker，运行 Web/UI 与真实浏览器回归；
2. 运行可选 Bridge 的兼容回归；
3. 检查 Runtime API / Native dispatch 对齐并运行 Rust tests；
4. 构建 Android ARM64 APK；
5. 构建 Windows x64 NSIS / portable EXE；
6. 只有 `main` 上全部门禁通过后，才创建 `v<version>` 正式 GitHub Release。

发布不再使用 `-alpha`、`build.N` 或 prerelease 标记。
