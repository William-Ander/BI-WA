const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, { ...options, signal: AbortSignal.timeout(180000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  return { status: response.status, body };
}

async function main() {
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  if (login.status !== 200) throw new Error('Login falhou: ' + JSON.stringify(login.body));
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const cases = [
    {
      name: 'discount_columns_only',
      fields: [
        { name: 'Coluna1', table: 'Desconto Financeiro', type: 'text' },
        { name: 'Coluna2', table: 'Desconto Financeiro', type: 'number' }
      ],
      value: 'Coluna2'
    },
    {
      name: 'discount_columns_and_measure',
      fields: [
        { name: 'Coluna1', table: 'Desconto Financeiro', type: 'text' },
        { name: 'Coluna2', table: 'Desconto Financeiro', type: 'number' },
        { name: 'Descontado', table: 'Cliente e Fornecedor', type: 'measure', measureId: 'Descontado' }
      ],
      value: 'Descontado'
    }
  ];
  const output = [];
  for (const test of cases) {
    const result = await request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({
        table: 'Desconto Financeiro',
        visualId: '__diagnose_alias_' + test.name,
        visualization: 'table',
        dimension: 'Coluna1',
        value: test.value,
        fields: test.fields,
        aggregation: 'SUM',
        order: 'DESC',
        limit: 50,
        pageSize: 50,
        model
      })
    });
    output.push({ name: test.name, status: result.status, error: result.body.error || '', sql: result.body.sql || '', rows: Array.isArray(result.body.rows) ? result.body.rows.length : 0, data: result.body.rows || [] });
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
