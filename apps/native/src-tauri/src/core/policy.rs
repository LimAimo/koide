use crate::core::RuntimeError;
use std::path::{Component, Path};

const SENSITIVE_DIRS: &[&str] = &[
    ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".azure", ".config/gcloud",
];
const SENSITIVE_FILES: &[&str] = &[
    "id_rsa", "id_ed25519", "id_ecdsa", ".netrc", ".pgpass", "credentials",
    "credentials.json", ".npmrc", ".pypirc", "service-account.json",
];

pub fn check_read_path(raw: &str) -> Result<(), RuntimeError> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(RuntimeError::new("BAD_PATH", "路径不能为空"));
    }

    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(RuntimeError::new(
            "OUTSIDE_WORKSPACE",
            "只读智能体只能访问工作区内部的相对路径",
        ));
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_lowercase()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(RuntimeError::new(
                    "OUTSIDE_WORKSPACE",
                    "只读智能体不能访问工作区之外的路径",
                ));
            }
        }
    }

    let joined = parts.join("/");
    if SENSITIVE_DIRS.iter().any(|s| {
        let s = s.to_ascii_lowercase();
        joined == s || joined.starts_with(&(s.clone() + "/")) || joined.contains(&("/".to_owned() + &s + "/"))
    }) {
        return Err(RuntimeError::new(
            "SENSITIVE_PATH",
            "HardPolicy 已阻止读取可能包含凭据的目录",
        ));
    }

    if let Some(name) = parts.last() {
        if name == ".env" || name.starts_with(".env.") {
            return Err(RuntimeError::new(
                "SENSITIVE_PATH",
                "HardPolicy 已阻止读取环境变量文件",
            ));
        }
        if SENSITIVE_FILES.iter().any(|x| name == &x.to_ascii_lowercase()) {
            return Err(RuntimeError::new(
                "SENSITIVE_PATH",
                "HardPolicy 已阻止读取可能包含凭据或私钥的文件",
            ));
        }
        if name.ends_with(".pem") || name.ends_with(".p12") || name.ends_with(".pfx") || name.ends_with(".key") {
            return Err(RuntimeError::new(
                "SENSITIVE_PATH",
                "HardPolicy 已阻止读取密钥/证书私密文件",
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_common_secret_paths() {
        for path in [
            ".env",
            ".env.local",
            ".ssh/id_ed25519",
            ".aws/credentials",
            "config/private.key",
            "secrets/client.p12",
        ] {
            assert!(check_read_path(path).is_err(), "{path} should be blocked");
        }
    }

    #[test]
    fn allows_normal_project_paths() {
        for path in ["src/main.rs", "README.md", "packages/app/package.json", ".github/workflows/build.yml"] {
            assert!(check_read_path(path).is_ok(), "{path} should be allowed");
        }
    }

    #[test]
    fn blocks_workspace_escape() {
        assert!(check_read_path("../secret").is_err());
        assert!(check_read_path("/etc/passwd").is_err());
    }
}


pub fn check_write_path(raw: &str) -> Result<(), RuntimeError> {
    // Writing inherits every read restriction first: no absolute paths, escapes, secrets or keys.
    check_read_path(raw)?;

    let normalized = raw.replace('\\', "/").trim_start_matches("./").to_ascii_lowercase();
    if normalized == ".git"
        || normalized.starts_with(".git/")
        || normalized == ".diffusion"
        || normalized.starts_with(".diffusion/")
    {
        return Err(RuntimeError::new(
            "SENSITIVE_PATH",
            "HardPolicy 不允许智能体直接修改 Git 内部数据或 Diffusion 自身元数据",
        ));
    }
    Ok(())
}
