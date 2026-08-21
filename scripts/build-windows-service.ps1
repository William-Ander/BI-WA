param(
  [string]$OutputPath = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'windows-service\BiWaServerService.cs'

if (-not $OutputPath) {
  $OutputPath = Join-Path $root 'dist-server\BI WA Servidor Online.exe'
}
if (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath = Join-Path $root $OutputPath
}

$frameworkCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $frameworkCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) {
  throw 'Compilador .NET Framework 4 nao encontrado. Ative o .NET Framework 4.x no Windows.'
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$icon = Join-Path $root 'public\app-icon.ico'
$arguments = @(
  '/nologo',
  '/target:winexe',
  '/optimize+',
  ('/out:' + $OutputPath),
  '/reference:System.ServiceProcess.dll',
  '/reference:System.Windows.Forms.dll'
)
if (Test-Path -LiteralPath $icon) {
  $arguments += '/win32icon:' + $icon
}
$arguments += $source

& $compiler $arguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath)) {
  throw 'Falha ao compilar o executavel do servico BI WA.'
}

Write-Host "Executavel criado: $OutputPath" -ForegroundColor Green
