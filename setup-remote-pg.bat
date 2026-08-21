@echo off
title BI WA - Liberar PostgreSQL para acesso remoto

echo =============================================
echo  BI WA - Liberar PostgreSQL Remoto
echo =============================================
echo.

echo [FIREWALL] Liberando porta 5432...
netsh advfirewall firewall add rule name="BI WA PostgreSQL" dir=in action=allow protocol=TCP localport=5432 >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Porta 5432 liberada no firewall.
) else (
    netsh advfirewall firewall show rule name="BI WA PostgreSQL" >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] Regra de firewall ja existe.
    ) else (
        echo [AVISO] Nao foi possivel configurar o firewall.
        echo        Execute como Administrador.
    )
)

echo.
echo =============================================
echo  CONFIGURACAO CONCLUIDA
echo =============================================
echo.
echo  Agora reinicie o PostgreSQL:
echo    Windows + R ^> services.msc
echo    Procure "postgresql-x64-16"
echo    Clique direito ^> Reiniciar
echo.
echo  Depois no servidor, o cache PostgreSQL vai conectar.
echo.
pause
