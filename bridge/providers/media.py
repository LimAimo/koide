"""图片附件与实际用量的统一格式，不读取任意路径或远程图片。"""
from __future__ import annotations
import base64
import math
from typing import Any


def image_data(url: str) -> tuple[str, str]:
    if not isinstance(url, str) or "," not in url:
        raise ValueError("参考图必须是内嵌图片数据")
    header, data = url.split(",", 1)
    if header not in ("data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"):
        raise ValueError("参考图只支持 PNG、JPEG 和 WebP")
    return header[5:-7], data


def validate_attachments(attachments: list[dict] | None) -> list[dict]:
    if attachments is None:
        return []
    if not isinstance(attachments, list) or len(attachments) > 4:
        raise ValueError("每次最多添加 4 张参考图")
    result, total = [], 0
    for attachment in attachments:
        if not isinstance(attachment, dict):
            raise ValueError("参考图附件格式无效")
        mime, data = image_data(attachment.get("data_url"))
        if len(data) > 7 * 1024 * 1024:
            raise ValueError("单张参考图不能超过 5 MiB")
        try:
            raw = base64.b64decode(data, validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError("参考图不是有效的 Base64 数据") from exc
        valid = (mime == "image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n")
                 or mime == "image/jpeg" and raw.startswith(b"\xff\xd8\xff")
                 or mime == "image/webp" and len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
        if not valid or len(raw) > 5 * 1024 * 1024:
            raise ValueError("参考图格式无效，或超过单张 5 MiB 限制")
        total += len(raw)
        if total > 10 * 1024 * 1024:
            raise ValueError("参考图总大小不能超过 10 MiB")
        result.append({"name": str(attachment.get("name") or "参考图")[:120], "data_url": attachment["data_url"]})
    return result


def user_content(text: str, attachments: list[dict]) -> str | list[dict]:
    return ([{"type": "text", "text": text}, *[{"type": "image_url", "image_url": {"url": x["data_url"]}}
            for x in attachments]] if attachments else text)


def ensure_vision(profile: dict, messages: list[dict]) -> None:
    if profile.get("vision") is True:
        return
    if any(isinstance(m.get("content"), list) and any(p.get("type") == "image_url"
           for p in m["content"] if isinstance(p, dict)) for m in messages):
        raise ValueError("当前服务商配置未启用图片理解，请选择支持视觉的模型并开启图片能力")


def converted_content(content: Any, gemini: bool = False) -> Any:
    if not isinstance(content, list):
        return [{"text": str(content or "")}] if gemini else str(content or "")
    result = []
    for part in content:
        if part.get("type") == "text":
            result.append({"text": part["text"]} if gemini else part)
        elif part.get("type") == "image_url":
            mime, data = image_data(part["image_url"]["url"])
            result.append({"inlineData": {"mimeType": mime, "data": data}} if gemini else
                          {"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}})
    return result


def normalize_usage(kind: str, raw: dict | None) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    def token(key: str) -> int | None:
        value = raw.get(key)
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
    if kind == "gemini_native":
        a, b, total = token("promptTokenCount"), token("candidatesTokenCount"), token("totalTokenCount")
        if b is not None:
            b += token("thoughtsTokenCount") or 0
    elif kind == "anthropic":
        a, b, total = token("input_tokens"), token("output_tokens"), None
        if a is not None:
            a += (token("cache_creation_input_tokens") or 0) + (token("cache_read_input_tokens") or 0)
    else:
        a, b, total = token("prompt_tokens"), token("completion_tokens"), token("total_tokens")
    known = a is not None and b is not None
    return {"source": "provider" if known else "unknown", "input_tokens": a, "output_tokens": b,
            "total_tokens": total if total is not None else a + b if known else None, "raw": raw}


def configured_prices(profile: dict) -> tuple[float, float] | None:
    pricing = profile.get("pricing") or {}
    values = [pricing.get(key) for key in ("input_per_million", "output_per_million")]
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 for v in values):
        return tuple(float(v) for v in values)
    return None


def validate_start(profile: dict, attachments: list[dict] | None, limits: dict | None) -> list[dict]:
    images = validate_attachments(attachments)
    ensure_vision(profile, [{"content": user_content("", images)}])
    for key in ("max_tokens", "max_cost_usd", "max_repeated_failures"):
        value = (limits or {}).get(key, 0)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError("任务预算必须是非负有限数值")
    if (limits or {}).get("max_cost_usd", 0) > 0 and configured_prices(profile) is None:
        raise ValueError("请先配置模型的输入和输出单价，再启用费用预算")
    return images


class UsageMeter:
    def __init__(self) -> None:
        self.input = self.output = self.total = self.turns = 0
        self.cost = 0.0
        self.unknown = self.cost_unknown = False

    def record(self, profile: dict, usage: dict) -> dict:
        self.turns += 1
        if usage.get("source") != "provider":
            self.unknown = self.cost_unknown = True
        else:
            self.input += usage["input_tokens"]
            self.output += usage["output_tokens"]
            self.total += usage["total_tokens"]
            prices = configured_prices(profile)
            if prices is None:
                self.cost_unknown = True
            else:
                self.cost += (usage["input_tokens"] * prices[0] + usage["output_tokens"] * prices[1]) / 1_000_000
        return {"turn": usage, "input_tokens": None if self.unknown else self.input, "output_tokens": None if self.unknown else self.output,
                "known_input_tokens": self.input, "known_output_tokens": self.output,
                "total_tokens": None if self.unknown else self.total, "known_tokens": self.total,
                "source": "unknown" if self.unknown else "provider", "cost_usd": None if self.cost_unknown else self.cost,
                "cost_source": "unknown" if self.cost_unknown else "configured_estimate", "turns": self.turns}

    def check(self, limits: dict) -> None:
        token_limit, cost_limit = float(limits.get("max_tokens") or 0), float(limits.get("max_cost_usd") or 0)
        if (token_limit > 0 or cost_limit > 0) and self.unknown:
            raise ValueError("服务商未返回实际用量，已停止后续请求以保护预算")
        if token_limit > 0 and self.total >= token_limit:
            raise ValueError("已达到 Token 预算，已停止后续请求与工具")
        if cost_limit > 0 and self.cost_unknown:
            raise ValueError("无法计算本次费用，已停止后续请求以保护预算")
        if cost_limit > 0 and self.cost >= cost_limit:
            raise ValueError("已达到按配置单价估算的费用预算，已停止后续请求与工具")
