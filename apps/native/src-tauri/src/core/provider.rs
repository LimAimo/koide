use crate::core::id::unique_id;
use crate::core::RuntimeError;
use base64::Engine;
use reqwest::blocking::{Client, RequestBuilder};
use serde_json::{json, Map, Value};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const PROFILE_FIELDS: &[&str] = &[
    "id",
    "name",
    "kind",
    "endpoint",
    "model",
    "headers",
    "tool_calling",
    "sampling",
    "extra_body",
    "vision",
    "pricing",
];

pub fn presets() -> Value {
    json!({
        "openai": {"endpoint": "https://api.openai.com/v1", "model": "gpt-4.1"},
        "deepseek": {"endpoint": "https://api.deepseek.com/v1", "model": "deepseek-chat"},
        "kimi": {"endpoint": "https://api.moonshot.cn/v1", "model": "kimi-k2-0905-preview"},
        "openrouter": {"endpoint": "https://openrouter.ai/api/v1", "model": "anthropic/claude-sonnet-4.5"},
        "gemini": {"endpoint": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.5-pro"},
        "ollama": {"endpoint": "http://127.0.0.1:11434/v1", "model": "qwen2.5-coder"},
        "openai_compatible": {"endpoint": "http://127.0.0.1:8000/v1", "model": ""},
        "anthropic": {"endpoint": "https://api.anthropic.com/v1", "model": "claude-sonnet-5"},
        "gemini_native": {"endpoint": "https://generativelanguage.googleapis.com/v1beta", "model": "gemini-2.5-pro"},
        "minimax": {"endpoint": "https://api.minimax.io/v1", "model": "MiniMax-M2"},
        "minimax_cn": {"endpoint": "https://api.minimaxi.com/v1", "model": "MiniMax-M2"}
    })
}

fn preset(kind: &str) -> Option<(String, String)> {
    let p = presets();
    let row = p.get(kind)?;
    Some((
        row.get("endpoint")?.as_str()?.to_owned(),
        row.get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    ))
}

fn io_error(subject: &str, e: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::new("PROFILE_IO", format!("{subject}: {e}"))
}

fn provider_error(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new("PROVIDER_ERROR", message)
}

fn read_json(path: &Path, default: Value) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(default)
}

fn write_json(path: &Path, value: &Value) -> Result<(), RuntimeError> {
    write_json_with_mode(path, value, false)
}

fn write_secret_json(path: &Path, value: &Value) -> Result<(), RuntimeError> {
    write_json_with_mode(path, value, true)
}

fn write_json_with_mode(path: &Path, value: &Value, _secret: bool) -> Result<(), RuntimeError> {
    let tmp = path.with_extension("tmp");
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| io_error("无法序列化服务商配置", e))?;
    fs::write(&tmp, bytes).map_err(|e| io_error("无法写入服务商配置", e))?;
    #[cfg(unix)]
    if _secret {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| io_error("无法保护服务商密钥文件权限", e))?;
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|e| io_error("无法替换旧的服务商配置", e))?;
    }
    fs::rename(&tmp, path).map_err(|e| io_error("无法替换服务商配置", e))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub struct ProfileStore {
    profiles_path: PathBuf,
    secrets_path: PathBuf,
}

impl ProfileStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            profiles_path: data_dir.join("profiles.json"),
            secrets_path: data_dir.join("secrets.json"),
        }
    }

    fn profiles(&self) -> Vec<Value> {
        read_json(&self.profiles_path, json!([]))
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    fn secrets(&self) -> Map<String, Value> {
        read_json(&self.secrets_path, json!({}))
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    pub fn list_public(&self) -> Vec<Value> {
        let secrets = self.secrets();
        self.profiles()
            .into_iter()
            .filter_map(|p| {
                let mut obj = p.as_object()?.clone();
                let id = obj.get("id")?.as_str()?;
                obj.insert(
                    "has_key".into(),
                    Value::Bool(
                        secrets
                            .get(id)
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.is_empty()),
                    ),
                );
                Some(Value::Object(obj))
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Result<(Value, Option<String>), RuntimeError> {
        let profile = self
            .profiles()
            .into_iter()
            .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| RuntimeError::new("NO_PROFILE", format!("找不到服务商配置：{id}")))?;
        let key = self
            .secrets()
            .get(id)
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok((profile, key))
    }

    pub fn save(&self, profile: &Value, api_key: Option<&str>) -> Result<Value, RuntimeError> {
        let src = profile
            .as_object()
            .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "profile 必须是对象"))?;
        let id = src
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "服务商配置缺少 id"))?;
        if !valid_id(id) {
            return Err(RuntimeError::new(
                "BAD_PROFILE",
                "配置编号需为 1 到 48 个字符，只能包含字母、数字以及 . _ -",
            ));
        }

        let kind = src
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("openai_compatible");
        let (default_endpoint, default_model) = preset(kind)
            .ok_or_else(|| RuntimeError::new("BAD_PROFILE", format!("未知的服务商类型：{kind}")))?;

        let mut out = Map::new();
        for key in PROFILE_FIELDS {
            if let Some(value) = src.get(*key) {
                out.insert((*key).to_owned(), value.clone());
            }
        }
        out.insert("id".into(), Value::String(id.to_owned()));
        out.entry("name")
            .or_insert_with(|| Value::String(id.to_owned()));
        out.insert("kind".into(), Value::String(kind.to_owned()));
        if out
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            out.insert("endpoint".into(), Value::String(default_endpoint));
        }
        if out.get("model").and_then(Value::as_str).is_none() {
            out.insert("model".into(), Value::String(default_model));
        }
        out.entry("tool_calling").or_insert(Value::Bool(true));

        let mut profiles: Vec<Value> = self
            .profiles()
            .into_iter()
            .filter(|p| p.get("id").and_then(Value::as_str) != Some(id))
            .collect();
        profiles.push(Value::Object(out.clone()));
        write_json(&self.profiles_path, &Value::Array(profiles))?;

        let mut secrets = self.secrets();
        if let Some(key) = api_key {
            if key.is_empty() {
                secrets.remove(id);
            } else {
                secrets.insert(id.to_owned(), Value::String(key.to_owned()));
            }
            write_secret_json(&self.secrets_path, &Value::Object(secrets.clone()))?;
        }

        out.insert(
            "has_key".into(),
            Value::Bool(
                secrets
                    .get(id)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty()),
            ),
        );
        Ok(Value::Object(out))
    }

    pub fn delete(&self, id: &str) -> Result<(), RuntimeError> {
        let profiles: Vec<Value> = self
            .profiles()
            .into_iter()
            .filter(|p| p.get("id").and_then(Value::as_str) != Some(id))
            .collect();
        write_json(&self.profiles_path, &Value::Array(profiles))?;

        let mut secrets = self.secrets();
        if secrets.remove(id).is_some() {
            write_secret_json(&self.secrets_path, &Value::Object(secrets))?;
        }
        Ok(())
    }

    pub fn resolve(
        &self,
        id: Option<&str>,
        draft: Option<&Value>,
        supplied_key: Option<&str>,
    ) -> Result<(Value, Option<String>), RuntimeError> {
        let (mut base, stored_key) = match id {
            Some(id) => self.get(id).unwrap_or_else(|_| (json!({}), None)),
            None => (json!({}), None),
        };
        let obj = base
            .as_object_mut()
            .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "服务商配置损坏"))?;
        if let Some(draft) = draft.and_then(Value::as_object) {
            for (k, v) in draft {
                obj.insert(k.clone(), v.clone());
            }
        }

        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("openai_compatible")
            .to_owned();
        let (endpoint, model) = preset(&kind)
            .ok_or_else(|| RuntimeError::new("BAD_PROFILE", format!("未知的服务商类型：{kind}")))?;
        obj.insert("kind".into(), Value::String(kind));
        if obj
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            obj.insert("endpoint".into(), Value::String(endpoint));
        }
        if obj.get("model").and_then(Value::as_str).is_none() {
            obj.insert("model".into(), Value::String(model));
        }

        let key = supplied_key
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or(stored_key);
        Ok((base, key))
    }
}

