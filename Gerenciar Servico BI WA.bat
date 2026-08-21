@echo off
setlocal
title BI WA - Gerenciar Servico Online
cd /d "%~dp0"

:menu
cls
echo ============================================
echo  BI WA - Servidor Online
echo ============================================
echo.
echo  1. Instalar ou atualizar servico
echo  2. Ver status
echo  3. Reiniciar
echo  4. Parar
echo  5. Iniciar
echo  6. Remover servico
echo  7. Sair
echo.
choice /c 1234567 /n /m "Escolha: "

if errorlevel 7 exit /b 0
if errorlevel 6 set "ACAO=Remover"& goto executar
if errorlevel 5 set "ACAO=Iniciar"& goto executar
if errorlevel 4 set "ACAO=Parar"& goto executar
if errorlevel 3 set "ACAO=Reiniciar"& goto executar
if errorlevel 2 set "ACAO=Status"& goto executar
if errorlevel 1 set "ACAO=Instalar"& goto executar

:executar
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gerenciar_servico_bi_wa.ps1" -Acao %ACAO%
echo.
pause
goto menu
