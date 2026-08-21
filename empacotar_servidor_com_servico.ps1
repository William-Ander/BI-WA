param(
  [string]$Destino = ""
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $Destino) { $Destino = Join-Path $root 'instalar no servidor' }

function New-HexToken([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($buffer) } finally { $random.Dispose() }
  return ([BitConverter]::ToString($buffer)).Replace('-', '').ToLowerInvariant()
}

function ConvertTo-DotEnvValue([AllowEmptyString()][string]$Value) {
  if ($null -eq $Value) { $Value = '' }
  return $Value.Replace("`r", '').Replace("`n", '\\n')
}

function ConvertTo-BoolText($Value) {
  if ([string]$Value -match '^(?i:true|1|yes|sim|s)$') { return 'true' }
  return 'false'
}

function Update-PackagedEnvironment([string]$FilePath, [string]$SettingsPath) {
  $values = [ordered]@{}
  if (Test-Path -LiteralPath $FilePath) {
    foreach ($line in Get-Content -LiteralPath $FilePath) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $values[$Matches[1]] = $Matches[2]
      }
    }
  }
  $settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
  $source = $settings.web
  if (-not $source -or -not $source.mysqlHost -or -not $source.mysqlUser -or -not $source.mysqlDatabase) {
    $source = $settings.database
  }
  if (-not $source -or -not $source.mysqlHost -or -not $source.mysqlUser -or -not $source.mysqlDatabase) {
    throw 'A conexao MySQL de origem esta incompleta em data\settings.json.'
  }

  if (-not $values.Contains('PORT')) { $values['PORT'] = '3000' }
  if (-not $values.Contains('SYNC_TOKEN')) {
    $token = if ($settings.publish -and $settings.publish.syncToken) { [string]$settings.publish.syncToken } else { New-HexToken 24 }
    $values['SYNC_TOKEN'] = ConvertTo-DotEnvValue $token
  }
  if (-not $values.Contains('BIWA_AUTH_SECRET')) { $values['BIWA_AUTH_SECRET'] = New-HexToken 32 }
  $users = if ($settings.access -and $settings.access.onlineUsers) { @($settings.access.onlineUsers) } else { @() }
  $credentialedUsers = @($users | Where-Object { $_.active -ne $false -and $_.username -and $_.password })
  if (-not $credentialedUsers.Count) { throw 'Cadastre ao menos um usuario online ativo com senha antes de empacotar o servidor.' }
  $usersJson = ConvertTo-Json -InputObject @($users) -Compress -Depth 12
  $values['BIWA_ONLINE_USERS_BASE64'] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($usersJson))
  $values['BIWA_ONLINE_USERS_JSON'] = ''
  if ($settings.access -and $settings.access.adminUser) {
    $values['APP_USER'] = ConvertTo-DotEnvValue ([string]$settings.access.adminUser)
  }
  if ($settings.access -and $settings.access.adminName) {
    $values['APP_ADMIN_NAME'] = ConvertTo-DotEnvValue ([string]$settings.access.adminName)
  }
  if ($settings.access -and $settings.access.adminPassword) {
    $values['APP_PASSWORD'] = ConvertTo-DotEnvValue ([string]$settings.access.adminPassword)
  }

  $values['APP_MODE'] = 'online'
  $values['MYSQL_HOST'] = ConvertTo-DotEnvValue ([string]$source.mysqlHost)
  $values['MYSQL_PORT'] = ConvertTo-DotEnvValue ([string]$(if ($source.mysqlPort) { $source.mysqlPort } else { '3306' }))
  $values['MYSQL_USER'] = ConvertTo-DotEnvValue ([string]$source.mysqlUser)
  $values['MYSQL_PASSWORD'] = ConvertTo-DotEnvValue ([string]$source.mysqlPassword)
  $values['MYSQL_DATABASE'] = ConvertTo-DotEnvValue ([string]$source.mysqlDatabase)
  $values['MYSQL_SSL'] = if ([string]$source.mysqlSsl -match '^(?i:true|1|yes|sim|s)$') { 'true' } else { 'false' }
  $values['MYSQL_CHARSET'] = ConvertTo-DotEnvValue ([string]$(if ($source.mysqlCharset) { $source.mysqlCharset } else { 'utf8mb4' }))
  if (-not $values.Contains('DB_CONNECTION_LIMIT')) { $values['DB_CONNECTION_LIMIT'] = '10' }

  $onlineUrl = if ($settings.publish -and $settings.publish.onlineUrl) {
    [string]$settings.publish.onlineUrl
  } elseif ($settings.vps -and $settings.vps.domain) {
    'https://' + ([string]$settings.vps.domain).Trim().TrimEnd('/')
  } else {
    ''
  }
  if ($onlineUrl) { $values['ONLINE_APP_URL'] = ConvertTo-DotEnvValue $onlineUrl.TrimEnd('/') }
  if ($settings.web -and $settings.web.corsOrigin) {
    $corsOrigin = ConvertTo-DotEnvValue ([string]$settings.web.corsOrigin)
    $values['CORS_ORIGIN'] = $corsOrigin
    $values['ONLINE_CORS_ORIGIN'] = $corsOrigin
  }

  if (-not $values.Contains('BIWA_PG_CACHE_ENABLED')) { $values['BIWA_PG_CACHE_ENABLED'] = 'true' }
  if (-not $values.Contains('BIWA_PG_CACHE_HOST')) { $values['BIWA_PG_CACHE_HOST'] = '127.0.0.1' }
  if (-not $values.Contains('BIWA_PG_CACHE_PORT')) { $values['BIWA_PG_CACHE_PORT'] = '5432' }
  if (-not $values.Contains('BIWA_PG_CACHE_DATABASE')) { $values['BIWA_PG_CACHE_DATABASE'] = 'bi_wa_cache' }
  if (-not $values.Contains('BIWA_PG_CACHE_USER')) { $values['BIWA_PG_CACHE_USER'] = 'biwa_cache' }
  if (-not $values.Contains('BIWA_PG_CACHE_PASSWORD')) { $values['BIWA_PG_CACHE_PASSWORD'] = 'biwa_cache' }
  $values['BIWA_PG_CACHE_SYNC_OWNER'] = 'server'
  $values['BIWA_PG_CACHE_STARTUP_SYNC'] = 'true'
  $values['BIWA_PG_CACHE_AUTO_CREATE_MISSING'] = 'true'
  $values['BIWA_MYSQL_STREAM_INACTIVITY_TIMEOUT_MS'] = '300000'
  $intervalMinutes = if ($settings.pgCache -and $settings.pgCache.syncIntervalMinutes) { [double]$settings.pgCache.syncIntervalMinutes } else { 5 }
  $recentWindowDays = if ($settings.pgCache -and $settings.pgCache.recentWindowDays) { [int]$settings.pgCache.recentWindowDays } else { 90 }
  $values['BIWA_PG_CACHE_SYNC_INTERVAL_MINUTES'] = $intervalMinutes.ToString([Globalization.CultureInfo]::InvariantCulture)
  $values['BIWA_PG_CACHE_RECENT_WINDOW_DAYS'] = [string]$recentWindowDays

  $values['ALLOW_TABLE_WRITES'] = ConvertTo-BoolText $settings.permissions.tableWrites
  $values['ALLOW_SCHEMA_CHANGES'] = ConvertTo-BoolText $settings.permissions.schemaChanges
  $values['ALLOW_REPORT_EDITING'] = ConvertTo-BoolText $settings.permissions.reportEditing
  $values['ALLOW_PUBLISH'] = ConvertTo-BoolText $settings.permissions.publishOnline

  $content = ($values.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value }) -join "`r`n"
  [IO.File]::WriteAllText($FilePath, $content + "`r`n", (New-Object Text.UTF8Encoding($false)))
}

