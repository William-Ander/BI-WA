@echo off
setlocal
chcp 65001 >nul
set "BAT_PATH=%~f0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $content=Get-Content -Raw -LiteralPath $env:BAT_PATH; $marker='### POWERSHELL_PAYLOAD_BELOW ###'; $idx=$content.LastIndexOf($marker); if($idx -lt 0){ throw 'Marcador PowerShell nao encontrado no instalador.' }; $code=$content.Substring($idx + $marker.Length); Invoke-Expression $code"
set "ERR=%ERRORLEVEL%"

if not "%ERR%"=="0" (
  echo.
  echo A instalacao encontrou um problema. Codigo: %ERR%
  echo Veja a mensagem acima. Depois corrija o problema e execute este arquivo novamente.
  pause
)
exit /b %ERR%

### POWERSHELL_PAYLOAD_BELOW ###
$ErrorActionPreference = 'Stop'

function Write-Section([string]$Text) {
    Write-Host ''
    Write-Host '============================================================'
    Write-Host $Text
    Write-Host '============================================================'
}

function Read-DotEnv([string]$Path) {
    $map = @{}
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in Get-Content -LiteralPath $Path) {
            if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
            $parts = $line -split '=', 2
            $key = $parts[0].Trim()
            $value = if ($parts.Count -gt 1) { $parts[1].Trim().Trim('"') } else { '' }
            if (-not [string]::IsNullOrWhiteSpace($key)) { $map[$key] = $value }
        }
    }
    return $map
}

function Get-OrDefault([hashtable]$Map, [string]$Key, [string]$Default) {
    if ($Map.ContainsKey($Key)) {
        $value = [string]$Map[$Key]
        if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
    }
    return $Default
}

