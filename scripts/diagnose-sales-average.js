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

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function closeEnough(left, right) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= Math.max(0.001, Math.abs(right) * 1e-9);
}

function reportsFrom(value) {
  return Array.isArray(value) ? value : (Array.isArray(value && value.reports) ? value.reports : []);
}

function fieldFor(name, table, type = 'measure') {
  return { name, table, type, fieldType: type === 'measure' ? 'measure' : 'column', semanticType: type === 'measure' ? 'measure' : 'column', measureId: type === 'measure' ? name : undefined };
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, { ...options, signal: options.signal || AbortSignal.timeout(180000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert(response.ok, path + ' HTTP ' + response.status + ': ' + (body.error || body.message || text.slice(0, 1500)));
  return { body, elapsedMs: Number((performance.now() - startedAt).toFixed(1)) };
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
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const dimension = (visual.selectedFields || []).find((field) => String(field.type || '').toLowerCase() !== 'measure');
  assert(dimension, 'Dimensao de produto nao encontrada.');
  const productOptions = (await request('/api/filter-options?' + new URLSearchParams({ table: dimension.table, field: dimension.name }).toString(), { headers })).body.values || [];
  const product = productOptions.find((value) => /(?:^|\D)1056(?:\D|$)/.test(String(value)));
  assert(product, 'Produto 1056 nao encontrado no dominio de ' + dimension.name + '.');
  const configuredByName = new Map((visual.selectedFields || []).map((field) => [canonical(field.name), field]));
  const measureField = (name) => configuredByName.get(canonical(name)) || fieldFor(name, visual.table);
  const names = [
    'Qtde Vendas L\u00edquida',
    'Valor Vendas',
    'Valor L\u00edquido vendas',
    'Descontado',
    'Valor L\u00edquido com Desconto',
    'Qtde Liquido 1 e 3',
    'Pre\u00e7o M\u00e9dio Vendas'
  ];
  names.forEach((name) => assert((model.measures || []).some((measure) => canonical(measure.name) === canonical(name)), 'Medida ausente: ' + name));
  const salesAverageMeasure = (model.measures || []).find((measure) => canonical(measure.name) === canonical('Preço Médio Vendas'));
  const purchaseAverageMeasure = (model.measures || []).find((measure) => canonical(measure.name) === canonical('Preço Médio Compras'));
  assert(/DIVIDE\s*\(\s*\[Valor Líquido com Desconto\]\s*,\s*\[Qtde Vendas Líquida\]\s*,\s*0\s*\)/i.test(salesAverageMeasure && salesAverageMeasure.formula || ''), 'Preço Médio Vendas precisa usar a quantidade líquida de vendas.');
  assert(/\[Qtde Liquido 1 e 3\]/i.test(purchaseAverageMeasure && purchaseAverageMeasure.formula || ''), 'Preço Médio Compras não pode perder seu denominador de compras.');
  const selected = names.map(measureField);
  const salesOnlyNames = ['Qtde Vendas Líquida', 'Valor Vendas', 'Valor Líquido com Desconto', 'Preço Médio Vendas'];
  const purchaseNames = ['Qtde Liquido 1 e 3', 'Preço Compras base', 'Valor compras 1 e 3'];
  const companyFilter = (report.onlineFilters || []).find((filter) => canonical(filter.field) === 'fantasia');
  const company = companyFilter && (companyFilter.selectedValue || companyFilter.value || companyFilter.defaultValue) || 'RLS HORTIFRUTI - CD';
  const activeFilters = companyFilter ? { [companyFilter.id]: company } : {};
  const base = {
    table: visual.table,
    pageId: visual.pageId || 'page_1',
    visualization: 'table',
    dimension: dimension.name,
    value: 'Pre\u00e7o M\u00e9dio Vendas',
    aggregation: 'SUM',
    order: 'DESC',
    fields: [dimension, ...selected],
    visualFilters: [],
    pageFilters: report.pageFilters || [],
    allPagesFilters: report.allPagesFilters || [],
    filters: activeFilters,
    onlineFilters: report.onlineFilters || [],
    limit: 200,
    page: 1,
    pageSize: 200,
    model,
    deferTotals: true,
    performanceDiagnostics: true
  };

  async function visualQuery(payload, id) {
    return request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({ ...payload, visualId: '__price_average_diag_' + id })
    });
  }

  const allRun = await visualQuery(base, 'all_products');
  const totalRun = await visualQuery({ ...base, totalsOnly: true, deferTotals: false }, 'all_products_total');
  const targetRun = await visualQuery({
    ...base,
    visualFilters: [{ table: dimension.table, column: dimension.name, values: [product] }]
  }, 'product_1056');
  const productFilter = [{ table: dimension.table, column: dimension.name, values: [product] }];
  const salesOnlyRun = await visualQuery({
    ...base,
    fields: [dimension, ...salesOnlyNames.map(measureField)],
    visualFilters: productFilter
  }, 'product_1056_sales_only');
  const purchasesFirstRun = await visualQuery({
    ...base,
    fields: [dimension, ...purchaseNames.map(measureField), ...salesOnlyNames.map(measureField)],
    visualFilters: productFilter
  }, 'product_1056_purchases_first');
  const salesFirstRun = await visualQuery({
    ...base,
    fields: [dimension, ...salesOnlyNames.map(measureField), ...purchaseNames.map(measureField)],
    visualFilters: productFilter
  }, 'product_1056_sales_first');
  assert.strictEqual((targetRun.body.rows || []).length, 1, 'Filtro do produto 1056 nao retornou uma unica linha.');
  const targetRow = targetRun.body.rows[0];
  const salesOnlyRow = salesOnlyRun.body.rows[0];
  const purchasesFirstRow = purchasesFirstRun.body.rows[0];
  const salesFirstRow = salesFirstRun.body.rows[0];
  const targetKey = String(targetRow[dimension.name]);
  assert(/1056/.test(targetKey), 'Linha retornada nao corresponde ao produto 1056.');
  const withoutAlternateName = '__Preco Medio Vendas sem alternate';
  const draftModel = JSON.parse(JSON.stringify(model));
  draftModel.measures.push({ name: withoutAlternateName, displayName: withoutAlternateName, table: visual.table, formula: 'DIVIDE([Valor Líquido com Desconto], [Qtde Vendas Líquida])', format: '#,##0.000' });
  const diagnosticRun = await visualQuery({
    ...base,
    value: withoutAlternateName,
    fields: [dimension, ...selected, fieldFor(withoutAlternateName, visual.table)],
    visualFilters: [{ table: dimension.table, column: dimension.name, values: [product] }],
    model: draftModel
  }, 'without_alternate');
  const diagnosticRow = diagnosticRun.body.rows[0];
  const rows = allRun.body.rows || [];
  const visibleAnomalies = rows.filter((row) => {
    const salesQuantity = asNumber(row['Qtde Vendas L\u00edquida']);
    const salesValue = asNumber(row['Valor Vendas']);
    const average = asNumber(row['Pre\u00e7o M\u00e9dio Vendas']);
    return salesQuantity > 0 && salesValue > 0 && average === 0;
  });
  const dependencyAnomalies = rows.filter((row) => {
    const numerator = asNumber(row['Valor L\u00edquido com Desconto']);
    const denominator = asNumber(row['Qtde Vendas L\u00edquida']);
    const average = asNumber(row['Pre\u00e7o M\u00e9dio Vendas']);
    return numerator > 0 && denominator > 0 && average === 0;
  });
  const workingIndex = rows.findIndex((row) => asNumber(row['Valor L\u00edquido com Desconto']) > 0 && asNumber(row['Qtde Vendas L\u00edquida']) > 0 && asNumber(row['Pre\u00e7o M\u00e9dio Vendas']) > 0);
  const workingRow = workingIndex >= 0 ? rows[workingIndex] : null;
  rows.forEach((row, index) => {
    const numerator = asNumber(row['Valor L\u00edquido com Desconto']);
    const denominator = asNumber(row['Qtde Vendas L\u00edquida']);
    const average = asNumber(row['Pre\u00e7o M\u00e9dio Vendas']);
    if (numerator !== null && denominator > 0) {
      assert(closeEnough(average, numerator / denominator), 'DIVIDE divergiu matematicamente na linha ' + index + '.');
    }
  });
  ['Qtde Vendas L\u00edquida', 'Valor Vendas', 'Valor L\u00edquido com Desconto', 'Pre\u00e7o M\u00e9dio Vendas'].forEach((name) => {
    assert(closeEnough(asNumber(salesOnlyRow[name]), asNumber(purchasesFirstRow[name])), 'Campo de compras alterou ' + name + '.');
    assert(closeEnough(asNumber(purchasesFirstRow[name]), asNumber(salesFirstRow[name])), 'Ordem dos campos alterou ' + name + '.');
  });
  assert(closeEnough(asNumber(targetRow['Pre\u00e7o M\u00e9dio Vendas']), asNumber(targetRow['Valor L\u00edquido com Desconto']) / asNumber(targetRow['Qtde Vendas L\u00edquida'])), 'MELANCIA BABY não foi calculada com as dependências de vendas.');
  assert(closeEnough(asNumber(diagnosticRow[withoutAlternateName]), asNumber(targetRow['Pre\u00e7o M\u00e9dio Vendas'])), 'O terceiro argumento de DIVIDE interferiu em denominador válido.');
  assert.strictEqual(visibleAnomalies.length, 0, 'Ainda há produtos com venda válida e Preço Médio Vendas zerado.');
  assert.strictEqual(dependencyAnomalies.length, 0, 'Ainda há dependências de vendas válidas com Preço Médio Vendas zerado.');
  const totals = totalRun.body.totals || {};
  const totalNumerator = asNumber(totals['Valor L\u00edquido com Desconto']);
  const totalDenominator = asNumber(totals['Qtde Vendas L\u00edquida']);
  const totalAverage = asNumber(totals['Pre\u00e7o M\u00e9dio Vendas']);
  assert(closeEnough(totalAverage, totalNumerator / totalDenominator), 'Total do Preço Médio Vendas não foi reavaliado pela fórmula DAX.');
  const cardRun = await visualQuery({
    ...base,
    visualization: 'card', dimension: '', fields: [measureField('Preço Médio Vendas')],
    value: 'Preço Médio Vendas', limit: 1, pageSize: undefined, deferTotals: false
  }, 'all_products_card');
  assert(closeEnough(asNumber(cardRun.body.rows && cardRun.body.rows[0] && cardRun.body.rows[0]['Preço Médio Vendas']), totalAverage), 'Card e total divergem para Preço Médio Vendas.');
  const matrixRun = await visualQuery({
    ...base,
    visualization: 'matrix', fields: [dimension, measureField('Preço Médio Vendas')],
    matrixRows: [dimension.name], matrixColumns: [], matrixValues: ['Preço Médio Vendas'], deferTotals: true
  }, 'all_products_matrix');
  assert((matrixRun.body.rows || []).length > 0, 'Matriz não retornou linhas.');

  function filterBy(field) {
    return (report.onlineFilters || []).find((filter) => canonical(filter.field) === canonical(field));
  }
  async function options(filter, contextFilters = {}) {
    if (!filter) return [];
    const query = new URLSearchParams({ table: filter.table, field: filter.field });
    if (Object.keys(contextFilters).length) query.set('contextFilters', JSON.stringify(contextFilters));
    return (await request('/api/filter-options?' + query.toString(), { headers })).body.values || [];
  }
  const companyDefinition = filterBy('Fantasia');
  const yearDefinition = filterBy('Ano');
  const monthDefinition = filterBy('MesNome');
  const partyDefinition = filterBy('Cliente e Fornecedor');
  const companies = companyDefinition ? (await options(companyDefinition)).filter((value) => /(?:CD|LOJA)$/i.test(String(value))).slice(0, 2) : [];
  const scenarioCompany = companies[0] || company;
  const years = companyDefinition && yearDefinition ? await options(yearDefinition, { [companyDefinition.key]: scenarioCompany }) : [];
  const scenarioYear = years.includes(2026) ? '2026' : String(years[0] || '2026');
  const months = companyDefinition && yearDefinition && monthDefinition
    ? await options(monthDefinition, { [companyDefinition.key]: scenarioCompany, [yearDefinition.key]: scenarioYear })
    : [];
  const parties = companyDefinition && partyDefinition ? await options(partyDefinition, { [companyDefinition.key]: scenarioCompany }) : [];
  const scenarios = [];
  if (companyDefinition && companies[0]) scenarios.push({ name: 'empresa_a', filters: { [companyDefinition.id]: companies[0] }, onlineFilters: report.onlineFilters || [] });
  if (companyDefinition && companies[1]) scenarios.push({ name: 'empresa_b', filters: { [companyDefinition.id]: companies[1] }, onlineFilters: report.onlineFilters || [] });
  if (companyDefinition && yearDefinition && monthDefinition && months[0]) scenarios.push({ name: 'mes_unico', filters: { [companyDefinition.id]: scenarioCompany, [yearDefinition.id]: scenarioYear, [monthDefinition.id]: months[0] }, onlineFilters: report.onlineFilters || [] });
  if (companyDefinition && yearDefinition && monthDefinition && months.length > 1) scenarios.push({
    name: 'multimes',
    filters: { [companyDefinition.id]: scenarioCompany, [yearDefinition.id]: scenarioYear, [monthDefinition.id]: months.slice(0, Math.min(3, months.length)).join('||') },
    onlineFilters: (report.onlineFilters || []).map((filter) => filter.id === monthDefinition.id ? { ...filter, multiSelect: true, operator: '=' } : filter)
  });
  if (companyDefinition && partyDefinition && parties[0]) scenarios.push({ name: 'cliente_fornecedor', filters: { [companyDefinition.id]: scenarioCompany, [partyDefinition.id]: parties[0] }, onlineFilters: report.onlineFilters || [] });
  const filterScenarios = [];
  for (const scenario of scenarios) {
    const rowsRun = await visualQuery({ ...base, filters: scenario.filters, onlineFilters: scenario.onlineFilters, deferTotals: true }, scenario.name + '_rows');
    const scenarioTotalsRun = await visualQuery({ ...base, filters: scenario.filters, onlineFilters: scenario.onlineFilters, totalsOnly: true, deferTotals: false }, scenario.name + '_total');
    const scenarioTotals = scenarioTotalsRun.body.totals || {};
    const scenarioNumerator = asNumber(scenarioTotals['Valor Líquido com Desconto']);
    const scenarioDenominator = asNumber(scenarioTotals['Qtde Vendas Líquida']);
    const scenarioAverage = asNumber(scenarioTotals['Preço Médio Vendas']);
    if (scenarioDenominator > 0) assert(closeEnough(scenarioAverage, scenarioNumerator / scenarioDenominator), scenario.name + ': total perdeu o contexto de vendas.');
    else assert(closeEnough(scenarioAverage, 0), scenario.name + ': DIVIDE não respeitou o alternateResult com denominador zero.');
    (rowsRun.body.rows || []).forEach((row, index) => {
      const numerator = asNumber(row['Valor Líquido com Desconto']);
      const denominator = asNumber(row['Qtde Vendas Líquida']);
      const average = asNumber(row['Preço Médio Vendas']);
      if (denominator > 0) assert(closeEnough(average, numerator / denominator), scenario.name + ': linha ' + index + ' perdeu o contexto de vendas.');
    });
    const scenarioSql = scenarioTotalsRun.body.totalSql || scenarioTotalsRun.body.sql || '';
    if (scenario.name === 'multimes') {
      assert(/\bIN\s*\(/i.test(scenarioSql), 'Multiseleção de meses não foi compilada como conjunto IN.');
    }
    filterScenarios.push({ name: scenario.name, filters: scenario.filters, rows: (rowsRun.body.rows || []).length, total: scenarioAverage, numerator: scenarioNumerator, denominator: scenarioDenominator, elapsedMs: { rows: rowsRun.elapsedMs, totals: scenarioTotalsRun.elapsedMs } });
  }
  for (const file of protectedFiles) assert.strictEqual(hash(file), protectedBefore[file], file + ' foi alterado pelo diagnostico.');
  const pick = (row) => row ? Object.fromEntries([dimension.name, ...names, withoutAlternateName].filter((name) => Object.prototype.hasOwnProperty.call(row, name)).map((name) => [name, row[name]])) : null;
  console.log(JSON.stringify({
    ok: true,
    product,
    company,
    savedMeasure: salesAverageMeasure,
    purchaseAverageMeasure,
    dependencies: Object.fromEntries(['Valor L\u00edquido com Desconto', 'Qtde Liquido 1 e 3', 'Qtde Vendas L\u00edquida'].map((name) => {
      const measure = (model.measures || []).find((item) => canonical(item.name) === canonical(name));
      return [name, measure && measure.formula];
    })),
    target: pick(targetRow),
    fieldMix: {
      salesOnly: pick(salesOnlyRow),
      purchasesFirst: pick(purchasesFirstRow),
      salesFirst: pick(salesFirstRow),
      invariant: true
    },
    targetWithoutAlternate: pick(diagnosticRow),
    arithmetic: {
      configuredNumerator: asNumber(targetRow['Valor L\u00edquido com Desconto']),
      configuredDenominator: asNumber(targetRow['Qtde Vendas L\u00edquida']),
      configuredResult: asNumber(targetRow['Pre\u00e7o M\u00e9dio Vendas']),
      salesQuantity: asNumber(targetRow['Qtde Vendas L\u00edquida']),
      salesValue: asNumber(targetRow['Valor Vendas']),
      valueDividedBySalesQuantity: asNumber(targetRow['Valor L\u00edquido com Desconto']) / asNumber(targetRow['Qtde Vendas L\u00edquida'])
    },
    workingComparison: pick(workingRow),
    anomalyCounts: {
      visibleSalesButZeroAverage: visibleAnomalies.length,
      validSalesDependenciesButZeroAverage: dependencyAnomalies.length
    },
    examples: visibleAnomalies.slice(0, 20).map(pick),
    plan: {
      targetSql: targetRun.body.sql || targetRun.body.baseSql || '',
      diagnosticSql: diagnosticRun.body.sql || diagnosticRun.body.baseSql || '',
      targetElapsedMs: targetRun.elapsedMs,
      salesOnlyElapsedMs: salesOnlyRun.elapsedMs,
      purchasesFirstElapsedMs: purchasesFirstRun.elapsedMs,
      salesFirstElapsedMs: salesFirstRun.elapsedMs,
      allElapsedMs: allRun.elapsedMs,
      allRows: rows.length
    },
    totals: {
      numerator: totalNumerator,
      denominator: totalDenominator,
      priceAverage: totalAverage,
      matchesFormula: true,
      matchesCard: true
    },
    matrix: { rows: (matrixRun.body.rows || []).length, executed: true },
    filters: {
      companies,
      year: scenarioYear,
      months,
      scenarios: filterScenarios
    },
    protectedFiles: 'inalterados'
  }, null, 2));
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
