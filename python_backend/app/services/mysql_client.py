import re
from typing import Any

try:
    import pymysql
except Exception:  # dependencia instalada pelo requirements.txt no Windows/produção
    pymysql = None

from app.core.config import settings
from app.services.storage import read_settings

BLOCKED = re.compile(r'\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|exec|merge)\b', re.I)


def database_config() -> dict[str, Any]:
    cfg = read_settings()
    db = cfg.get('database') if settings.app_mode.lower() != 'online' else cfg.get('web')
    db = db if isinstance(db, dict) else {}
    return {
        'host': settings.mysql_host or db.get('mysqlHost') or '127.0.0.1',
        'port': int(settings.mysql_port or db.get('mysqlPort') or 3306),
        'user': settings.mysql_user or db.get('mysqlUser') or '',
        'password': settings.mysql_password or db.get('mysqlPassword') or '',
        'database': settings.mysql_database or db.get('mysqlDatabase') or '',
        'cursorclass': pymysql.cursors.DictCursor if pymysql else None,
        'connect_timeout': 8,
        'read_timeout': 30,
        'write_timeout': 30,
        'charset': 'utf8mb4',
        'autocommit': True,
    }


def assert_read_only_sql(sql: str) -> str:
    text = str(sql or '').strip().rstrip(';')
    if not text:
        raise ValueError('SQL vazio.')
    if not re.match(r'^(select|with)\b', text, re.I):
        raise ValueError('Somente SELECT/WITH é permitido no backend Python.')
    if BLOCKED.search(text):
        raise ValueError('SQL contém comando não permitido.')
    return text


def _connect_config() -> dict[str, Any]:
    if pymysql is None:
        raise RuntimeError('PyMySQL não instalado. Execute npm run python:install ou pip install -r requirements.txt.')
    cfg = database_config()
    return {k: v for k, v in cfg.items() if v is not None}


def run_select(sql: str, limit: int | None = None) -> list[dict[str, Any]]:
    text = assert_read_only_sql(sql)
    limit = max(1, min(int(limit or settings.default_query_limit), int(settings.max_query_limit)))
    if not re.search(r'\blimit\s+\d+\b', text, re.I):
        text = f'SELECT * FROM ({text}) biwa_py_query LIMIT {limit}'
    cfg = _connect_config()
    if not cfg.get('user') or not cfg.get('database'):
        raise RuntimeError('Banco MySQL não configurado para o backend Python.')
    with pymysql.connect(**cfg) as conn:
        with conn.cursor() as cur:
            cur.execute(text)
            return list(cur.fetchall())


def test_connection() -> dict[str, Any]:
    cfg = _connect_config()
    safe = {k: v for k, v in cfg.items() if k not in {'password', 'cursorclass'}}
    with pymysql.connect(**cfg) as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT 1 AS ok')
            row = cur.fetchone()
    return {'ok': True, 'database': safe.get('database'), 'host': safe.get('host'), 'result': row}
