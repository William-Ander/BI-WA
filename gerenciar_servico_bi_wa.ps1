param(
  [ValidateSet('Instalar', 'Remover', 'Iniciar', 'Parar', 'Reiniciar', 'Status')]
  [string]$Acao = 'Status'
)

$ErrorActionPreference = 'Stop'
$serviceName = 'BIWAServerOnline'
$displayName = 'BI WA Servidor Online'
$root = $PSScriptRoot
$serviceExe = Join-Path $root 'BI WA Servidor Online.exe'
$envFile = Join-Path $root '.env'
$initialEnvFile = Join-Path $root 'CONFIGURACAO_INICIAL.env'
$logsDirectory = Join-Path $root 'logs'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Administrator {
  if (Test-Administrator) { return }
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Acao {1}' -f $PSCommandPath, $Acao
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  exit $process.ExitCode
}

function New-HexToken([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($buffer) } finally { $random.Dispose() }
  return ([BitConverter]::ToString($buffer)).Replace('-', '').ToLowerInvariant()
}

function Ensure-EnvironmentFile {
  if (Test-Path -LiteralPath $envFile) { return }
  if (Test-Path -LiteralPath $initialEnvFile) {
    Copy-Item -LiteralPath $initialEnvFile -Destination $envFile -Force
    Write-Host "Arquivo .env criado a partir de CONFIGURACAO_INICIAL.env." -ForegroundColor Yellow
    return
  }
  $content = @"
# BI WA - Servidor Online
APP_MODE=online
PORT=3000

# Token para receber publicacao do Desktop
SYNC_TOKEN=$(New-HexToken 24)

# Chave secreta para autenticacao
BIWA_AUTH_SECRET=$(New-HexToken 32)
BIWA_ONLINE_USERS_BASE64=

# PostgreSQL cache
BIWA_PG_CACHE_ENABLED=true
BIWA_PG_CACHE_HOST=127.0.0.1
BIWA_PG_CACHE_PORT=5432
BIWA_PG_CACHE_DATABASE=bi_wa_cache
BIWA_PG_CACHE_USER=biwa_cache
BIWA_PG_CACHE_PASSWORD=biwa_cache
BIWA_PG_CACHE_SYNC_OWNER=server
BIWA_PG_CACHE_STARTUP_SYNC=true
BIWA_PG_CACHE_SYNC_INTERVAL_MINUTES=5
BIWA_PG_CACHE_RECENT_WINDOW_DAYS=60

# MySQL de origem usado pelo proprio servidor para atualizar o PostgreSQL
MYSQL_HOST=CONFIGURE_O_HOST_DO_MYSQL
MYSQL_PORT=3306
MYSQL_USER=CONFIGURE_O_USUARIO_MYSQL
MYSQL_PASSWORD=
MYSQL_DATABASE=CONFIGURE_O_BANCO_MYSQL
MYSQL_SSL=false

# Modo Online somente leitura
ALLOW_TABLE_WRITES=false
ALLOW_SCHEMA_CHANGES=false
ALLOW_REPORT_EDITING=false
ALLOW_PUBLISH=false
"@
  [IO.File]::WriteAllText($envFile, $content, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Arquivo .env criado em $envFile" -ForegroundColor Yellow
  Write-Host 'Revise as conexoes MySQL e PostgreSQL antes do teste final.' -ForegroundColor Yellow
}

function Get-EnvironmentValues {
  $values = @{}
  if (-not (Test-Path -LiteralPath $envFile)) { return $values }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $values[$Matches[1]] = $Matches[2].Trim().Trim('"')
    }
  }
  return $values
}

