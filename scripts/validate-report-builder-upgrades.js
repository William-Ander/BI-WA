const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const formatting = require('../public/formatting.js');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
const protectedFiles = ['data/reports.json', 'data/semantic_model.json', 'data/transform_queries.json', 'data/settings.json'];
const hashesBefore = Object.fromEntries(protectedFiles.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, options);
  const headersMs = performance.now() - startedAt;
  const transferStartedAt = performance.now();
  const text = await response.text();
  const transferMs = performance.now() - transferStartedAt;
  const parseStartedAt = performance.now();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  const parseMs = performance.now() - parseStartedAt;
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 400)));
  return { body, elapsedMs: performance.now() - startedAt, headersMs, transferMs, parseMs, bytes: Buffer.byteLength(text, 'utf8'), serverTiming: response.headers.get('server-timing') || '' };
}

function testFormatting() {
  const f = formatting.formatNumber;
  assert.strictEqual(f(1234, { type: 'decimal', decimalPlaces: 2, locale: 'pt-BR' }), '1.234,00');
  assert.strictEqual(f(1234.5, { type: 'decimal', decimalPlaces: 2, locale: 'pt-BR' }), '1.234,50');
  assert.strictEqual(f(1234.5678, { type: 'decimal', decimalPlaces: 2, locale: 'pt-BR' }), '1.234,57');
  assert.strictEqual(f(1234.5678, { type: 'integer', decimalPlaces: 0, locale: 'pt-BR' }), '1.235');
  assert.strictEqual(f(0, { type: 'decimal', decimalPlaces: 2, locale: 'pt-BR' }), '0,00');
  assert.strictEqual(f(0.1534, { type: 'percentage', decimalPlaces: 2, locale: 'pt-BR' }), '15,34%');
  assert.strictEqual(f(-1234.5678, { type: 'currency', decimalPlaces: 2, locale: 'pt-BR' }), '-R$ 1.234,57');
  for (const blank of [null, undefined, '']) assert.strictEqual(f(blank, { type: 'decimal', decimalPlaces: 2 }), '');
}

function testSourceContracts() {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert(app.includes('duplicateVisualMeasureInstance'), 'Duplicação por instância não foi encontrada.');
  assert(app.includes('instanceId'), 'Identidade de instância não foi encontrada no frontend.');
  assert(server.includes('cacheScope'), 'Escopo de segurança do cache não foi encontrado.');
  assert(server.includes('queryBuildCount'), 'Métrica de compilação da consulta não foi encontrada.');
  assert(app.includes('visualAutoAbortController'), 'Cancelamento de consultas obsoletas não foi encontrado.');
  assert(app.includes('const visualAutoRequestsById = new Map()'), 'Cancelamento por visual não foi encontrado.');
  assert(app.includes('const visualQueryVersionsById = new Map()'), 'Versão de consulta por visual não foi encontrada.');
  assert(app.includes('removeVisualTableColumnsFromDom'), 'Remoção visual imediata de coluna não foi encontrada.');
  assert(app.includes('preserveTotals: !mutation.filterChanged'), 'Remoção ainda recalcula totais válidos.');
  assert(!html.includes('id="measureFormulaEditorTitle"'), 'A faixa adicional Nova medida DAX ainda ocupa o construtor.');
  assert(html.includes('placeholder="Nome da Medida = expressão DAX"'), 'O editor DAX único não foi encontrado.');
  assert(app.includes('findDaxMeasureDefinitionSeparator'), 'O parser de Nome = expressão não foi encontrado.');
  assert(html.includes('visualCardColorRulesList'), 'Editor de cor dinâmica do cartão não foi encontrado.');
}

function benchmarkFirstPage(volume) {
  const startedAt = performance.now();
  const source = Array.from({ length: volume }, (_, index) => ({ id: index + 1, value: (index + 1) / 7 }));
  const generatedMs = performance.now() - startedAt;
  const pageStartedAt = performance.now();
  const firstPage = source.slice(0, 200).map((row) => ({ ...row, displayed: formatting.formatNumber(row.value, { type: 'decimal', decimalPlaces: 2, locale: 'pt-BR' }) }));
  return { volume, generatedMs: Number(generatedMs.toFixed(2)), firstPageMs: Number((performance.now() - pageStartedAt).toFixed(2)), pageRows: firstPage.length };
}

