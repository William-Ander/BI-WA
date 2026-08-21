@echo off
setlocal
title BI WA - Configurar HTTPS Cloudflare
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configurar_cloudflare_tunnel.ps1"
echo.
pause