fn client() -> Result<Client, RuntimeError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| provider_error(format!("无法创建网络客户端：{e}")))
}

fn add_headers(
    mut req: RequestBuilder,
    profile: &Value,
    api_key: Option<&str>,
    json_body: bool,
) -> RequestBuilder {
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openai_compatible");

    req = req.header("Accept", "application/json");
    if json_body {
        req = req.header("Content-Type", "application/json");
    }
    if let Some(key) = api_key.filter(|s| !s.is_empty()) {
        req = match kind {
            "anthropic" => req
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01"),
            "gemini_native" => req.header("x-goog-api-key", key),
            _ => req.bearer_auth(key),
        };
    } else if kind == "anthropic" {
        req = req.header("anthropic-version", "2023-06-01");
    }

    if let Some(headers) = profile.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                req = req.header(name.as_str(), value);
            }
        }
    }
    req
}

fn response_error(resp: reqwest::blocking::Response) -> RuntimeError {
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    provider_error(format!(
        "模型接口返回 HTTP {}：{}",
        status.as_u16(),
        body.chars().take(1000).collect::<String>()
    ))
}

fn response_json(resp: reqwest::blocking::Response) -> Result<Value, RuntimeError> {
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| provider_error(format!("读取服务商响应失败：{e}")))?;
    if !status.is_success() {
        return Err(provider_error(format!(
            "HTTP {}: {}",
            status.as_u16(),
            text.chars().take(500).collect::<String>()
        )));
    }
    serde_json::from_str(&text).map_err(|e| provider_error(format!("服务商返回了无效 JSON：{e}")))
}

pub fn list_models(profile: &Value, api_key: Option<&str>) -> Result<Vec<String>, RuntimeError> {
    let endpoint = profile
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写接口地址"))?;
    let url = format!("{}/models", endpoint.trim_end_matches('/'));
    let resp = add_headers(client()?.get(url), profile, api_key, false)
        .send()
        .map_err(|e| provider_error(format!("获取模型失败：{e}")))?;
    let payload = response_json(resp)?;
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openai_compatible");

    let mut ids = Vec::new();
    if kind == "gemini_native" {
        for model in payload
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let methods = model
                .get("supportedGenerationMethods")
                .and_then(Value::as_array);
            if methods.is_some_and(|xs| {
                !xs.is_empty() && !xs.iter().any(|v| v.as_str() == Some("generateContent"))
            }) {
                continue;
            }
            if let Some(name) = model.get("name").and_then(Value::as_str) {
                ids.push(name.strip_prefix("models/").unwrap_or(name).to_owned());
            }
        }
    } else {
        for model in payload
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = model.get("id").and_then(Value::as_str) {
                ids.push(id.to_owned());
            }
        }
    }

    ids.sort_by_key(|s| s.to_lowercase());
    ids.dedup();
    Ok(ids)
}

pub fn test_profile(profile: &Value, api_key: Option<&str>) -> Result<String, RuntimeError> {
    let endpoint = profile
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写接口地址"))?;
    let model = profile
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写模型 ID"))?;
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openai_compatible");

    let (url, body) = match kind {
        "anthropic" => (
            format!("{}/messages", endpoint.trim_end_matches('/')),
            json!({
                "model": model,
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "Reply with: ok"}]
            }),
        ),
        "gemini_native" => (
            format!(
                "{}/models/{}:generateContent",
                endpoint.trim_end_matches('/'),
                model.strip_prefix("models/").unwrap_or(model)
            ),
            json!({"contents": [{"role": "user", "parts": [{"text": "Reply with: ok"}]}]}),
        ),
        _ => (
            format!("{}/chat/completions", endpoint.trim_end_matches('/')),
            json!({
                "model": model,
                "stream": false,
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "Reply with: ok"}]
            }),
        ),
    };

    let resp = add_headers(client()?.post(url), profile, api_key, true)
        .json(&body)
        .send()
        .map_err(|e| provider_error(format!("测试连接失败：{e}")))?;
    let payload = response_json(resp)?;

    let reply = match kind {
        "anthropic" => payload
            .get("content")
            .and_then(Value::as_array)
            .and_then(|xs| {
                xs.iter()
                    .find_map(|x| x.get("text").and_then(Value::as_str))
            })
            .unwrap_or("ok"),
        "gemini_native" => payload
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(Value::as_str)
            .unwrap_or("ok"),
        _ => payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or("ok"),
    };
    Ok(reply.chars().take(80).collect())
}