$fullDestination = [IO.Path]::GetFullPath($Destino)
$fullRoot = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
if (-not $fullDestination.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'O destino do pacote deve permanecer dentro da pasta do projeto.'
}
if ([IO.Path]::GetFileName($fullDestination) -ne 'instalar no servidor') {
  throw 'Destino inesperado. Use a pasta "instalar no servidor".'
}

$preservedEnv = $null
if (Test-Path -LiteralPath (Join-Path $fullDestination '.env')) {
  $preservedEnv = [IO.File]::ReadAllBytes((Join-Path $fullDestination '.env'))
} elseif (Test-Path -LiteralPath (Join-Path $fullDestination 'CONFIGURACAO_INICIAL.env')) {
  $preservedEnv = [IO.File]::ReadAllBytes((Join-Path $fullDestination 'CONFIGURACAO_INICIAL.env'))
}
if (Test-Path -LiteralPath $fullDestination) {
  Remove-Item -LiteralPath $fullDestination -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $fullDestination | Out-Null
@('lib', 'public', 'data', 'dados-iniciais-publicacao') | ForEach-Object {
  New-Item -ItemType Directory -Force -Path (Join-Path $fullDestination $_) | Out-Null
}

$files = @(
  'server.js',
  'package.json',
  'package-lock.json',
  'instalar_postgresql_cache_bi_wa.bat',
  'configurar_postgresql_servidor.ps1',
  'Configurar PostgreSQL do Servidor.bat',
  'gerenciar_servico_bi_wa.ps1',
  'Gerenciar Servico BI WA.bat',
  'configurar_cloudflare_tunnel.ps1',
  'Configurar HTTPS Cloudflare.bat',
  'SERVIDOR_ONLINE_LEIA-ME.txt',
  'ATUALIZAR_SERVIDOR_BI_WA.txt'
)
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $fullDestination $file) -Force
}
if ($preservedEnv) {
  [IO.File]::WriteAllBytes((Join-Path $fullDestination 'CONFIGURACAO_INICIAL.env'), $preservedEnv)
}
Update-PackagedEnvironment -FilePath (Join-Path $fullDestination 'CONFIGURACAO_INICIAL.env') -SettingsPath (Join-Path $root 'data\settings.json')

