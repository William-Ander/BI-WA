const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

for (const expected of [
  'data-settings-tab="monitoringSettingsPanel"',
  'data-settings-tab="logsSettingsPanel"',
  'id="settingsMonitoringContent"',
  'id="settingsLogsContent"',
  'id="refreshSettingsMonitoringBtn"',
  'id="refreshSettingsLogsBtn"'
]) {
  assert(html.includes(expected), 'Elemento ausente nas novas abas: ' + expected);
}

assert(/function loadSettingsMonitoring[\s\S]*\/api\/health/.test(app), 'A aba Monitoramento nao consulta o estado real do app.');
assert(/function loadSettingsLogs[\s\S]*\/api\/logs\//.test(app), 'A aba Logs nao consulta os logs do servidor.');
assert(/settingsMonitoringTimer[\s\S]*5000/.test(app), 'O monitoramento nao possui atualizacao visual a cada 5 segundos.');
assert(/refreshDashboardBtn[\s\S]*resumeDashboardUpdates[\s\S]*runSingleReport/.test(app), 'O botao Atualizar nao retoma a origem antes de recarregar os relatorios.');

assert(/app\.post\('\/api\/dashboard\/resume-updates', requireDesktopAdmin/.test(server), 'A retomada nao esta protegida por acesso administrativo.');
assert(/dashboard\/resume-updates[\s\S]*mysqlAuthManualRetryWaitMs[\s\S]*clearMysqlAuthGuardForConfig[\s\S]*ensureMysqlAuthenticationVerified[\s\S]*runPgCacheScheduledSync/.test(server), 'A retomada controlada nao executa todas as etapas de seguranca e sincronizacao.');
assert(/app\.get\('\/api\/logs\/errors', requireDesktopAdmin/.test(server), 'Logs de erro podem ser lidos sem acesso administrativo.');
assert(/function sanitizeOperationalLog[\s\S]*MYSQL_PASSWORD|function sanitizeOperationalLog[\s\S]*password/i.test(server), 'Os logs nao possuem mascaramento de credenciais.');
const sanitizerStart = server.indexOf('function sanitizeOperationalLog(value)');
const sanitizerEnd = server.indexOf('function sanitizeOperationalLogLines', sanitizerStart);
assert(sanitizerStart >= 0 && sanitizerEnd > sanitizerStart, 'Funcao de mascaramento nao encontrada.');
const sanitizeOperationalLog = Function(server.slice(sanitizerStart, sanitizerEnd) + '; return sanitizeOperationalLog;')();
const sanitized = sanitizeOperationalLog('MYSQL_PASSWORD=segredo123 senha: outraSenha token=abc123 mysql://usuario:senhaUrl@host Authorization: Basic dXNlcjpwYXNz');
for (const secret of ['segredo123', 'outraSenha', 'abc123', 'senhaUrl', 'dXNlcjpwYXNz']) {
  assert(!sanitized.includes(secret), 'O segredo ainda aparece no log sanitizado: ' + secret);
}
assert(css.includes('.settings-monitor-grid') && css.includes('.settings-log-viewer'), 'Estilos das novas abas nao foram adicionados.');

console.log('Monitoramento validado: retomada controlada pelo dashboard, status ao vivo, logs administrativos e mascaramento de credenciais.');