/// Complete chat helper used for profile tests and approval review.
/// Interactive Agent turns use the streaming path below so stop/reasoning/tool deltas remain responsive.
pub fn chat_complete(
    profile: &Value,
    api_key: Option<&str>,
    messages: &[Value],
    reasoning: &str,
) -> Result<String, RuntimeError> {
    let endpoint = profile
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写接口地址"))?;
    let model = profile
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写模型 ID"))?;
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openai_compatible");

    let (url, body) = match kind {
        "anthropic" => {
            let mut system = Vec::new();
            let mut out = Vec::new();
            for message in messages {
                let role = message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("user");
                let content = message.get("content").and_then(Value::as_str).unwrap_or("");
                if content.is_empty() {
                    continue;
                }
                if role == "system" {
                    system.push(content.to_owned());
                } else {
                    out.push(json!({
                        "role": if role == "assistant" { "assistant" } else { "user" },
                        "content": content
                    }));
                }
            }
            let mut body = json!({
                "model": model,
                "max_tokens": profile.pointer("/sampling/max_tokens").and_then(Value::as_u64).unwrap_or(8192),
                "messages": out
            });
            if !system.is_empty() {
                body["system"] = Value::String(system.join("\n\n"));
            }
            if reasoning == "on" {
                body["thinking"] = json!({"type": "adaptive"});
            }
            (format!("{}/messages", endpoint.trim_end_matches('/')), body)
        }
        "gemini_native" => {
            let mut contents = Vec::new();
            let mut system = Vec::new();
            for message in messages {
                let role = message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("user");
                let content = message.get("content").and_then(Value::as_str).unwrap_or("");
                if content.is_empty() {
                    continue;
                }
                if role == "system" {
                    system.push(content.to_owned());
                } else {
                    contents.push(json!({
                        "role": if role == "assistant" { "model" } else { "user" },
                        "parts": [{"text": content}]
                    }));
                }
            }
            let mut body = json!({"contents": contents});
            if !system.is_empty() {
                body["systemInstruction"] = json!({"parts": [{"text": system.join("\n\n")}]});
            }
            (
                format!(
                    "{}/models/{}:generateContent",
                    endpoint.trim_end_matches('/'),
                    model.strip_prefix("models/").unwrap_or(model)
                ),
                body,
            )
        }
        _ => {
            let mut body = json!({
                "model": model,
                "messages": messages,
                "stream": false
            });
            if let Some(sampling) = profile.get("sampling").and_then(Value::as_object) {
                for (key, value) in sampling {
                    if !value.is_null() {
                        body[key] = value.clone();
                    }
                }
            }

            let lower_model = model.to_ascii_lowercase();
            if matches!(reasoning, "on" | "off") {
                let on = reasoning == "on";
                match kind {
                    "deepseek" => {
                        body["thinking"] = json!({"type": if on { "enabled" } else { "disabled" }})
                    }
                    "openrouter" => body["reasoning"] = json!({"enabled": on}),
                    "gemini" => {
                        body["reasoning_effort"] = Value::String(
                            if on {
                                "high"
                            } else if lower_model.contains("pro")
                                || lower_model.starts_with("gemini-3")
                            {
                                "minimal"
                            } else {
                                "none"
                            }
                            .into(),
                        )
                    }
                    "openai"
                        if lower_model.starts_with("o1")
                            || lower_model.starts_with("o3")
                            || lower_model.starts_with("o4")
                            || lower_model.starts_with("gpt-5") =>
                    {
                        body["reasoning_effort"] =
                            Value::String(if on { "medium" } else { "none" }.into())
                    }
                    "minimax" | "minimax_cn" => {
                        body["thinking"] = json!({"type": if on { "adaptive" } else { "disabled" }})
                    }
                    _ => {}
                }
            }
            if matches!(kind, "minimax" | "minimax_cn") {
                body["reasoning_split"] = Value::Bool(true);
            }
            if let Some(extra) = profile.get("extra_body").and_then(Value::as_object) {
                for (key, value) in extra {
                    body[key] = value.clone();
                }
            }
            (
                format!("{}/chat/completions", endpoint.trim_end_matches('/')),
                body,
            )
        }
    };

    let resp = add_headers(client()?.post(url), profile, api_key, true)
        .json(&body)
        .send()
        .map_err(|e| provider_error(format!("模型请求失败：{e}")))?;
    let payload = response_json(resp)?;

    let text = match kind {
        "anthropic" => payload
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
        "gemini_native" => payload
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
        _ => {
            let content = payload.pointer("/choices/0/message/content");
            match content {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|part| {
                        part.get("text")
                            .and_then(Value::as_str)
                            .or_else(|| part.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            }
        }
    };

    if text.trim().is_empty() {
        return Err(provider_error(format!(
            "模型返回成功，但没有可显示的文本：{}",
            payload.to_string().chars().take(600).collect::<String>()
        )));
    }
    Ok(text)
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct ProviderTurn {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub assistant_message: Value,
    pub usage: Value,
}

/// Canonical messages use OpenAI content blocks; adapters convert image blocks without reading files.
pub fn validate_attachments(attachments: &[Value]) -> Result<Vec<Value>, RuntimeError> {
    if attachments.len() > 4 {
        return Err(RuntimeError::new(
            "BAD_ATTACHMENT",
            "每次最多添加 4 张参考图",
        ));
    }
    let mut total = 0usize;
    let mut out = Vec::new();
    for attachment in attachments {
        let data_url = attachment
            .get("data_url")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::new("BAD_ATTACHMENT", "图片附件缺少 data_url"))?;
        let (mime, encoded) = image_data(data_url)?;
        if encoded.len() > 7 * 1024 * 1024 {
            return Err(RuntimeError::new(
                "BAD_ATTACHMENT",
                "单张参考图不能超过 5 MiB",
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| RuntimeError::new("BAD_ATTACHMENT", "参考图不是有效的 Base64 数据"))?;
        let signature_ok = match mime {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
            _ => false,
        };
        if !signature_ok || bytes.len() > 5 * 1024 * 1024 {
            return Err(RuntimeError::new(
                "BAD_ATTACHMENT",
                "参考图格式无效，或超过单张 5 MiB 限制",
            ));
        }
        total += bytes.len();
        if total > 10 * 1024 * 1024 {
            return Err(RuntimeError::new(
                "BAD_ATTACHMENT",
                "参考图总大小不能超过 10 MiB",
            ));
        }
        out.push(json!({"name":attachment.get("name").and_then(Value::as_str).unwrap_or("参考图").chars().take(120).collect::<String>(), "data_url":data_url}));
    }
    Ok(out)
}

fn image_data(url: &str) -> Result<(&str, &str), RuntimeError> {
    let (header, data) = url
        .split_once(',')
        .ok_or_else(|| RuntimeError::new("BAD_ATTACHMENT", "参考图必须是内嵌图片数据"))?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|x| x.strip_suffix(";base64"))
        .filter(|x| matches!(*x, "image/png" | "image/jpeg" | "image/webp"))
        .ok_or_else(|| RuntimeError::new("BAD_ATTACHMENT", "参考图只支持 PNG、JPEG 和 WebP"))?;
    Ok((mime, data))
}

pub fn user_content(text: &str, attachments: &[Value]) -> Value {
    if attachments.is_empty() {
        return json!(text);
    }
    let mut content = vec![json!({"type":"text","text":text})];
    content.extend(
        attachments
            .iter()
            .map(|x| json!({"type":"image_url","image_url":{"url":x["data_url"]}})),
    );
    Value::Array(content)
}

pub fn ensure_vision(profile: &Value, messages: &[Value]) -> Result<(), RuntimeError> {
    if profile.get("vision").and_then(Value::as_bool) != Some(true)
        && messages.iter().any(|m| {
            m["content"]
                .as_array()
                .is_some_and(|xs| xs.iter().any(|x| x["type"] == "image_url"))
        })
    {
        return Err(RuntimeError::new(
            "VISION_UNSUPPORTED",
            "当前服务商配置未启用图片理解，请选择支持视觉的模型并开启图片能力",
        ));
    }
    Ok(())
}

fn converted_content(content: &Value, gemini: bool) -> Value {
    let Some(parts) = content.as_array() else {
        return if gemini {
            json!([{"text":content.as_str().unwrap_or("")}])
        } else {
            content.clone()
        };
    };
    Value::Array(
        parts
            .iter()
            .filter_map(|part| {
                if part["type"] == "text" {
                    return Some(if gemini {
                        json!({"text":part["text"]})
                    } else {
                        part.clone()
                    });
                }
                let (mime, data) = image_data(part.pointer("/image_url/url")?.as_str()?).ok()?;
                Some(if gemini {
                    json!({"inlineData":{"mimeType":mime,"data":data}})
                } else {
                    json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}})
                })
            })
            .collect(),
    )
}

