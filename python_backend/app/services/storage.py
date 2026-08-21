import json
from pathlib import Path
from typing import Any

from app.core.config import DATA_DIR, REPORTS_FILE, SETTINGS_FILE, SEMANTIC_MODEL_FILE, TRANSFORMS_FILE


def read_json(path: Path, fallback: Any) -> Any:
    try:
        if not path.exists():
            return fallback
        raw = path.read_text(encoding='utf-8').strip()
        if not raw:
            return fallback
        return json.loads(raw)
    except Exception:
        return fallback


def write_json(path: Path, payload: Any) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def read_reports() -> list[dict[str, Any]]:
    value = read_json(REPORTS_FILE, [])
    return value if isinstance(value, list) else []


def write_reports(reports: list[dict[str, Any]]) -> None:
    write_json(REPORTS_FILE, reports)


def read_settings() -> dict[str, Any]:
    value = read_json(SETTINGS_FILE, {})
    return value if isinstance(value, dict) else {}


def write_settings(settings: dict[str, Any]) -> None:
    write_json(SETTINGS_FILE, settings)


def read_semantic_model() -> dict[str, Any]:
    value = read_json(SEMANTIC_MODEL_FILE, {})
    return value if isinstance(value, dict) else {}


def read_transforms() -> list[dict[str, Any]]:
    value = read_json(TRANSFORMS_FILE, [])
    return value if isinstance(value, list) else []
