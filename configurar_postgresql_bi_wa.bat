@echo off
title BI WA - Configuracao do PostgreSQL
chcp 65001 >nul

echo ============================================
echo  BI WA - Configuracao do Cache PostgreSQL
echo ============================================
echo.

set "PGHOST=127.0.0.1"
set "PGPORT=5432"

:: Variaveis do BI WA
set "BIWA_DB=bi_wa_cache"
set "BIWA_USER=biwa_cache"
set "BIWA_PASS=biwa_cache"
set "BIWA_SCHEMA=biwa_cache"

:: Detecta caminho do psql
where psql >nul 2>&1
if %ERRORLEVEL% neq 0 (
    :: Tenta caminhos comuns (ordem: versao mais nova primeiro)
    if exist "C:\Program Files\PostgreSQL\18\bin\psql.exe" (
        set "PSQL_CMD=C:\Program Files\PostgreSQL\18\bin\psql.exe"
    ) else if exist "C:\Program Files\PostgreSQL\17\bin\psql.exe" (
        set "PSQL_CMD=C:\Program Files\PostgreSQL\17\bin\psql.exe"
    ) else if exist "C:\Program Files\PostgreSQL\16\bin\psql.exe" (
        set "PSQL_CMD=C:\Program Files\PostgreSQL\16\bin\psql.exe"
    ) else if exist "C:\Program Files\PostgreSQL\15\bin\psql.exe" (
        set "PSQL_CMD=C:\Program Files\PostgreSQL\15\bin\psql.exe"
    ) else if exist "C:\Program Files\PostgreSQL\14\bin\psql.exe" (
        set "PSQL_CMD=C:\Program Files\PostgreSQL\14\bin\psql.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\PostgreSQL\16\bin\psql.exe" (
        set "PSQL_CMD=%LOCALAPPDATA%\Programs\PostgreSQL\16\bin\psql.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\PostgreSQL\15\bin\psql.exe" (
        set "PSQL_CMD=%LOCALAPPDATA%\Programs\PostgreSQL\15\bin\psql.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\PostgreSQL\14\bin\psql.exe" (
        set "PSQL_CMD=%LOCALAPPDATA%\Programs\PostgreSQL\14\bin\psql.exe"
    ) else (
        echo [ERRO] psql nao encontrado. Verifique se o PostgreSQL esta instalado
        echo e adicione o caminho do binario ao PATH do Windows.
        echo Caminho comum: C:\Program Files\PostgreSQL\16\bin
        echo.
        pause
        exit /b 1
    )
) else (
    set "PSQL_CMD=psql"
)

:: Pede senha do superusuario postgres
echo O script vai criar o banco, usuario e schema para o cache do BI WA.
echo Sera necessario a senha do usuario postgres (superadmin do PostgreSQL).
echo.
set /p "PG_SUPER_PASS=Senha do postgres: "

set "PGPASSWORD=%PG_SUPER_PASS%"

echo.
echo --- 1. Criando usuario %BIWA_USER% ---
"%PSQL_CMD%" -h %PGHOST% -p %PGPORT% -U postgres -c "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '%BIWA_USER%') THEN CREATE ROLE %BIWA_USER% LOGIN PASSWORD '%BIWA_PASS%'; END IF; END $$;" 2>&1
if %ERRORLEVEL% neq 0 (
    echo [AVISO] Falha ao criar usuario (pode ja existir, continuando...)
)

echo --- 2. Criando banco %BIWA_DB% ---
"%PSQL_CMD%" -h %PGHOST% -p %PGPORT% -U postgres -c "SELECT 'CREATE DATABASE %BIWA_DB% OWNER %BIWA_USER%' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '%BIWA_DB%')\gexec" 2>&1
if %ERRORLEVEL% neq 0 (
    echo [AVISO] Falha ao criar banco (pode ja existir, continuando...)
)

:: Conecta como o proprio usuario para criar schema
set "PGPASSWORD=%BIWA_PASS%"

echo.
echo --- 3. Criando schema %BIWA_SCHEMA% ---
"%PSQL_CMD%" -h %PGHOST% -p %PGPORT% -U %BIWA_USER% -d %BIWA_DB% -c "CREATE SCHEMA IF NOT EXISTS %BIWA_SCHEMA% AUTHORIZATION %BIWA_USER%;" 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERRO] Falha ao criar schema.
    pause
    exit /b 1
)

echo.
echo --- 4. Verificando conexao ---
"%PSQL_CMD%" -h %PGHOST% -p %PGPORT% -U %BIWA_USER% -d %BIWA_DB% -c "SELECT current_database() AS banco, current_schema() AS schema, current_user AS usuario;" 2>&1

echo.
echo ============================================
echo  PostgreSQL configurado com sucesso!
echo ============================================
echo.
echo  Banco: %BIWA_DB%
echo  Usuario: %BIWA_USER% / %BIWA_PASS%
echo  Schema: %BIWA_SCHEMA%
echo  Host: %PGHOST%:%PGPORT%
echo.
echo  As tabelas de cache serao criadas automaticamente
echo  pelo app na primeira sincronizacao.
echo.
pause
