'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const protectedFiles = ['data/reports.json', 'data/semantic_model.json', 'data/transform_queries.json', 'data/settings.json'];

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function canonical(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function reportsFrom(value) {
  return Array.isArray(value) ? value : (Array.isArray(value && value.reports) ? value.reports : []);
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function closeEnough(left, right) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= Math.max(0.01, Math.abs(right) * 1e-9);
}

function filterBy(filters, field) {
  return (filters || []).find((filter) => canonical(filter.field) === canonical(field));
}

function fieldFor(name, table) {
  return { name, table, type: 'measure', fieldType: 'measure', semanticType: 'measure', measureId: name };
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, { ...options, signal: options.signal || AbortSignal.timeout(180000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  return { ok: response.ok, status: response.status, body, elapsedMs: Number((performance.now() - startedAt).toFixed(1)) };
}

async function main() {
  const protectedBefore = Object.fromEntries(protectedFiles.map((file) => [file, hash(file)]));
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const reports = reportsFrom(JSON.parse(fs.readFileSync('data/reports.json', 'utf8')));
  const report = reports.find((item) => canonical(item.name || item.title) === 'gerencial');
  assert(report, 'Relatorio Gerencial nao encontrado.');
  const visual = (report.visuals || []).find((item) => String(item.visualization || '').toLowerCase() === 'table');
  assert(visual, 'Tabela do Relatorio Gerencial nao encontrada.');
  const targetName = 'Valor L\u00edquido com Frete';
  const target = (model.measures || []).find((measure) => canonical(measure.name || measure.displayName) === canonical(targetName));
  assert(target, 'Medida real nao encontrada no modelo.');
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  assert(login.ok && login.body.token, 'Login de diagnostico falhou.');
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const configured = Array.isArray(visual.selectedFields) ? visual.selectedFields : [];
  const dimension = configured.find((field) => String(field.type || '').toLowerCase() !== 'measure');
  assert(dimension, 'Dimensao da Tabela nao encontrada.');
  const targetField = fieldFor(targetName, target.table || visual.table);
  const dependencies = ['Valor L\u00edquido vendas', 'Desconto Financeiro', 'Descontado']
    .map((name) => configured.find((field) => canonical(field.name) === canonical(name)) || { name, table: visual.table, type: 'measure', fieldType: 'measure', semanticType: 'measure', measureId: name });
  const companyFilter = (report.onlineFilters || []).find((filter) => canonical(filter.field) === 'fantasia');
  const company = companyFilter && (companyFilter.selectedValue || companyFilter.value || companyFilter.defaultValue) || 'RLS HORTIFRUTI - CD';
  const filters = companyFilter ? { [companyFilter.id]: company } : {};
  const base = {
    table: visual.table,
    pageId: visual.pageId || 'page_1',
    dimension: dimension.name,
    value: targetName,
    aggregation: 'SUM',
    order: 'DESC',
    visualFilters: visual.visualFilters || [],
    pageFilters: report.pageFilters || [],
    allPagesFilters: report.allPagesFilters || [],
    filters,
    onlineFilters: report.onlineFilters || [],
    limit: 100,
    page: 1,
    pageSize: 100,
    model,
    performanceDiagnostics: true
  };

  async function visualQuery(payload, name) {
    const run = await request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({ ...payload, visualId: '__dependent_diag_' + name })
    });
    assert(run.ok, name + ' HTTP ' + run.status + ': ' + (run.body.error || run.body.message || run.body.raw || 'erro desconhecido'));
    return run;
  }

  async function cardValue(measureName, currentModel, currentFilters, currentOnlineFilters, name) {
    const field = fieldFor(measureName, visual.table);
    const run = await visualQuery({
      ...base,
      visualization: 'card', dimension: '', value: measureName, fields: [field],
      filters: currentFilters, onlineFilters: currentOnlineFilters || report.onlineFilters || [],
      limit: 1, pageSize: undefined, deferTotals: false, totalsOnly: false,
      model: currentModel || model
    }, name);
    return { value: asNumber(run.body.rows && run.body.rows[0] && run.body.rows[0][measureName]), elapsedMs: run.elapsedMs, sql: run.body.sql || run.body.baseSql || '' };
  }
  const cases = [
    { name: 'card_target', payload: { ...base, visualization: 'card', dimension: '', fields: [targetField], limit: 1, pageSize: undefined } },
    { name: 'table_target', payload: { ...base, visualization: 'table', fields: [dimension, targetField], deferTotals: true } },
    { name: 'matrix_target', payload: { ...base, visualization: 'matrix', fields: [dimension, targetField], matrixRows: [dimension.name], matrixColumns: [], matrixValues: [targetName], deferTotals: true } },
    { name: 'table_dependencies_then_target', payload: { ...base, visualization: 'table', fields: [dimension, ...dependencies, targetField], deferTotals: true } },
    { name: 'table_target_then_dependencies', payload: { ...base, visualization: 'table', fields: [dimension, targetField, ...dependencies.slice().reverse()], deferTotals: true } },
    { name: 'total_target', payload: { ...base, visualization: 'table', fields: [dimension, targetField], totalsOnly: true, deferTotals: false } }
  ];
  const results = [];
  for (const item of cases) {
    const run = await visualQuery(item.payload, item.name);
    results.push({
      name: item.name,
      ok: run.ok,
      status: run.status,
      elapsedMs: run.elapsedMs,
      error: run.body.error || run.body.message || '',
      columns: Array.isArray(run.body.rows) && run.body.rows[0] ? Object.keys(run.body.rows[0]) : [],
      rowCount: Array.isArray(run.body.rows) ? run.body.rows.length : 0,
      totals: run.body.totals || null,
      sql: run.body.sql || run.body.baseSql || run.body.totalSql || ''
    });
    console.error('[dependent-measure]', item.name, run.status, run.body.error || 'ok');
  }
  const cardTarget = results.find((result) => result.name === 'card_target');
  const totalTarget = results.find((result) => result.name === 'total_target');
  const detailedTable = results.find((result) => result.name === 'table_dependencies_then_target');
  const reorderedTable = results.find((result) => result.name === 'table_target_then_dependencies');
  const baseTarget = asNumber((await visualQuery(cases[0].payload, 'card_target_assert')).body.rows[0][targetName]);
  const baseSales = await cardValue('Valor L\u00edquido vendas', model, filters, report.onlineFilters, 'card_base_sales');
  const baseDiscounted = await cardValue('Descontado', model, filters, report.onlineFilters, 'card_base_discounted');
  const expectedBaseTarget = (baseSales.value || 0) + (baseDiscounted.value || 0);
  assert(closeEnough(baseTarget, expectedBaseTarget), 'Medida composta diverge da soma de suas dependencias no mesmo contexto.');
  assert(closeEnough(asNumber(totalTarget.totals && totalTarget.totals[targetName]), baseTarget), 'Total da medida composta diverge do Card no mesmo contexto.');
  assert(cardTarget && detailedTable && reorderedTable, 'Casos base de Card/Tabela incompletos.');

  const detailedRun = await visualQuery(cases[3].payload, 'table_row_assert');
  const reorderedRun = await visualQuery(cases[4].payload, 'table_order_assert');
  (detailedRun.body.rows || []).forEach((row, index) => {
    const expected = (asNumber(row['Valor L\u00edquido vendas']) || 0) + (asNumber(row.Descontado) || 0);
    assert(closeEnough(asNumber(row[targetName]), expected), 'Linha ' + index + ' diverge da soma das dependencias.');
  });
  const byDimension = (rows) => new Map((rows || []).map((row) => [String(row[dimension.name]), asNumber(row[targetName])]));
  const detailedByDimension = byDimension(detailedRun.body.rows);
  const reorderedByDimension = byDimension(reorderedRun.body.rows);
  assert.strictEqual(detailedByDimension.size, reorderedByDimension.size, 'A ordem visual alterou a quantidade de linhas.');
  detailedByDimension.forEach((value, key) => assert(closeEnough(value, reorderedByDimension.get(key)), 'A ordem visual alterou o resultado de ' + key + '.'));

  const companyFilterDefinition = filterBy(report.onlineFilters, 'Fantasia');
  const yearFilter = filterBy(report.onlineFilters, 'Ano');
  const monthFilter = filterBy(report.onlineFilters, 'MesNome');
  const partyFilter = filterBy(report.onlineFilters, 'Cliente e Fornecedor');
  async function options(filter, contextFilters = {}) {
    if (!filter) return [];
    const query = new URLSearchParams({ table: filter.table, field: filter.field });
    if (Object.keys(contextFilters).length) query.set('contextFilters', JSON.stringify(contextFilters));
    const run = await request('/api/filter-options?' + query.toString(), { headers });
    assert(run.ok, 'Falha ao consultar dominio de ' + filter.field + '.');
    return run.body.values || [];
  }
  const companies = companyFilterDefinition
    ? (await options(companyFilterDefinition)).filter((value) => /(?:CD|LOJA)$/i.test(String(value))).slice(0, 2)
    : [];
  const scenarioCompany = companies[0] || company;
  const years = yearFilter && companyFilterDefinition ? await options(yearFilter, { [companyFilterDefinition.key]: scenarioCompany }) : [];
  const year = years.includes(2026) ? '2026' : String(years[0] || '2026');
  const months = monthFilter && companyFilterDefinition && yearFilter
    ? await options(monthFilter, { [companyFilterDefinition.key]: scenarioCompany, [yearFilter.key]: year })
    : [];
  const multiMonths = months.slice(0, Math.min(3, months.length));
  const parties = partyFilter && companyFilterDefinition
    ? await options(partyFilter, { [companyFilterDefinition.key]: scenarioCompany })
    : [];
  const scenarios = [];
  if (companyFilterDefinition && companies[0]) scenarios.push({ name: 'empresa_a', values: { [companyFilterDefinition.id]: companies[0] }, onlineFilters: report.onlineFilters });
  if (companyFilterDefinition && companies[1]) scenarios.push({ name: 'empresa_b', values: { [companyFilterDefinition.id]: companies[1] }, onlineFilters: report.onlineFilters });
  if (companyFilterDefinition && yearFilter && monthFilter && multiMonths[0]) {
    scenarios.push({ name: 'mes_unico', values: { [companyFilterDefinition.id]: scenarioCompany, [yearFilter.id]: year, [monthFilter.id]: multiMonths[0] }, onlineFilters: report.onlineFilters });
  }
  if (companyFilterDefinition && yearFilter && monthFilter && multiMonths.length > 1) {
    scenarios.push({
      name: 'multimes',
      values: { [companyFilterDefinition.id]: scenarioCompany, [yearFilter.id]: year, [monthFilter.id]: multiMonths.join('||') },
      onlineFilters: report.onlineFilters.map((filter) => filter.id === monthFilter.id ? { ...filter, multiSelect: true, operator: '=' } : filter)
    });
  }
  if (companyFilterDefinition && partyFilter && parties[0]) {
    scenarios.push({ name: 'cliente_fornecedor', values: { [companyFilterDefinition.id]: scenarioCompany, [partyFilter.id]: parties[0] }, onlineFilters: report.onlineFilters });
  }
  const scenarioResults = [];
  for (const scenario of scenarios) {
    const [targetCard, salesCard, discountedCard] = await Promise.all([
      cardValue(targetName, model, scenario.values, scenario.onlineFilters, scenario.name + '_target'),
      cardValue('Valor L\u00edquido vendas', model, scenario.values, scenario.onlineFilters, scenario.name + '_sales'),
      cardValue('Descontado', model, scenario.values, scenario.onlineFilters, scenario.name + '_discounted')
    ]);
    const expected = (salesCard.value || 0) + (discountedCard.value || 0);
    assert(closeEnough(targetCard.value, expected), scenario.name + ': medida composta perdeu o contexto de filtro.');
    scenarioResults.push({ name: scenario.name, filters: scenario.values, target: targetCard.value, sales: salesCard.value, discounted: discountedCard.value, matches: true, elapsedMs: targetCard.elapsedMs, sql: targetCard.sql });
  }
  if (scenarioResults.length > 1) {
    const distinctTargets = new Set(scenarioResults.map((item) => String(item.target)));
    assert(distinctTargets.size > 1, 'Os cenarios de filtro nao alteraram a medida composta.');
  }
  const multiScenario = scenarioResults.find((item) => item.name === 'multimes');
  if (multiScenario) {
    assert(/\bIN\s*\(/i.test(multiScenario.sql), 'Multiselecao nao foi compilada como conjunto IN.');
    multiMonths.forEach((month) => assert(multiScenario.sql.includes("'" + String(month).replace(/'/g, "''") + "'"), 'Mes ausente no SQL set-based: ' + month));
  }

  const draftModel = JSON.parse(JSON.stringify(model));
  const synthetic = [
    { name: '__Teste Soma Medidas', formula: '[Valor L\u00edquido vendas] + [Desconto Financeiro]' },
    { name: '__Teste Subtracao Medidas', formula: '[Valor L\u00edquido vendas] - [Descontado]' },
    { name: '__Teste Multiplicacao Medidas', formula: '[Valor L\u00edquido vendas] * [Desconto Financeiro]' },
    { name: '__Teste Divisao Medidas', formula: 'DIVIDE([Valor L\u00edquido vendas], [Descontado])' },
    { name: '__DAG Medida A', formula: '[Valor L\u00edquido vendas]' },
    { name: '__DAG Medida B', formula: '[__DAG Medida A] * 0.10' },
    { name: '__DAG Medida C', formula: '[__DAG Medida A] + [__DAG Medida B]' },
    { name: '__DAG Medida D', formula: '[__DAG Medida C] - [__DAG Medida B]' }
  ].map((item) => ({ ...item, displayName: item.name, table: visual.table, format: '#,##0.00' }));
  draftModel.measures.push(...synthetic);
  const syntheticFields = synthetic.map((measure) => fieldFor(measure.name, visual.table));
  const syntheticDependencyFields = [
    fieldFor('Valor L\u00edquido vendas', visual.table),
    fieldFor('Desconto Financeiro', 'Desconto Financeiro'),
    fieldFor('Descontado', 'Cliente e Fornecedor')
  ];
  const syntheticTotalsRun = await visualQuery({
    ...base,
    visualization: 'table', fields: [dimension, ...syntheticDependencyFields, ...syntheticFields], value: synthetic[0].name,
    totalsOnly: true, deferTotals: false, model: draftModel
  }, 'synthetic_totals');
  const syntheticTotals = syntheticTotalsRun.body.totals || {};
  const baseFinancial = await cardValue('Desconto Financeiro', model, filters, report.onlineFilters, 'card_base_financial');
  console.error('[synthetic-values]', JSON.stringify({ syntheticTotals, baseSales: baseSales.value, baseDiscounted: baseDiscounted.value, baseFinancial: baseFinancial.value }));
  const localSales = asNumber(syntheticTotals['Valor L\u00edquido vendas']);
  const localFinancial = asNumber(syntheticTotals['Desconto Financeiro']);
  const localDiscounted = asNumber(syntheticTotals.Descontado);
  assert(closeEnough(asNumber(syntheticTotals['__Teste Soma Medidas']), (localSales || 0) + (localFinancial || 0)), 'Soma generica entre medidas falhou.');
  assert(closeEnough(asNumber(syntheticTotals['__Teste Subtracao Medidas']), (localSales || 0) - (localDiscounted || 0)), 'Subtracao generica entre medidas falhou.');
  assert(closeEnough(asNumber(syntheticTotals['__Teste Multiplicacao Medidas']), (localSales || 0) * (localFinancial || 0)), 'Multiplicacao generica entre medidas falhou.');
  const expectedDivision = localDiscounted ? (localSales || 0) / localDiscounted : null;
  assert(closeEnough(asNumber(syntheticTotals['__Teste Divisao Medidas']), expectedDivision), 'DIVIDE generico entre medidas falhou.');
  assert(closeEnough(asNumber(syntheticTotals['__DAG Medida A']), localSales), 'DAG nivel A falhou.');
  assert(closeEnough(asNumber(syntheticTotals['__DAG Medida B']), (localSales || 0) * 0.10), 'DAG nivel B falhou.');
  assert(closeEnough(asNumber(syntheticTotals['__DAG Medida C']), (localSales || 0) * 1.10), 'DAG nivel C falhou.');
  assert(closeEnough(asNumber(syntheticTotals['__DAG Medida D']), localSales), 'DAG nivel D/dependencia compartilhada falhou.');
  const syntheticCards = {};
  for (const measure of [...synthetic.slice(0, 4), synthetic[7]]) {
    const card = await cardValue(measure.name, draftModel, filters, report.onlineFilters, 'card_' + canonical(measure.name).replace(/[^a-z0-9]+/g, '_'));
    syntheticCards[measure.name] = card.value;
    assert(closeEnough(card.value, asNumber(syntheticTotals[measure.name])), 'Card e total divergiram para ' + measure.name + '.');
  }
  const syntheticTableRun = await visualQuery({
    ...base,
    visualization: 'table', fields: [dimension, ...syntheticDependencyFields, ...syntheticFields], value: synthetic[0].name,
    deferTotals: true, totalsOnly: false, model: draftModel
  }, 'synthetic_table');
  assert((syntheticTableRun.body.rows || []).length > 0, 'Tabela sintetica nao retornou linhas.');
  syntheticFields.forEach((field) => assert(Object.prototype.hasOwnProperty.call(syntheticTableRun.body.rows[0], field.name), 'Tabela nao projetou ' + field.name + '.'));

  const afterSql = cardTarget.sql || '';
  assert(afterSql.includes('__biwa_measure_stage_'), 'SQL corrigido nao materializou a camada pos-agregacao.');
  assert(/COALESCE\(\([^)]*Valor L.quido vendas[^)]*\),\s*0\)\s*\+\s*COALESCE\(\([^)]*Descontado[^)]*\),\s*0\)/i.test(afterSql), 'Projecao final nao combina os escalares materializados.');
  assert(!/SUM\s*\(\s*SUM\s*\(/i.test(afterSql), 'SQL final ainda contem SUM(SUM(...)).');
  assert(!/AVG\s*\(\s*SUM\s*\(/i.test(afterSql), 'SQL final ainda contem AVG(SUM(...)).');

  for (const file of protectedFiles) assert.strictEqual(hash(file), protectedBefore[file], file + ' foi alterado pelo diagnostico.');
  console.log(JSON.stringify({
    ok: true,
    measure: { name: targetName, formula: target.formula },
    fieldContract: targetField,
    dependencies: ['Valor L\u00edquido vendas', 'Descontado', 'Desconto Financeiro'],
    baseline: { target: baseTarget, expected: expectedBaseTarget, total: asNumber(totalTarget.totals[targetName]), matches: true },
    results: results.map(({ sql, ...result }) => ({ ...result, sqlPlan: sql.includes('__biwa_measure_stage_') ? 'post-aggregate-projection' : 'direct' })),
    rowValidation: { rows: detailedRun.body.rows.length, formulaMatches: true, fieldOrderInvariant: true },
    filterScenarios: scenarioResults.map(({ sql, ...result }) => ({ ...result, setBasedMultiSelect: result.name === 'multimes' ? /\bIN\s*\(/i.test(sql) : undefined })),
    synthetic: {
      measures: synthetic.map((item) => ({ name: item.name, formula: item.formula, total: asNumber(syntheticTotals[item.name]) })),
      dependencyScalars: { sales: localSales, financial: localFinancial, discounted: localDiscounted },
      cards: syntheticCards,
      tableRows: syntheticTableRun.body.rows.length,
      operators: ['+', '-', '*', 'DIVIDE'],
      dagDepth: 4,
      sharedDependency: '__DAG Medida A',
      oneSqlQuery: true
    },
    sqlPlan: {
      invalidBeforeShape: 'SUM(CASE ... THEN (SUM(...) * MAX(...)) ... END)',
      afterShape: 'materialized dependency scalars -> post-aggregate projection',
      finalHasNestedAggregate: false
    },
    protectedFiles: 'inalterados'
  }, null, 2));
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
