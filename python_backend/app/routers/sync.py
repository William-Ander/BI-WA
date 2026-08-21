from datetime import datetime, timezone
from fastapi import APIRouter, Request, Depends
from app.core.config import settings
from app.services.security import require_sync_token
from app.services.storage import read_reports, write_reports

router = APIRouter(prefix='/sync', tags=['sync'])

def require_token_dep(request: Request):
    require_sync_token(request)

@router.get('/ping', dependencies=[Depends(require_token_dep)])
def ping():
    reports = read_reports()
    return {'ok': True, 'mode': settings.app_mode, 'version': settings.app_version, 'engine': 'python-fastapi', 'onlineViewOnly': settings.app_mode.lower() == 'online', 'reportCount': len(reports), 'reports': [{'id': r.get('id'), 'name': r.get('name'), 'pages': len(r.get('pages') or []), 'visuals': len(r.get('visuals') or [])} for r in reports], 'checkedAt': datetime.now(timezone.utc).isoformat()}

@router.post('/reports', dependencies=[Depends(require_token_dep)])
async def sync_reports(request: Request):
    body = await request.json()
    reports = body.get('reports') if isinstance(body, dict) else []
    if not isinstance(reports, list):
        reports = []
    write_reports(reports)
    return {'ok': True, 'count': len(reports), 'mode': settings.app_mode, 'engine': 'python-fastapi', 'updatedAt': datetime.now(timezone.utc).isoformat()}
