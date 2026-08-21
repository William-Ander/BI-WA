const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const checks = [
  ['monitor compartilhado de 5 segundos', server.includes('BIWA_DATA_SOURCE_HEALTH_INTERVAL_MS') && server.includes('startDataSourceHealthMonitor()')],
  ['broadcast independente dos relatórios', server.includes("io.emit('dashboard:connectionStatus', payload)")],
  ['status inicial enviado ao conectar', server.includes("socket.emit('dashboard:connectionStatus', payload)")],
  ['endpoint leve de contingência', server.includes("app.get('/api/dashboard/connection-status'")],
  ['portal escuta mudanças do MySQL', app.includes("socket.on('dashboard:connectionStatus'")],
  ['consulta de contingência no portal', app.includes("api('/api/dashboard/connection-status?ts=' + Date.now()")],
  ['horário usa fuso configurado', server.includes('timeZone: BIWA_TIME_ZONE') && app.includes("state.config && state.config.timeZone || 'America/Bahia'")],
  ['última atualização é armazenada por relatório', app.includes('dashboardLastUpdatedByReport: {}') && app.includes('function setDashboardReportLastUpdate')],
  ['socket envia sincronização específica por relatório', server.includes('lastPgSyncAt: normalizeHealthTimestamp(result.cacheCoverage && result.cacheCoverage.lastSyncAt)')],
  ['heartbeat não sobrescreve horário', !/socket\.on\('dashboard:connectionStatus'[\s\S]{0,260}setDashboardLastUpdate/.test(app)],
  ['consulta de contingência não sobrescreve horário', !/api\('\/api\/dashboard\/connection-status[\s\S]{0,220}setDashboardLastUpdate/.test(app)],
  ['última atualização vem do PostgreSQL', app.includes('cacheCoverage.lastDataUpdateAt ||') && app.includes('cacheCoverage.lastSyncAt')],
  ['checagem e dados recebidos ficam separados', server.includes('last_data_update_at TIMESTAMPTZ') && server.includes('MAX(last_data_update_at)')],
  ['checagem sem alteração preserva a data real', server.includes('CASE WHEN $14::integer > 0 THEN $6::timestamptz ELSE last_data_update_at END')],
  ['calendário interno não altera o horário comercial', server.includes('LOWER(source_table) <> LOWER($1)') && server.includes('CALENDAR_TABLE_NAME.toLowerCase()')],
  ['calendário sem mudanças registra zero linhas', server.includes("syncStrategy: 'calendar-check'") && server.includes('changedRows: 0')],
  ['construtor usa somente dados realmente recebidos', app.includes('if (c.lastDataUpdateAt)')],
  ['geração do visual não substitui sincronização', !app.includes('payload.lastPgSyncAt || payload.generatedAt')],
  ['portal não usa generatedAt como atualização', !app.includes('state.dashboardLastUpdated || result && result.generatedAt')]
];

const failures = checks.filter(([, passed]) => !passed);
checks.forEach(([label, passed]) => console.log(`${passed ? 'OK' : 'FALHA'} - ${label}`));

if (failures.length) {
  console.error(`\n${failures.length} validação(ões) do status online falharam.`);
  process.exit(1);
}

console.log('\nStatus MySQL e horário do portal validados.');
