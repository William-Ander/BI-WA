const fs = require('fs');
const path = require('path');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
const access = settings.access || {};

async function main() {
  const loginResponse = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: access.adminUser,
      password: access.adminPassword,
      accessMode: 'admin'
    })
  });
  if (!loginResponse.ok) throw new Error('login HTTP ' + loginResponse.status);
  const login = await loginResponse.json();
  const gerencial = reports.find((report) => String(report.name || report.title || '').toLowerCase() === 'gerencial');
  const runtimeFilters = {};
  const companyFilter = gerencial && (gerencial.onlineFilters || []).find((filter) => filter.field === 'Fantasia');
  if (companyFilter) {
    const optionsResponse = await fetch(baseUrl + '/api/filter-options?table=' + encodeURIComponent(companyFilter.table) + '&field=' + encodeURIComponent(companyFilter.field), {
      headers: { authorization: 'Bearer ' + login.token }
    });
    const options = await optionsResponse.json();
    if (Array.isArray(options.values) && options.values.length) runtimeFilters[companyFilter.id || companyFilter.key] = String(options.values[0]);
  }
  const testModel = JSON.parse(JSON.stringify(model));
  testModel.measures = Array.isArray(testModel.measures) ? testModel.measures : [];
  if (!testModel.measures.some((item) => item.name === 'Valor compras 1 e 3')) {
    testModel.measures.push({
      id: 'measure_test_valor_compras_1_3',
      name: 'Valor compras 1 e 3',
      displayName: 'Valor compras 1 e 3',
      table: 'Faturamento e Recebimento',
      formula: '[Valor Compras Liquida com Frete] + [Valor Liquido trasf]',
      format: 'decimal'
    });
  }
  const startedAt = Date.now();
  const response = await fetch(baseUrl + '/api/visual-query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + login.token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      table: 'Faturamento e Recebimento',
      visualization: 'table',
      dimension: 'Código e Produto',
      value: 'Valor compras 1 e 3',
      fields: [
        { name: 'Código e Produto', table: 'Faturamento e Recebimento', type: 'Texto' },
        { name: 'Valor Compras Liquida com Frete', table: 'Faturamento e Recebimento', type: 'measure' },
        { name: 'Valor Liquido trasf', table: 'Faturamento e Recebimento', type: 'measure' },
        { name: 'Valor compras 1 e 3', table: 'Faturamento e Recebimento', type: 'measure' }
      ],
      aggregation: 'SUM',
      order: 'DESC',
      limit: 1000,
      onlineFilters: gerencial && gerencial.onlineFilters || [],
      filters: runtimeFilters,
      pageId: 'page_1',
      model: testModel
    })
  });
  const body = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (error) {}
  if (process.env.BIWA_DIAG_SQL_FILE && parsed && parsed.sql) {
    fs.writeFileSync(path.resolve(process.env.BIWA_DIAG_SQL_FILE), parsed.sql, 'utf8');
  }
  const numericDifferences = parsed && Array.isArray(parsed.rows) ? parsed.rows.map((row) => Math.abs(
    Number(row['Valor compras 1 e 3'] || 0)
      - (Number(row['Valor Compras Liquida com Frete'] || 0) + Number(row['Valor Liquido trasf'] || 0))
  )).filter(Number.isFinite) : [];
  console.log(JSON.stringify({
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    bytes: body.length,
    rows: parsed && Array.isArray(parsed.rows) ? parsed.rows.length : null,
    maxFormulaDifference: numericDifferences.length ? Math.max(...numericDifferences) : null,
    sqlChars: parsed && parsed.sql ? parsed.sql.length : 0,
    sql: parsed && parsed.sql || '',
    preview: body.slice(0, 500)
  }));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
