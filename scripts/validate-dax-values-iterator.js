const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const formula = `SUMX(
    KEEPFILTERS(
        VALUES('Faturamento e Recebimento'[Código Produto])
    ),
    CALCULATE(
        [Conversão vendas] * [Preço Médio Compras]
    )
)`;
const quantityFormula = `SUMX(
    KEEPFILTERS(
        VALUES('Faturamento e Recebimento'[Código Produto])
    ),
    CALCULATE(
        [Qtde Vendas Líquida] * [Preço Médio Compras]
    )
)`;

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function request(path, options, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert.strictEqual(response.status, expectedStatus, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return body;
}

async function main() {
  const server = fs.readFileSync('server.js', 'utf8');
  const app = fs.readFileSync('public/app.js', 'utf8');
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert(server.includes('function unwrapDaxKeepFiltersTableExpression'), 'O backend precisa desembrulhar KEEPFILTERS no argumento tabular.');
  assert(server.includes('function parseDaxValuesIterator'), 'O backend precisa reconhecer SUMX(KEEPFILTERS(VALUES(coluna)), expressão).');
  assert(server.includes("type: 'values'"), 'VALUES precisa ser aceito como fonte do iterador.');
  assert(server.includes('__BIWA_RUNTIME_FILTER_WHERE__'), 'Filtros precisam ser aplicados dentro da agregação por VALUES.');
  assert(server.includes("const tablePattern = new RegExp") && server.includes("'gi');"), 'Todas as ocorrências da fonte precisam ser reescritas para o cache PostgreSQL.');
  assert(app.includes('function findDaxMeasureDefinitionSeparator'), 'O editor precisa localizar o primeiro = válido da definição completa.');
  assert(app.includes("+ ' =\\n' + (previous.formula || '')"), 'A edição precisa reconstruir Nome = expressão no único editor.');
  assert(!html.includes('class="measure-formula-equals"'), 'O separador de nome não deve ocupar o campo da fórmula.');
  assert(!html.includes('id="measureFormulaEditorTitle"'), 'A faixa adicional Nova medida DAX não pode existir no editor ativo.');
  assert(html.includes('id="ribbonMeasureName" type="hidden"'), 'O nome separado deve permanecer apenas como compatibilidade interna.');
  assert(html.includes('placeholder="Nome da Medida = expressão DAX"'), 'O editor precisa orientar a definição DAX completa em um único campo.');

  const reportHash = hash('data/reports.json');
  const modelHash = hash('data/semantic_model.json');
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: settings.access.adminUser,
      password: settings.access.adminPassword,
      accessMode: 'admin'
    })
  });
  const headers = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
  const draft = JSON.parse(JSON.stringify(model));
  const name = 'Custo __regressao_values';
  draft.measures = Array.isArray(draft.measures) ? draft.measures : [];
  draft.measures.push({ name, displayName: name, table: 'Faturamento e Recebimento', formula });
  const quantityName = 'Custo Qtde __regressao_values';
  draft.measures.push({ name: quantityName, displayName: quantityName, table: 'Faturamento e Recebimento', formula: quantityFormula });

  const validation = await request('/api/model/measures/validate', {
    method: 'POST', headers, body: JSON.stringify({ model: draft, measureName: name })
  });
  assert(validation.diagnostic.valid, 'A medida Custo deveria ser válida.');
  assert.deepStrictEqual(validation.diagnostic.dependencies, ['Conversão vendas', 'Preço Médio Compras']);
  assert.deepStrictEqual(validation.diagnostic.tables, ['Faturamento e Recebimento']);

  const quantityValidation = await request('/api/model/measures/validate', {
    method: 'POST', headers, body: JSON.stringify({ model: draft, measureName: quantityName })
  });
  assert(quantityValidation.diagnostic.valid, 'A variante com Qtde Vendas Líquida deveria ser válida.');
  assert.deepStrictEqual(quantityValidation.diagnostic.dependencies, ['Qtde Vendas Líquida', 'Preço Médio Compras']);
  assert.deepStrictEqual(quantityValidation.diagnostic.tables, ['Faturamento e Recebimento']);

  const visual = await request('/api/visual-query', {
    method: 'POST', headers,
    body: JSON.stringify({
      table: 'Faturamento e Recebimento',
      visualization: 'table',
      dimension: 'Código Produto',
      value: name,
      fields: [
        { name: 'Código Produto', table: 'Faturamento e Recebimento', type: 'text' },
        { name, table: 'Faturamento e Recebimento', type: 'measure' }
      ],
      pageFilters: [{ table: 'Faturamento e Recebimento', column: 'Empresa', values: ['1'] }],
      aggregation: 'SUM',
      page: 1,
      pageSize: 25,
      deferTotals: true,
      limit: 25,
      model: draft
    })
  });
  assert(Array.isArray(visual.rows) && visual.rows.length > 0, 'O visual com Custo não retornou linhas.');
  assert(visual.rows.every((row) => Number.isFinite(Number(row[name]))), 'A medida Custo retornou valor não numérico.');
  assert(String(visual.sql || '').includes('__biwa_values_iterator_value'), 'A consulta não utilizou a agregação em dois níveis por produto.');

  assert.strictEqual(hash('data/reports.json'), reportHash, 'A validação alterou relatórios salvos.');
  assert.strictEqual(hash('data/semantic_model.json'), modelHash, 'A validação alterou o modelo salvo.');
  console.log('OK: editor DAX único e SUMX(KEEPFILTERS(VALUES(...)), CALCULATE(...)) validados/executados com filtros.');
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
