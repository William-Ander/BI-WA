from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = 'BI WA API'
    app_mode: str = 'desktop'
    app_version: str = '3.2.31'
    api_host: str = '127.0.0.1'
    api_port: int = 8000
    cors_origin: str = '*'
    biwa_auth_secret: str = 'troque_essa_chave'
    biwa_auth_token_ttl_seconds: int = 43200
    biwa_sync_token: str = ''
    mysql_host: str = ''
    mysql_port: int = 3306
    mysql_user: str = ''
    mysql_password: str = ''
    mysql_database: str = ''
    mysql_ssl: str = 'false'
    max_query_limit: int = 5000
    default_query_limit: int = 200

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')


settings = Settings()
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = PROJECT_ROOT / 'data'
REPORTS_FILE = DATA_DIR / 'reports.json'
SETTINGS_FILE = DATA_DIR / 'settings.json'
SEMANTIC_MODEL_FILE = DATA_DIR / 'semantic_model.json'
TRANSFORMS_FILE = DATA_DIR / 'transform_queries.json'
