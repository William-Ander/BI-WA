const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';

function canonical(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, { ...options, signal: options.signal || AbortSignal.timeout(180000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert.strictEqual(response.status, expectedStatus, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return body;
}

function reportsFrom(value) {
  return Array.isArray(value) ? value : (Array.isArray(value && value.reports) ? value.reports : []);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowsByKey(rows, key, measures) {
  const result = new Map();
  (rows || []).forEach((row) => {
    result.set(String(row[key]), measures.map((measure) => number(row[measure])));
  });
  return result;
}

function assertSameValues(leftRows, rightRows, key, measures, label) {
  const left = rowsByKey(leftRows, key, measures);
  const right = rowsByKey(rightRows, key, measures);
  assert.deepStrictEqual(Array.from(right.keys()).sort(), Array.from(left.keys()).sort(), label + ': o conjunto de linhas mudou.');
  left.forEach((values, rowKey) => assert.deepStrictEqual(right.get(rowKey), values, label + ': valores divergiram em ' + rowKey));
}

async function main() {
  const modelPath = 'data/semantic_model.json';
  const reportPath = 'data/reports.json';
  const before = { model: hash(modelPath), reports: hash(reportPath) };
  const appSource = fs.readFileSync('public/app.js', 'utf8');
  assert(/Object\.keys\(sourceRows\[0\]\)[\s\S]{0,180}fields\.map\(function\(field\) \{ return field\.name; \}\)/.test(appSource), 'O schema da Tabela ainda depende somente da primeira linha do dataset.');
  assert(/if \(!rows\.length && !normalizeSelectedFields\(visual && visual\.selectedFields\)\.length\)/.test(appSource), 'Dataset vazio ainda remove cabeçalhos configurados explicitamente.');
  assert(!/if \(!sourceColumns\.includes\(field\.name\)\) return;/.test(appSource), 'Uma medida configurada ainda é descartada quando a primeira linha não contém a propriedade.');
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const reports = reportsFrom(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const report = reports.find((item) => canonical(item.name || item.title) === 'gerencial');
  assert(report, 'Relatório Gerencial não encontrado.');
  const visual = (report.visuals || []).find((item) => String(item.visualization || '').toLowerCase() === 'table');
  assert(visual, 'Tabela do Relatório Gerencial não encontrada.');
  const measureMap = new Map((model.measures || []).map((measure) => [canonical(measure.name || measure.displayName), measure]));
  const cost = measureMap.get('custo');
  const returns = measureMap.get('conversao devolucao vendas');
  const oldMeasure = measureMap.get('qtde liquido 1 e 3');
  assert(cost && returns && oldMeasure, 'Medidas de reprodução não encontradas no modelo.');
  assert(cost.table && cost.formula && cost.name, 'A medida recém-criada não possui o contrato semântico mínimo.');
  assert.strictEqual(cost.table, oldMeasure.table, 'A medida nova foi associada a uma tabela diferente das medidas antigas do visual.');

  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
  const companyFilter = (report.onlineFilters || []).find((filter) => canonical(filter.field) === 'fantasia');
  assert(companyFilter, 'Filtro Empresa do Gerencial não encontrado.');
  const options = await request('/api/filter-options?table=' + encodeURIComponent(companyFilter.table) + '&field=' + encodeURIComponent(companyFilter.field), { headers });
  const companies = (options.values || []).filter((value) => /(?:CD|LOJA)$/i.test(String(value)));
  assert(companies.length >= 2, 'São necessárias duas empresas para validar propagação de filtros.');

  const configured = Array.isArray(visual.selectedFields) ? visual.selectedFields : [];
  const keyField = configured.find((field) => field.name === 'Código e Produto') || configured[0];
  const costField = configured.find((field) => canonical(field.name) === 'custo');
  assert(costField, 'Custo existe no painel/modelo, mas não está persistida na configuração da Tabela atual.');
  assert.strictEqual(String(costField.type).toLowerCase(), 'measure', 'Custo não foi persistida como MEASURE.');
  assert.strictEqual(costField.measureId, cost.name, 'measureId de Custo não corresponde ao nome interno da medida.');
  const returnsField = { name: returns.name, table: returns.table, type: 'measure', measureId: returns.name };

  const basePayload = {
    table: visual.table,
    visualId: visual.id,
    pageId: visual.pageId || 'page_1',
    visualization: 'table',
    dimension: visual.dimension || keyField.name,
    value: visual.value || oldMeasure.name,
    fields: configured,
    aggregation: visual.aggregation || 'SUM',
    order: visual.order || 'DESC',
    page: 1,
    pageSize: 100,
    deferTotals: true,
    limit: 100,
    visualFilters: visual.visualFilters || [],
    pageFilters: report.pageFilters || [],
    allPagesFilters: report.allPagesFilters || [],
    onlineFilters: report.onlineFilters || [],
    filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: String(companies[0]) },
    model
  };
  async function run(payload) {
    return request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(payload) });
  }

  const withoutCostFields = configured.filter((field) => canonical(field.name) !== 'custo');
  const removed = await run({ ...basePayload, visualId: 'regression_remove_cost', fields: withoutCostFields });
  assert(removed.rows.length > 0, 'Remover Custo deixou a tabela sem linhas.');
  assert(!Object.prototype.hasOwnProperty.call(removed.rows[0], cost.name), 'Custo permaneceu no dataset após remoção.');

  const added = await run({ ...basePayload, visualId: 'regression_add_cost', fields: configured });
  assert(added.rows.length > 0, 'Reinserir Custo deixou a tabela sem linhas.');
  assert(Object.prototype.hasOwnProperty.call(added.rows[0], cost.name), 'Custo não chegou ao dataset da Tabela.');
  assert(added.rows.some((row) => number(row[cost.name]) !== null), 'Custo não apresentou valores numéricos.');
  configured.forEach((field) => assert(Object.prototype.hasOwnProperty.call(added.rows[0], field.name), 'Campo configurado ausente do dataset: ' + field.name));
  assert(added.performance && added.performance.queryBuildCount === 1, 'Adicionar Custo recompilou a consulta mais de uma vez.');
  const rowContextChecks = added.rows.filter((row) =>
    number(row[cost.name]) !== null &&
    number(row['Qtde Vendas Líquida']) !== null &&
    number(row['Preço Compras base']) !== null
  );
  assert(rowContextChecks.length > 0, 'Não houve linhas numéricas para validar o contexto por produto de Custo.');
  rowContextChecks.forEach((row) => {
    const expected = number(row['Qtde Vendas Líquida']) * number(row['Preço Compras base']);
    const actual = number(row[cost.name]);
    const tolerance = Math.max(0.01, Math.abs(expected) * 1e-9);
    assert(Math.abs(actual - expected) <= tolerance, 'Custo não respeitou quantidade × preço no contexto de ' + row[keyField.name]);
  });

  const currentMonthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'America/Bahia' })
    .format(new Date())
    .replace(/^./, (letter) => letter.toLocaleUpperCase('pt-BR'));
  const realReportFilters = { ...basePayload.filters };
  (report.onlineFilters || []).forEach((filter) => {
    const key = filter.id || filter.key || filter.field;
    const field = canonical(filter.field);
    if (field === 'dia') realReportFilters[key] = '1|31';
    else if (field === 'mesnome') realReportFilters[key] = currentMonthName;
    else if (field === 'ano') realReportFilters[key] = String(new Date().getFullYear());
  });
  const fullReportContext = await run({
    ...basePayload,
    visualId: 'regression_real_report_filter_context',
    fields: configured,
    filters: realReportFilters
  });
  assert(fullReportContext.rows.length > 0, 'Custo falhou com Dia, Mês, Ano e Empresa simultaneamente.');
  assert(fullReportContext.rows.some((row) => number(row[cost.name]) !== null), 'Custo não retornou valores com os filtros reais do Gerencial.');
  assert(fullReportContext.performance && fullReportContext.performance.queryBuildCount === 1, 'Os filtros reais provocaram recompilação redundante da consulta de Custo.');

  const simpleCostFields = [keyField, costField];
  const simpleCost = await run({ ...basePayload, visualId: 'regression_simple_cost', dimension: keyField.name, fields: simpleCostFields });
  assert(simpleCost.rows.length > 0 && simpleCost.rows.every((row) => Object.prototype.hasOwnProperty.call(row, cost.name)), 'Tabela simples Código Produto + Custo falhou.');

  const simpleReturns = await run({ ...basePayload, visualId: 'regression_simple_returns', dimension: keyField.name, fields: [keyField, returnsField] });
  assert(simpleReturns.rows.length > 0 && simpleReturns.rows.some((row) => number(row[returns.name]) !== null), 'Conversão Devolução Vendas falhou isoladamente.');

  const combinedFields = configured.filter((field) => canonical(field.name) !== canonical(returns.name)).concat(returnsField);
  const combined = await run({ ...basePayload, visualId: 'regression_combined_measures', fields: combinedFields });
  [cost.name, returns.name, 'Qtde Vendas Líquida', 'Preço Compras base'].forEach((name) => {
    assert(Object.prototype.hasOwnProperty.call(combined.rows[0], name), 'Medida ausente na combinação: ' + name);
  });

  const reversed = await run({ ...basePayload, visualId: 'regression_reversed_fields', fields: combinedFields.slice().reverse() });
  assertSameValues(combined.rows, reversed.rows, keyField.name, [cost.name, returns.name, oldMeasure.name], 'Reordenação de medidas');

  const matrix = await run({
    ...basePayload,
    visualId: 'regression_matrix',
    visualization: 'matrix',
    value: cost.name,
    fields: [keyField, costField, returnsField],
    matrixRows: [keyField.instanceId || keyField.name],
    matrixColumns: [],
    matrixValues: [costField.instanceId || costField.name, returns.name]
  });
  assert(matrix.rows.length > 0 && Object.prototype.hasOwnProperty.call(matrix.rows[0], cost.name) && Object.prototype.hasOwnProperty.call(matrix.rows[0], returns.name), 'Matriz não retornou as duas medidas.');

  const card = await run({
    ...basePayload,
    visualId: 'regression_card_cost',
    visualization: 'card',
    dimension: '',
    value: cost.name,
    fields: [costField],
    page: undefined,
    pageSize: undefined,
    deferTotals: false,
    limit: 1
  });
  const cardTotal = number(card.rows[0] && card.rows[0][cost.name]);
  assert(cardTotal !== null, 'Card de Custo não retornou total numérico.');

  const totals = await run({
    ...basePayload,
    visualId: 'regression_cost_totals',
    visualization: 'table',
    dimension: keyField.name,
    value: cost.name,
    fields: simpleCostFields,
    totalsOnly: true,
    deferTotals: false
  });
  const tableTotal = number(totals.totals && totals.totals[cost.name]);
  assert(tableTotal !== null, 'Total autoritativo de Custo não foi retornado: ' + JSON.stringify(totals));
  assert(Math.abs(tableTotal - cardTotal) <= Math.max(0.01, Math.abs(cardTotal) * 1e-9), 'Total da Tabela diverge da avaliação direta da medida Custo.');

  const companyTotals = [];
  for (const company of companies.slice(0, 2)) {
    const filteredCard = await run({
      ...basePayload,
      visualId: 'regression_filter_' + canonical(company).replace(/[^a-z0-9]+/g, '_'),
      visualization: 'card',
      dimension: '',
      value: cost.name,
      fields: [costField],
      filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: String(company) },
      deferTotals: false,
      limit: 1
    });
    const total = number(filteredCard.rows[0] && filteredCard.rows[0][cost.name]);
    assert(total !== null, 'Custo não foi avaliada para o filtro ' + company);
    companyTotals.push({ company, total });
  }
  assert.notStrictEqual(companyTotals[0].total, companyTotals[1].total, 'O filtro Empresa não alterou o contexto de Custo.');

  const draft = JSON.parse(JSON.stringify(model));
  const genericName = 'Iterador Genérico __regressão visual';
  draft.measures.push({ name: genericName, displayName: genericName, table: cost.table, formula: cost.formula });
  const genericField = { name: genericName, table: cost.table, type: 'measure', measureId: genericName };
  const generic = await run({
    ...basePayload,
    visualId: 'regression_generic_iterator',
    model: draft,
    fields: [keyField, { name: oldMeasure.name, table: oldMeasure.table, type: 'measure', measureId: oldMeasure.name }, genericField]
  });
  assert(generic.rows.length > 0 && generic.rows.some((row) => number(row[genericName]) !== null), 'A correção ficou específica para o nome Custo.');

  const publishedRun = await request('/api/reports/' + report.id + '/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: String(companies[0]) },
      crossFilters: [],
      pageId: visual.pageId || 'page_1'
    })
  });
  const publishedResult = publishedRun.result || publishedRun;
  const publishedVisual = (publishedResult.visualResults || []).find((item) => String(item.id) === String(visual.id));
  assert(publishedVisual && !publishedVisual.error, 'A versão salva/publicada do Gerencial falhou ao executar Custo.');
  assert(publishedVisual.rows.length > 0, 'A versão salva/publicada do Gerencial não retornou linhas.');
  assert(Object.prototype.hasOwnProperty.call(publishedVisual.rows[0], cost.name), 'A versão salva/publicada não retornou a coluna Custo.');
  assert(publishedVisual.rows.some((row) => number(row[cost.name]) !== null), 'A versão salva/publicada não retornou valores de Custo.');

  const onlineReports = reportsFrom(await request('/api/reports', { headers }));
  const reloaded = onlineReports.find((item) => String(item.id) === String(report.id));
  const reloadedVisual = reloaded && (reloaded.visuals || []).find((item) => String(item.id) === String(visual.id));
  assert(reloadedVisual && (reloadedVisual.selectedFields || []).some((field) => canonical(field.name) === 'custo'), 'Reabrir o relatório não preservou Custo na Tabela.');

  assert.strictEqual(hash(modelPath), before.model, 'A suíte alterou o modelo persistido.');
  assert.strictEqual(hash(reportPath), before.reports, 'A suíte alterou relatórios persistidos.');
  console.log(JSON.stringify({
    ok: true,
    tableRows: added.rows.length,
    simpleRows: simpleCost.rows.length,
    matrixRows: matrix.rows.length,
    cardTotal,
    tableTotal,
    companyTotals,
    realReportFilterContext: {
      month: currentMonthName,
      year: String(new Date().getFullYear()),
      rowCount: fullReportContext.rows.length,
      serverMs: fullReportContext.performance.totalServerMs,
      queryBuildCount: fullReportContext.performance.queryBuildCount
    },
    tableServerMs: added.performance.totalServerMs,
    configuredMeasures: combinedFields.filter((field) => String(field.type).toLowerCase() === 'measure').map((field) => field.name),
    genericMeasure: genericName,
    publishedReportRows: publishedVisual.rows.length,
    persistence: 'inalterada'
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
