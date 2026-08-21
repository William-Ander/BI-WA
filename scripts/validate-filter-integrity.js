const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const reportsData = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reports.json'), 'utf8'));
const reports = Array.isArray(reportsData) ? reportsData : (reportsData.reports || []);

function requireText(text, pattern, message) {
  assert(pattern.test(text), message);
}

requireText(server, /const baseBuilt = hasRuntimeReportFilters[\s\S]{0,260}onlineFilters:\s*\[\],\s*filters:\s*\{\}/, 'O servidor nao gera SQL-base sem os filtros de execucao.');
requireText(server, /sql:\s*inlineSqlParams\(visualSql, visualParams\)[\s\S]{0,120}baseSql/, 'A consulta visual nao separa SQL executado e SQL-base.');
requireText(app, /function applyVisualFilterQueryData[\s\S]{0,260}data\.baseSql[\s\S]{0,160}visual\.sql = baseSql/, 'A atualizacao por filtro ainda pode persistir o SQL executado.');
assert(!/function applyVisualFilterQueryData[\s\S]{0,180}visual\.sql\s*=\s*String\(data\s*&&\s*data\.sql/.test(app), 'O SQL filtrado ainda e gravado diretamente no visual.');
requireText(app, /sql = incrementalApplied \? String\(activeViz\.sql \|\| ''\) : \(data\.baseSql \|\| data\.sql \|\| ''\)/, 'O preview nao preserva o SQL-base durante a atualizacao incremental.');
requireText(server, /Nao foi possivel aplicar os filtros em cascata[\s\S]{0,220}\b409\b/, 'Falha de cascata ainda pode voltar silenciosamente para opcoes amplas.');
requireText(server, /BIWA_FILTER_DEBUG_LOG[\s\S]{0,500}DEBUG_LOG_MAX_BYTES/, 'O log de filtros nao possui ativacao explicita e limite.');
requireText(server, /dataRestrictionFields:[\s\S]{0,220}table:\s*filter\.table[\s\S]{0,80}field:\s*filter\.field/, 'O cliente nao recebe os campos protegidos para higienizar filtros antigos.');
requireText(app, /restrictedFilterValueAllowed[\s\S]{0,1600}ui === 'between'[\s\S]{0,900}ui === 'search'/, 'A higienizacao de filtros restritos nao cobre pesquisa e intervalo.');
requireText(app, /visual-filter-warning[\s\S]{0,900}filterWarnings/, 'Avisos de filtro nao aparecem nos visuais online.');
requireText(server, /function orderFilterOptionValues[\s\S]{0,1600}monthNames/, 'A ordenacao cronologica dos meses nao existe no servidor.');
requireText(server, /orderedPayload[\s\S]{0,180}orderFilterOptionValues\(table, field/, 'A resposta de opcoes nao aplica a ordenacao cronologica do servidor.');
requireText(app, /function orderCalendarFilterOptions[\s\S]{0,1800}monthNames/, 'A ordenacao cronologica dos meses nao existe no cliente.');
requireText(app, /const values = orderCalendarFilterOptions\(filter, Array\.isArray\(data\.values\)/, 'As opcoes carregadas nao aplicam a ordenacao cronologica do cliente.');
requireText(app, /colFmt\.isText \|\| colFmt\.isBinary[\s\S]{0,260}String\(value\)\.trim\(\)/, 'Colunas de texto ainda podem ser convertidas e arredondadas como numeros.');
requireText(app, /function runtimeFilterSummaryForFilter[\s\S]{0,500}calendarFilterDefaultRole/, 'Campos de calendario ainda podem receber separador de milhar no resumo.');

const heartbeatStart = app.indexOf("socket.on('dashboard:connectionStatus'");
const heartbeatEnd = app.indexOf("socket.on('dashboard:cacheInvalidated'", heartbeatStart);
const heartbeatHandler = app.slice(heartbeatStart, heartbeatEnd);
assert(heartbeatStart >= 0 && heartbeatEnd > heartbeatStart, 'Handler de heartbeat nao encontrado.');
assert(!/setDashboardLastUpdate|setDashboardReportLastUpdate|rememberDashboardReportLastUpdate/.test(heartbeatHandler), 'Heartbeat ainda altera o horario da ultima atualizacao.');

const vendas = reports.find((report) => String(report && report.name || '').toLocaleLowerCase('pt-BR') === 'vendas');
assert(vendas, 'Relatorio Vendas nao encontrado.');
const affectedIds = new Set(['vis_mqqn3ua7_79in5', 'vis_ms3dpwia_cn8br']);
const affectedVisuals = (vendas.visuals || []).filter((visual) => affectedIds.has(String(visual && visual.id || '')));
assert.strictEqual(affectedVisuals.length, affectedIds.size, 'Visuais auditados do relatorio Vendas nao foram encontrados.');
function hasPinnedMonthPredicate(sql) {
  return /(?:WHERE|AND)\s+[\s\S]{0,500}?(?:>=|BETWEEN)\s*'2026-(?:07|08)-01'/i.test(String(sql || ''));
}
for (const visual of affectedVisuals) {
  assert(!hasPinnedMonthPredicate(visual.sql), 'Periodo mensal continua fixo no SQL do visual ' + visual.id + '.');
}
assert(!hasPinnedMonthPredicate(vendas.sql), 'Periodo mensal continua fixo no SQL principal do relatorio Vendas.');

console.log('Integridade dos filtros validada: SQL-base separado, cascata explicita, restricoes higienizadas e relatorio Vendas sem periodo fixo.');
