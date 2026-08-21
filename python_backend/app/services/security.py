import base64
import hashlib
import hmac
import json
import time
from typing import Any

from fastapi import Header, HTTPException, Request
from app.core.config import settings
from app.services.storage import read_settings


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def _b64url_decode(value: str) -> bytes:
    padding = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode('ascii'))


def safe_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(str(a or ''), str(b or ''))


def normalize_online_users(users: Any) -> list[dict[str, Any]]:
    if not isinstance(users, list):
        return []
    normalized = []
    seen = set()
    for raw in users[:200]:
        if not isinstance(raw, dict):
            continue
        username = str(raw.get('username') or raw.get('user') or raw.get('login') or '').strip()
        if not username or username.lower() in seen:
            continue
        seen.add(username.lower())
        normalized.append({
            'id': str(raw.get('id') or hashlib.sha1(username.encode('utf-8')).hexdigest()[:12]),
            'username': username,
            'name': str(raw.get('name') or username).strip(),
            'password': str(raw.get('password') or ''),
            'active': bool(raw.get('active', True)),
            'role': str(raw.get('role') or 'viewer'),
            'reportPermissions': raw.get('reportPermissions') if isinstance(raw.get('reportPermissions'), dict) else {},
        })
    return normalized


def effective_online_users() -> list[dict[str, Any]]:
    cfg = read_settings()
    access = cfg.get('access') if isinstance(cfg.get('access'), dict) else {}
    users = normalize_online_users(access.get('onlineUsers'))
    if users:
        return users
    viewer_user = str(access.get('viewerUser') or '').strip()
    if viewer_user:
        return normalize_online_users([{
            'username': viewer_user,
            'name': 'Visualizador padrão',
            'password': str(access.get('viewerPassword') or ''),
            'active': True,
            'reportPermissions': {},
        }])
    return []


def find_user(username: str, password: str | None = None) -> dict[str, Any] | None:
    cfg = read_settings()
    access = cfg.get('access') if isinstance(cfg.get('access'), dict) else {}
    mode = settings.app_mode.lower()
    if mode != 'online':
        admin_user = str(access.get('adminUser') or 'admin').strip()
        admin_pass = str(access.get('adminPassword') or '')
        if username == admin_user and (password is None or safe_equal(password, admin_pass)):
            return {'username': admin_user, 'name': 'Administrador', 'role': 'admin', 'reportPermissions': {}}
    for user in effective_online_users():
        if not user.get('active'):
            continue
        if user['username'].lower() == username.lower() and (password is None or safe_equal(password, user.get('password', ''))):
            return user
    return None


def build_token(user: dict[str, Any]) -> str:
    payload = {
        'sub': user.get('username'),
        'name': user.get('name') or user.get('username'),
        'role': user.get('role') or 'viewer',
        'exp': int(time.time()) + int(settings.biwa_auth_token_ttl_seconds),
    }
    body = _b64url(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
    sig = _b64url(hmac.new(settings.biwa_auth_secret.encode('utf-8'), body.encode('ascii'), hashlib.sha256).digest())
    return f'{body}.{sig}'


def read_token(token: str) -> dict[str, Any] | None:
    try:
        body, sig = token.split('.', 1)
        expected = _b64url(hmac.new(settings.biwa_auth_secret.encode('utf-8'), body.encode('ascii'), hashlib.sha256).digest())
        if not safe_equal(sig, expected):
            return None
        payload = json.loads(_b64url_decode(body).decode('utf-8'))
        if int(payload.get('exp') or 0) < int(time.time()):
            return None
        user = find_user(str(payload.get('sub') or ''), None)
        if not user:
            return None
        user = dict(user)
        user['role'] = payload.get('role') or user.get('role') or 'viewer'
        return user
    except Exception:
        return None


def current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if settings.app_mode.lower() != 'online':
        return {'username': 'admin', 'name': 'Administrador', 'role': 'admin', 'reportPermissions': {}}
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status_code=401, detail='Login obrigatório.')
    user = read_token(authorization.split(' ', 1)[1])
    if not user:
        raise HTTPException(status_code=401, detail='Sessão inválida ou expirada.')
    return user


def require_sync_token(request: Request) -> None:
    configured = settings.biwa_sync_token or str((read_settings().get('publish') or {}).get('syncToken') or '')
    if not configured:
        raise HTTPException(status_code=403, detail='Token de sincronização não configurado.')
    supplied = request.headers.get('x-sync-token') or request.headers.get('authorization', '').replace('Bearer ', '')
    if not safe_equal(supplied, configured):
        raise HTTPException(status_code=403, detail='Token de sincronização inválido.')
