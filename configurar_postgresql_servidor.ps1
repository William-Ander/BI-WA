param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$envFile = Join-Path $root '.env'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Administrator {
  if (Test-Administrator) { return }
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath) -Verb RunAs -Wait -PassThru
  exit $process.ExitCode
}

function Convert-SecureStringToText([Security.SecureString]$SecureValue) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Get-EnvValue([string]$Name, [string]$Fallback) {
  if (-not (Test-Path -LiteralPath $envFile)) { return $Fallback }
  $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Name) + '\s*=') } | Select-Object -First 1
  if (-not $line) { return $Fallback }
  return (($line -split '=', 2)[1]).Trim().Trim('"')
}

Ensure-Administrator

$service = Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'postgresql*' } | Sort-Object Name -Descending | Select-Object -First 1
if (-not $service) { throw 'Servico PostgreSQL nao encontrado. Execute primeiro instalar_postgresql_cache_bi_wa.bat.' }

$dataDirectory = ''
if ($service.PathName -match '(?i)(?:-D|--pgdata)\s+"([^"]+)"') { $dataDirectory = $Matches[1] }
elseif ($service.PathName -match '(?i)(?:-D|--pgdata)\s+([^\s]+)') { $dataDirectory = $Matches[1] }
if (-not $dataDirectory -or -not (Test-Path -LiteralPath (Join-Path $dataDirectory 'pg_hba.conf'))) {
  $candidate = Get-ChildItem -Path (Join-Path $env:ProgramFiles 'PostgreSQL') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'data' } |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'pg_hba.conf') } |
    Select-Object -First 1
  $dataDirectory = [string]$candidate
}
if (-not $dataDirectory) { throw 'Diretorio de dados do PostgreSQL nao encontrado.' }

$versionDirectory = Split-Path $dataDirectory -Parent
$psql = Join-Path $versionDirectory 'bin\psql.exe'
if (-not (Test-Path -LiteralPath $psql)) { throw 'psql.exe nao encontrado.' }

Write-Host 'Defina uma nova senha administrativa do PostgreSQL.' -ForegroundColor Cyan
Write-Host 'Use pelo menos 12 caracteres e guarde essa senha em local seguro.' -ForegroundColor Yellow
$firstSecure = Read-Host 'Nova senha do usuario postgres' -AsSecureString
$secondSecure = Read-Host 'Confirme a nova senha' -AsSecureString
$adminPassword = Convert-SecureStringToText $firstSecure
$confirmation = Convert-SecureStringToText $secondSecure
if (-not $adminPassword -or $adminPassword.Length -lt 12) { throw 'A senha deve possuir pelo menos 12 caracteres.' }
if ($adminPassword -cne $confirmation) { throw 'As senhas informadas nao coincidem.' }

$cacheUser = Get-EnvValue 'BIWA_PG_CACHE_USER' 'biwa_cache'
$cachePassword = Get-EnvValue 'BIWA_PG_CACHE_PASSWORD' 'biwa_cache'
$cacheDatabase = Get-EnvValue 'BIWA_PG_CACHE_DATABASE' 'bi_wa_cache'
$cacheSchema = Get-EnvValue 'BIWA_PG_CACHE_SCHEMA' 'biwa_cache'
foreach ($identifier in @($cacheUser, $cacheDatabase, $cacheSchema)) {
  if ($identifier -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'Identificador PostgreSQL invalido no .env.' }
}

$hbaFile = Join-Path $dataDirectory 'pg_hba.conf'
$originalHba = [IO.File]::ReadAllText($hbaFile)
$backupFile = $hbaFile + '.biwa-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.bak'
[IO.File]::WriteAllText($backupFile, $originalHba, (New-Object Text.UTF8Encoding($false)))
$temporaryRules = "host all postgres 127.0.0.1/32 trust`r`nhost all postgres ::1/128 trust`r`n"

$configured = $false
try {
  [IO.File]::WriteAllText($hbaFile, $temporaryRules + $originalHba, (New-Object Text.UTF8Encoding($false)))
  Restart-Service -Name $service.Name -Force
  Start-Sleep -Seconds 3

  $escapedAdminPassword = $adminPassword.Replace("'", "''")
  $escapedCachePassword = $cachePassword.Replace("'", "''")
  & $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d postgres -c ("ALTER ROLE postgres WITH PASSWORD '{0}';" -f $escapedAdminPassword)
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao redefinir a senha do usuario postgres.' }

  $roleExists = ((& $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc ("SELECT 1 FROM pg_roles WHERE rolname='{0}'" -f $cacheUser)) | Out-String).Trim()
  if ($roleExists -eq '1') {
    & $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d postgres -c ("ALTER ROLE {0} LOGIN PASSWORD '{1}';" -f $cacheUser, $escapedCachePassword)
  } else {
    & $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d postgres -c ("CREATE ROLE {0} LOGIN PASSWORD '{1}';" -f $cacheUser, $escapedCachePassword)
  }
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao configurar o usuario do cache.' }

  $databaseExists = ((& $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc ("SELECT 1 FROM pg_database WHERE datname='{0}'" -f $cacheDatabase)) | Out-String).Trim()
  if ($databaseExists -ne '1') {
    & $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d postgres -c ("CREATE DATABASE {0} OWNER {1};" -f $cacheDatabase, $cacheUser)
  }
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao configurar o banco do cache.' }

  & $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U postgres -d $cacheDatabase -c ("CREATE SCHEMA IF NOT EXISTS {0} AUTHORIZATION {1}; GRANT ALL PRIVILEGES ON SCHEMA {0} TO {1};" -f $cacheSchema, $cacheUser)
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao configurar o schema do cache.' }
  $configured = $true
} finally {
  [IO.File]::WriteAllText($hbaFile, $originalHba, (New-Object Text.UTF8Encoding($false)))
  Restart-Service -Name $service.Name -Force
  Start-Sleep -Seconds 3
  $env:PGPASSWORD = $null
  $adminPassword = $null
  $confirmation = $null
}

if ($configured) {
  $env:PGPASSWORD = $cachePassword
  & $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U $cacheUser -d $cacheDatabase -c 'SELECT 1 AS biwa_ok;'
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL configurado, mas o teste final do cache falhou.' }
  $env:PGPASSWORD = $null
  Write-Host 'PostgreSQL do BI WA configurado com sucesso.' -ForegroundColor Green
  Write-Host ('Backup criado em: ' + $backupFile) -ForegroundColor DarkGray
}
