const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const protectedFiles = ['data/reports.json', 'data/semantic_model.json', 'data/transform_queries.json', 'data/settings.json'];

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function canonical(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, { ...options, signal: options.signal || AbortSignal.timeout(180000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert(response.ok, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return { body, elapsedMs: performance.now() - startedAt };
}

function sourceContracts() {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');
  const removeStart = app.indexOf('function removeSelectedVisualField');
  const removeEnd = app.indexOf('\nfunction ', removeStart + 20);
  const removeSource = app.slice(removeStart, removeEnd);

  assert(app.includes('const visualAutoRequestsById = new Map()'), 'Consultas ainda não são controladas por visual.');
  assert(app.includes('const visualQueryVersionsById = new Map()'), 'Versão de consulta por visual ausente.');
  assert(app.includes('currentVisualQueryVersion(targetVisualId) !== queryVersion'), 'Resposta obsoleta ainda pode aplicar dados.');
  assert(app.includes('stableClientJson(visualDataQuerySignature(visual)) !== options.configSignature'), 'Resposta antiga não valida a configuração atual.');
  assert(app.includes("frame.dataset.fieldMutationRequestCount = '0'"), 'Contador de requisições da mutação não foi inicializado.');
  assert(app.includes("frame.dataset.fieldMutationQueryRequired = details && details.queryRequired ? '1' : '0'"), 'Diagnóstico de necessidade semântica ausente.');
  assert(app.includes('removeVisualTableColumnsFromDom'), 'Projeção imediata de coluna da Tabela ausente.');
  assert(app.includes('appendVisualTablePendingColumn'), 'Cabeçalho localizado de carregamento ao adicionar medida está ausente.');
  assert(app.includes('incrementalMeasureQueryPlan'), 'Plano incremental para adicionar uma medida está ausente.');
  assert(app.includes('mergeIncrementalMeasureRows'), 'Merge seguro dos valores incrementais está ausente.');
  assert(app.includes('fields: incrementalPlan.fields'), 'A consulta incremental ainda envia todos os campos do visual.');
  assert(app.includes('removeVisualFilterCardsForMutation'), 'Remoção ainda depende de reconstruir todos os cartões de filtro.');
  assert(app.includes('preserveTotals: !mutation.filterChanged'), 'Totais válidos ainda são recalculados em remoção sem filtro.');
  assert(app.includes('options.preserveTotals !== true && visual && data && data.totalsPending === true'), 'Remoção ainda dispara totais autoritativos redundantes.');
  assert(removeSource.indexOf('renderVisualFieldConfigurationImmediately') < removeSource.indexOf('scheduleVisualAutoUpdate'), 'A interface ainda espera a consulta para remover o campo.');
  assert(/if \(mutation\.needsQuery\)\s*\{\s*scheduleVisualAutoUpdate/.test(removeSource), 'Remoção puramente visual ainda agenda consulta.');
  assert(!removeSource.includes('renderVisualFilterCards('), 'Remoção ainda recarrega metadados de filtros.');
  assert(!removeSource.includes('saveReport('), 'Persistência está bloqueando a remoção local.');
  assert(app.includes('if (options.autoQuery === true) scheduleVisualAutoUpdate(\'refresh\')'), 'Carregamento de metadados ainda pode disparar consultas duplicadas.');
  assert(server.includes('const submittedFilterIds = new Set()'), 'Deduplicação semântica de aliases de filtros está ausente.');
  assert(server.includes('if (submittedFilterIds.has(identity)) continue'), 'Aliases do mesmo filtro ainda podem produzir predicados repetidos.');
  assert(app.includes("assignBuilderField('auto', field, col.columnType || col.dataType || '', fieldTable);\n      return;"), 'Adição por checkbox ainda deixa uma segunda atualização cair no mesmo evento.');
  assert(app.includes("removeSelectedVisualField(field, { allByName: true, reason: 'field-check' });\n      return;"), 'Remoção por checkbox ainda deixa uma segunda atualização cair no mesmo evento.');
  assert(!/(?:field|measure)(?:\.name)?\s*={2,3}\s*['"](?:Custo|Conversão devolução vendas)['"]/i.test(app), 'Foi encontrado hardcode por medida no frontend.');
  return 'ok';
}

async function main() {
  const hashesBefore = Object.fromEntries(protectedFiles.map((file) => [file, hash(file)]));
  const contracts = sourceContracts();
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const reportsValue = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
  const reports = Array.isArray(reportsValue) ? reportsValue : reportsValue.reports || [];
  const report = reports.find((item) => canonical(item.name || item.title) === 'gerencial');
  assert(report, 'Relatório Gerencial não encontrado.');
  const table = (report.visuals || []).find((visual) => String(visual.visualization || '').toLowerCase() === 'table' && Array.isArray(visual.selectedFields));
  assert(table, 'Tabela do Relatório Gerencial não encontrada.');
  const fields = table.selectedFields.map((field) => ({ ...field }));
  const measureNames = new Set((model.measures || []).map((measure) => canonical(measure.name)));
  const isMeasure = (field) => String(field && field.type || '').toLowerCase() === 'measure' || measureNames.has(canonical(field && field.name));
  const removedMeasure = fields.find((field) => canonical(field.name) === 'custo') || fields.find(isMeasure);
  const physical = fields.find((field) => !isMeasure(field));
  const remainingMeasure = fields.find((field) => isMeasure(field) && field !== removedMeasure);
  assert(removedMeasure && physical && remainingMeasure, 'Campos de coluna/medida insuficientes para o teste.');

  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const companyFilter = (report.onlineFilters || []).find((filter) => canonical(filter.field) === 'fantasia');
  assert(companyFilter, 'Filtro Empresa do Gerencial não encontrado.');
  const companyOptions = await request('/api/filter-options?table=' + encodeURIComponent(companyFilter.table) + '&field=' + encodeURIComponent(companyFilter.field), { headers });
  const company = (companyOptions.body.values || []).find((value) => /(?:CD|LOJA)$/i.test(String(value))) || (companyOptions.body.values || [])[0];
  assert(company !== undefined, 'Nenhuma Empresa disponível para limitar o teste de performance.');
  const payload = {
    table: table.table,
    visualId: table.id,
    pageId: table.pageId || 'page_1',
    visualization: 'table',
    dimension: table.dimension || physical.name,
    value: table.value || remainingMeasure.name,
    fields,
    aggregation: table.aggregation || 'SUM',
    order: table.order || 'DESC',
    page: 1,
    pageSize: 100,
    deferTotals: true,
    limit: 100,
    visualFilters: table.visualFilters || [],
    pageFilters: report.pageFilters || [],
    allPagesFilters: report.allPagesFilters || [],
    filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: String(company) },
    onlineFilters: report.onlineFilters || [],
    model
  };
  const run = (next) => request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(next) });

  const add = await run({ ...payload, visualId: 'perf_add_field' });
  assert(add.body.performance && add.body.performance.queryBuildCount === 1, 'Adicionar campo compilou mais de uma consulta.');
  assert(add.body.rows.length, 'Adicionar campos não retornou dados.');
  assert(Object.prototype.hasOwnProperty.call(add.body.rows[0], removedMeasure.name), 'Medida adicionada não chegou ao dataset.');

  const remainingFields = fields.filter((field) => field !== removedMeasure);
  const semanticRemoval = await run({ ...payload, visualId: 'perf_remove_field', fields: remainingFields });
  assert(semanticRemoval.body.performance && semanticRemoval.body.performance.queryBuildCount === 1, 'Remoção sem a medida compilou mais de uma consulta.');
  assert(semanticRemoval.body.rows.length, 'Remoção deixou o visual sem os dados restantes.');
  assert(!Object.prototype.hasOwnProperty.call(semanticRemoval.body.rows[0], removedMeasure.name), 'Medida removida continuou no dataset/Query Builder.');
  assert(!(semanticRemoval.body.fields || []).some((field) => canonical(field && field.name) === canonical(removedMeasure.name)), 'Schema retornado ainda contém a medida removida.');
  assert(!String(semanticRemoval.body.sql || semanticRemoval.body.baseSql || '').includes('"' + removedMeasure.name + '"'), 'SQL gerado ainda contém a medida removida.');
  remainingFields.forEach((field) => assert(Object.prototype.hasOwnProperty.call(semanticRemoval.body.rows[0], field.name), 'Campo restante ausente: ' + field.name));

  const simpleFields = [physical, remainingMeasure];
  const visualTypes = ['table', 'matrix', 'card', 'bar', 'line'];
  const visualResults = [];
  for (const visualization of visualTypes) {
    const result = await run({
      ...payload,
      visualId: 'perf_' + visualization,
      visualization,
      fields: visualization === 'card' ? [remainingMeasure] : simpleFields,
      dimension: visualization === 'card' ? '' : physical.name,
      value: remainingMeasure.name,
      pageSize: ['table', 'matrix'].includes(visualization) ? 100 : undefined,
      deferTotals: ['table', 'matrix'].includes(visualization)
    });
    assert(result.body.rows.length, visualization + ' não retornou dados.');
    assert(result.body.performance && result.body.performance.queryBuildCount === 1, visualization + ' compilou a consulta mais de uma vez.');
    visualResults.push({ visualization, elapsedMs: Number(result.elapsedMs.toFixed(2)), rows: result.body.rows.length });
  }

  for (const [file, before] of Object.entries(hashesBefore)) assert.strictEqual(hash(file), before, file + ' foi alterado pelo teste.');
  console.log(JSON.stringify({
    sourceContracts: contracts,
    requestPolicy: {
      pureRemoval: 0,
      semanticRemoval: 1,
      addField: { data: 1, authoritativeTotals: '0 ou 1, somente quando o visual exibe totais' },
      staleResponses: 'canceladas ou ignoradas por visualId + versão + assinatura'
    },
    apiBenchmarks: {
      addMs: Number(add.elapsedMs.toFixed(2)),
      semanticRemovalMs: Number(semanticRemoval.elapsedMs.toFixed(2)),
      addQueryBuildCount: add.body.performance.queryBuildCount,
      removalQueryBuildCount: semanticRemoval.body.performance.queryBuildCount
    },
    visualResults,
    protectedFiles: 'inalterados'
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
