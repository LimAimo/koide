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


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandPolicyAction {
    Ask,
    Deny,
}

#[derive(Debug, Clone)]
pub struct CommandPolicyVerdict {
    pub action: CommandPolicyAction,
    pub reason: String,
}

pub fn check_command(command: &str) -> Option<CommandPolicyVerdict> {
    let raw = command.trim();
    let lower = raw.to_ascii_lowercase();
    if raw.is_empty() {
        return Some(CommandPolicyVerdict {
            action: CommandPolicyAction::Deny,
            reason: "命令不能为空".into(),
        });
    }

    let root_delete = lower.contains("rm -rf /")
        || lower.contains("rm -fr /")
        || lower.contains("rm -rf ~")
        || lower.contains("rm -fr ~")
        || lower.contains("rm -rf $home")
        || lower.contains("rm -fr $home");
    let destructive = root_delete
        || lower.split_whitespace().any(|x| x == "mkfs" || x.starts_with("mkfs."))
        || (lower.contains("dd ") && lower.contains("of=/dev/"))
        || lower.contains(":(){")
        || lower.contains(": () {")
        || lower.contains(">/dev/sd")
        || lower.contains("> /dev/sd")
        || lower.contains(">/dev/nvme")
        || lower.contains("> /dev/nvme")
        || lower.contains(">/dev/mmcblk")
        || lower.contains("> /dev/mmcblk")
        || (lower.contains("chmod -r") && lower.contains(" /"));
    if destructive {
        return Some(CommandPolicyVerdict {
            action: CommandPolicyAction::Deny,
            reason: "HardPolicy 已拦截可能破坏系统或用户数据的命令".into(),
        });
    }

    let asks = [
        ("sudo", "提升权限"),
        ("su ", "提升权限"),
        ("git reset --hard", "git reset --hard 会丢弃未提交的工作"),
        ("git push --force", "强制推送会改写远程历史"),
        ("git push -f", "强制推送会改写远程历史"),
        ("git clean -f", "git clean 会删除未跟踪的文件"),
        ("git clean -df", "git clean 会删除未跟踪的文件"),
        ("shutdown", "关机或重启"),
        ("reboot", "关机或重启"),
        ("poweroff", "关机或重启"),
        ("halt", "关机或重启"),
        ("pkill", "按名称结束进程"),
        ("killall", "按名称结束进程"),
    ];
    for (needle, why) in asks {
        if contains_tokenish(&lower, needle) {
            return Some(CommandPolicyVerdict {
                action: CommandPolicyAction::Ask,
                reason: format!("高风险命令：{why}"),
            });
        }
    }
    if (lower.contains("curl ") || lower.contains("wget "))
        && (lower.contains("| sh") || lower.contains("| bash") || lower.contains("| zsh") || lower.contains("| sudo sh") || lower.contains("| sudo bash"))
    {
        return Some(CommandPolicyVerdict {
            action: CommandPolicyAction::Ask,
            reason: "高风险命令：把下载内容直接交给 shell 执行".into(),
        });
    }
    None
}

fn contains_tokenish(haystack: &str, needle: &str) -> bool {
    if needle.ends_with(' ') {
        return haystack.starts_with(needle) || haystack.contains(&format!(" {needle}"));
    }
    haystack == needle
        || haystack.starts_with(&format!("{needle} "))
        || haystack.contains(&format!(" {needle} "))
        || haystack.contains(&format!(" {needle};"))
        || haystack.contains(&format!(" {needle}|"))
}

pub fn ensure_public_http_url(raw: &str) -> Result<(), RuntimeError> {
    use std::net::{IpAddr, ToSocketAddrs};

    let url = reqwest::Url::parse(raw)
        .map_err(|_| RuntimeError::new("BAD_URL", "网址格式无效"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RuntimeError::new("BAD_URL", "只支持 http/https 网址"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| RuntimeError::new("BAD_URL", "网址缺少主机名"))?
        .trim_matches('[')
        .trim_matches(']')
        .to_ascii_lowercase();
    if host == "localhost" || host == "localhost.localdomain" || host.ends_with(".local") {
        return Err(RuntimeError::new("BLOCKED_HOST", "出于安全考虑，禁止访问本机或内网地址"));
    }

    let port = url.port_or_known_default().unwrap_or(80);
    if let Ok(addrs) = (host.as_str(), port).to_socket_addrs() {
        for addr in addrs {
            if blocked_ip(addr.ip()) {
                return Err(RuntimeError::new("BLOCKED_HOST", "出于安全考虑，禁止访问本机或内网地址"));
            }
        }
    }
    Ok(())
}

fn blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_multicast()
                || ip.is_unspecified()
                || ip.segments()[0] & 0xfe00 == 0xfc00
                || ip.segments()[0] & 0xffc0 == 0xfe80
        }
    }
}

#[cfg(test)]
mod command_policy_tests {
    use super::*;

    #[test]
    fn command_policy_blocks_destructive_commands() {
        assert_eq!(check_command("rm -rf /").unwrap().action, CommandPolicyAction::Deny);
        assert_eq!(check_command("mkfs.ext4 /dev/sda1").unwrap().action, CommandPolicyAction::Deny);
    }

    #[test]
    fn command_policy_forces_confirmation_for_risky_commands() {
        assert_eq!(check_command("sudo apt update").unwrap().action, CommandPolicyAction::Ask);
        assert_eq!(check_command("git reset --hard HEAD~1").unwrap().action, CommandPolicyAction::Ask);
    }

    #[test]
    fn command_policy_allows_normal_builds() {
        assert!(check_command("cargo test").is_none());
        assert!(check_command("pnpm test").is_none());
    }
}
