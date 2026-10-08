fn main() {
    tauri_build::build();
    // Windows 的测试 harness 也会链接 rfd/TaskDialogIndirect，需要 Common Controls 6。
    // 应用 EXE 由 Tauri 嵌入 manifest；Cargo 的 lib test EXE 需显式声明同一依赖。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!(r#"cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"#);
    }
}