function findRuntimeVisual() {
  const report = reports.find((item) => String(item.name || '').toLocaleLowerCase('pt-BR') === 'vendas') || reports[0];
  assert(report, 'Nenhum relatório encontrado para teste.');
  const visual = (report.visuals || []).find((item) => ['table', 'matrix'].includes(String(item.visualization || '').toLowerCase()) && item.table && Array.isArray(item.selectedFields) && item.selectedFields.length)
    || (report.visuals || []).find((item) => item.table && Array.isArray(item.selectedFields) && item.selectedFields.length);
  assert(visual, 'Nenhum visual com campos encontrado para teste.');
  return { report, visual };
}

async function main() {
  testFormatting();
  testSourceContracts();
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const { report, visual } = findRuntimeVisual();
  const originalFields = Array.isArray(visual.selectedFields) ? visual.selectedFields : [];
  const measure = originalFields.find((field) => String(field && field.type || '').toLowerCase() === 'measure')
    || originalFields.find((field) => (model.measures || []).some((item) => item.name === field.name));
  const fields = originalFields.map((field, index) => ({ ...field, instanceId: 'test_' + index }));
  if (measure) fields.push({ ...measure, instanceId: 'test_duplicate_measure', displayName: String(measure.name) + ' percentual', format: { type: 'percentage', decimalPlaces: 2 } });
  const payload = {
    table: visual.table,
    visualId: visual.id,
    pageId: visual.pageId || 'page_1',
    dimension: visual.dimension || '',
    value: visual.value || '',
    fields,
    visualization: ['table', 'matrix'].includes(String(visual.visualization || '').toLowerCase()) ? visual.visualization : 'table',
    aggregation: visual.aggregation || 'SUM', order: visual.order || 'DESC',
    limit: 1000, page: 1, pageSize: 200, deferTotals: true, model,
    performanceDiagnostics: process.env.BIWA_DEBUG_SQL === '1'
  };
  const cold = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(payload) });
  if (process.env.BIWA_DEBUG_SQL === '1') console.error(cold.body.sql || 'SQL não retornado.');
  if (process.env.BIWA_DEBUG_RELATIONSHIP === '1') {
    console.log(JSON.stringify(cold.body.performance, null, 2));
    return;
  }
  const warm = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(payload) });
  const totalsPayload = { ...payload, totalsOnly: true, deferTotals: false };
  const totalsCold = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(totalsPayload) });
  const totalsWarm = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(totalsPayload) });
  assert(Array.isArray(cold.body.rows), 'Visual não retornou linhas.');
  assert(cold.body.rows.length <= 200, 'A primeira página excedeu 200 linhas.');
  assert(cold.body.pageInfo && cold.body.pageInfo.page === 1, 'Metadado de paginação ausente.');
  assert(cold.body.totalsPending === true, 'A primeira página ficou bloqueada aguardando os totais.');
  assert(totalsCold.body.totalsAuthoritative === true, 'O total autoritativo não foi calculado em segundo plano.');
  assert(cold.body.performance && cold.body.performance.queryBuildCount === 1, 'A consulta foi compilada mais de uma vez sem filtros de execução.');
  assert(Number.isFinite(Number(cold.body.performance.databaseMs)), 'Tempo de banco não foi medido.');
  assert(cold.serverTiming.includes('build;dur='), 'Cabeçalho Server-Timing ausente.');
  const cancelledController = new AbortController();
  const cancelledRequest = fetch(baseUrl + '/api/visual-query', {
    method: 'POST', headers, signal: cancelledController.signal,
    body: JSON.stringify({ ...payload, order: payload.order === 'ASC' ? 'DESC' : 'ASC', visualId: 'cancelled_request_probe' })
  });
  cancelledController.abort();
  let cancelled = false;
  try { await cancelledRequest; } catch (error) { cancelled = error && error.name === 'AbortError'; }
  assert(cancelled, 'A requisição obsoleta não foi cancelada pelo cliente.');
  let secondPage = null;
  if (cold.body.pageInfo.hasMore) {
    secondPage = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify({ ...payload, page: 2 }) });
    assert(secondPage.body.pageInfo.page === 2, 'A segunda página não foi retornada.');
    assert(secondPage.body.rows.length <= 200, 'A segunda página excedeu 200 linhas.');
  }
  const fieldIsMeasure = (field) => String(field && field.type || '').toLowerCase() === 'measure'
    || (model.measures || []).some((item) => String(item.name) === String(field && field.name));
  const dimensionField = fields.find((field) => !fieldIsMeasure(field));
  const simpleMeasureField = fields.find((field) => /valor faturamento/i.test(String(field && field.name))) || fields.find(fieldIsMeasure);
  const complexMeasureField = fields.find((field) => /faturamento l[ií]quido|ranking faturamento/i.test(String(field && field.name)) && fieldIsMeasure(field));
  const operationBenchmarks = [];
  if (simpleMeasureField) {
    const measureOnly = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify({ ...payload, dimension: '', fields: [simpleMeasureField], visualId: 'benchmark_measure_only' }) });
    operationBenchmarks.push({ operation: 'Adicionar medida simples', elapsedMs: Number(measureOnly.elapsedMs.toFixed(2)), serverMs: measureOnly.body.performance && measureOnly.body.performance.totalServerMs, rows: measureOnly.body.rows.length });
  }
  if (dimensionField && simpleMeasureField) {
    const addColumn = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify({ ...payload, fields: [dimensionField, simpleMeasureField], visualId: 'benchmark_add_column' }) });
    operationBenchmarks.push({ operation: 'Adicionar coluna', elapsedMs: Number(addColumn.elapsedMs.toFixed(2)), serverMs: addColumn.body.performance && addColumn.body.performance.totalServerMs, rows: addColumn.body.rows.length });
  }
  if (dimensionField && complexMeasureField) {
    const addComplex = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify({ ...payload, fields: [dimensionField, complexMeasureField], visualId: 'benchmark_complex_measure' }) });
    operationBenchmarks.push({ operation: 'Adicionar medida complexa', elapsedMs: Number(addComplex.elapsedMs.toFixed(2)), serverMs: addComplex.body.performance && addComplex.body.performance.totalServerMs, rows: addComplex.body.rows.length });
  }
  const filtered = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify({ ...payload, visualId: 'benchmark_filter', visualFilters: [{ table: visual.table, column: 'Empresa', values: ['1'] }] }) });
  operationBenchmarks.push({ operation: 'Aplicar filtro', elapsedMs: Number(filtered.elapsedMs.toFixed(2)), serverMs: filtered.body.performance && filtered.body.performance.totalServerMs, rows: filtered.body.rows.length });
  const sorted = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify({ ...payload, visualId: 'benchmark_sort', order: payload.order === 'ASC' ? 'DESC' : 'ASC' }) });
  operationBenchmarks.push({ operation: 'Ordenar tabela', elapsedMs: Number(sorted.elapsedMs.toFixed(2)), serverMs: sorted.body.performance && sorted.body.performance.totalServerMs, rows: sorted.body.rows.length });
  const cacheStatus = await request('/api/postgres-cache', { headers });
  const largestCaches = (cacheStatus.body.caches || []).slice().sort((a, b) => Number(b.rowCount || 0) - Number(a.rowCount || 0)).slice(0, 5).map((item) => ({ table: item.sourceTable, rows: Number(item.rowCount || 0) }));
  const reportRun = await request('/api/reports/' + report.id + '/run', {
    method: 'POST', headers,
    body: JSON.stringify({ filters: {}, crossFilters: [], pageId: report.pages && report.pages[0] && report.pages[0].id || 'page_1' })
  });
  const visualResults = reportRun.body.result && reportRun.body.result.visualResults || [];
  assert(visualResults.every((item) => !item.error), 'O relatório de vendas apresentou erro: ' + visualResults.map((item) => item.error).filter(Boolean).join('; '));
  for (const [file, hash] of Object.entries(hashesBefore)) {
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, file + ' foi alterado durante os testes.');
  }
  console.log(JSON.stringify({
    formatting: 'ok', sourceContracts: 'ok', report: report.name,
    visualQuery: {
      coldMs: Number(cold.elapsedMs.toFixed(2)), warmMs: Number(warm.elapsedMs.toFixed(2)),
      clientCold: { headersMs: Number(cold.headersMs.toFixed(2)), transferMs: Number(cold.transferMs.toFixed(2)), parseMs: Number(cold.parseMs.toFixed(2)) },
      coldServer: cold.body.performance, warmServer: warm.body.performance,
      totalsColdMs: Number(totalsCold.elapsedMs.toFixed(2)), totalsWarmMs: Number(totalsWarm.elapsedMs.toFixed(2)),
      responseBytes: cold.bytes, firstPageRows: cold.body.rows.length,
      secondPageRows: secondPage ? secondPage.body.rows.length : 0,
      secondPageMs: secondPage ? Number(secondPage.elapsedMs.toFixed(2)) : 0
    },
    cancellation: 'ok',
    operationBenchmarks,
    reportRun: { elapsedMs: Number(reportRun.elapsedMs.toFixed(2)), visuals: visualResults.length, rows: visualResults.reduce((sum, item) => sum + (item.rows || []).length, 0) },
    largestCaches,
    boundedFirstPageBenchmarks: [10000, 100000, 1000000].map(benchmarkFirstPage)
  }, null, 2));
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