function Ensure-EnvironmentDefaults {
  $values = Get-EnvironmentValues
  $defaults = [ordered]@{
    APP_MODE = 'online'
    BIWA_PG_CACHE_ENABLED = 'true'
    BIWA_PG_CACHE_SYNC_OWNER = 'server'
    BIWA_PG_CACHE_STARTUP_SYNC = 'true'
    BIWA_PG_CACHE_SYNC_INTERVAL_MINUTES = '5'
    BIWA_PG_CACHE_RECENT_WINDOW_DAYS = '60'
    MYSQL_HOST = 'CONFIGURE_O_HOST_DO_MYSQL'
    MYSQL_PORT = '3306'
    MYSQL_USER = 'CONFIGURE_O_USUARIO_MYSQL'
    MYSQL_PASSWORD = ''
    MYSQL_DATABASE = 'CONFIGURE_O_BANCO_MYSQL'
    MYSQL_SSL = 'false'
  }
  $missingLines = @()
  foreach ($entry in $defaults.GetEnumerator()) {
    if (-not $values.ContainsKey($entry.Key)) { $missingLines += ($entry.Key + '=' + $entry.Value) }
  }
  if ($missingLines.Count) {
    Add-Content -LiteralPath $envFile -Value ("`r`n# Atualizacao autonoma MySQL para PostgreSQL`r`n" + ($missingLines -join "`r`n")) -Encoding UTF8
  }
}

function Assert-DataSyncEnvironment {
  $values = Get-EnvironmentValues
  $required = @('MYSQL_HOST', 'MYSQL_USER', 'MYSQL_DATABASE', 'BIWA_PG_CACHE_HOST', 'BIWA_PG_CACHE_DATABASE', 'BIWA_PG_CACHE_USER')
  $invalid = @()
  foreach ($key in $required) {
    $value = [string]$values[$key]
    if (-not $value -or $value -match 'CONFIGURE_|COLOCAR_') { $invalid += $key }
  }
  if ($invalid.Count) {
    throw ('Configuracao incompleta para atualizacao autonoma. Revise no .env: ' + ($invalid -join ', '))
  }
  if ([string]$values['BIWA_PG_CACHE_SYNC_OWNER'] -ne 'server') {
    throw 'BIWA_PG_CACHE_SYNC_OWNER deve estar definido como server.'
  }
}

function Find-Node {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    (Join-Path $root 'runtime\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  return $candidates | Select-Object -First 1
}

function Get-ConfiguredPort {
  if (-not (Test-Path -LiteralPath $envFile)) { return 3000 }
  $match = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)\s*$' } | Select-Object -First 1
  if ($match -and $match -match '^\s*PORT\s*=\s*(\d+)\s*$') { return [int]$Matches[1] }
  return 3000
}

function Ensure-Dependencies {
  if (-not (Find-Node)) { throw 'Node.js nao encontrado. Instale o Node.js 20 LTS antes de continuar.' }
  if (Test-Path -LiteralPath (Join-Path $root 'node_modules\express')) { return }
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { throw 'npm.cmd nao encontrado junto ao Node.js.' }
  Write-Host 'Instalando dependencias do servidor...' -ForegroundColor Cyan
  Push-Location $root
  try {
    & $npm.Source install --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar as dependencias do servidor.' }
  } finally {
    Pop-Location
  }
}

function Show-ServiceStatus {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Host 'Servico nao instalado.' -ForegroundColor Yellow
    return
  }
  Write-Host ("Servico: {0}" -f $service.DisplayName)
  Write-Host ("Status:  {0}" -f $service.Status)
  Write-Host 'Inicio:  Automatico'
  Write-Host ("Portal:  http://localhost:{0}" -f (Get-ConfiguredPort))
  Write-Host ("Logs:    {0}" -f (Join-Path $logsDirectory 'biwa-service.log'))
}