pub fn normalize_usage(kind: &str, raw: Option<&Value>) -> Value {
    let Some(raw) = raw.filter(|v| v.is_object()) else {
        return json!({"source":"unknown","input_tokens":null,"output_tokens":null,"total_tokens":null});
    };
    let (input, output, total) = if kind == "gemini_native" {
        let input = raw.get("promptTokenCount").and_then(Value::as_u64);
        let output = raw
            .get("candidatesTokenCount")
            .and_then(Value::as_u64)
            .map(|n| {
                n.saturating_add(
                    raw.get("thoughtsTokenCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                )
            });
        (
            input,
            output,
            raw.get("totalTokenCount").and_then(Value::as_u64),
        )
    } else if kind == "anthropic" {
        let input = raw.get("input_tokens").and_then(Value::as_u64).map(|n| {
            n.saturating_add(
                raw.get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
            .saturating_add(
                raw.get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        });
        let output = raw.get("output_tokens").and_then(Value::as_u64);
        (
            input,
            output,
            input.zip(output).map(|(a, b)| a.saturating_add(b)),
        )
    } else {
        (
            raw.get("prompt_tokens").and_then(Value::as_u64),
            raw.get("completion_tokens").and_then(Value::as_u64),
            raw.get("total_tokens").and_then(Value::as_u64),
        )
    };
    json!({"source":if input.is_some() && output.is_some() {"provider"} else {"unknown"},"input_tokens":input,"output_tokens":output,"total_tokens":total.or_else(|| input.zip(output).map(|(a,b)| a.saturating_add(b))),"raw":raw})
}

pub(crate) async fn cancellable<F: Future>(
    cancel: &AtomicBool,
    future: F,
) -> Result<F::Output, RuntimeError> {
    tokio::pin!(future);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(RuntimeError::new("STOPPED", "已由你停止"));
        }
        tokio::select! {
            result = &mut future => return Ok(result),
            _ = tokio::time::sleep(Duration::from_millis(80)) => {},
        }
    }
}

/// Async network futures are dropped on stop, including DNS/connect/header/body waits.
struct CancellableSseReader {
    runtime: tokio::runtime::Runtime,
    response: reqwest::Response,
    buffer: Vec<u8>,
    ended: bool,
}

impl CancellableSseReader {
    fn new(
        url: &str,
        body: &Value,
        profile: &Value,
        key: Option<&str>,
        cancel: &AtomicBool,
    ) -> Result<Self, RuntimeError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| provider_error(e.to_string()))?;
        let response = runtime.block_on(async {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .timeout(Duration::from_secs(180))
                .build()
                .map_err(|e| provider_error(e.to_string()))?;
            let mut request = client
                .post(url)
                .header("Accept", "text/event-stream")
                .json(body);
            let kind = profile["kind"].as_str().unwrap_or("openai_compatible");
            if kind == "anthropic" {
                request = request.header("anthropic-version", "2023-06-01");
            }
            if let Some(key) = key.filter(|s| !s.is_empty()) {
                request = match kind {
                    "anthropic" => request.header("x-api-key", key),
                    "gemini_native" => request.header("x-goog-api-key", key),
                    _ => request.bearer_auth(key),
                };
            }
            if let Some(headers) = profile["headers"].as_object() {
                for (k, v) in headers {
                    if let Some(v) = v.as_str() {
                        request = request.header(k, v);
                    }
                }
            }
            let response = cancellable(cancel, request.send())
                .await?
                .map_err(|e| provider_error(e.to_string()))?;
            if !response.status().is_success() {
                let status = response.status();
                let detail = cancellable(cancel, response.text())
                    .await?
                    .unwrap_or_default();
                return Err(provider_error(format!(
                    "模型接口返回 HTTP {}：{}",
                    status.as_u16(),
                    detail.chars().take(1000).collect::<String>()
                )));
            }
            Ok(response)
        })?;
        Ok(Self {
            runtime,
            response,
            buffer: Vec::new(),
            ended: false,
        })
    }

    fn read_line(&mut self, line: &mut String, cancel: &AtomicBool) -> Result<usize, RuntimeError> {
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(RuntimeError::new("STOPPED", "已由你停止"));
            }
            if let Some(pos) = self.buffer.iter().position(|x| *x == b'\n') {
                let bytes: Vec<u8> = self.buffer.drain(..=pos).collect();
                line.push_str(&String::from_utf8_lossy(&bytes));
                return Ok(bytes.len());
            }
            if self.ended {
                let n = self.buffer.len();
                line.push_str(&String::from_utf8_lossy(&self.buffer));
                self.buffer.clear();
                return Ok(n);
            }
            let chunk = self
                .runtime
                .block_on(cancellable(cancel, self.response.chunk()))?
                .map_err(|e| provider_error(e.to_string()))?;
            if let Some(chunk) = chunk {
                self.buffer.extend_from_slice(&chunk);
            } else {
                self.ended = true;
            }
            if self.buffer.len() > 8 * 1024 * 1024 {
                return Err(provider_error("模型流数据行超过安全上限"));
            }
        }
    }
}

fn parse_json_object(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn canonical_tool_calls(calls: &[ToolCall]) -> Value {
    Value::Array(
        calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into())
                    }
                })
            })
            .collect(),
    )
}

fn anthropic_request_messages(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut system = Vec::new();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < messages.len() {
        let message = &messages[i];
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        match role {
            "system" => {
                if let Some(text) = message.get("content").and_then(Value::as_str) {
                    if !text.is_empty() {
                        system.push(text.to_owned());
                    }
                }
                i += 1;
            }
            "assistant" => {
                let mut content = Vec::new();
                if let Some(text) = message.get("content").and_then(Value::as_str) {
                    if !text.is_empty() {
                        content.push(json!({"type":"text","text":text}));
                    }
                }
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let id = call.get("id").and_then(Value::as_str).unwrap_or("");
                        let function = call.get("function").and_then(Value::as_object);
                        let name = function
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let args = function
                            .and_then(|f| f.get("arguments"))
                            .and_then(Value::as_str)
                            .map(parse_json_object)
                            .unwrap_or_else(|| json!({}));
                        if !name.is_empty() {
                            content
                                .push(json!({"type":"tool_use","id":id,"name":name,"input":args}));
                        }
                    }
                }
                out.push(json!({"role":"assistant","content":content}));
                i += 1;
            }
            "tool" => {
                let mut content = Vec::new();
                while i < messages.len()
                    && messages[i].get("role").and_then(Value::as_str) == Some("tool")
                {
                    let tool = &messages[i];
                    let id = tool
                        .get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let result = tool.get("content").and_then(Value::as_str).unwrap_or("");
                    content.push(json!({"type":"tool_result","tool_use_id":id,"content":result}));
                    i += 1;
                }
                out.push(json!({"role":"user","content":content}));
            }
            _ => {
                out.push(
                    json!({"role":"user","content":converted_content(&message["content"], false)}),
                );
                i += 1;
            }
        }
    }
    let system = if system.is_empty() {
        None
    } else {
        Some(system.join("\n\n"))
    };
    (system, out)
}

