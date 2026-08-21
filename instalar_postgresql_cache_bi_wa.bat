@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

echo ============================================================
echo BI WA - Instalador do PostgreSQL para Cache Local
echo ============================================================

set "PG_VERSION=16"
set "PG_HOST=127.0.0.1"
set "PG_PORT=5432"
set "PG_DB=bi_wa_cache"
set "PG_USER=biwa_cache"
set "PG_PASS=biwa_cache"
set "PG_SCHEMA=biwa_cache"
set "ENV_FILE=.env"

where psql >nul 2>nul
if errorlevel 1 (
    echo PostgreSQL nao encontrado.

    where winget >nul 2>nul
    if errorlevel 1 (
        echo Winget nao encontrado. Instale o PostgreSQL manualmente.
        pause
        exit /b 1
    )

    echo Tentando instalar PostgreSQL %PG_VERSION%...
    winget install -e --id PostgreSQL.PostgreSQL.%PG_VERSION% --accept-package-agreements --accept-source-agreements

    rem tenta localizar a pasta bin automaticamente
    if exist "C:\Program Files\PostgreSQL\%PG_VERSION%\bin\psql.exe" (
        set "PATH=C:\Program Files\PostgreSQL\%PG_VERSION%\bin;%PATH%"
    )
)

where psql >nul 2>nul
if errorlevel 1 (
    echo psql nao encontrado apos a instalacao.
    echo Adicione manualmente a pasta bin do PostgreSQL ao PATH.
    pause
    exit /b 1
)

echo.
set /p POSTGRES_PASSWORD=Informe a senha do usuario postgres:

set "PGPASSWORD=%POSTGRES_PASSWORD%"

psql -U postgres -h %PG_HOST% -p %PG_PORT% -d postgres -c "SELECT 1" >nul 2>nul
if errorlevel 1 (
    echo Falha ao conectar no PostgreSQL.
    pause
    exit /b 1
)

psql -U postgres -h %PG_HOST% -p %PG_PORT% -d postgres -c "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='%PG_USER%') THEN CREATE ROLE %PG_USER% LOGIN PASSWORD '%PG_PASS%'; ELSE ALTER ROLE %PG_USER% LOGIN PASSWORD '%PG_PASS%'; END IF; END $$;"

psql -U postgres -h %PG_HOST% -p %PG_PORT% -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='%PG_DB%'" | find "1" >nul
if errorlevel 1 (
    psql -U postgres -h %PG_HOST% -p %PG_PORT% -d postgres -c "CREATE DATABASE %PG_DB% OWNER %PG_USER%;"
)

psql -U postgres -h %PG_HOST% -p %PG_PORT% -d %PG_DB% -c "CREATE SCHEMA IF NOT EXISTS %PG_SCHEMA% AUTHORIZATION %PG_USER%;"
psql -U postgres -h %PG_HOST% -p %PG_PORT% -d %PG_DB% -c "GRANT ALL PRIVILEGES ON SCHEMA %PG_SCHEMA% TO %PG_USER%;"

echo Configuracao concluida.
pause
