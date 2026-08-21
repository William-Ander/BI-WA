from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.core.config import settings
from app.services.security import build_token, find_user

router = APIRouter(prefix='/auth', tags=['auth'])

class LoginRequest(BaseModel):
    username: str
    password: str

@router.post('/login')
def login(payload: LoginRequest):
    user = find_user(payload.username.strip(), payload.password)
    if not user:
        raise HTTPException(status_code=401, detail='Usuário ou senha inválidos.')
    token = build_token(user)
    return {'ok': True, 'token': token, 'role': user.get('role') or 'viewer', 'username': user.get('username'), 'name': user.get('name') or user.get('username'), 'mode': settings.app_mode, 'expiresInMs': settings.biwa_auth_token_ttl_seconds * 1000}

@router.post('/logout')
def logout():
    return {'ok': True}