function Install-Service {
  Ensure-Administrator
  if (-not (Test-Path -LiteralPath $serviceExe)) { throw "Executavel nao encontrado: $serviceExe" }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'server.js'))) { throw 'server.js nao encontrado na pasta do servidor.' }
  Ensure-EnvironmentFile
  Ensure-EnvironmentDefaults
  Assert-DataSyncEnvironment
  Ensure-Dependencies
  New-Item -ItemType Directory -Force -Path $logsDirectory | Out-Null

  $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($existing -and $existing.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName -Force
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
  }

  $binaryPath = '"{0}"' -f $serviceExe
  if (-not $existing) {
    New-Service -Name $serviceName -BinaryPathName $binaryPath -DisplayName $displayName -Description 'Mantem o portal BI WA Online ativo em segundo plano.' -StartupType Automatic | Out-Null
  } else {
    & sc.exe config $serviceName binPath= $binaryPath start= auto DisplayName= $displayName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao atualizar a configuracao do servico.' }
  }

  & sc.exe description $serviceName 'Mantem o portal BI WA Online ativo em segundo plano.' | Out-Null
  & sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
  & sc.exe failureflag $serviceName 1 | Out-Null

  $port = Get-ConfiguredPort
  & netsh advfirewall firewall delete rule name='BI WA Servidor Online' | Out-Null
  & netsh advfirewall firewall add rule name='BI WA Servidor Online' dir=in action=allow protocol=TCP localport=$port | Out-Null

  Start-Service -Name $serviceName
  (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))

  $healthy = $false
  $healthPayload = $null
  $environmentValues = Get-EnvironmentValues
  $syncToken = [string]$environmentValues['SYNC_TOKEN']
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/api/sync/health" -f $port) -Headers @{ 'X-Sync-Token' = $syncToken } -TimeoutSec 6
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        $healthy = $true
        try { $healthPayload = $response.Content | ConvertFrom-Json } catch { }
        break
      }
    } catch { }
  }
  if (-not $healthy) {
    Write-Host 'O servico iniciou, mas a verificacao HTTP ainda nao respondeu.' -ForegroundColor Yellow
    Write-Host ("Consulte: {0}" -f (Join-Path $logsDirectory 'biwa-service.log')) -ForegroundColor Yellow
  }
  if ($healthPayload) {
    if (-not $healthPayload.database.connected) { Write-Host 'ATENCAO: o servidor nao conseguiu conectar ao MySQL de origem.' -ForegroundColor Red }
    if (-not $healthPayload.pgCache.connected) { Write-Host 'ATENCAO: o servidor nao conseguiu conectar ao PostgreSQL.' -ForegroundColor Red }
    if (-not $healthPayload.pgCache.scheduler.enabled) { Write-Host 'ATENCAO: o agendador PostgreSQL nao esta ativo neste servidor.' -ForegroundColor Red }
  }
  Write-Host 'BI WA instalado como servico automatico.' -ForegroundColor Green
  Show-ServiceStatus
}

function Remove-Service {
  Ensure-Administrator
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service) {
    if ($service.Status -ne 'Stopped') {
      Stop-Service -Name $serviceName -Force
      $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
    }
    & sc.exe delete $serviceName | Out-Null
  }
  & netsh advfirewall firewall delete rule name='BI WA Servidor Online' | Out-Null
  Write-Host 'Servico removido. Os dados e configuracoes foram preservados.' -ForegroundColor Green
}

try {
  switch ($Acao) {
    'Instalar' { Install-Service }
    'Remover' { Remove-Service }
    'Iniciar' { Ensure-Administrator; Ensure-EnvironmentFile; Ensure-EnvironmentDefaults; Assert-DataSyncEnvironment; Start-Service -Name $serviceName; Show-ServiceStatus }
    'Parar' { Ensure-Administrator; Stop-Service -Name $serviceName -Force; Show-ServiceStatus }
    'Reiniciar' { Ensure-Administrator; Ensure-EnvironmentFile; Ensure-EnvironmentDefaults; Assert-DataSyncEnvironment; Restart-Service -Name $serviceName -Force; Show-ServiceStatus }
    'Status' { Show-ServiceStatus }
  }
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