Copy-Item -LiteralPath (Join-Path $root 'lib\logger.js') -Destination (Join-Path $fullDestination 'lib\logger.js') -Force

$publicFiles = @('index.html', 'app.js', 'formatting.js', 'styles.css', 'favicon.ico', 'manifest.json', 'logo-bi-wa.png', 'app-icon.ico', 'app-icon.png')
foreach ($file in $publicFiles) {
  $source = Join-Path $root ('public\' + $file)
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $fullDestination ('public\' + $file)) -Force
  }
}

$initialDataFiles = @('reports.json', 'semantic_model.json', 'transform_queries.json', 'imported_tables.json', 'manual_tables.json', 'hidden_tables.json')
foreach ($file in $initialDataFiles) {
  $source = Join-Path $root ('data\' + $file)
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $fullDestination ('dados-iniciais-publicacao\' + $file)) -Force
  }
}
$manualSeedOutput = Join-Path $fullDestination 'dados-iniciais-publicacao\manual_tables.snapshot.json'
$previousManualSeedOutput = [Environment]::GetEnvironmentVariable('BIWA_MANUAL_SEED_OUTPUT', 'Process')
try {
  [Environment]::SetEnvironmentVariable('BIWA_MANUAL_SEED_OUTPUT', $manualSeedOutput, 'Process')
  & node (Join-Path $root 'scripts\export-manual-table-seed.js')
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o snapshot de tabelas manuais para publicacao.' }
} finally {
  if ($null -eq $previousManualSeedOutput) {
    Remove-Item -LiteralPath 'Env:BIWA_MANUAL_SEED_OUTPUT' -ErrorAction SilentlyContinue
  } else {
    [Environment]::SetEnvironmentVariable('BIWA_MANUAL_SEED_OUTPUT', $previousManualSeedOutput, 'Process')
  }
}
Copy-Item -LiteralPath (Join-Path $root 'data\settings.example.json') -Destination (Join-Path $fullDestination 'data\settings.example.json') -Force
$dataNotice = @'
ATENCAO: esta pasta nao contem relatorios, configuracoes nem tabelas do ambiente de desenvolvimento.
Ela existe assim para que uma atualizacao completa nao substitua os dados ativos do servidor.
Em uma instalacao nova, o BI WA cria os arquivos necessarios e os relatorios devem ser enviados por Publicar Online.
'@
[IO.File]::WriteAllText((Join-Path $fullDestination 'data\NAO_SUBSTITUI_DADOS_DO_SERVIDOR.txt'), $dataNotice, (New-Object Text.UTF8Encoding($false)))

& (Join-Path $root 'scripts\build-windows-service.ps1') -OutputPath (Join-Path $fullDestination 'BI WA Servidor Online.exe')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar o servico do Windows.' }

Write-Host "Pacote do servidor criado em: $fullDestination" -ForegroundColor Green