function Backup-LocalData([string]$AppDir) {
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $backupRoot = Join-Path $AppDir '_backup_dados_bi_wa'
    $backupDir = Join-Path $backupRoot $stamp
    $hasSomething = $false

    if (Test-Path -LiteralPath (Join-Path $AppDir '.env')) { $hasSomething = $true }
    if (Test-Path -LiteralPath (Join-Path $AppDir 'data')) {
        $items = Get-ChildItem -LiteralPath (Join-Path $AppDir 'data') -Force -ErrorAction SilentlyContinue
        if ($items -and $items.Count -gt 0) { $hasSomething = $true }
    }

    if (-not $hasSomething) { return $null }

    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $envFile = Join-Path $AppDir '.env'
    if (Test-Path -LiteralPath $envFile) {
        Copy-Item -LiteralPath $envFile -Destination (Join-Path $backupDir '.env') -Force -ErrorAction SilentlyContinue
    }
    $dataDir = Join-Path $AppDir 'data'
    if (Test-Path -LiteralPath $dataDir) {
        Copy-Item -LiteralPath $dataDir -Destination (Join-Path $backupDir 'data') -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Mantem somente os 10 backups mais recentes para nao ocupar muito disco.
    try {
        Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip 10 |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    } catch {}

    return $backupDir
}

function Save-DotEnv([string]$Path, [hashtable]$Existing) {
    $port = Get-OrDefault $Existing 'PORT' '3000'
    $appMode = Get-OrDefault $Existing 'APP_MODE' 'desktop'
    $appUser = Get-OrDefault $Existing 'APP_USER' 'admin'
    $appPassword = Get-OrDefault $Existing 'APP_PASSWORD' ''
    $viewerUser = Get-OrDefault $Existing 'VIEWER_USER' 'viewer'
    $viewerPassword = Get-OrDefault $Existing 'VIEWER_PASSWORD' ''
    $syncToken = Get-OrDefault $Existing 'SYNC_TOKEN' ([guid]::NewGuid().ToString('N'))
    $onlineUrl = Get-OrDefault $Existing 'ONLINE_APP_URL' ''

    $mysqlHost = Get-OrDefault $Existing 'MYSQL_HOST' ''
    $mysqlPort = Get-OrDefault $Existing 'MYSQL_PORT' '3306'
    $mysqlUser = Get-OrDefault $Existing 'MYSQL_USER' ''
    $mysqlPassword = Get-OrDefault $Existing 'MYSQL_PASSWORD' ''
    $mysqlDatabase = Get-OrDefault $Existing 'MYSQL_DATABASE' ''
    $mysqlSsl = Get-OrDefault $Existing 'MYSQL_SSL' 'false'
    $dbConnectionLimit = Get-OrDefault $Existing 'DB_CONNECTION_LIMIT' '10'

    $onlinePort = Get-OrDefault $Existing 'ONLINE_PORT' '3000'
    $onlineMysqlHost = Get-OrDefault $Existing 'ONLINE_MYSQL_HOST' $mysqlHost
    $onlineMysqlPort = Get-OrDefault $Existing 'ONLINE_MYSQL_PORT' $mysqlPort
    $onlineMysqlUser = Get-OrDefault $Existing 'ONLINE_MYSQL_USER' 'bi_viewer'
    $onlineMysqlPassword = Get-OrDefault $Existing 'ONLINE_MYSQL_PASSWORD' ''
    $onlineMysqlDatabase = Get-OrDefault $Existing 'ONLINE_MYSQL_DATABASE' $mysqlDatabase
    $onlineMysqlSsl = Get-OrDefault $Existing 'ONLINE_MYSQL_SSL' $mysqlSsl
    $onlineCorsOrigin = Get-OrDefault $Existing 'ONLINE_CORS_ORIGIN' ''

    $authSecret = Get-OrDefault $Existing 'BIWA_AUTH_SECRET' $syncToken
    $onlineUsersJson = Get-OrDefault $Existing 'BIWA_ONLINE_USERS_JSON' ''
    $authTtl = Get-OrDefault $Existing 'BIWA_AUTH_TOKEN_TTL_MS' '43200000'
    $allowOpenOnline = Get-OrDefault $Existing 'BIWA_ALLOW_OPEN_ONLINE' 'false'

    $allowTableWrites = Get-OrDefault $Existing 'ALLOW_TABLE_WRITES' 'true'
    $allowSchemaChanges = Get-OrDefault $Existing 'ALLOW_SCHEMA_CHANGES' 'true'
    $allowReportEditing = Get-OrDefault $Existing 'ALLOW_REPORT_EDITING' 'true'
    $allowPublish = Get-OrDefault $Existing 'ALLOW_PUBLISH' 'true'

    $defaultRefresh = Get-OrDefault $Existing 'DEFAULT_REFRESH_SECONDS' '15'
    $pushRefresh = Get-OrDefault $Existing 'SERVER_PUSH_INTERVAL_SECONDS' $defaultRefresh
    $onlineDefaultRefresh = Get-OrDefault $Existing 'ONLINE_DEFAULT_REFRESH_SECONDS' $defaultRefresh
    $onlinePushRefresh = Get-OrDefault $Existing 'ONLINE_SERVER_PUSH_INTERVAL_SECONDS' $pushRefresh
    $corsOrigin = Get-OrDefault $Existing 'CORS_ORIGIN' ''

    $pgCacheEnabled = Get-OrDefault $Existing 'BIWA_PG_CACHE_ENABLED' 'true'
    $pgCacheHost = Get-OrDefault $Existing 'BIWA_PG_CACHE_HOST' '127.0.0.1'
    $pgCachePort = Get-OrDefault $Existing 'BIWA_PG_CACHE_PORT' '5432'
    $pgCacheDatabase = Get-OrDefault $Existing 'BIWA_PG_CACHE_DATABASE' 'bi_wa_cache'
    $pgCacheUser = Get-OrDefault $Existing 'BIWA_PG_CACHE_USER' 'biwa_cache'
    $pgCachePassword = Get-OrDefault $Existing 'BIWA_PG_CACHE_PASSWORD' 'biwa_cache'
    $pgCacheSchema = Get-OrDefault $Existing 'BIWA_PG_CACHE_SCHEMA' 'biwa_cache'

    $lines = @(
        '# BI WA - Desktop/Admin',
        '# Instalacao automatica. Todas as configuracoes sao feitas dentro do app.',
        '# Atualizacao segura: valores existentes deste .env sao preservados.',
        "APP_MODE=$appMode",
        "PORT=$port",
        '',
        '# Login inicial do app. Senhas vazias = sem bloqueio no primeiro acesso.',
        "APP_USER=$appUser",
        "APP_PASSWORD=$appPassword",
        "VIEWER_USER=$viewerUser",
        "VIEWER_PASSWORD=$viewerPassword",
        '',
        '# Publicacao web. Configure dentro do app.',
        "ONLINE_APP_URL=$onlineUrl",
        "SYNC_TOKEN=$syncToken",
        '',
        '# Conexao MySQL do Desktop/Admin',
        '# Configure dentro do app: Configuracao > MySQL do Desktop/Admin.',
        "MYSQL_HOST=$mysqlHost",
        "MYSQL_PORT=$mysqlPort",
        "MYSQL_USER=$mysqlUser",
        "MYSQL_PASSWORD=$mysqlPassword",
        "MYSQL_DATABASE=$mysqlDatabase",
        "MYSQL_SSL=$mysqlSsl",
        "DB_CONNECTION_LIMIT=$dbConnectionLimit",
        '',
        '# Conexao MySQL da versao Online/Viewer',
        "ONLINE_PORT=$onlinePort",
        "ONLINE_MYSQL_HOST=$onlineMysqlHost",
        "ONLINE_MYSQL_PORT=$onlineMysqlPort",
        "ONLINE_MYSQL_USER=$onlineMysqlUser",
        "ONLINE_MYSQL_PASSWORD=$onlineMysqlPassword",
        "ONLINE_MYSQL_DATABASE=$onlineMysqlDatabase",
        "ONLINE_MYSQL_SSL=$onlineMysqlSsl",
        "ONLINE_CORS_ORIGIN=$onlineCorsOrigin",
        '',
        '# Login e permissoes da versao Online/Viewer',
        "BIWA_AUTH_SECRET=$authSecret",
        "BIWA_AUTH_TOKEN_TTL_MS=$authTtl",
        "BIWA_ALLOW_OPEN_ONLINE=$allowOpenOnline",
        "BIWA_ONLINE_USERS_JSON=$onlineUsersJson",
        '',
        '# Permissoes iniciais do Desktop/Admin. Tambem podem ser alteradas dentro do app.',
        "ALLOW_TABLE_WRITES=$allowTableWrites",
        "ALLOW_SCHEMA_CHANGES=$allowSchemaChanges",
        "ALLOW_REPORT_EDITING=$allowReportEditing",
        "ALLOW_PUBLISH=$allowPublish",
        '',
        '# Atualizacao automatica dos dashboards',
        "DEFAULT_REFRESH_SECONDS=$defaultRefresh",
        "SERVER_PUSH_INTERVAL_SECONDS=$pushRefresh",
        "ONLINE_DEFAULT_REFRESH_SECONDS=$onlineDefaultRefresh",
        "ONLINE_SERVER_PUSH_INTERVAL_SECONDS=$onlinePushRefresh",
        '',
        '# Deixe em branco para uso local',
        "CORS_ORIGIN=$corsOrigin",
        '',
        '# Cache PostgreSQL do BI WA',
        "BIWA_PG_CACHE_ENABLED=$pgCacheEnabled",
        "BIWA_PG_CACHE_HOST=$pgCacheHost",
        "BIWA_PG_CACHE_PORT=$pgCachePort",
        "BIWA_PG_CACHE_DATABASE=$pgCacheDatabase",
        "BIWA_PG_CACHE_USER=$pgCacheUser",
        "BIWA_PG_CACHE_PASSWORD=$pgCachePassword",
        "BIWA_PG_CACHE_SCHEMA=$pgCacheSchema"
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, $lines, $utf8NoBom)
}

function Stop-ProcessOnPort([string]$Port) {
    try {
        $connections = Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $connections) {
            if ($conn.OwningProcess -and $conn.OwningProcess -gt 0) {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        try {
            $lines = netstat -ano | Select-String (":" + $Port + " ")
            foreach ($line in $lines) {
                $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
                $pid = $parts[-1]
                if ($pid -match '^\d+$') { Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue }
            }
        } catch {}
    }
}

function Wait-ForApp([string]$Url, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch {}
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Get-BrowserPath() {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Start-BiWaApp([string]$AppDir, [string]$Port) {
    $url = "http://localhost:$Port/?v=3.3.0"
    Stop-ProcessOnPort $Port
    Start-Sleep -Seconds 1

    $node = (Get-Command node -ErrorAction Stop).Source
    Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $AppDir -WindowStyle Hidden

    $ready = Wait-ForApp $url 25
    if (-not $ready) {
        Write-Host 'O servidor local demorou para responder. Tentando abrir mesmo assim...' -ForegroundColor Yellow
    }

    $browser = Get-BrowserPath
    if ($browser) {
        $profile = Join-Path $AppDir 'browser-profile-biwa'
        Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--user-data-dir=$profile", '--no-first-run')
    } else {
        Start-Process $url
    }
}

function Create-Shortcut([string]$AppDir, [string]$Port) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop 'BI WA.lnk'
    $oldShortcuts = @(
        (Join-Path $desktop 'BI WA.lnk'),
        (Join-Path $desktop 'BI WA Desktop.lnk')
    )
    foreach ($oldShortcut in $oldShortcuts) {
        if (Test-Path -LiteralPath $oldShortcut) { Remove-Item -LiteralPath $oldShortcut -Force -ErrorAction SilentlyContinue }
    }

    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $icon = Join-Path $AppDir 'public\app-icon.ico'
    $escapedAppDir = $AppDir.Replace("'", "''")
    $command = "Set-Location -LiteralPath '$escapedAppDir'; `$env:APP_MODE='desktop'; `$env:PORT='$Port'; `$node=(Get-Command node).Source; Start-Process -FilePath `$node -ArgumentList 'server.js' -WorkingDirectory '$escapedAppDir' -WindowStyle Hidden; Start-Sleep -Seconds 2; `$url='http://localhost:$Port/?v=3.3.0'; `$edge='${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe'; if(Test-Path `$edge){ Start-Process `$edge -ArgumentList @('--app='+`$url,'--user-data-dir=$escapedAppDir\browser-profile-biwa','--no-first-run') } else { Start-Process `$url }"

    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershell
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($command)
    $encoded = [Convert]::ToBase64String($bytes)
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand $encoded"
    $shortcut.WorkingDirectory = $AppDir
    $shortcut.Description = 'BI WA Desktop/Admin'
    $shortcut.WindowStyle = 7
    if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = "$icon,0" }
    $shortcut.Save()
    return $shortcutPath
}

$batPath = [Environment]::GetEnvironmentVariable('BAT_PATH')
$scriptDir = Split-Path -Parent $batPath
Set-Location -LiteralPath $scriptDir

Write-Section 'BI WA - instalador Desktop Windows'
Write-Host 'Esta versao instala o BI WA com apenas um arquivo .bat: este instalador.' -ForegroundColor Green
Write-Host 'Os atalhos passam a abrir o app diretamente, sem .bat auxiliares.' -ForegroundColor Green
Write-Host 'O app abre em janela propria pelo Edge/Chrome em modo aplicativo.' -ForegroundColor Green
Write-Host 'Icone: usando exatamente o ICO oficial enviado pelo usuario; PNG fica apenas na tela/interface.' -ForegroundColor Green
Write-Host 'Nenhuma configuracao sera perguntada no instalador; configure tudo dentro do app.' -ForegroundColor Green

$appDir = $null
if (Test-Path -LiteralPath (Join-Path $scriptDir 'package.json')) {
    $appDir = $scriptDir
} elseif (Test-Path -LiteralPath (Join-Path $scriptDir 'rl-mysql-bi-app\package.json')) {
    $appDir = Join-Path $scriptDir 'rl-mysql-bi-app'
}
if (-not $appDir) { throw 'Nao encontrei package.json. Execute este .bat dentro da pasta do app.' }
Set-Location -LiteralPath $appDir
Write-Host "Pasta do app: $appDir"

Write-Section 'Verificando Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js/npm nao foi encontrado.' -ForegroundColor Yellow
    Write-Host 'Instale o Node.js LTS, reabra este instalador e execute novamente.'
    Start-Process 'https://nodejs.org/'
    throw 'Node.js nao instalado.'
}
$nodeVersion = & node -v
Write-Host "Node encontrado: $nodeVersion"

Write-Section 'Protegendo dados locais do usuario'
$backupDir = Backup-LocalData $appDir
if ($backupDir) {
    Write-Host "Backup local criado antes da instalacao: $backupDir" -ForegroundColor Green
} else {
    Write-Host 'Nenhum dado local antigo encontrado para backup.' -ForegroundColor Yellow
}

$envPath = Join-Path $appDir '.env'
$existing = Read-DotEnv $envPath
Save-DotEnv $envPath $existing
$port = Get-OrDefault (Read-DotEnv $envPath) 'PORT' '3000'
$url = "http://localhost:$port/?v=3.3.0"
Write-Host ".env preparado automaticamente. Porta local: $port" -ForegroundColor Green

Write-Section 'Limpando instalacao antiga do Electron, se existir'
$electronPath = Join-Path $appDir 'node_modules\electron'
if (Test-Path -LiteralPath $electronPath) {
    Write-Host 'Removendo node_modules\electron quebrado...'
    Remove-Item -LiteralPath $electronPath -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Section 'Instalando dependencias do BI WA'
Write-Host 'Instalando somente dependencias necessarias. Electron nao sera instalado.'
$npmCmdInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmdInfo) { $npmCmdInfo = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmdInfo) { throw 'npm nao foi encontrado no PATH.' }
$npmExe = $npmCmdInfo.Source
Write-Host "Usando npm: $npmExe"

$requiredModules = @('express','mysql2','socket.io','dotenv','pg')
$missingModules = @()
foreach ($m in $requiredModules) {
    if (-not (Test-Path -LiteralPath (Join-Path $appDir "node_modules\$m"))) { $missingModules += $m }
}
if ($missingModules.Count -eq 0) {
    Write-Host 'Dependencias principais ja encontradas. Pulando npm install.' -ForegroundColor Green
} else {
    Write-Host ('Dependencias ausentes: ' + ($missingModules -join ', ')) -ForegroundColor Yellow
    Write-Host 'O instalador vai executar npm install com log e limite de tempo para nao ficar travado sem retorno.' -ForegroundColor Yellow

    $logDir = Join-Path $appDir 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $npmOut = Join-Path $logDir 'npm-install-out.log'
    $npmErr = Join-Path $logDir 'npm-install-err.log'
    Remove-Item -LiteralPath $npmOut,$npmErr -Force -ErrorAction SilentlyContinue

    $npmArgs = @('install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-online', '--registry=https://registry.npmjs.org/', '--loglevel=info', '--fetch-retries=2', '--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=60000')
    Write-Host 'Modo online habilitado: o instalador vai baixar dependencias faltantes, sem depender de jsonwebtoken.' -ForegroundColor Yellow
    Write-Host ('Comando: npm ' + ($npmArgs -join ' '))
    Write-Host 'Registry forcado: https://registry.npmjs.org/' -ForegroundColor Yellow
    $proc = Start-Process -FilePath $npmExe -ArgumentList $npmArgs -WorkingDirectory $appDir -PassThru -NoNewWindow -RedirectStandardOutput $npmOut -RedirectStandardError $npmErr
    $deadline = (Get-Date).AddMinutes(15)
    $lastShown = ''
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 5
        $elapsed = [int]((Get-Date) - $proc.StartTime).TotalSeconds
        Write-Host ("npm install em andamento... {0}s" -f $elapsed) -ForegroundColor DarkGray
        try {
            $tail = ''
            if (Test-Path -LiteralPath $npmOut) { $tail += ((Get-Content -LiteralPath $npmOut -Tail 3 -ErrorAction SilentlyContinue) -join ' | ') }
            if (Test-Path -LiteralPath $npmErr) { $tail += ' ' + ((Get-Content -LiteralPath $npmErr -Tail 3 -ErrorAction SilentlyContinue) -join ' | ') }
            $tail = $tail.Trim()
            if ($tail -and $tail -ne $lastShown) {
                Write-Host $tail -ForegroundColor Gray
                $lastShown = $tail
            }
        } catch {}
        if ((Get-Date) -gt $deadline) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
            Write-Host 'npm install excedeu 15 minutos e foi interrompido para evitar travamento.' -ForegroundColor Red
            Write-Host "Logs: $npmOut / $npmErr" -ForegroundColor Yellow
            throw 'npm install timeout.'
        }
    }
    if ($proc.ExitCode -ne 0) {
        Write-Host 'npm install falhou. Tentando limpar cache do npm e repetir uma vez...' -ForegroundColor Yellow
        try { & $npmExe cache verify } catch {}
        Remove-Item -LiteralPath $npmOut,$npmErr -Force -ErrorAction SilentlyContinue
        $proc2 = Start-Process -FilePath $npmExe -ArgumentList @('install','--omit=dev','--no-audit','--no-fund','--prefer-online','--registry=https://registry.npmjs.org/','--loglevel=info','--fetch-retries=2') -WorkingDirectory $appDir -PassThru -NoNewWindow -RedirectStandardOutput $npmOut -RedirectStandardError $npmErr
        $deadline2 = (Get-Date).AddMinutes(15)
        while (-not $proc2.HasExited) {
            Start-Sleep -Seconds 5
            Write-Host ("segunda tentativa npm install... {0}s" -f ([int]((Get-Date) - $proc2.StartTime).TotalSeconds)) -ForegroundColor DarkGray
            if ((Get-Date) -gt $deadline2) {
                try { Stop-Process -Id $proc2.Id -Force -ErrorAction SilentlyContinue } catch {}
                Write-Host 'Segunda tentativa excedeu 15 minutos.' -ForegroundColor Red
                break
            }
        }
        if (-not $proc2.HasExited -or $proc2.ExitCode -ne 0) {
            Write-Host 'Falha ao instalar dependencias. Veja os logs abaixo:' -ForegroundColor Red
            if (Test-Path -LiteralPath $npmErr) { Get-Content -LiteralPath $npmErr -Tail 30 -ErrorAction SilentlyContinue }
            throw 'npm install falhou.'
        }
    }
    $stillMissing = @()
    foreach ($m in $requiredModules) {
        if (-not (Test-Path -LiteralPath (Join-Path $appDir "node_modules\$m"))) { $stillMissing += $m }
    }
    if ($stillMissing.Count -gt 0) {
        Write-Host ('A instalacao terminou, mas ainda faltam modulos: ' + ($stillMissing -join ', ')) -ForegroundColor Red
        Write-Host 'Tente executar novamente com internet ativa ou envie logs\npm-install-err.log.' -ForegroundColor Yellow
        throw 'dependencias obrigatorias ausentes.'
    }
    Write-Host 'Dependencias instaladas e verificadas com sucesso.' -ForegroundColor Green
}


