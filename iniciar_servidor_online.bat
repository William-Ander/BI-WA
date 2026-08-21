@echo off
setlocal enabledelayedexpansion
title BI WA - Servidor Online
set "PASTA=%~dp0"
cd /d "%PASTA%"

echo ============================================
echo  BI WA - Servidor Online
echo ============================================
echo.

:: Verifica Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado.
    echo Baixe e instale o Node.js 18 LTS:
    echo   https://nodejs.org/dist/latest-v18.x/node-v18.20.4-x64.msi
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo Node.js: %NODE_VER%

:: Detecta Windows 7
ver | findstr /C:"6.1" >nul
if %errorlevel% equ 0 (
    echo [OK] Windows 7 - modo compativel ativado
    set NODE_OPTIONS=--openssl-legacy-provider
)

:: Cria .env com tokens automaticos se nao existir
if not exist "%PASTA%.env" (
    echo [CONFIG] Criando .env com tokens automaticos...

    for /f "tokens=*" %%a in ('node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"') do set SYNC_TOKEN=%%a
    for /f "tokens=*" %%b in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set AUTH_SECRET=%%b

    (
        echo # BI WA - Servidor Online
        echo APP_MODE=online
        echo PORT=3000
        echo.
        echo # Token para receber publicacao do Desktop
        echo SYNC_TOKEN=!SYNC_TOKEN!
        echo.
        echo # Chave secreta para autenticacao dos usuarios
        echo BIWA_AUTH_SECRET=!AUTH_SECRET!
        echo.
        echo # Usuarios online (deixe vazio para configurar depois)
        echo BIWA_ONLINE_USERS_JSON=
        echo.
        echo # Conexao com PostgreSQL do Desktop (cache de dados)
        echo BIWA_PG_CACHE_ENABLED=true
        echo BIWA_PG_CACHE_HOST=COLOCAR_O_IP_PUBLICO_DO_DESKTOP_AQUI
        echo BIWA_PG_CACHE_PORT=5432
        echo BIWA_PG_CACHE_DATABASE=bi_wa_cache
        echo BIWA_PG_CACHE_USER=biwa_cache
        echo BIWA_PG_CACHE_PASSWORD=biwa_cache
        echo.
        echo # Bloqueios - modo somente visualizacao
        echo ALLOW_TABLE_WRITES=false
        echo ALLOW_SCHEMA_CHANGES=false
        echo ALLOW_REPORT_EDITING=false
        echo ALLOW_PUBLISH=false
    ) > "%PASTA%.env"

    echo.
    echo ============================================
    echo  .env CRIADO COM SUCESSO!
    echo ============================================
    echo.
    echo  ANTES DE INICIAR, configure o arquivo .env:
    echo.
    echo  1. Abra o arquivo .env com o bloco de notas
    echo  2. Substitua COLOCAR_O_IP_PUBLICO_DO_DESKTOP_AQUI
    echo     pelo IP publico do computador onde roda o Desktop
    echo     (onde o PostgreSQL esta configurado)
    echo.
    echo  3. Anote o SYNC_TOKEN acima - voce vai precisar
    echo     dele no Desktop em Configuracao > Online
    echo.
    echo  SYNC_TOKEN: !SYNC_TOKEN!
    echo.
    echo ============================================
    echo  Depois de configurar, execute este bat novamente.
    echo ============================================
    pause
    exit /b 1
)

:: Forca modo online
set APP_MODE=online

:: Dependencias
if not exist node_modules\express (
    echo [INSTALL] Instalando dependencias...
    call npm install --omit=dev
    if %errorlevel% neq 0 (
        echo [ERRO] Falha ao instalar dependencias.
        pause
        exit /b 1
    )
) else (
    echo Dependencias OK
)

:: Garante arquivos de dados
if not exist data\reports.json echo [] > data\reports.json
if not exist data\semantic_model.json echo {"tables":[],"selectedColumns":[],"relationships":[],"measures":[]} > data\semantic_model.json

:: Descobre IP local
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /C:"IPv4" /C:"Endereço"') do set IP_LOCAL=%%i
set IP_LOCAL=%IP_LOCAL: =%

echo.
echo ============================================
echo  SERVIDOR INICIADO
echo ============================================
echo.
echo  Acesso local:  http://localhost:3000
echo  Acesso rede:   http://%IP_LOCAL%:3000
echo.
echo  Para acessar de fora:
echo    Configure o roteador para liberar a porta 3000
echo    (port forwarding) para este computador
echo.
echo  Para PUBLICAR relatorios do Desktop:
echo    Configuracao > Online > URL publica:
echo    http://%IP_LOCAL%:3000
echo.
echo  Pressione Ctrl+C para parar o servidor
echo ============================================
echo.

node %NODE_OPTIONS% server.js

echo.
echo Servidor encerrado.
pause
