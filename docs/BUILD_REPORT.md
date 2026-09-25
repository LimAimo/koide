# 0.8.0-alpha.3 本轮构建 / 验证报告

日期：2026-09-25

## Cargo vendor 已验证

用户提供的 `diffusion-alpha2-cargo-vendor.tar.gz.part-aa` 实际是完整单卷压缩包，约 70 MiB；展开后约 595 MiB，并包含：

- `vendor/`；
- `Cargo.lock`；
- `cargo-vendor-config.toml`。

Cargo 已成功用该 vendor 离线编译 Tauri 依赖。

## 修复的 Rust 编译问题

真实 Android target 检查暴露了 4 个源码问题：

1. `checkpoint.rs` 的 `io_err` 闭包缺少明确生命周期；
2. `trash.rs` 同类问题；
3. `workspace.rs` 同类问题；
4. 移除直接 `uuid` 依赖后，Trash 原子 JSON 临时文件名仍残留一次 `Uuid::new_v4()`。

修复方式：错误上下文先复制为 owned `String`，闭包不再借用参数；Trash 临时名改用 Native Core 自带 `unique_id()`。

## Android 结果

通过：

```text
cargo check --offline --locked --target aarch64-linux-android
```

Tauri Android 工程初始化通过：

```text
tauri android init --skip-targets-install --ci
```

实际 APK 构建尝试：

```text
tauri android build --debug --target aarch64 --apk --ci
```

已成功完成 Rust native 编译，并生成 / 链接 ARM64 `libdiffusion_native_lib.so`。随后 Gradle Wrapper 尝试下载 `gradle-8.14.3-bin.zip`，因当前容器无 DNS / 外网而停止。因此本轮仍没有 APK 文件，但阻塞已从 Rust/Tauri 核心缩小到 Gradle/Maven 离线层。

## Windows 结果

首次 Windows target 检查发现缺少 `icons/icon.ico`。已从现有 512×512 PNG 生成含 256/128/64/48/32/16 六档的标准 ICO。

再次运行 Windows MSVC `cargo check` 后，工程已经进入 Tauri Windows Resource 构建，当前停在：

```text
llvm-rc not found
```

因此本轮没有 `.exe`。

## 回归测试

- Python Bridge：47 / 47；
- Web / Editor / Runtime：43 / 43；
- UI Integration：23 / 23；
- 合计：113 / 113。

## 结论

`alpha.3` 是第一个可以确认 **Rust Native Core 在 Android ARM64 目标真实通过编译检查，并且能产出 Android native `.so`** 的检查点。接下来构建工作主要是 Gradle/Maven 离线依赖与 Windows `llvm-rc`，而不是继续猜测 Rust 工具链问题。