fn gemini_request(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut system = Vec::new();
    let mut contents = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        match role {
            "system" => {
                if let Some(text) = message.get("content").and_then(Value::as_str) {
                    if !text.is_empty() {
                        system.push(text.to_owned());
                    }
                }
            }
            "assistant" => {
                let mut parts = Vec::new();
                if let Some(saved) = message.get("gemini_parts").and_then(Value::as_array) {
                    contents.push(json!({"role":"model","parts":saved}));
                    continue;
                }
                if let Some(text) = message.get("content").and_then(Value::as_str) {
                    if !text.is_empty() {
                        parts.push(json!({"text":text}));
                    }
                }
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let function = call.get("function").and_then(Value::as_object);
                        let name = function
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let args = function
                            .and_then(|f| f.get("arguments"))
                            .and_then(Value::as_str)
                            .map(parse_json_object)
                            .unwrap_or_else(|| json!({}));
                        if !name.is_empty() {
                            parts.push(json!({"functionCall":{"name":name,"args":args}}));
                        }
                    }
                }
                contents.push(json!({"role":"model","parts":parts}));
            }
            "tool" => {
                let name = message
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let raw = message.get("content").and_then(Value::as_str).unwrap_or("");
                let response =
                    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({"result":raw}));
                contents.push(json!({
                    "role":"user",
                    "parts":[{"functionResponse":{"name":name,"response":response}}]
                }));
            }
            _ => {
                contents.push(
                    json!({"role":"user","parts":converted_content(&message["content"], true)}),
                );
            }
        }
    }
    let system = if system.is_empty() {
        None
    } else {
        Some(system.join("\n\n"))
    };
    (system, contents)
}

pub fn agent_turn(
    profile: &Value,
    api_key: Option<&str>,
    messages: &[Value],
    tools: &[Value],
    reasoning: &str,
    web_search: bool,
) -> Result<ProviderTurn, RuntimeError> {
    ensure_vision(profile, messages)?;
    let endpoint = profile
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写接口地址"))?;
    let model = profile
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写模型 ID"))?;
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openai_compatible");

    if profile.get("tool_calling").and_then(Value::as_bool) == Some(false) {
        return Err(RuntimeError::new(
            "TOOLS_DISABLED",
            "这个服务商配置关闭了工具调用；请在服务商设置里启用后再使用只读模式",
        ));
    }

    match kind {
        "anthropic" => {
            let (system, request_messages) = anthropic_request_messages(messages);
            let mut body = json!({
                "model": model,
                "max_tokens": profile.pointer("/sampling/max_tokens").and_then(Value::as_u64).unwrap_or(8192),
                "messages": request_messages,
                "tools": tools.iter().filter_map(|tool| {
                    let function = tool.get("function")?;
                    Some(json!({
                        "name": function.get("name")?,
                        "description": function.get("description").cloned().unwrap_or(Value::String(String::new())),
                        "input_schema": function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object"}))
                    }))
                }).collect::<Vec<_>>()
            });
            if let Some(system) = system {
                body["system"] = Value::String(system);
            }
            if reasoning == "on" {
                body["thinking"] = json!({"type":"adaptive"});
            }
            if let Some(extra) = profile.get("extra_body").and_then(Value::as_object) {
                for (key, value) in extra {
                    body[key] = value.clone();
                }
            }
            let resp = add_headers(
                client()?.post(format!("{}/messages", endpoint.trim_end_matches('/'))),
                profile,
                api_key,
                true,
            )
            .json(&body)
            .send()
            .map_err(|e| provider_error(format!("模型请求失败：{e}")))?;
            let payload = response_json(resp)?;

            let mut text = String::new();
            let mut calls = Vec::new();
            for part in payload
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        text.push_str(part.get("text").and_then(Value::as_str).unwrap_or(""))
                    }
                    Some("tool_use") => {
                        let name = part
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        if !name.is_empty() {
                            calls.push(ToolCall {
                                id: part
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| unique_id("call-")),
                                name,
                                arguments: part
                                    .get("input")
                                    .cloned()
                                    .filter(Value::is_object)
                                    .unwrap_or_else(|| json!({})),
                            });
                        }
                    }
                    _ => {}
                }
            }
            let assistant_message = json!({
                "role":"assistant",
                "content":text,
                "tool_calls":canonical_tool_calls(&calls)
            });
            Ok(ProviderTurn {
                text,
                tool_calls: calls,
                assistant_message,
                usage: normalize_usage(kind, payload.get("usage")),
            })
        }
        "gemini_native" => {
            let (system, contents) = gemini_request(messages);
            let mut body = json!({
                "contents": contents,
                "tools": [{"functionDeclarations": tools.iter().filter_map(|tool| {
                    let function = tool.get("function")?;
                    Some(json!({
                        "name": function.get("name")?,
                        "description": function.get("description").cloned().unwrap_or(Value::String(String::new())),
                        "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object"}))
                    }))
                }).collect::<Vec<_>>()}]
            });
            if let Some(system) = system {
                body["systemInstruction"] = json!({"parts":[{"text":system}]});
            }
            if let Some(extra) = profile.get("extra_body").and_then(Value::as_object) {
                for (key, value) in extra {
                    body[key] = value.clone();
                }
            }
            let url = format!(
                "{}/models/{}:generateContent",
                endpoint.trim_end_matches('/'),
                model.strip_prefix("models/").unwrap_or(model)
            );
            let resp = add_headers(client()?.post(url), profile, api_key, true)
                .json(&body)
                .send()
                .map_err(|e| provider_error(format!("模型请求失败：{e}")))?;
            let payload = response_json(resp)?;

            let mut text = String::new();
            let mut calls = Vec::new();
            for part in payload
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                if let Some(piece) = part.get("text").and_then(Value::as_str) {
                    text.push_str(piece);
                }
                if let Some(call) = part.get("functionCall").and_then(Value::as_object) {
                    let name = call
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    if !name.is_empty() {
                        calls.push(ToolCall {
                            id: unique_id("call-"),
                            name,
                            arguments: call
                                .get("args")
                                .cloned()
                                .filter(Value::is_object)
                                .unwrap_or_else(|| json!({})),
                        });
                    }
                }
            }
            let assistant_message = json!({
                "role":"assistant",
                "content":text,
                "tool_calls":canonical_tool_calls(&calls)
            });
            Ok(ProviderTurn {
                text,
                tool_calls: calls,
                assistant_message,
                usage: normalize_usage(kind, payload.get("usageMetadata")),
            })
        }
        _ => {
            let mut body = json!({
                "model": model,
                "messages": messages,
                "stream": false,
                "tools": tools
            });
            if let Some(sampling) = profile.get("sampling").and_then(Value::as_object) {
                for (key, value) in sampling {
                    if !value.is_null() {
                        body[key] = value.clone();
                    }
                }
            }
            let lower_model = model.to_ascii_lowercase();
            if matches!(reasoning, "on" | "off") {
                let on = reasoning == "on";
                match kind {
                    "deepseek" => {
                        body["thinking"] = json!({"type": if on { "enabled" } else { "disabled" }})
                    }
                    "openrouter" => body["reasoning"] = json!({"enabled":on}),
                    "gemini" => {
                        body["reasoning_effort"] = Value::String(
                            if on {
                                "high"
                            } else if lower_model.contains("pro")
                                || lower_model.starts_with("gemini-3")
                            {
                                "minimal"
                            } else {
                                "none"
                            }
                            .into(),
                        );
                    }
                    "openai"
                        if lower_model.starts_with("o1")
                            || lower_model.starts_with("o3")
                            || lower_model.starts_with("o4")
                            || lower_model.starts_with("gpt-5") =>
                    {
                        body["reasoning_effort"] =
                            Value::String(if on { "medium" } else { "none" }.into());
                    }
                    "minimax" | "minimax_cn" => {
                        body["thinking"] =
                            json!({"type": if on { "adaptive" } else { "disabled" }});
                    }
                    _ => {}
                }
            }
            if matches!(kind, "minimax" | "minimax_cn") {
                body["reasoning_split"] = Value::Bool(true);
            }
            if kind == "deepseek" && web_search {
                let list = body["tools"]
                    .as_array_mut()
                    .ok_or_else(|| provider_error("tools 结构无效"))?;
                list.push(json!({"type":"web_search"}));
            }
            if let Some(extra) = profile.get("extra_body").and_then(Value::as_object) {
                for (key, value) in extra {
                    body[key] = value.clone();
                }
            }
            let resp = add_headers(
                client()?.post(format!(
                    "{}/chat/completions",
                    endpoint.trim_end_matches('/')
                )),
                profile,
                api_key,
                true,
            )
            .json(&body)
            .send()
            .map_err(|e| provider_error(format!("模型请求失败：{e}")))?;
            let payload = response_json(resp)?;
            let message = payload
                .pointer("/choices/0/message")
                .cloned()
                .ok_or_else(|| provider_error("模型响应缺少 choices[0].message"))?;

            let text = match message.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|part| {
                        part.get("text")
                            .and_then(Value::as_str)
                            .or_else(|| part.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            let mut calls = Vec::new();
            for call in message
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let function = call.get("function").and_then(Value::as_object);
                let name = function
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if name.is_empty() {
                    continue;
                }
                let args = function
                    .and_then(|f| f.get("arguments"))
                    .and_then(Value::as_str)
                    .map(parse_json_object)
                    .unwrap_or_else(|| json!({}));
                calls.push(ToolCall {
                    id: call
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| unique_id("call-")),
                    name,
                    arguments: args,
                });
            }
            Ok(ProviderTurn {
                text,
                tool_calls: calls,
                assistant_message: message,
                usage: normalize_usage(kind, payload.get("usage")),
            })
        }
    }
}

