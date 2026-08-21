from datetime import datetime, timezone
from fastapi import APIRouter
from app.core.config import settings

router = APIRouter(tags=['health'])

@router.get('/health')
def health():
    return {'ok': True, 'app': 'BI WA API', 'engine': 'python-fastapi', 'version': settings.app_version, 'mode': settings.app_mode, 'checkedAt': datetime.now(timezone.utc).isoformat()}

@router.get('/version')
def version():
    return {'ok': True, 'app': 'BI WA', 'engine': 'python-fastapi', 'version': settings.app_version, 'mode': settings.app_mode, 'checkedAt': datetime.now(timezone.utc).isoformat()}

@router.get('/public-config')
def public_config():
    return {'ok': True, 'appName': 'BI WA', 'version': settings.app_version, 'mode': settings.app_mode, 'engine': 'python-fastapi', 'onlineViewOnly': settings.app_mode.lower() == 'online'}
