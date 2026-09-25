"""Agent Tool Registry. Every tool declares the same metadata so permissions and UI stay uniform."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


@dataclass
class Tool:
    id: str
    description: str
    input_schema: dict
    permission_class: str            # read | write | delete | exec | network
    risk: str                        # low | medium | high
    handler: Callable[..., Awaitable[Any]]
    activity: str = "working"        # reading | searching | editing | running  (drives the status capsule)
    environment: str = "bridge"
    cancelable: bool = False
    timeout: float = 60.0
    title: Callable[[dict], str] = lambda a: ""   # human title for the tool card, e.g. "读取 "main.py""
    display_name: str = ""           # human name for the tool itself, e.g. "读取文件" for `fs_read`.
                                      # Shown in status lines instead of the raw internal id — the UI
                                      # must never show a person a snake_case tool id like "fs_patch".

    def describe(self) -> dict:
        """Public metadata (Tool ID, description, schema, permission class, risk, environment, cancel, timeout)."""
        return {"id": self.id, "description": self.description, "input_schema": self.input_schema,
                "permission_class": self.permission_class, "risk": self.risk, "environment": self.environment,
                "cancelable": self.cancelable, "timeout": self.timeout}


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.id] = tool

    def get(self, tool_id: str) -> Tool | None:
        return self._tools.get(tool_id)

    def all(self) -> list[Tool]:
        return list(self._tools.values())

    def for_classes(self, classes: set[str]) -> list[Tool]:
        return [t for t in self._tools.values() if t.permission_class in classes]

    @staticmethod
    def openai_specs(tools: list[Tool]) -> list[dict]:
        return [{"type": "function", "function": {"name": t.id, "description": t.description,
                                                  "parameters": t.input_schema}} for t in tools]


_TYPES = {
    "string": str, "boolean": bool, "array": list, "object": dict,
    "integer": int, "number": (int, float),
}


def validate(schema: dict, value: Any, path: str = "$") -> list[str]:
    """Validate `value` against a practical subset of JSON Schema. Returns human-readable errors."""
    errs: list[str] = []
    t = schema.get("type")
    if t:
        ok = isinstance(value, _TYPES[t]) and not (t in ("integer", "number") and isinstance(value, bool))
        if not ok:
            return [f"{path}: expected {t}, got {type(value).__name__}"]
    if "enum" in schema and value not in schema["enum"]:
        errs.append(f"{path}: must be one of {schema['enum']}")
    if isinstance(value, str) and "minLength" in schema and len(value) < schema["minLength"]:
        errs.append(f"{path}: too short")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errs.append(f"{path}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errs.append(f"{path}: must be <= {schema['maximum']}")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for req in schema.get("required", []):
            if req not in value:
                errs.append(f"{path}.{req}: required")
        for k, v in value.items():
            if k in props:
                errs += validate(props[k], v, f"{path}.{k}")
            elif schema.get("additionalProperties") is False:
                errs.append(f"{path}.{k}: unexpected property")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errs.append(f"{path}: needs at least {schema['minItems']} item(s)")
        if "items" in schema:
            for i, item in enumerate(value):
                errs += validate(schema["items"], item, f"{path}[{i}]")
    return errs
