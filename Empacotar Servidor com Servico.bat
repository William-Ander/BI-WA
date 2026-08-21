@echo off
title BI WA - Empacotar Servidor com Servico
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0empacotar_servidor_com_servico.ps1"
if errorlevel 1 (
  echo.
  echo Falha ao criar o pacote.
  pause
  exit /b 1
)
echo.
echo Pacote pronto na pasta "instalar no servidor".
pause
