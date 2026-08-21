<#
.SYNOPSIS
  BI WA — Deploy cloud automatizado (Windows / PowerShell)

.DESCRIPTION
  Faz deploy da instância cloud do BI WA usando Docker Compose.
  Gera .env, secrets, build da imagem e sobe os serviços.

.PARAMETER Domain
  Domínio público para SSL (ex: meuapp.com)

.PARAMETER Email
  E-mail para o Certbot (Let's Encrypt)

.EXAMPLE
  .\scripts\deploy-cloud.ps1
  .\scripts\deploy-cloud.ps1 -Domain "meuapp.com" -Email "admin@meuapp.com"
#>

param(
  [string]$Domain = "",
  [string]$Email = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $PSScriptRoot
Set-Location $ScriptDir

function Log  { Write-Host "[BI WA] $($args[0])" -ForegroundColor Cyan }
function Ok   { Write-Host "[✓] $($args[0])" -ForegroundColor Green }
function Warn { Write-Host "[!] $($args[0])" -ForegroundColor Yellow }
function Err  { Write-Host "[✗] $($args[0])" -ForegroundColor Red; exit 1 }

# --- Pré-requisitos ---
$null = Get-Command docker -ErrorAction SilentlyContinue
if (-not $?) { Err "Docker não encontrado. Instale Docker Desktop para Windows." }

$null = Get-Command docker -ErrorAction SilentlyContinue
if (-not $?) { Err "Docker Compose v2 não encontrado." }

# --- .env ---
if (-not (Test-Path ".env")) {
  Warn "Arquivo .env não encontrado. Criando..."

  @"
# BI WA Cloud — configuração gerada pelo deploy script
APP_MODE=online
PORT=3000

# Credenciais administrativas
VIEWER_USER=viewer
VIEWER_PASSWORD=TroqueAqui
BIWA_AUTH_SECRET=
SYNC_TOKEN=

# MySQL (conforme docker-compose.cloud.yml)
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_USER=biwa
MYSQL_PASSWORD=TroqueSenhaBiwa
MYSQL_DATABASE=biwa_cloud
MYSQL_SSL=false
DB_CONNECTION_LIMIT=10

# Refresh / tempo real
DEFAULT_REFRESH_SECONDS=15
SERVER_PUSH_INTERVAL_SECONDS=15
BIWA_QUERY_CACHE_ENABLED=true
BIWA_QUERY_CACHE_TTL_MS=15000

# Opcional: tabela de eventos no MySQL para invalidação de cache
# BIWA_REALTIME_EVENT_TABLE=minha_tabela
# BIWA_REALTIME_EVENT_COLUMN=updated_at

# Segurança
BIWA_ALLOW_OPEN_ONLINE=false
"@ | Out-File -FilePath ".env" -Encoding UTF8

  Ok ".env criado. Edite o arquivo e execute novamente."
  exit 0
}

Ok ".env encontrado."

# --- Valida .env ---
$envContent = Get-Content ".env" -Raw
if ($envContent -match "Troque") {
  Warn "Ainda existem senhas 'Troque...' no .env. Edite antes de publicar."
  Start-Sleep 2
}

# --- Gera secrets se vazios ---
if ($envContent -match "^BIWA_AUTH_SECRET=$" -or $envContent -match "^BIWA_AUTH_SECRET=\n") {
  $secret = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
  (Get-Content ".env") -replace "^BIWA_AUTH_SECRET=$", "BIWA_AUTH_SECRET=$secret" | Set-Content ".env"
  Ok "BIWA_AUTH_SECRET gerado automaticamente."
}

$envContent = Get-Content ".env" -Raw
if ($envContent -match "^SYNC_TOKEN=$" -or $envContent -match "^SYNC_TOKEN=\n") {
  $token = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
  (Get-Content ".env") -replace "^SYNC_TOKEN=$", "SYNC_TOKEN=$token" | Set-Content ".env"
  Ok "SYNC_TOKEN gerado automaticamente."
}

# --- Build ---
Log "Fazendo build da imagem Docker..."
docker compose -f docker-compose.cloud.yml build --pull app
if (-not $?) { Err "Falha no build da imagem." }
Ok "Build concluído."

# --- Deploy ---
Log "Subindo serviços..."
docker compose -f docker-compose.cloud.yml up -d
if (-not $?) { Err "Falha ao subir serviços." }
Ok "Serviços iniciados."

# --- Health check ---
Log "Aguardando health check..."
$healthy = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep 5
  try {
    $status = Invoke-RestMethod -Uri "http://localhost:3000/api/health" -TimeoutSec 5
    if ($status.ok) {
      $healthy = $true
      break
    }
  } catch {}
}
if ($healthy) {
  Ok "App está saudável!"
} else {
  Warn "Health check não respondeu após 60s. Verifique: docker compose -f docker-compose.cloud.yml logs app"
}

# --- Resumo ---
$syncToken = (Select-String -Path ".env" -Pattern "^SYNC_TOKEN=").Line -replace "^SYNC_TOKEN=", ""

Write-Host ""
Write-Host "══════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  BI WA Cloud está no ar!" -ForegroundColor Green
Write-Host "══════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Local:    http://localhost:3000"
if ($Domain) { Write-Host "  Domínio:  https://$Domain" }
Write-Host ""
Write-Host "  Admin:    Configure o Desktop > Configuração > Publicar Online"
Write-Host "            URL Online: https://$Domain"
Write-Host "            Sync Token: $syncToken"
Write-Host ""
Write-Host "  Logs:     docker compose -f docker-compose.cloud.yml logs -f app"
Write-Host "  Parar:    docker compose -f docker-compose.cloud.yml down"
Write-Host ""