#[derive(Debug, Clone)]
pub enum StreamEvent {
    Text(String),
    Reasoning(String),
}

pub fn gemini_stream_turn<F>(
    profile: &Value,
    api_key: Option<&str>,
    messages: &[Value],
    tools: &[Value],
    reasoning: &str,
    cancel: &AtomicBool,
    mut on_event: F,
) -> Result<ProviderTurn, RuntimeError>
where
    F: FnMut(StreamEvent),
{
    ensure_vision(profile, messages)?;
    let endpoint = profile
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写接口地址"))?;
    let model = profile
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写模型 ID"))?;
    let (system, contents) = gemini_request(messages);
    let mut body = json!({
        "contents":contents,
        "tools":[{"functionDeclarations":tools.iter().filter_map(|tool|{
            let f=tool.get("function")?;
            Some(json!({"name":f.get("name")?,"description":f.get("description").cloned().unwrap_or(Value::String(String::new())),"parameters":f.get("parameters").cloned().unwrap_or_else(||json!({"type":"object"}))}))
        }).collect::<Vec<_>>()}]
    });
    if let Some(system) = system {
        body["systemInstruction"] = json!({"parts":[{"text":system}]});
    }
    if let Some(sampling) = profile.get("sampling").and_then(Value::as_object) {
        let mut config = Map::new();
        for (key, out) in [
            ("temperature", "temperature"),
            ("top_p", "topP"),
            ("max_tokens", "maxOutputTokens"),
        ] {
            if let Some(v) = sampling.get(key) {
                if !v.is_null() {
                    config.insert(out.into(), v.clone());
                }
            }
        }
        if reasoning == "on" {
            config.insert("thinkingConfig".into(), json!({"includeThoughts":true}));
        }
        if !config.is_empty() {
            body["generationConfig"] = Value::Object(config);
        }
    } else if reasoning == "on" {
        body["generationConfig"] = json!({"thinkingConfig":{"includeThoughts":true}});
    }
    if let Some(extra) = profile.get("extra_body").and_then(Value::as_object) {
        for (k, v) in extra {
            body[k] = v.clone();
        }
    }
    let url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse",
        endpoint.trim_end_matches('/'),
        model.strip_prefix("models/").unwrap_or(model)
    );
    if tools.is_empty() {
        body.as_object_mut().unwrap().remove("tools");
    }
    let mut reader = CancellableSseReader::new(&url, &body, profile, api_key, cancel)?;
    let mut line = String::new();
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut original_parts = Vec::new();
    let mut usage_raw = Value::Null;
    let mut finished = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(RuntimeError::new("STOPPED", "已由你停止"));
        }
        line.clear();
        let n = reader.read_line(&mut line, cancel)?;
        if n == 0 {
            break;
        }
        let raw = line.trim();
        let Some(data) = raw.strip_prefix("data:") else {
            continue;
        };
        let Ok(chunk) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        if let Some(error) = chunk.get("error") {
            return Err(provider_error(error.to_string()));
        }
        if let Some(usage) = chunk.get("usageMetadata") {
            usage_raw = usage.clone();
        }
        if chunk
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
            .is_some()
        {
            finished = true;
        }
        for part in chunk
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if part.get("thought").and_then(Value::as_bool) != Some(true) {
                original_parts.push(part.clone());
            }
            if let Some(piece) = part.get("text").and_then(Value::as_str) {
                if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    on_event(StreamEvent::Reasoning(piece.to_owned()));
                } else {
                    text.push_str(piece);
                    on_event(StreamEvent::Text(piece.to_owned()));
                }
            }
            if let Some(fc) = part.get("functionCall").and_then(Value::as_object) {
                let name = fc
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if !name.is_empty() {
                    calls.push(ToolCall {
                        id: unique_id("call-"),
                        name,
                        arguments: fc
                            .get("args")
                            .cloned()
                            .filter(Value::is_object)
                            .unwrap_or_else(|| json!({})),
                    });
                }
            }
        }
    }
    if !finished {
        return Err(RuntimeError::new(
            "PROVIDER_TRUNCATED",
            "模型流提前中断，未执行不完整的工具调用",
        ));
    }
    let assistant_message = json!({"role":"assistant","content":text,"tool_calls":canonical_tool_calls(&calls),"gemini_parts":original_parts});
    Ok(ProviderTurn {
        text,
        tool_calls: calls,
        assistant_message,
        usage: normalize_usage("gemini_native", Some(&usage_raw)),
    })
}