Write-Section 'Limpando cache de icone antigo do BI WA'
# Fecha janelas antigas do Edge/Chrome abertas pelo perfil antigo do BI WA, quando possivel.
try {
    $oldBrowsers = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*browser-profile-biwa*' }
    foreach ($proc in $oldBrowsers) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}

# Remove todos os perfis locais antigos do BI WA para forcar o navegador a buscar novamente favicon/manifest.
Get-ChildItem -LiteralPath $appDir -Directory -Filter 'browser-profile-biwa*' -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

# Remove atalhos antigos para recriar com IconLocation apontando para o ICO oficial.
$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($lnkName in @('BI WA.lnk','BI WA Desktop.lnk')) {
    $lnk = Join-Path $desktop $lnkName
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue }
}

# Tenta atualizar cache visual do Windows sem interromper a instalacao.
try { Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'IconCache.db') -Force -ErrorAction SilentlyContinue } catch {}
try { Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer\iconcache*') -Force -ErrorAction SilentlyContinue } catch {}
try { Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer\thumbcache*') -Force -ErrorAction SilentlyContinue } catch {}
try { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\ie4uinit.exe') -ArgumentList '-show' -WindowStyle Hidden -ErrorAction SilentlyContinue } catch {}

Write-Section 'Criando app na Area de Trabalho'
$shortcutPath = Create-Shortcut $appDir $port
Write-Host "Atalho criado: $shortcutPath" -ForegroundColor Green

Write-Section 'Encerrando servidor antigo na porta local'
Stop-ProcessOnPort $port
Start-Sleep -Seconds 1

Write-Section 'Iniciando BI WA Desktop'
Write-Host 'Abrindo o BI WA diretamente pelo instalador unico...' -ForegroundColor Green
Start-BiWaApp $appDir $port

Write-Section 'Instalacao concluida'
Write-Host 'O BI WA Desktop foi instalado.' -ForegroundColor Green
Write-Host 'Use o atalho BI WA na Area de Trabalho para abrir novamente.' -ForegroundColor Green
Write-Host 'Configure MySQL, permissoes e publicacao web dentro do app em Configuracao.' -ForegroundColor Green
