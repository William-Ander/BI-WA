from fastapi import APIRouter, Depends, HTTPException
from app.services.security import current_user
from app.services.mysql_client import test_connection

router = APIRouter(prefix='/mysql', tags=['mysql'])

@router.post('/test')
def test_mysql(user=Depends(current_user)):
    if user.get('role') != 'admin':
        raise HTTPException(status_code=403, detail='Apenas administrador.')
    try:
        return test_connection()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
