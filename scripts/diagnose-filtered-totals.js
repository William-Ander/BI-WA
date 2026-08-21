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

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, { ...options, signal: options.signal || AbortSignal.timeout(180000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert(response.ok, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 1200)));
  return { body, elapsedMs: Number((performance.now() - startedAt).toFixed(1)) };
}

function filterBy(filters, field) {
  return (filters || []).find((filter) => canonical(filter.field) === canonical(field));
}

async function main() {
  const protectedBefore = Object.fromEntries(protectedFiles.map((file) => [file, hash(file)]));
  const serverSource = fs.readFileSync('server.js', 'utf8');
  const appSource = fs.readFileSync('public/app.js', 'utf8');
  assert(/preAggregateMeasureTables:[\s\S]{0,500}preAggregatedMeasureRegistry:\s*compiledMeasurePreAggregates/.test(serverSource), 'Medidas secundárias não compartilham o subplano pré-agregado da âncora.');
  assert(/metadata\.totalsAuthoritative\s*=\s*false;[\s\S]{0,300}TOTALS ERROR/.test(serverSource), 'Falha de total ainda pode ser marcada como autoritativa.');
  assert(/rowAdditiveColumns[\s\S]{0,300}!measureSourceNames\.has/.test(appSource), 'Frontend ainda pode somar linhas de medidas DAX como fallback.');
  assert(/pendingTotalsSignature\s*!==\s*signature/.test(appSource) && /visualTotalsControllers[\s\S]{0,300}\.abort\(\)/.test(appSource), 'Proteção contra resposta obsoleta do total ausente.');
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const reports = reportsFrom(JSON.parse(fs.readFileSync('data/reports.json', 'utf8')));
  const report = reports.find((item) => canonical(item.name || item.title) === 'gerencial');
  assert(report, 'Relatório Gerencial não encontrado.');
  const visual = (report.visuals || []).find((item) => String(item.visualization || '').toLowerCase() === 'table');
  assert(visual, 'Tabela do Relatório Gerencial não encontrada.');
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const configured = Array.isArray(visual.selectedFields) ? visual.selectedFields : [];
  // Diagnosticar somente medidas efetivamente configuradas no visual salvo.
  // "Descontado" pode existir no modelo sem estar na Tabela; exigir sua
  // presença transformava o próprio teste de totais em uma falsa regressão.
  const allMeasureNames = ['Preço Compras base', 'Valor compras 1 e 3', 'Preço Médio Vendas'];
  const requestedMeasureNames = String(process.env.DIAG_MEASURES || '').split('||').map((value) => value.trim()).filter(Boolean);
  const measureNames = requestedMeasureNames.length ? allMeasureNames.filter((name) => requestedMeasureNames.includes(name)) : allMeasureNames;
  const measureFields = configured.filter((field) => String(field.type || '').toLowerCase() === 'measure' && measureNames.includes(field.name));
  assert.strictEqual(measureFields.length, measureNames.length, 'Nem todas as medidas de diagnóstico estão no visual.');
  const companyFilter = filterBy(report.onlineFilters, 'Fantasia');
  const yearFilter = filterBy(report.onlineFilters, 'Ano');
  const monthFilter = filterBy(report.onlineFilters, 'MesNome');
  const partyFilter = filterBy(report.onlineFilters, 'Cliente e Fornecedor');
  const groupFilter = filterBy(report.onlineFilters, 'Grupo Cliente');
  const dayFilter = filterBy(report.onlineFilters, 'Dia');
  assert(companyFilter && yearFilter && monthFilter && partyFilter && groupFilter && dayFilter, 'Filtros do Gerencial incompletos.');

  async function options(filter, contextFilters = {}) {
    const query = new URLSearchParams({ table: filter.table, field: filter.field });
    if (Object.keys(contextFilters).length) query.set('contextFilters', JSON.stringify(contextFilters));
    return (await request('/api/filter-options?' + query.toString(), { headers })).body.values || [];
  }

  const companies = (await options(companyFilter)).filter((value) => /(?:CD|LOJA)$/i.test(String(value))).slice(0, 2);
  assert.strictEqual(companies.length, 2, 'São necessárias duas empresas.');
  const years = await options(yearFilter, { [companyFilter.key]: companies[0] });
  const year = years.includes(2026) ? '2026' : String(years[0] || '2026');
  const months = await options(monthFilter, { [companyFilter.key]: companies[0], [yearFilter.key]: year });
  assert(months.length, 'Nenhum mês disponível para o cenário.');
  const multiMonths = months.slice(0, Math.min(3, months.length));
  const parties = await options(partyFilter, { [companyFilter.key]: companies[0], [yearFilter.key]: year, [monthFilter.key]: multiMonths[0] });
  const groups = await options(groupFilter, { [companyFilter.key]: companies[0], [yearFilter.key]: year, [monthFilter.key]: multiMonths[0] });

  let scenarios = [
    { name: 'empresa_obrigatoria', values: { [companyFilter.id]: companies[0] }, onlineFilters: report.onlineFilters },
    { name: 'empresa_b', values: { [companyFilter.id]: companies[1] }, onlineFilters: report.onlineFilters },
    { name: 'empresa_ano_mes', values: { [companyFilter.id]: companies[0], [yearFilter.id]: year, [monthFilter.id]: multiMonths[0], [dayFilter.id]: '1|31' }, onlineFilters: report.onlineFilters },
    { name: 'empresa_multimes', values: { [companyFilter.id]: companies[0], [yearFilter.id]: year, [monthFilter.id]: multiMonths.join('||'), [dayFilter.id]: '1|31' }, onlineFilters: report.onlineFilters.map((filter) => filter.id === monthFilter.id ? { ...filter, multiSelect: true, operator: '=' } : filter) }
  ];
  if (parties[0]) scenarios.push({ name: 'empresa_mes_cliente', values: { [companyFilter.id]: companies[0], [yearFilter.id]: year, [monthFilter.id]: multiMonths[0], [partyFilter.id]: parties[0] }, onlineFilters: report.onlineFilters });
  if (groups[0]) scenarios.push({ name: 'empresa_mes_grupo', values: { [companyFilter.id]: companies[0], [yearFilter.id]: year, [monthFilter.id]: multiMonths[0], [groupFilter.id]: groups[0] }, onlineFilters: report.onlineFilters });
  scenarios.push({ name: 'zero_linhas', values: { [companyFilter.id]: companies[0], [yearFilter.id]: year, [monthFilter.id]: multiMonths[0], [groupFilter.id]: '__BIWA_SEM_RESULTADOS__' }, onlineFilters: report.onlineFilters });
  if (process.env.DIAG_SCENARIO) scenarios = scenarios.filter((scenario) => scenario.name === process.env.DIAG_SCENARIO);
  assert(scenarios.length, 'Cenário solicitado não encontrado.');

  async function visualQuery(payload) {
    return request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(payload) });
  }

  const base = {
    table: visual.table, pageId: visual.pageId || 'page_1', visualization: 'table',
    dimension: visual.dimension, value: visual.value, fields: configured,
    aggregation: visual.aggregation || 'SUM', order: visual.order || 'DESC',
    visualFilters: visual.visualFilters || [], pageFilters: report.pageFilters || [], allPagesFilters: report.allPagesFilters || [],
    limit: 100, page: 1, pageSize: 100, model
  };
  const results = [];
  for (const scenario of scenarios) {
    console.error('[scenario]', scenario.name);
    const rowsRun = await visualQuery({ ...base, visualId: '__total_diag_rows_' + scenario.name, filters: scenario.values, onlineFilters: scenario.onlineFilters, deferTotals: true });
    const totalsRun = await visualQuery({ ...base, visualId: '__total_diag_total_' + scenario.name, filters: scenario.values, onlineFilters: scenario.onlineFilters, totalsOnly: true, deferTotals: false, performanceDiagnostics: true });
    const cards = {};
    for (const field of measureFields) {
      console.error('[card]', scenario.name, field.name);
      try {
        const card = await visualQuery({
          ...base, visualId: '__total_diag_card_' + scenario.name + '_' + canonical(field.name).replace(/[^a-z0-9]+/g, '_'),
          visualization: 'card', dimension: '', value: field.name, fields: [field], filters: scenario.values,
          onlineFilters: scenario.onlineFilters, limit: 1, pageSize: undefined, deferTotals: false, totalsOnly: false
        });
        cards[field.name] = asNumber(card.body.rows[0] && card.body.rows[0][field.name]);
      } catch (error) {
        cards[field.name] = { error: error.message };
      }
    }
    const totals = totalsRun.body.totals || {};
    const comparisons = Object.fromEntries(measureNames.map((name) => {
      const totalValue = asNumber(totals[name]);
      const cardValue = typeof cards[name] === 'number' || cards[name] === null ? cards[name] : null;
      return [name, { total: totalValue, card: cardValue, matches: closeEnough(totalValue, cardValue) }];
    }));
    results.push({
      name: scenario.name,
      filters: scenario.values,
      rows: rowsRun.body.rows.length,
      rowsSql: rowsRun.body.sql || rowsRun.body.baseSql || '',
      totalSql: totalsRun.body.totalSql || '',
      totalsError: totalsRun.body.totalsError || '',
      totalsAuthoritative: totalsRun.body.totalsAuthoritative,
      totals,
      cards,
      comparisons,
      elapsedMs: { rows: rowsRun.elapsedMs, totals: totalsRun.elapsedMs }
    });
    console.error('[result]', JSON.stringify(results[results.length - 1].comparisons));
  }

  results.forEach((result) => {
    assert.strictEqual(result.totalsError, '', result.name + ': consulta de total falhou: ' + result.totalsError);
    assert.strictEqual(result.totalsAuthoritative, true, result.name + ': total não foi marcado como autoritativo.');
    assert(result.totalSql, result.name + ': SQL diagnóstico do total ausente.');
    Object.entries(result.comparisons).forEach(([name, comparison]) => {
      assert.strictEqual(comparison.matches, true, result.name + ': total de ' + name + ' diverge do Card no mesmo contexto (' + comparison.total + ' != ' + comparison.card + ').');
    });
  });
  if (process.env.DIAG_SCENARIO) {
    for (const file of protectedFiles) assert.strictEqual(hash(file), protectedBefore[file], file + ' foi alterado durante os testes.');
    console.log(JSON.stringify({
      ok: true,
      isolatedScenario: process.env.DIAG_SCENARIO,
      results: results.map((result) => ({
        name: result.name,
        rows: result.rows,
        totals: result.comparisons,
        totalsAuthoritative: result.totalsAuthoritative,
        elapsedMs: result.elapsedMs
      }))
    }, null, 2));
    return;
  }
  const baseCompany = results.find((result) => result.name === 'empresa_obrigatoria');
  const otherCompany = results.find((result) => result.name === 'empresa_b');
  assert(baseCompany && otherCompany, 'Cenários de Empresa incompletos.');
  assert.notStrictEqual(baseCompany.comparisons['Valor compras 1 e 3'].total, otherCompany.comparisons['Valor compras 1 e 3'].total, 'Empresa não alterou o total aditivo.');
  assert.notStrictEqual(baseCompany.comparisons['Preço Médio Vendas'].total, otherCompany.comparisons['Preço Médio Vendas'].total, 'Empresa não alterou o total da medida não aditiva.');
  const multi = results.find((result) => result.name === 'empresa_multimes');
  if (multiMonths.length > 1) {
    assert(multi, 'Cenário de multiseleção ausente.');
    multiMonths.forEach((month) => assert(multi.totalSql.includes("'" + month.replace(/'/g, "''") + "'"), 'Mês ausente do SQL total: ' + month));
    assert(/\bIN\s*\(/i.test(multi.totalSql), 'Multiseleção não chegou ao total como conjunto IN.');
  }
  const zeroRows = results.find((result) => result.name === 'zero_linhas');
  assert(zeroRows && zeroRows.rows === 0, 'Cenário vazio não retornou zero linhas.');
  assert.strictEqual(zeroRows.comparisons['Preço Médio Vendas'].total, zeroRows.comparisons['Preço Médio Vendas'].card, 'Contexto vazio reutilizou total anterior.');

  const keyField = configured.find((field) => String(field.type || '').toLowerCase() !== 'measure');
  const nonAdditiveField = configured.find((field) => field.name === 'Preço Médio Vendas');
  assert(keyField && nonAdditiveField, 'Campos para regressão de Matriz ausentes.');
  const matrixPayload = {
    ...base,
    visualId: '__total_diag_matrix',
    visualization: 'matrix',
    value: nonAdditiveField.name,
    fields: [keyField, nonAdditiveField],
    matrixRows: [keyField.name],
    matrixColumns: [],
    matrixValues: [nonAdditiveField.name],
    filters: { [companyFilter.id]: companies[0] },
    onlineFilters: report.onlineFilters
  };
  const matrixRows = await visualQuery({ ...matrixPayload, deferTotals: true });
  const matrixTotals = await visualQuery({ ...matrixPayload, totalsOnly: true, deferTotals: false, performanceDiagnostics: true });
  assert(matrixRows.body.rows.length > 0, 'Matriz não retornou linhas.');
  assert(closeEnough(asNumber(matrixTotals.body.totals && matrixTotals.body.totals['Preço Médio Vendas']), baseCompany.comparisons['Preço Médio Vendas'].card), 'Total da Matriz diverge do Card no mesmo contexto.');

  const percentName = 'Percentual Genérico __total regression';
  const draftModel = JSON.parse(JSON.stringify(model));
  draftModel.measures.push({
    name: percentName,
    displayName: percentName,
    table: visual.table,
    formula: 'DIVIDE([Valor compras 1 e 3], [Qtde Liquido 1 e 3], 0)',
    format: '0.00%'
  });
  const percentField = { name: percentName, table: visual.table, type: 'measure', measureId: percentName };
  const percentPayload = {
    ...base,
    visualId: '__total_diag_non_additive',
    value: percentName,
    fields: [keyField, percentField],
    filters: { [companyFilter.id]: companies[0] },
    onlineFilters: report.onlineFilters,
    model: draftModel
  };
  const percentRows = await visualQuery({ ...percentPayload, deferTotals: true });
  const percentTotals = await visualQuery({ ...percentPayload, totalsOnly: true, deferTotals: false });
  const percentCard = await visualQuery({ ...percentPayload, visualization: 'card', dimension: '', fields: [percentField], limit: 1, pageSize: undefined, totalsOnly: false, deferTotals: false });
  const percentTotal = asNumber(percentTotals.body.totals && percentTotals.body.totals[percentName]);
  const percentCardValue = asNumber(percentCard.body.rows[0] && percentCard.body.rows[0][percentName]);
  const percentRowSum = (percentRows.body.rows || []).reduce((sum, row) => sum + (asNumber(row[percentName]) || 0), 0);
  assert(closeEnough(percentTotal, percentCardValue), 'Medida percentual não foi reavaliada no total.');
  assert(!closeEnough(percentTotal, percentRowSum), 'Total percentual ainda é a soma das porcentagens de linha.');
  for (const file of protectedFiles) assert.strictEqual(hash(file), protectedBefore[file], file + ' foi alterado durante os testes.');

  console.log(JSON.stringify({
    ok: true,
    company: companies,
    year,
    months,
    scenarios: results.map((result) => ({
      name: result.name,
      filters: result.filters,
      rows: result.rows,
      totals: result.comparisons,
      rowsSqlHasCompany: companies.some((company) => result.rowsSql.includes(company)),
      totalSqlHasCompany: companies.some((company) => result.totalSql.includes(company)),
      totalPlan: 'semantic-re-evaluation',
      elapsedMs: result.elapsedMs
    })),
    matrix: { rows: matrixRows.body.rows.length, total: asNumber(matrixTotals.body.totals['Preço Médio Vendas']), matchesCard: true },
    nonAdditive: { measure: percentName, total: percentTotal, card: percentCardValue, rowSum: percentRowSum, reEvaluated: true },
    requestCount: (results.length * (2 + measureNames.length)) + 5,
    beforeProblematicShape: 'SUM(related_alias.value) over fact rows',
    afterPlanShape: 'MAX(related_alias.__biwa_pre_measure_*) over one-row-per-key subplan',
    protectedFiles: 'inalterados'
  }, null, 2));
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