pub fn anthropic_stream_turn<F>(
    profile: &Value,
    api_key: Option<&str>,
    messages: &[Value],
    tools: &[Value],
    reasoning: &str,
    cancel: &AtomicBool,
    mut on_event: F,
) -> Result<ProviderTurn, RuntimeError>
where
    F: FnMut(StreamEvent),
{
    ensure_vision(profile, messages)?;
    let endpoint = profile
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写接口地址"))?;
    let model = profile
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写模型 ID"))?;
    let (system, request_messages) = anthropic_request_messages(messages);
    let mut body = json!({
        "model":model,
        "max_tokens":profile.pointer("/sampling/max_tokens").and_then(Value::as_u64).unwrap_or(8192),
        "messages":request_messages,
        "stream":true,
        "tools":tools.iter().filter_map(|tool|{
            let function=tool.get("function")?;
            Some(json!({"name":function.get("name")?,"description":function.get("description").cloned().unwrap_or(Value::String(String::new())),"input_schema":function.get("parameters").cloned().unwrap_or_else(||json!({"type":"object"}))}))
        }).collect::<Vec<_>>()
    });
    if let Some(system) = system {
        body["system"] = Value::String(system);
    }
    if reasoning == "on" {
        body["thinking"] = json!({"type":"adaptive"});
    }
    if let Some(sampling) = profile.get("sampling").and_then(Value::as_object) {
        for key in ["temperature", "top_p"] {
            if let Some(v) = sampling.get(key) {
                if !v.is_null() {
                    body[key] = v.clone();
                }
            }
        }
    }
    if let Some(extra) = profile.get("extra_body").and_then(Value::as_object) {
        for (k, v) in extra {
            body[k] = v.clone();
        }
    }
    if tools.is_empty() {
        body.as_object_mut().unwrap().remove("tools");
    }
    let mut reader = CancellableSseReader::new(
        &format!("{}/messages", endpoint.trim_end_matches('/')),
        &body,
        profile,
        api_key,
        cancel,
    )?;
    let mut line = String::new();
    let mut text = String::new();
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut active_tool: Option<(usize, String, String, String)> = None;
    let mut usage_raw = json!({});
    let mut finished = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(RuntimeError::new("STOPPED", "已由你停止"));
        }
        line.clear();
        let n = reader.read_line(&mut line, cancel)?;
        if n == 0 {
            break;
        }
        let raw = line.trim();
        let Some(data) = raw.strip_prefix("data:") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        if let Some(usage) = event
            .get("usage")
            .or_else(|| event.pointer("/message/usage"))
            .and_then(Value::as_object)
        {
            for (k, v) in usage {
                usage_raw[k] = v.clone();
            }
        }
        match event.get("type").and_then(Value::as_str) {
            Some("message_stop") => {
                finished = true;
            }
            Some("content_block_start") => {
                let idx = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if event.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use")
                {
                    active_tool = Some((
                        idx,
                        event
                            .pointer("/content_block/id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        event
                            .pointer("/content_block/name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        String::new(),
                    ));
                }
            }
            Some("content_block_delta") => {
                match event.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(piece) = event.pointer("/delta/text").and_then(Value::as_str) {
                            text.push_str(piece);
                            on_event(StreamEvent::Text(piece.to_owned()));
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(piece) =
                            event.pointer("/delta/thinking").and_then(Value::as_str)
                        {
                            on_event(StreamEvent::Reasoning(piece.to_owned()));
                        }
                    }
                    Some("input_json_delta") => {
                        if let (Some((idx, id, name, args)), Some(piece)) = (
                            active_tool.as_mut(),
                            event.pointer("/delta/partial_json").and_then(Value::as_str),
                        ) {
                            let _ = idx;
                            let _ = id;
                            let _ = name;
                            args.push_str(piece);
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                let idx = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(usize::MAX as u64) as usize;
                if active_tool.as_ref().is_some_and(|x| x.0 == idx) {
                    if let Some((_, id, name, args)) = active_tool.take() {
                        if !name.is_empty() {
                            calls.push(ToolCall {
                                id: if id.is_empty() {
                                    unique_id("call-")
                                } else {
                                    id
                                },
                                name,
                                arguments: parse_json_object(&args),
                            });
                        }
                    }
                }
            }
            Some("error") => {
                return Err(provider_error(
                    event
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Anthropic 流返回错误"),
                ))
            }
            _ => {}
        }
    }
    if !finished {
        return Err(RuntimeError::new(
            "PROVIDER_TRUNCATED",
            "模型流提前中断，未执行不完整的工具调用",
        ));
    }
    let assistant_message =
        json!({"role":"assistant","content":text,"tool_calls":canonical_tool_calls(&calls)});
    Ok(ProviderTurn {
        text,
        tool_calls: calls,
        assistant_message,
        usage: normalize_usage("anthropic", Some(&usage_raw)),
    })
}

pub fn openai_stream_turn<F>(
    profile: &Value,
    api_key: Option<&str>,
    messages: &[Value],
    tools: &[Value],
    reasoning: &str,
    web_search: bool,
    cancel: &AtomicBool,
    mut on_event: F,
) -> Result<ProviderTurn, RuntimeError>
where
    F: FnMut(StreamEvent),
{
    ensure_vision(profile, messages)?;
    let endpoint = profile
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写接口地址"))?;
    let model = profile
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::new("BAD_PROFILE", "请先填写模型 ID"))?;
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openai_compatible");
    if matches!(kind, "anthropic" | "gemini_native") {
        return if kind == "anthropic" {
            anthropic_stream_turn(
                profile, api_key, messages, tools, reasoning, cancel, on_event,
            )
        } else {
            gemini_stream_turn(
                profile, api_key, messages, tools, reasoning, cancel, on_event,
            )
        };
    }

    let mut body = json!({"model":model,"messages":messages,"stream":true,"stream_options":{"include_usage":true}});
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    if let Some(sampling) = profile.get("sampling").and_then(Value::as_object) {
        for (key, value) in sampling {
            if !value.is_null() {
                body[key] = value.clone();
            }
        }
    }
    let lower_model = model.to_ascii_lowercase();
    if matches!(reasoning, "on" | "off") {
        let on = reasoning == "on";
        match kind {
            "deepseek" => body["thinking"] = json!({"type":if on{"enabled"}else{"disabled"}}),
            "openrouter" => body["reasoning"] = json!({"enabled":on}),
            "gemini" => {
                body["reasoning_effort"] = Value::String(
                    if on {
                        "high"
                    } else if lower_model.contains("pro") || lower_model.starts_with("gemini-3") {
                        "minimal"
                    } else {
                        "none"
                    }
                    .into(),
                )
            }
            "openai"
                if lower_model.starts_with("o1")
                    || lower_model.starts_with("o3")
                    || lower_model.starts_with("o4")
                    || lower_model.starts_with("gpt-5") =>
            {
                body["reasoning_effort"] = Value::String(if on { "medium" } else { "none" }.into())
            }
            "minimax" | "minimax_cn" => {
                body["thinking"] = json!({"type":if on{"adaptive"}else{"disabled"}})
            }
            _ => {}
        }
    }
    if matches!(kind, "minimax" | "minimax_cn") {
        body["reasoning_split"] = Value::Bool(true);
    }
    if kind == "deepseek" && web_search {
        if let Some(list) = body["tools"].as_array_mut() {
            list.push(json!({"type":"web_search"}));
        }
    }
    if let Some(extra) = profile.get("extra_body").and_then(Value::as_object) {
        for (key, value) in extra {
            body[key] = value.clone();
        }
    }

    let mut reader = CancellableSseReader::new(
        &format!("{}/chat/completions", endpoint.trim_end_matches('/')),
        &body,
        profile,
        api_key,
        cancel,
    )?;
    let mut line = String::new();
    let mut text = String::new();
    let mut reasoning_text = String::new();
    let mut call_ids: Vec<String> = Vec::new();
    let mut call_names: Vec<String> = Vec::new();
    let mut call_args: Vec<String> = Vec::new();
    let mut usage_raw = Value::Null;
    let mut finished = false;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(RuntimeError::new("STOPPED", "已由你停止"));
        }
        line.clear();
        let n = reader.read_line(&mut line, cancel)?;
        if n == 0 {
            break;
        }
        let raw = line.trim();
        if raw.is_empty() || raw.starts_with(':') {
            continue;
        }
        let Some(data) = raw.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            break;
        }
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(error) = payload.get("error") {
            return Err(provider_error(error.to_string()));
        }
        if let Some(usage) = payload.get("usage").filter(|x| x.is_object()) {
            usage_raw = usage.clone();
        }
        if payload
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .is_some()
        {
            finished = true;
        }
        let Some(delta) = payload.pointer("/choices/0/delta") else {
            continue;
        };

        if let Some(piece) = delta.get("content").and_then(Value::as_str) {
            if !piece.is_empty() {
                text.push_str(piece);
                on_event(StreamEvent::Text(piece.to_owned()));
            }
        }
        for key in ["reasoning_content", "reasoning"] {
            if let Some(piece) = delta.get(key).and_then(Value::as_str) {
                if !piece.is_empty() {
                    reasoning_text.push_str(piece);
                    on_event(StreamEvent::Reasoning(piece.to_owned()));
                }
            }
        }
        for tc in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = tc.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            while call_ids.len() <= index {
                call_ids.push(String::new());
                call_names.push(String::new());
                call_args.push(String::new());
            }
            if let Some(id) = tc.get("id").and_then(Value::as_str) {
                call_ids[index].push_str(id);
            }
            if let Some(name) = tc.pointer("/function/name").and_then(Value::as_str) {
                call_names[index].push_str(name);
            }
            if let Some(args) = tc.pointer("/function/arguments").and_then(Value::as_str) {
                call_args[index].push_str(args);
            }
        }
    }
    if !finished {
        return Err(RuntimeError::new(
            "PROVIDER_TRUNCATED",
            "模型流提前中断，未执行不完整的工具调用",
        ));
    }
    let calls = call_names
        .into_iter()
        .enumerate()
        .filter_map(|(i, name)| {
            if name.is_empty() {
                return None;
            }
            Some(ToolCall {
                id: if call_ids[i].is_empty() {
                    unique_id("call-")
                } else {
                    call_ids[i].clone()
                },
                name,
                arguments: parse_json_object(&call_args[i]),
            })
        })
        .collect::<Vec<_>>();
    let assistant_message =
        json!({"role":"assistant","content":text,"tool_calls":canonical_tool_calls(&calls)});
    let _ = reasoning_text;
    Ok(ProviderTurn {
        text,
        tool_calls: calls,
        assistant_message,
        usage: normalize_usage(kind, Some(&usage_raw)),
    })
}

