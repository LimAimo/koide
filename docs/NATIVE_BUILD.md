# Native Core 构建说明

当前原生化分支版本：`0.8.0-alpha.3`。

## 已确认的工具链

- Node.js 22；
- Java 21；
- Rust / Cargo 1.98.1；
- Rust target：`aarch64-linux-android`；
- Rust target：`x86_64-pc-windows-msvc`；
- Android SDK Platform 36；
- Android Build Tools 36.0.0；
- Platform Tools / adb；
- Android NDK r27d (`27.3.13750724`)；
- Tauri CLI native binding 2.11.5；
- cargo-xwin 0.23.1；
- 完整 Cargo vendor / `Cargo.lock`。

NDK 合并包 SHA-256：

```text
601246087a682d1944e1e16dd85bc6e49560fe8b6d61255be2829178c8ed15d9
```

## Cargo 离线构建

`alpha.3` 已用用户提供的完整 vendor 实际验证：

```bash
cd apps/native/src-tauri
cargo check --offline --locked --target aarch64-linux-android
```

结果：通过。

源码包会保留 `Cargo.lock`，但为了避免把约 595 MiB 展开后的第三方源码塞进主源码 ZIP，`vendor/` 不随源码重复打包。离线构建时把 vendor 放回 `apps/native/src-tauri/vendor/`，并创建：

```toml
# apps/native/src-tauri/.cargo/config.toml
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"
```

## Android

已经真实执行成功：

```bash
tauri android init --skip-targets-install --ci
cargo check --offline --locked --target aarch64-linux-android
tauri android build --debug --target aarch64 --apk --ci
```

最后一条命令已经成功编译 Rust 并生成：

```text
libdiffusion_native_lib.so
```

APK 组装随后停在 Gradle Wrapper，因为当前环境不能联网下载：

```text
https://services.gradle.org/distributions/gradle-8.14.3-bin.zip
```

生成的 Android 工程当前要求：

- Gradle 8.14.3；
- Android Gradle Plugin 8.11.0；
- Kotlin Gradle Plugin 1.9.25；
- compileSdk / targetSdk 36；
- minSdk 24；
- AndroidX WebKit 1.14.0；
- AppCompat 1.7.1；
- Activity KTX 1.10.1；
- Material 1.12.0；
- Lifecycle Process 2.10.0。

因此下一步不是再补 Rust，而是准备 Gradle distribution 和 Maven/Gradle cache。

## Windows

Windows 图标已经补齐为：

```text
apps/native/src-tauri/icons/icon.ico
```

`cargo check --offline --locked --target x86_64-pc-windows-msvc` 已经进入 Tauri Windows Resource 编译阶段。当前停止在：

```text
llvm-rc not found
```

也就是说下一步需要一个 Linux host 可执行的 `llvm-rc`，之后再继续验证 cargo-xwin 所需 Windows SDK / CRT payload。

## 注意

现在的 `bridge/` 仍然存在，是迁移期兼容实现和 113 项旧行为回归基准。`alpha.3` 并不代表 Python 删除线完成。
