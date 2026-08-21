@echo off
title BI WA - Empacotar arquivos do servidor
cd /d "%~dp0"

set DESTINO=%~dp0instalar no servidor

echo ============================================
echo  BI WA - Empacotar para Servidor Online
echo ============================================
echo.

if exist "%DESTINO%" (
    echo Removendo pasta anterior...
    rmdir /s /q "%DESTINO%"
)

echo Criando estrutura...
mkdir "%DESTINO%"
mkdir "%DESTINO%\lib"
mkdir "%DESTINO%\public"
mkdir "%DESTINO%\data"

echo Copiando arquivos...
copy server.js "%DESTINO%\server.js" >nul
copy package.json "%DESTINO%\package.json" >nul
copy package-lock.json "%DESTINO%\package-lock.json" >nul
copy iniciar_servidor_online.bat "%DESTINO%\iniciar_servidor_online.bat" >nul
copy lib\logger.js "%DESTINO%\lib\logger.js" >nul

copy public\index.html "%DESTINO%\public\index.html" >nul
copy public\app.js "%DESTINO%\public\app.js" >nul
copy public\styles.css "%DESTINO%\public\styles.css" >nul
copy public\favicon.ico "%DESTINO%\public\favicon.ico" >nul
copy public\manifest.json "%DESTINO%\public\manifest.json" >nul
copy public\logo-bi-wa.png "%DESTINO%\public\logo-bi-wa.png" >nul
if exist public\app-icon.ico copy public\app-icon.ico "%DESTINO%\public\app-icon.ico" >nul
if exist public\app-icon.png copy public\app-icon.png "%DESTINO%\public\app-icon.png" >nul

copy data\reports.json "%DESTINO%\data\reports.json" >nul
copy data\semantic_model.json "%DESTINO%\data\semantic_model.json" >nul
copy data\transform_queries.json "%DESTINO%\data\transform_queries.json" >nul
copy data\settings.example.json "%DESTINO%\data\settings.example.json" >nul
copy data\imported_tables.json "%DESTINO%\data\imported_tables.json" >nul
if exist data\hidden_tables.json copy data\hidden_tables.json "%DESTINO%\data\hidden_tables.json" >nul

:: Descobre IP local
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /C:"IPv4" /C:"Endere"') do set IP_LOCAL=%%i
set IP_LOCAL=%IP_LOCAL: =%
if "%IP_LOCAL%"=="" set IP_LOCAL=192.168.0.x

:: Cria arquivo de configuracao na area de trabalho
set DESKTOP=%USERPROFILE%\Desktop
if not exist "%DESKTOP%" set DESKTOP=%USERPROFILE%\Área de Trabalho
if not exist "%DESKTOP%" for /f "tokens=*" %%i in ('powershell -command "[Environment]::GetFolderPath('Desktop')"') do set DESKTOP=%%i

(
    echo =============================================
    echo  BI WA - CONFIGURAR ONLINE NO DESKTOP
    echo  Gerado em: %DATE% %TIME%
    echo =============================================
    echo.
    echo  Servidor Online ja esta funcionando?
    echo  Se sim, configure abaixo no Desktop:
    echo.
    echo =============================================
    echo  1. EXECUTAR COMO ADMINISTRADOR:
    echo =============================================
    echo.
    echo  Rode o arquivo: setup-remote-pg.bat
    echo  (libera o PostgreSQL para acesso remoto)
    echo.
    echo.
    echo =============================================
    echo  2. CONFIGURAR ROTEADOR:
    echo =============================================
    echo.
    echo  Libere a porta 5432 TCP no roteador
    echo  (port forwarding) apontando para:
    echo    IP local deste Desktop: %IP_LOCAL%
    echo.
    echo.
    echo =============================================
    echo  3. CONFIGURAR NO APP (Configuracao ^> Online):
    echo =============================================
    echo.
    echo  URL publica:  http://IP_DO_SERVIDOR_WIN7:3000
    echo.
    echo  Token de sincronizacao:
    echo  (PEGUE O TOKEN QUE APARECEU NO SERVIDOR
    echo   quando executou iniciar_servidor_online.bat)
    echo.
    echo  SYNC_TOKEN: _______________________________
    echo.
    echo.
    echo =============================================
    echo  4. TESTAR E PUBLICAR:
    echo =============================================
    echo.
    echo  - Clique em "Testar conexao"
    echo  - Se funcionar, clique em "Publicar relatorios"
    echo.
    echo.
    echo =============================================
    echo  ACESSO DOS USUARIOS:
    echo =============================================
    echo.
    echo  Os usuarios acessam: http://IP_DO_SERVIDOR_WIN7:3000
    echo.
    echo  Para cadastrar usuarios:
    echo    Desktop ^> Configuracao ^> Acesso ^> Usuarios online
    echo.
    echo =============================================
) > "%DESKTOP%\BI WA - Configurar Online.txt"

echo.
echo ============================================
echo  PRONTO!
echo ============================================
echo.
echo  Pasta criada: %DESTINO%
echo.
dir "%DESTINO%" /s /-c | findstr /i "arquivos"
echo.
echo  Arquivo criado na Area de Trabalho:
echo    BI WA - Configurar Online.txt
echo.
echo  Instrucoes para o servidor:
echo   1. Copie a pasta "instalar no servidor" para o Windows 7
echo   2. Instale Node.js 18
echo   3. Execute iniciar_servidor_online.bat
echo   4. Anote o SYNC_TOKEN que aparecer na tela
echo.
echo  Depois do servidor no ar, preencha os dados
echo  no arquivo da Area de Trabalho e configure
echo  em Configuracao > Online.
echo.
pause
