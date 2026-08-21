@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configurar_postgresql_servidor.ps1"
if errorlevel 1 (
  echo.
  echo Falha ao configurar o PostgreSQL.
  pause
  exit /b 1
)
echo.
echo Configuracao concluida. Execute novamente BI WA Servidor Online.exe.
pause
