from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.routers import auth, config, health, mysql, reports, sync

app = FastAPI(title=settings.app_name, version='3.2.31')

origins = ['*'] if settings.cors_origin in ('', '*') else [x.strip() for x in settings.cors_origin.split(',') if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(health.router, prefix='/api')
app.include_router(auth.router, prefix='/api')
app.include_router(config.router, prefix='/api')
app.include_router(reports.router, prefix='/api')
app.include_router(sync.router, prefix='/api')
app.include_router(mysql.router, prefix='/api')
