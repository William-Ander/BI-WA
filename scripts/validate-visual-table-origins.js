const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const protectedFiles = ['data/reports.json', 'data/semantic_model.json', 'data/transform_queries.json', 'data/settings.json'];

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, { ...options, signal: options.signal || AbortSignal.timeout(60000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert(response.ok, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return { body, elapsedMs: performance.now() - startedAt };
}

function fieldFromColumn(table, column) {
  return {
    name: column.name,
    table,
    type: column.columnType || column.dataType || column.pgType || 'text',
    aggregation: 'NONE'
  };
}

async function main() {
  const hashesBefore = Object.fromEntries(protectedFiles.map((file) => [file, hash(file)]));
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const reportsValue = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
  const reports = Array.isArray(reportsValue) ? reportsValue : reportsValue.reports || [];
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const gerencial = reports.find((report) => /gerencial/i.test(String(report && report.name || '')));
  const companyFilter = gerencial && (gerencial.onlineFilters || []).find((filter) => String(filter.field || '').toLocaleLowerCase('pt-BR') === 'fantasia');
  assert(gerencial && companyFilter, 'Filtro Empresa do Relatório Gerencial não encontrado.');
  const companyOptions = await request('/api/filter-options?table=' + encodeURIComponent(companyFilter.table) + '&field=' + encodeURIComponent(companyFilter.field), { headers });
  const company = (companyOptions.body.values || [])[0];
  assert(company !== undefined, 'Nenhuma empresa disponível para o teste transformado.');
  const scenarios = [
    { origin: 'manual', table: 'Metas Empresa' },
    { origin: 'imported', table: 'Empresas', preferred: ['Empresa', 'Fantasia'] },
    { origin: 'transformed', table: 'Faturamento e Recebimento', preferred: ['Código e Produto'], measure: 'Valor Vendas', reportFilters: true }
  ];
  const results = [];

  for (const scenario of scenarios) {
    const columnsResult = await request('/api/tables/' + encodeURIComponent(scenario.table) + '/columns', { headers });
    const columns = Array.isArray(columnsResult.body.columns) ? columnsResult.body.columns : [];
    assert(columns.length >= (scenario.measure ? 1 : 2), scenario.origin + ': colunas insuficientes em ' + scenario.table + '.');
    const preferredColumns = (scenario.preferred || []).map((name) => columns.find((column) => column.name === name)).filter(Boolean);
    const physicalFields = preferredColumns.concat(columns.filter((column) => !preferredColumns.includes(column))).slice(0, scenario.measure ? 1 : 2).map((column) => fieldFromColumn(scenario.table, column));
    const measure = scenario.measure && (model.measures || []).find((item) => item.name === scenario.measure);
    if (scenario.measure) assert(measure, scenario.origin + ': medida ' + scenario.measure + ' não encontrada.');
    const addedField = measure
      ? { name: measure.name, displayName: measure.displayName || measure.name, table: measure.table, type: 'measure', fieldType: 'measure', semanticType: 'measure', measureId: measure.id || measure.name, id: measure.id || measure.name, aggregation: 'NONE' }
      : physicalFields[1];
    const baseField = physicalFields[0];
    const fields = [baseField, addedField];
    const payload = {
      table: scenario.table,
      visualId: 'origin_' + scenario.origin,
      pageId: 'page_1',
      visualization: 'table',
      dimension: baseField.name,
      value: measure ? measure.name : '',
      fields,
      aggregation: 'SUM',
      order: 'ASC',
      page: 1,
      pageSize: 100,
      deferTotals: true,
      limit: 100,
      filters: scenario.reportFilters ? { [companyFilter.id || companyFilter.key || companyFilter.field]: String(company) } : {},
      onlineFilters: scenario.reportFilters ? gerencial.onlineFilters || [] : [],
      visualFilters: [],
      pageFilters: [],
      allPagesFilters: [],
      model
    };
    const add = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(payload) });
    assert(Array.isArray(add.body.rows) && add.body.rows.length, scenario.origin + ': adicionar campo não retornou linhas.');
    assert(Object.prototype.hasOwnProperty.call(add.body.rows[0], addedField.name), scenario.origin + ': campo adicionado não chegou ao dataset.');
    assert(add.body.performance && add.body.performance.queryBuildCount === 1, scenario.origin + ': adição compilou mais de uma consulta.');

    const remove = await request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({ ...payload, visualId: 'origin_' + scenario.origin + '_remove', value: '', fields: [baseField] })
    });
    assert(Array.isArray(remove.body.rows) && remove.body.rows.length, scenario.origin + ': remoção perdeu os dados restantes.');
    assert(!Object.prototype.hasOwnProperty.call(remove.body.rows[0], addedField.name), scenario.origin + ': campo removido continuou no dataset.');
    assert(remove.body.performance && remove.body.performance.queryBuildCount === 1, scenario.origin + ': remoção compilou mais de uma consulta.');
    results.push({
      origin: scenario.origin,
      table: scenario.table,
      added: addedField.name,
      addMs: Number(add.elapsedMs.toFixed(2)),
      removeMs: Number(remove.elapsedMs.toFixed(2)),
      rows: add.body.rows.length
    });
  }

  for (const [file, before] of Object.entries(hashesBefore)) assert.strictEqual(hash(file), before, file + ' foi alterado pelo teste.');
  console.log(JSON.stringify({ ok: true, results, protectedFiles: 'inalterados' }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
