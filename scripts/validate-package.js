const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const forbiddenNames = new Set(['.env', 'settings.json', 'mysql_auth_guard.json', 'Login Data', 'Login Data For Account']);
const forbiddenDirs = new Set(['node_modules', '.git', 'dist-windows', 'BI', '_backup_dados_bi_wa', 'Cache', 'Code Cache', 'Crashpad', 'BrowserMetrics', '__pycache__']);
const suspiciousContentPatterns = [
  /mysqlPassword"\s*:\s*"(?!")/i,
  /APP_PASSWORD\s*=\s*[^\s#]+/i,
  /VIEWER_PASSWORD\s*=\s*[^\s#]+/i,
  /MYSQL_PASSWORD\s*=\s*[^\s#]+/i,
  /SYNC_TOKEN\s*=\s*[^\s#]+/i
];
const allowedExampleFiles = new Set(['.env.example', '.env.online.example', 'settings.example.json']);
const packagingExcludedNames = new Set(['.env', '.env.cloud.example', 'settings.json', 'mysql_auth_guard.json', 'node_modules', 'dist-windows', 'BI', '_backup_dados_bi_wa', 'instalar no servidor', '.git', '__pycache__']);
const errors = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (packagingExcludedNames.has(entry.name)) continue;
    if (rel === 'data/settings.json' || rel === 'data/mysql_auth_guard.json' || /\.log$/i.test(entry.name) || /\.tmp$/i.test(entry.name) || /\.py[co]$/i.test(entry.name)) continue;
    if (entry.isDirectory()) {
      if (forbiddenDirs.has(entry.name)) {
        errors.push(`Diretorio proibido no pacote: ${rel}`);
        continue;
      }
      walk(full);
      continue;
    }
    if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) {
      errors.push(`Arquivo Python compilado proibido no pacote: ${rel}`);
    }
    if (forbiddenNames.has(entry.name) && !allowedExampleFiles.has(entry.name)) {
      errors.push(`Arquivo proibido no pacote: ${rel}`);
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (['.json', '.env', '.yml', '.yaml', '.txt', '.example'].includes(ext) || entry.name.startsWith('.env')) {
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { text = ''; }
      if (!allowedExampleFiles.has(entry.name)) {
        for (const pattern of suspiciousContentPatterns) {
          if (pattern.test(text)) errors.push(`Possivel segredo/configuracao real em: ${rel}`);
        }
      }
    }
  }
}

walk(root);

const packageVersion = require(path.join(root, 'package.json')).version;
const zipPath = path.resolve(root, '..', `BI_WA_limpo_v${packageVersion}.zip`);
if (fs.existsSync(zipPath)) {
  const escapedZip = zipPath.replace(/'/g, "''");
  const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[System.IO.Compression.ZipFile]::OpenRead('${escapedZip}'); try {$zip.Entries | ForEach-Object {$_.FullName}} finally {$zip.Dispose()}`;
  const entries = String(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' }) || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  const forbiddenZipPatterns = [
    /(^|\/)\.tmp-/i,
    /(^|\/)node_modules\//i,
    /(^|\/)dist-(?:windows|server)\//i,
    /(^|\/)logs\//i,
    /(^|\/)data\/erros\//i,
    /(^|\/)data\/(?:settings|mysql_auth_guard|audit_log)\.json$/i,
    /(^|\/)diagnostic_log\.json$/i,
    /(^|\/)Prints\//i,
    /(^|\/)\.env$/i,
    /\.log$/i,
    /\.zip$/i
  ];
  for (const entry of entries) {
    if (forbiddenZipPatterns.some((pattern) => pattern.test(entry))) errors.push(`Entrada proibida no ZIP: ${entry}`);
  }
}

if (errors.length) {
  console.error('Validacao do pacote falhou:');
  for (const err of errors) console.error('- ' + err);
  process.exit(1);
}
console.log('Pacote validado: nenhum arquivo proibido ou segredo obvio encontrado.');
