param(
  [switch]$SomenteStatus
)

$ErrorActionPreference = 'Stop'
$serviceName = 'Cloudflared'
$downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi'
$msiPath = Join-Path $env:TEMP 'cloudflared-windows-amd64.msi'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-CloudflaredExecutable {
  $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'),
    (Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  if ($candidates.Count) { return $candidates[0] }
  return $null
}

function Show-TunnelStatus {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Host 'Servico Cloudflared ainda nao esta instalado.' -ForegroundColor Yellow
    return $false
  }

  Write-Host ("Servico: {0} | Status: {1} | Inicializacao: automatica" -f $service.DisplayName, $service.Status) -ForegroundColor Cyan
  return $service.Status -eq 'Running'
}

if (-not (Test-Administrator)) {
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $PSCommandPath)
  )
  if ($SomenteStatus) { $arguments += '-SomenteStatus' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments
  exit
}

Write-Host '============================================' -ForegroundColor DarkCyan
Write-Host ' BI WA - HTTPS com Cloudflare Tunnel' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor DarkCyan
Write-Host

if ($SomenteStatus) {
  Show-TunnelStatus | Out-Null
  exit
}

try {
  $localResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/version' -UseBasicParsing -TimeoutSec 10
  Write-Host ("Portal local respondeu HTTP {0}." -f $localResponse.StatusCode) -ForegroundColor Green
} catch {
  Write-Host 'O portal local nao respondeu em http://127.0.0.1:3000.' -ForegroundColor Yellow
  Write-Host 'Inicie primeiro o servico BI WA Servidor Online e execute novamente.' -ForegroundColor Yellow
  exit 1
}

$cloudflared = Get-CloudflaredExecutable
if (-not $cloudflared) {
  Write-Host 'Baixando o instalador oficial do Cloudflare Tunnel...' -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $downloadUrl -OutFile $msiPath -UseBasicParsing

  $installer = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/i', ('"{0}"' -f $msiPath), '/qn', '/norestart')
  if ($installer.ExitCode -notin @(0, 1641, 3010)) {
    throw "Falha ao instalar cloudflared. Codigo MSI: $($installer.ExitCode)"
  }

  $cloudflared = Get-CloudflaredExecutable
  if (-not $cloudflared) { throw 'cloudflared.exe nao foi encontrado depois da instalacao.' }
  Write-Host 'Cloudflared instalado com sucesso.' -ForegroundColor Green
}

$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
  Write-Host 'Ja existe um servico Cloudflared neste servidor.' -ForegroundColor Yellow
  $replace = (Read-Host 'Deseja reinstalar usando o novo token? Digite S para confirmar').Trim()
  if ($replace -notmatch '^(?i:s|sim)$') {
    Show-TunnelStatus | Out-Null
    exit
  }

  & $cloudflared service uninstall | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel remover o servico Cloudflared existente.' }
}

Write-Host
Write-Host 'Cole o token copiado da tela do Cloudflare. Ele nao sera exibido nem salvo.' -ForegroundColor Cyan
$secureToken = Read-Host 'Token do Tunnel' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $tunnelToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  if ([string]::IsNullOrWhiteSpace($tunnelToken)) { throw 'Token nao informado.' }

  & $cloudflared service install $tunnelToken | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar o Cloudflare Tunnel como servico.' }
} finally {
  $tunnelToken = $null
  $secureToken = $null
  if ($tokenPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  }
}

Set-Service -Name $serviceName -StartupType Automatic
Start-Service -Name $serviceName -ErrorAction SilentlyContinue
$service = Get-Service -Name $serviceName
$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))

Write-Host
Write-Host 'Cloudflare Tunnel instalado e executando como servico automatico.' -ForegroundColor Green
Write-Host 'Volte ao painel da Cloudflare. O status deve mudar para Connected.' -ForegroundColor Cyan
Write-Host 'Depois configure biwaonline.com para http://localhost:3000.' -ForegroundColor Cyan

if (Test-Path -LiteralPath $msiPath) {
  Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
}
