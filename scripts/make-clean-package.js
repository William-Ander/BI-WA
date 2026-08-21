const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.resolve(root, '..');
const zipName = `BI_WA_limpo_v${require('../package.json').version}.zip`;
const zipPath = path.join(outDir, zipName);

const excludes = [
  '.env', '.env.cloud.example', 'data/settings.json', 'data/mysql_auth_guard.json', 'node_modules/*', 'dist-windows/*', 'BI/*', '_backup_dados_bi_wa/*',
  'instalar no servidor/*',
  '.tmp-*', '.tmp-*/*', 'dist-server/*', 'logs/*', 'data/erros/*', 'data/audit_log.json', 'data/last-*.json',
  'diagnostic_log.json', 'Prints/*', '*.zip', '*.log', 'npm-debug.log*', '.git/*', 'data/*.tmp',
  '**/Login Data*', '**/Cache/*', '**/Code Cache/*', '**/Crashpad/*', '**/__pycache__/*', '**/*.pyc', '**/*.pyo'
];
try { fs.unlinkSync(zipPath); } catch {}
try {
  execFileSync('zip', ['-r', zipPath, '.', ...excludes.flatMap((item) => ['-x', item])], { cwd: root, stdio: 'inherit' });
} catch (err) {
  if (err && err.code !== 'ENOENT') throw err;
  const stage = path.join(os.tmpdir(), `biwa-clean-${Date.now()}`);
  const excludedNames = new Set(['.env', '.env.cloud.example', 'settings.json', 'mysql_auth_guard.json', 'node_modules', 'dist-windows', 'dist-server', 'BI', '_backup_dados_bi_wa', 'instalar no servidor', '.git', '__pycache__', 'logs', 'erros', 'Prints']);
  const excludedParts = ['Login Data', 'Cache', 'Code Cache', 'Crashpad'];
  const shouldSkip = (filePath) => {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    const base = path.basename(filePath);
    if (!rel || rel === '.') return false;
    if (rel.split('/').some((part) => part.startsWith('.tmp-'))) return true;
    if (excludedNames.has(base)) return true;
    if (rel === 'data/settings.json' || rel === 'data/mysql_auth_guard.json') return true;
    if (rel === 'data/audit_log.json' || /^data\/last-.*\.json$/i.test(rel) || rel === 'diagnostic_log.json') return true;
    if (rel.startsWith('node_modules/') || rel.startsWith('dist-windows/') || rel.startsWith('dist-server/') || rel.startsWith('BI/') || rel.startsWith('_backup_dados_bi_wa/') || rel.startsWith('instalar no servidor/') || rel.startsWith('.git/') || rel.startsWith('logs/') || rel.startsWith('data/erros/') || rel.startsWith('Prints/')) return true;
    if (/\.zip$/i.test(base) || /\.log$/i.test(base) || /^npm-debug\.log/i.test(base) || /\.tmp$/i.test(base) || /\.py[co]$/i.test(base)) return true;
    return excludedParts.some((part) => rel.includes(part));
  };
  const copyClean = (src, dst) => {
    if (shouldSkip(src)) return;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src)) copyClean(path.join(src, entry), path.join(dst, entry));
      return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  try {
    copyClean(root, stage);
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`], { stdio: 'inherit' });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
console.log(zipPath);
