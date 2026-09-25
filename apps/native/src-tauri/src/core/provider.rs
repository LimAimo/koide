use crate::core::RuntimeError;
use reqwest::blocking::{Client, RequestBuilder};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
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
        row.get("model").and_then(Value::as_str).unwrap_or("").to_owned(),
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
    let tmp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| io_error("无法序列化服务商配置", e))?;
    fs::write(&tmp, bytes).map_err(|e| io_error("无法写入服务商配置", e))?;
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
                    Value::Bool(secrets.get(id).and_then(Value::as_str).is_some_and(|s| !s.is_empty())),
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
        out.entry("name".into())
            .or_insert_with(|| Value::String(id.to_owned()));
        out.insert("kind".into(), Value::String(kind.to_owned()));
        if out.get("endpoint").and_then(Value::as_str).unwrap_or("").is_empty() {
            out.insert("endpoint".into(), Value::String(default_endpoint));
        }
        if out.get("model").and_then(Value::as_str).is_none() {
            out.insert("model".into(), Value::String(default_model));
        }
        out.entry("tool_calling".into()).or_insert(Value::Bool(true));

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
            write_json(&self.secrets_path, &Value::Object(secrets.clone()))?;
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
            write_json(&self.secrets_path, &Value::Object(secrets))?;
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
        if obj.get("endpoint").and_then(Value::as_str).unwrap_or("").is_empty() {
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
        .timeout(Duration::from_secs(30))
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
                req = req.header(name, value);
            }
        }
    }
    req
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
    serde_json::from_str(&text)
        .map_err(|e| provider_error(format!("服务商返回了无效 JSON：{e}")))
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
                !xs.is_empty()
                    && !xs
                        .iter()
                        .any(|v| v.as_str() == Some("generateContent"))
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
            .and_then(|xs| xs.iter().find_map(|x| x.get("text").and_then(Value::as_str)))
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
