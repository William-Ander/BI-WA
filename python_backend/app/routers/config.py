from fastapi import APIRouter, Depends
from app.core.config import settings
from app.services.security import current_user
from app.services.storage import read_settings

router = APIRouter(tags=['config'])

def sanitize_settings(cfg):
    cfg = dict(cfg or {})
    access = dict(cfg.get('access') or {})
    database = dict(cfg.get('database') or {})
    web = dict(cfg.get('web') or {})
    publish = dict(cfg.get('publish') or {})
    access.pop('adminPassword', None); access.pop('viewerPassword', None)
    for user in access.get('onlineUsers') or []:
        if isinstance(user, dict):
            user.pop('password', None)
            user['hasPassword'] = True
    database['hasMysqlPassword'] = bool(database.pop('mysqlPassword', ''))
    web['hasMysqlPassword'] = bool(web.pop('mysqlPassword', ''))
    publish['syncTokenConfigured'] = bool(publish.pop('syncToken', ''))
    return {'permissions': cfg.get('permissions') or {}, 'access': access, 'database': database, 'web': web, 'publish': publish}

@router.get('/config')
def config(user=Depends(current_user)):
    return {'appName': 'BI WA', 'version': settings.app_version, 'mode': settings.app_mode, 'engine': 'python-fastapi', 'role': user.get('role'), 'user': {'username': user.get('username'), 'name': user.get('name'), 'role': user.get('role')}, 'onlineViewOnly': settings.app_mode.lower() == 'online', 'permissions': {'tableWrites': False, 'schemaChanges': False, 'reportEditing': user.get('role') == 'admin', 'publishOnline': user.get('role') == 'admin'}}

@router.get('/settings')
def settings_endpoint(user=Depends(current_user)):
    return sanitize_settings(read_settings())
