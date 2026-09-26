# Koide Native 构建说明

当前应用版本：`0.9.0`。

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

Android 0.9.0 的 `versionName` 来自 `tauri.conf.json`，当前 `versionCode` 为 `9000`。CI 会使用 `apksigner verify` 检查 APK 签名。

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
6. 只有 `main` 上全部门禁通过后，才创建 `v<version>` 正式 GitHub Release。

发布不再使用 `-alpha`、`build.N` 或 prerelease 标记。