#[cfg(test)]
mod vibe_provider_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Instant;

    fn attachment() -> Value {
        json!({"name":"参考.png","data_url":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nimage"))})
    }

    #[test]
    fn attachments_require_valid_inline_images_and_explicit_vision() {
        let images = validate_attachments(&[attachment()]).unwrap();
        let messages = vec![json!({"role":"user","content":user_content("参考",&images)})];
        assert_eq!(
            ensure_vision(&json!({}), &messages).unwrap_err().code,
            "VISION_UNSUPPORTED"
        );
        assert!(ensure_vision(&json!({"vision":true}), &messages).is_ok());
        let a = anthropic_request_messages(&messages).1;
        assert_eq!(a[0]["content"][1]["source"]["media_type"], "image/png");
        let g = gemini_request(&messages).1;
        assert_eq!(g[0]["parts"][1]["inlineData"]["mimeType"], "image/png");
        assert!(validate_attachments(&[json!({"data_url":"https://example.com/a.png"})]).is_err());
        assert!(validate_attachments(&[json!({"data_url":"data:image/png;base64,YQ=="})]).is_err());
        assert!(validate_attachments(&vec![attachment(); 5]).is_err());
    }

    #[test]
    fn provider_usage_is_real_or_unknown_and_includes_cache_thinking() {
        assert_eq!(normalize_usage("openai", None)["total_tokens"], Value::Null);
        let usage = normalize_usage(
            "anthropic",
            Some(&json!({"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":5})),
        );
        assert_eq!(usage["total_tokens"], 17);
        let usage = normalize_usage(
            "gemini_native",
            Some(
                &json!({"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3,"totalTokenCount":15}),
            ),
        );
        assert_eq!(usage["output_tokens"], 5);
    }

    #[test]
    fn stop_interrupts_a_server_that_never_sends_response_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0u8; 4096];
            let _ = stream.read(&mut bytes);
            let _ = release_rx.recv_timeout(Duration::from_secs(3));
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let stopper = thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            signal.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let result = CancellableSseReader::new(&url, &json!({}), &json!({}), None, &cancel);
        assert_eq!(result.err().unwrap().code, "STOPPED");
        assert!(started.elapsed() < Duration::from_secs(1));
        release_tx.send(()).unwrap();
        server.join().unwrap();
        stopper.join().unwrap();
    }

    #[test]
    fn usage_only_final_chunk_is_kept_and_truncated_calls_are_rejected() {
        for finished in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = [0u8; 4096];
                let _ = stream.read(&mut bytes);
                let mut data="data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"fs_read\",\"arguments\":\"{}\"}}]}}]}\n\n".to_owned();
                if finished {
                    data.push_str("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\ndata: [DONE]\n\n");
                }
                let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",data.len(),data);
            });
            let result = openai_stream_turn(
                &json!({"kind":"openai","model":"test","endpoint":endpoint}),
                None,
                &[],
                &[],
                "off",
                false,
                &AtomicBool::new(false),
                |_| {},
            );
            if finished {
                let turn = result.unwrap();
                assert_eq!(turn.usage["total_tokens"], 12);
                assert_eq!(turn.tool_calls.len(), 1);
            } else {
                assert_eq!(result.unwrap_err().code, "PROVIDER_TRUNCATED");
            }
            server.join().unwrap();
        }
    }
}
