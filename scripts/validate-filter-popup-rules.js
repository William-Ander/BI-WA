const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const reports = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reports.json'), 'utf8'));

function requireText(text, pattern, message) {
  assert(pattern.test(text), message);
}

requireText(html, /id="onlineFilterRequireSelectionInput"[\s\S]{0,180}páginas específicas/, 'A opção para exigir seleção por página não existe no editor.');
requireText(html, /id="onlineFilterRequiredPagesList"[\s\S]{0,180}páginas não marcadas[\s\S]{0,80}"Todos"/, 'O editor não possui o seletor das páginas obrigatórias.');
requireText(app, /allowAll:\s*!\(filter\s*&&\s*filter\.allowAll\s*===\s*false\)/, 'O cliente não preserva allowAll.');
requireText(app, /requiredPageIds:\s*Array\.from\(new Set/, 'O cliente não persiste as páginas obrigatórias.');
requireText(app, /function onlineFilterRequiresSelectionForPage[\s\S]{0,600}explicit\.includes\(currentPageId\)/, 'A regra obrigatória não é calculada pela página ativa.');
requireText(app, /function dashboardRunPayload[\s\S]{0,300}pageId:\s*activeOnlineReportPageId\(report\)/, 'A execução HTTP não envia a página ativa.');
requireText(app, /const pagesByReport = Object\.fromEntries[\s\S]{0,1800}pagesByReport,/, 'A atualização em tempo real não envia a página ativa.');
requireText(app, /filterSelectOptionDefinitions\(values, currentValue, allowAll = true\)[\s\S]{0,900}allowAll \? \[\{[\s\S]{0,180}Todos/, 'O dropdown não controla a opção Todos por página.');
requireText(app, /function runtimeOnlineFiltersForActivePage[\s\S]{0,500}filter\.scope !== 'page'/, 'O popup não respeita o escopo da página ativa.');
requireText(app, /function renderOnlineAppliedFilters[\s\S]{0,260}runtimeOnlineFiltersForActivePage\(report\)/, 'O resumo online ainda mistura filtros de outras páginas.');
requireText(app, /function syncAllOnlineFilterCardLayoutsFromDom[\s\S]{0,180}saveOnlineFilterCardLayout/, 'As posições dos cards não são sincronizadas antes de salvar.');
requireText(app, /async function saveOnlineFilterConfig\(\)[\s\S]{0,500}syncAllOnlineFilterCardLayoutsFromDom\(\)/, 'Salvar filtros não captura o layout exibido.');
requireText(app, /async function saveReport\(\)[\s\S]{0,500}onlineFilterDesignerIsOpen\(\)[\s\S]{0,120}syncAllOnlineFilterCardLayoutsFromDom\(\)/, 'Salvar o relatório não captura o layout aberto.');
requireText(app, /onlineFilterDesignerPlaneMetrics[\s\S]{0,500}Math\.max\(1000/, 'O editor não mantém uma área estável para posições absolutas.');
requireText(app, /function runtimeFilterCanvasMetrics[\s\S]{0,700}defaultOnlineFilterLayout\(filter, index\)/, 'O popup não reutiliza o layout salvo no editor.');
requireText(app, /dashboard-filter-layout-viewport[\s\S]{0,220}dashboard-filter-layout-canvas/, 'O visualizador não possui a área do layout persistido.');
requireText(app, /data-runtime-filter-card[^>]{0,600}position:absolute/, 'Os cards do visualizador não preservam as posições absolutas do editor.');
assert(!/function runtimeFilterDisplayOrder/.test(app), 'O visualizador ainda reordena os filtros fora do layout definido no editor.');
requireText(styles, /\.online-filter-layout-plane\s*\{[\s\S]{0,120}position:\s*relative/, 'A área do editor não ancora os cards absolutos.');
requireText(styles, /\.online-filter-required-pages-list[\s\S]{0,220}grid-template-columns/, 'O seletor de páginas não possui layout próprio.');

requireText(server, /allowAll:\s*raw\.allowAll !== false/, 'O servidor não persiste allowAll.');
requireText(server, /requiredPageIds:\s*Array\.from\(new Set/, 'O servidor não persiste as páginas obrigatórias.');
requireText(server, /function onlineFilterRequiresSelectionForPage[\s\S]{0,500}explicit\.includes\(currentPageId\)/, 'O servidor não valida a obrigatoriedade pela página ativa.');
requireText(server, /runReportsForSocket\(socket, reportIds, filtersByReport = \{\}, pagesByReport = \{\}/, 'O servidor em tempo real não recebe as páginas ativas.');
requireText(server, /const missingRequiredSelections = normalized\.filter[\s\S]{0,1500}Selecione uma opção/, 'O servidor não protege filtros que exigem seleção.');
requireText(server, /const aliases = \[filter\.id, filter\.key\][\s\S]{0,120}fieldAliasCounts/, 'A validação obrigatória não aceita as chaves compatíveis do filtro.');

requireText(app, /function editorReportRuntimePayload[\s\S]{0,500}pageId:\s*activeOnlineReportPageId\(runtimeReport\)/, 'O Construtor nao usa a mesma assinatura de pagina dos dados executados.');
requireText(app, /function setDashboardReportRuntimeLoading[\s\S]{0,1200}online-portal-report-loading/, 'A troca de filtro não mantém um indicador sobre o visual existente.');
requireText(app, /const hasPreviousResult = Boolean\(state\.dashboard\[reportId\]\)[\s\S]{0,500}!hasPreviousResult/, 'A troca de filtro ainda apaga um relatório que já possui dados.');
requireText(app, /state\.dashboardRunRequestIds\[reportId\] !== requestId/, 'Respostas antigas de filtros não são descartadas.');

requireText(styles, /v3\.4\.50[\s\S]{0,900}dashboard-filter-layout-canvas\s*>\s*\.dashboard-filter-field[\s\S]{0,180}position:\s*absolute\s*!important/, 'O CSS do visualizador não respeita as coordenadas do editor.');
requireText(styles, /dashboard-filter-runtime-intro[\s\S]{0,500}border-radius/, 'O popup não possui o acabamento visual da área introdutória.');

const gerencial = reports.find((report) => String(report.name).toLocaleLowerCase('pt-BR') === 'gerencial');
assert(gerencial, 'Relatório Gerencial não encontrado.');
const mc = (gerencial.pages || []).find((page) => String(page.name).toLocaleLowerCase('pt-BR') === 'mc');
assert(mc, 'Página MC do Gerencial não encontrada.');
const empresaGerencial = (gerencial.onlineFilters || []).find((filter) => filter.id === 'flt_1786460064800');
assert(empresaGerencial, 'Filtro Empresa do Gerencial não encontrado.');
assert.notStrictEqual(empresaGerencial.allowAll, false, 'A regra antiga global ainda está ativa no filtro Empresa.');
assert.strictEqual(empresaGerencial.scope, 'report', 'O filtro Empresa deve continuar visível em todas as páginas do Gerencial.');
assert.deepStrictEqual(empresaGerencial.requiredPageIds, [mc.id], 'A exigência de seleção não está limitada à página MC.');
const gerencialVisual = (gerencial.visuals || []).find((visual) => String(visual.pageId || 'page_1') === mc.id);
assert(gerencialVisual, 'Visual da página MC não encontrado.');
const valorComprasField = (gerencialVisual.selectedFields || []).find((field) => field.name === 'Valor compras 1 e 3');
assert(valorComprasField, 'A medida Valor compras 1 e 3 não está no visual Gerencial.');
assert.strictEqual(valorComprasField.displayName, 'Valor Compras', 'O nome exibido da medida no visual deve ser Valor Compras.');

for (const filter of gerencial.onlineFilters || []) {
  assert(Number.isFinite(Number(filter.x)) && Number.isFinite(Number(filter.y)), 'Posição inválida no editor para ' + filter.id + '.');
  assert(Number(filter.width) >= 70 && Number(filter.height) >= 32, 'Dimensão inválida no editor para ' + filter.id + '.');
}

const vendas = reports.find((report) => String(report.name).toLocaleLowerCase('pt-BR') === 'vendas');
assert(vendas, 'Relatório Vendas não encontrado.');
const empresaVendas = (vendas.onlineFilters || []).find((filter) => filter.field === 'Fantasia');
assert(empresaVendas, 'Filtro Empresa de Vendas não encontrado.');
assert(!Array.isArray(empresaVendas.requiredPageIds) || !empresaVendas.requiredPageIds.length, 'A regra da página MC vazou para o relatório Vendas.');

console.log('Popup validado: layout persistente, seleção obrigatória apenas nas páginas escolhidas e demais páginas com Todos.');
