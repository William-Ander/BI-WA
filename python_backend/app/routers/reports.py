from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from app.core.config import settings
from app.services.storage import read_reports, write_reports
from app.services.permissions import apply_user_access, public_report, reports_for_user
from app.services.security import current_user
from app.services.mysql_client import run_select

router = APIRouter(prefix='/reports', tags=['reports'])

class RunRequest(BaseModel):
    filters: dict | list | None = None
    limit: int | None = None

@router.get('')
def list_reports(user=Depends(current_user)):
    reports = read_reports()
    if settings.app_mode.lower() == 'online':
        reports = [public_report(r) for r in reports_for_user(reports, user)]
    return {'reports': reports}

@router.post('/{report_id}/run')
def run_report(report_id: str, payload: RunRequest | None = None, user=Depends(current_user)):
    report = next((r for r in read_reports() if str(r.get('id')) == report_id), None)
    if not report:
        raise HTTPException(status_code=404, detail='Relatório não encontrado.')
    accessible = apply_user_access(report, user) if settings.app_mode.lower() == 'online' else report
    if not accessible:
        raise HTTPException(status_code=403, detail='Você não tem permissão para acessar este relatório.')
    limit = payload.limit if payload else None
    visual_results = []
    for visual in (accessible.get('visuals') or [])[:60]:
        if not isinstance(visual, dict) or not visual.get('sql'):
            continue
        try:
            rows = run_select(str(visual.get('sql')), limit or accessible.get('limit'))
            visual_results.append({'id': visual.get('id'), 'title': visual.get('title'), 'visualization': visual.get('visualization'), 'layout': visual.get('layout'), 'pageId': visual.get('pageId') or 'page_1', 'style': visual.get('style') or {}, 'rows': rows})
        except Exception as exc:
            visual_results.append({'id': visual.get('id'), 'title': visual.get('title'), 'visualization': visual.get('visualization'), 'layout': visual.get('layout'), 'pageId': visual.get('pageId') or 'page_1', 'style': visual.get('style') or {}, 'error': str(exc)})
    try:
        rows = run_select(str(accessible.get('sql') or 'SELECT 1 AS ok'), limit or accessible.get('limit'))
        result = {'rows': rows}
    except Exception as exc:
        result = {'rows': [], 'error': str(exc)}
    if visual_results:
        result['visualResults'] = visual_results
    return {'report': public_report(accessible) if settings.app_mode.lower() == 'online' else accessible, 'result': result, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'engine': 'python-fastapi'}
