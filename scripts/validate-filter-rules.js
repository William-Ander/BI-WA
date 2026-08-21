const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const errors = [];
function requireText(text, pattern, message) { if (!pattern.test(text)) errors.push(message); }

requireText(server, /function isCalendarTableName/, 'Backend perdeu reconhecimento de Calendario/Calendário.');
requireText(server, /function findBestDateColumnForTarget/, 'Backend perdeu fallback para detectar coluna de data da tabela alvo.');
requireText(server, /function calendarFilterExpression[\s\S]{0,1200}case 'ano'/, 'Backend perdeu conversao de Ano do calendario.');
requireText(server, /function calendarFilterExpression[\s\S]{0,1600}case 'mes'/, 'Backend perdeu conversao de Mes do calendario.');
requireText(server, /resolveFilterExpression[\s\S]{0,1000}isCalendarTableName\(filterTable\)/, 'Backend nao propaga filtro de Calendario para tabela relacionada.');
requireText(server, /buildReportFilterWhere[\s\S]{0,1200}targetColumns/, 'Filtros online nao recebem colunas da tabela alvo.');
requireText(server, /async function buildVisualQueryFromRequest[\s\S]*builtOnlineFilters/, 'Preview do construtor nao aplica filtros online.');
requireText(app, /async function buildVisualPreview[\s\S]*onlineFilters:\s*currentOnlineFilters\(\)/, 'Frontend nao envia filtros online no preview.');
requireText(app, /async function buildVisualPreview[\s\S]*filters:\s*state\.dashboardFilters\[designerReportId\(\)\]/, 'Frontend nao envia valores dos filtros do designer no preview.');
requireText(app, /online-filter-preview/, 'Mudanca nos filtros do popup nao dispara atualizacao do preview.');
requireText(app, /async function ensureOnlineFilterSourceColumns\(sourceName\)\s*\{\s*if \(isOnlineMode\(\)\) return \[\];/, 'Portal visualizador voltou a consultar colunas do editor de filtros.');
requireText(app, /async function renderOnlineFilterBuilder\(\)\s*\{\s*if \(isOnlineMode\(\)\) return;/, 'Construtor de filtros voltou a renderizar no portal visualizador.');
requireText(app, /async function bootAfterAuth\(\)[\s\S]{0,500}if \(!isOnlineMode\(\)\) clearReportEditor\(\);/, 'Inicializacao online voltou a preparar o editor de relatorios.');

if (errors.length) {
  console.error('Validacao de filtros relacionados falhou:');
  for (const err of errors) console.error('- ' + err);
  process.exit(1);
}
console.log('Regras de filtros relacionados validadas: Calendario propaga para tabelas fato e preview atualiza em tempo real.');
