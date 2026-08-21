const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..');
const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
const savedModel = JSON.parse(fs.readFileSync(path.join(root, 'data', 'semantic_model.json'), 'utf8'));
const reports = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reports.json'), 'utf8'));
const transforms = JSON.parse(fs.readFileSync(path.join(root, 'data', 'transform_queries.json'), 'utf8'));
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const canonical = (value) => String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
const number = (value) => value === null || value === undefined || value === '' ? null : Number(value);
const closeTo = (actual, expected, tolerance = 1e-8) => Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
const quoteIdent = (value) => '"' + String(value || '').replace(/"/g, '""') + '"';

async function request(route, options = {}) {
  const response = await fetch(baseUrl + route, { ...options, signal: options.signal || AbortSignal.timeout(60000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  if (!response.ok) throw new Error(route + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return body;
}

function pgConfig() {
  if (process.env.BIWA_PG_CACHE_DATABASE_URL) return { connectionString: process.env.BIWA_PG_CACHE_DATABASE_URL };
  return {
    host: process.env.BIWA_PG_CACHE_HOST || '127.0.0.1',
    port: Number(process.env.BIWA_PG_CACHE_PORT || 5432),
    database: process.env.BIWA_PG_CACHE_DATABASE || process.env.BIWA_PG_CACHE_DB || 'bi_wa_cache',
    user: process.env.BIWA_PG_CACHE_USER || process.env.BIWA_PG_CACHE_USERNAME || 'postgres',
    password: process.env.BIWA_PG_CACHE_PASSWORD
  };
}

async function main() {
  const access = settings.access || {};
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: access.adminUser, password: access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };

  const gerencial = reports.find((report) => canonical(report.name || report.title) === 'gerencial');
  assert(gerencial, 'Relatorio Gerencial nao encontrado.');
  const baseVisual = (gerencial.visuals || []).find((visual) => (visual.selectedFields || []).some((field) => canonical(field.name) === 'valor compras 1 e 3'));
  assert(baseVisual, 'Visual base do Gerencial nao encontrado.');
  const dimensionField = (baseVisual.selectedFields || []).find((field) => canonical(field.type) !== 'measure');
  assert(dimensionField, 'Dimensao do visual Gerencial nao encontrada.');

  const priceMeasure = (savedModel.measures || []).find((measure) => canonical(measure.name) === 'preco medio compras');
  const valueMeasure = (savedModel.measures || []).find((measure) => canonical(measure.name) === 'valor compras 1 e 3');
  const quantityMeasure = (savedModel.measures || []).find((measure) => canonical(measure.name) === 'qtde liquido 1 e 3');
  assert(priceMeasure && valueMeasure && quantityMeasure, 'Medidas do preco medio nao foram localizadas no modelo salvo.');
  assert(/^DIVIDE\s*\(/i.test(priceMeasure.formula || ''), 'Preco Medio Compras precisa usar DIVIDE.');
  assert((priceMeasure.formula || '').includes('[' + valueMeasure.name + ']'), 'Numerador da medida nao foi preservado.');
  assert((priceMeasure.formula || '').includes('[' + quantityMeasure.name + ']'), 'Denominador da medida nao foi preservado.');
  assert(/,\s*0\s*\)$/s.test(priceMeasure.formula || ''), 'DIVIDE precisa retornar zero para denominador zero/em branco.');

  const loadedModelResponse = await request('/api/model', { headers });
  const loadedPrice = (loadedModelResponse.model.measures || []).find((measure) => canonical(measure.name) === 'preco medio compras');
  assert(loadedPrice && loadedPrice.formula === priceMeasure.formula, 'A formula nao foi recarregada do modelo persistido.');

  const companyFilter = (gerencial.onlineFilters || []).find((filter) => canonical(filter.field) === 'fantasia');
  assert(companyFilter, 'Filtro Empresa do Gerencial nao encontrado.');
  const companyOptions = await request('/api/filter-options?table=' + encodeURIComponent(companyFilter.table) + '&field=' + encodeURIComponent(companyFilter.field), { headers });
  const companies = (companyOptions.values || []).filter((value) => /(?:CD|LOJA)$/i.test(String(value)));
  assert(companies.length >= 2, 'As opcoes CD/LOJA do filtro Empresa nao estao disponiveis.');

  async function runPriceVisual(visualization, company, model = savedModel, extraFields = []) {
    const fields = [
      dimensionField,
      { name: valueMeasure.name, table: valueMeasure.table, type: 'measure' },
      { name: quantityMeasure.name, table: quantityMeasure.table, type: 'measure' },
      { name: priceMeasure.name, table: priceMeasure.table, type: 'measure' },
      ...extraFields
    ];
    return request('/api/visual-query', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        table: priceMeasure.table,
        visualization,
        dimension: dimensionField.name,
        value: priceMeasure.name,
        fields,
        aggregation: 'SUM',
        order: 'DESC',
        limit: 1000,
        onlineFilters: gerencial.onlineFilters || [],
        filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: company },
        pageId: 'page_1',
        model
      })
    });
  }

  const priceResults = [];
  for (const company of companies.slice(0, 2)) {
    const result = await runPriceVisual('table', company);
    assert(Array.isArray(result.rows) && result.rows.length > 0, 'Preco medio sem linhas para ' + company + '.');
    let zeroDenominators = 0;
    let regularCalculations = 0;
    for (const row of result.rows) {
      const value = number(row[valueMeasure.name]);
      const quantity = number(row[quantityMeasure.name]);
      const price = number(row[priceMeasure.name]);
      if (quantity === null || quantity === 0) {
        zeroDenominators += 1;
        assert(price === 0, 'DIVIDE nao retornou zero para denominador zero/em branco.');
      } else {
        regularCalculations += 1;
        assert(price !== null && closeTo(price, (value || 0) / quantity), 'Preco medio divergente para ' + row[dimensionField.name] + '.');
      }
    }
    assert(zeroDenominators > 0, 'O conjunto real nao exercitou divisao por zero para ' + company + '.');
    assert(regularCalculations > 0, 'O conjunto real nao exercitou calculo normal para ' + company + '.');
    const totalValue = number(result.totals && result.totals[valueMeasure.name]);
    const totalQuantity = number(result.totals && result.totals[quantityMeasure.name]);
    const totalPrice = number(result.totals && result.totals[priceMeasure.name]);
    const expectedTotal = !totalQuantity ? 0 : (totalValue || 0) / totalQuantity;
    assert(totalPrice !== null && closeTo(totalPrice, expectedTotal), 'Total do preco medio divergente para ' + company + '.');
    priceResults.push({ company, rows: result.rows.length, total: totalPrice, zeroDenominators });
  }
  assert(priceResults[0].total !== priceResults[1].total, 'O contexto do filtro Empresa nao afetou a medida.');

  const matrixPrice = await runPriceVisual('matrix', companies[0]);
  assert(Array.isArray(matrixPrice.rows) && matrixPrice.rows.length > 0, 'Preco medio falhou no visual matriz.');

  const blankModel = JSON.parse(JSON.stringify(savedModel));
  const testMeasures = [
    ['Teste Numerador Vazio', 'BLANK()'],
    ['Teste Denominador Vazio', 'BLANK()'],
    ['Teste Denominador Zero', '[' + valueMeasure.name + '] - [' + valueMeasure.name + ']'],
    ['Teste Divisao Zero', 'DIVIDE([' + valueMeasure.name + '], [Teste Denominador Zero], 0)'],
    ['Teste Divisao Den Vazio', 'DIVIDE([' + valueMeasure.name + '], [Teste Denominador Vazio], 0)'],
    ['Teste Divisao Num Vazio', 'DIVIDE([Teste Numerador Vazio], [' + quantityMeasure.name + '], 0)']
  ];
  for (const [name, formula] of testMeasures) blankModel.measures.push({ table: priceMeasure.table, name, displayName: name, formula, format: '', decimals: 2 });
  const blankFields = testMeasures.slice(3).map(([name]) => ({ name, table: priceMeasure.table, type: 'measure' }));
  const blankResult = await runPriceVisual('table', companies[0], blankModel, blankFields);
  for (const row of blankResult.rows) {
    assert(number(row['Teste Divisao Zero']) === 0, 'DIVIDE por zero nao usou o valor alternativo.');
    assert(number(row['Teste Divisao Den Vazio']) === 0, 'DIVIDE por denominador vazio nao usou o valor alternativo.');
    const quantity = number(row[quantityMeasure.name]);
    if (quantity) assert(row['Teste Divisao Num Vazio'] === null, 'Numerador vazio valido foi convertido indevidamente em erro/zero.');
    else assert(number(row['Teste Divisao Num Vazio']) === 0, 'Numerador e denominador vazios/zero nao usaram o alternativo.');
  }

  const combinedTransform = transforms.find((transform) => canonical(transform.name) === 'faturamento e recebimento');
  const costsTransform = transforms.find((transform) => canonical(transform.name) === 'tabela custos');
  assert(combinedTransform && combinedTransform.daxExpression, 'Faturamento e Recebimento nao e uma tabela calculada DAX.');
  assert(costsTransform && costsTransform.daxExpression, 'Tabela Custos nao e uma tabela calculada DAX.');
  const costStep = (combinedTransform.steps || []).find((step) => canonical(step.newName) === 'custos produtos');
  assert(costStep && costStep.kind === 'daxColumn', 'Custos Produtos nao foi salva como coluna calculada.');
  assert(/^Custos Produtos\s*=\s*LOOKUPVALUE\b/i.test(costStep.expression || ''), 'A coluna persistida nao usa LOOKUPVALUE.');
  assert(/'Tabela Custos'\[Empresa\][\s\S]*'Faturamento e Recebimento'\[Empresa\]/i.test(costStep.expression || ''), 'A busca de custo nao diferencia a empresa.');
  assert(/'Tabela Custos'\[Codigo Produto\][\s\S]*'Faturamento e Recebimento'\[Código Produto\]/i.test(costStep.expression || ''), 'A busca de custo nao preserva o codigo textual do produto.');

  const modelingTest = await request('/api/transforms/modeling/test', {
    method: 'POST',
    headers,
    body: JSON.stringify({ source: combinedTransform.name, steps: combinedTransform.steps, formula: costStep.expression, limit: 20 })
  });
  assert(modelingTest.valid === true, 'O editor nao validou a coluna Custos Produtos.');
  assert((modelingTest.preview.columns || []).includes('Custos Produtos'), 'A previa nao inclui Custos Produtos.');
  assert((modelingTest.preview.rows || []).some((row) => row['Custos Produtos'] !== null), 'A busca real nao retornou nenhum custo.');
  assert(/dax_lookup_/i.test(modelingTest.preview.sql || ''), 'LOOKUPVALUE nao foi compilado como busca agrupada.');
  assert(/CAST\([^)]*Empresa[^)]* AS TEXT\)/i.test(modelingTest.preview.sql || ''), 'LOOKUPVALUE nao compara a empresa.');
  assert(/Codigo Produto|Código Produto/i.test(modelingTest.preview.sql || ''), 'LOOKUPVALUE nao compara o codigo do produto.');
  assert(/COUNT\(DISTINCT/i.test(modelingTest.preview.sql || ''), 'SELECTEDVALUE nao detecta valores duplicados/conflitantes.');

  const columnsResult = await request('/api/tables/' + encodeURIComponent(combinedTransform.name) + '/columns', { headers });
  const costColumn = (columnsResult.columns || []).find((column) => canonical(column.name) === 'custos produtos');
  assert(costColumn && /numeric|decimal/i.test(costColumn.dataType || costColumn.columnType || costColumn.pgType), 'Custos Produtos nao foi recarregada como coluna numerica.');

  async function runCostVisual(visualization) {
    return request('/api/visual-query', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        table: combinedTransform.name,
        visualization,
        dimension: dimensionField.name,
        value: costColumn.name,
        fields: [dimensionField, { name: costColumn.name, table: combinedTransform.name, type: 'Numero Decimal', aggregation: 'MAX' }],
        aggregation: 'MAX',
        order: 'DESC',
        limit: 100,
        onlineFilters: gerencial.onlineFilters || [],
        filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: companies[0] },
        pageId: 'page_1',
        model: savedModel
      })
    });
  }
  for (const visualization of ['table', 'matrix']) {
    const result = await runCostVisual(visualization);
    assert(Array.isArray(result.rows) && result.rows.some((row) => row[costColumn.name] !== null), 'Custos Produtos falhou no visual ' + visualization + '.');
  }

  const filterValues = await request('/api/filter-options?table=' + encodeURIComponent(combinedTransform.name) + '&field=' + encodeURIComponent(costColumn.name), { headers });
  assert(Array.isArray(filterValues.values) && filterValues.values.length > 0, 'Custos Produtos nao esta disponivel em filtros.');

  const pool = new Pool(pgConfig());
  try {
    const schema = process.env.BIWA_PG_CACHE_SCHEMA || 'biwa_cache';
    const combinedViewResult = await pool.query(
      "SELECT c.table_name FROM information_schema.columns c " +
      "WHERE c.table_schema = $1 AND c.column_name = 'Custos Produtos' AND c.table_name LIKE 'dax_%' " +
      "AND pg_get_viewdef(format('%I.%I', c.table_schema, c.table_name)::regclass, true) ILIKE '%dax_lookup_%' " +
      "ORDER BY c.table_name DESC",
      [schema]
    );
    assert(combinedViewResult.rows.length >= 1, 'A view calculada vigente de Custos Produtos nao foi identificada.');
    const combinedView = quoteIdent(schema) + '.' + quoteIdent(combinedViewResult.rows[0].table_name);
    const costViewResult = await pool.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'Valor Custo' AND table_name LIKE 'dax_%'",
      [schema]
    );
    assert(costViewResult.rows.length >= 1, 'A view calculada da Tabela Custos nao foi encontrada.');
    const costView = quoteIdent(schema) + '.' + quoteIdent(costViewResult.rows[0].table_name);

    const duplicateResult = await pool.query(
      'WITH grouped AS (SELECT NULLIF(BTRIM(CAST("Chave" AS TEXT)), \'\') AS key, COUNT(*) AS rows, ' +
      'COUNT(DISTINCT "Valor Custo") AS costs, COUNT(*) FILTER (WHERE "Valor Custo" IS NULL) AS blanks ' +
      'FROM ' + costView + ' GROUP BY 1) SELECT ' +
      'COUNT(*) FILTER (WHERE rows > 1 AND costs = 1 AND blanks = 0) AS duplicate_same, ' +
      'COUNT(*) FILTER (WHERE costs > 1 OR (costs = 1 AND blanks > 0)) AS conflicting FROM grouped'
    );
    assert(Number(duplicateResult.rows[0].duplicate_same) > 0, 'O caso real de chave repetida com mesmo custo nao foi exercitado.');
    assert(Number(duplicateResult.rows[0].conflicting) > 0, 'O caso real de chave repetida com custos conflitantes nao foi exercitado.');

    const missingKeyResult = await pool.query(
      'SELECT DISTINCT base."Chave" AS key FROM ' + combinedView + ' base WHERE base."Chave" IS NOT NULL AND NOT EXISTS (' +
      'SELECT 1 FROM ' + costView + ' lookup WHERE BTRIM(CAST(lookup."Chave" AS TEXT)) = BTRIM(CAST(base."Chave" AS TEXT))) LIMIT 1'
    );
    assert(missingKeyResult.rows.length === 1, 'O conjunto real nao possui chave sem custo para validar.');
    const missingKey = String(missingKeyResult.rows[0].key);
    const product203Result = await pool.query(
      'SELECT CAST("Empresa" AS TEXT) AS company, BTRIM(CAST("Código Produto" AS TEXT)) AS product_code, ' +
      'MIN("Custos Produtos") AS min_cost, MAX("Custos Produtos") AS max_cost, COUNT("Custos Produtos") AS nonblank ' +
      'FROM ' + combinedView + ' WHERE BTRIM(CAST("Código Produto" AS TEXT)) IN ($1, $2) ' +
      'GROUP BY 1, 2 ORDER BY 1, 2',
      ['203', '000203']
    );
    const product203Cases = new Map(product203Result.rows.map((row) => [row.company + ':' + row.product_code, row]));
    assert(product203Cases.has('1:203') && Number(product203Cases.get('1:203').min_cost) === 8 && Number(product203Cases.get('1:203').max_cost) === 8, 'ALHO IMPORTADO N 8 (empresa 1, codigo 203) nao retornou custo 8.');
    assert(product203Cases.has('3:203') && Number(product203Cases.get('3:203').min_cost) === 9 && Number(product203Cases.get('3:203').max_cost) === 9, 'ALHO IMPORTADO N 8 (empresa 3, codigo 203) nao preservou o custo da empresa 3.');
    assert(product203Cases.has('1:000203') && Number(product203Cases.get('1:000203').min_cost) === 0, 'O codigo textual 000203 foi confundido com o produto 203 na empresa 1.');

    const missingKeyCostResult = await pool.query(
      'SELECT COUNT("Custos Produtos") AS nonblank FROM ' + combinedView + ' WHERE "Chave" = $1',
      [missingKey]
    );
    assert(Number(missingKeyCostResult.rows[0].nonblank) === 0, 'Produto inexistente na tabela de custos nao retornou vazio.');

    const normalizationResult = await pool.query(
      "WITH values_to_compare AS (SELECT ' 00125.000 '::text AS text_key, 125::numeric AS numeric_key, '   '::text AS blank_key) " +
      "SELECT ('N:' || TRIM_SCALE(BTRIM(text_key)::numeric)::text) = ('N:' || TRIM_SCALE(numeric_key)::text) AS compatible, " +
      "NULLIF(BTRIM(blank_key), '') IS NULL AS blank_is_null FROM values_to_compare"
    );
    assert(normalizationResult.rows[0].compatible === true, 'Chaves texto/numero com espacos nao foram normalizadas igualmente.');
    assert(normalizationResult.rows[0].blank_is_null === true, 'Chave vazia nao foi tratada como nula.');

    const viewKindResult = await pool.query(
      'SELECT table_type FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
      [schema, combinedViewResult.rows[0].table_name]
    );
    assert(viewKindResult.rows[0] && viewKindResult.rows[0].table_type === 'VIEW', 'Custos Produtos foi materializada e nao acompanhara a atualizacao das fontes.');
  } finally {
    await pool.end();
  }

  const mcCompany = companies.find((company) => /CD$/i.test(String(company))) || companies[0];
  const mcResponse = await request('/api/reports/' + gerencial.id + '/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: String(mcCompany) },
      crossFilters: [],
      pageId: 'page_1'
    })
  });
  const mcResult = mcResponse.result || mcResponse;
  const mcVisual = (mcResult.visualResults || []).find((visual) => visual && visual.id === baseVisual.id) || (mcResult.visualResults || [])[0];
  assert(mcVisual && !mcVisual.error, 'O visual principal da pagina MC nao foi executado.');
  const garlicVisual = await request('/api/visual-query', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      table: baseVisual.table,
      visualId: baseVisual.id + '_produto_203',
      pageId: baseVisual.pageId || 'page_1',
      visualization: 'table',
      dimension: baseVisual.dimension || 'Código e Produto',
      value: baseVisual.value || '',
      fields: baseVisual.selectedFields || [],
      aggregation: baseVisual.aggregation || 'SUM',
      order: baseVisual.order || 'DESC',
      limit: 50,
      page: 1,
      pageSize: 50,
      deferTotals: true,
      visualFilters: baseVisual.visualFilters || [],
      filterColumn: 'Código e Produto',
      filterOperator: 'LIKE',
      filterValue: 'ALHO IMPORTADO N 8',
      pageFilters: gerencial.pageFilters || [],
      allPagesFilters: gerencial.allPagesFilters || [],
      onlineFilters: gerencial.onlineFilters || [],
      filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: String(mcCompany) },
      model: savedModel
    })
  });
  const garlic203 = (garlicVisual.rows || []).find((row) => /ALHO IMPORTADO N 8\s+-\s+203/i.test(String(row['Código e Produto'] || '')));
  assert(garlic203, 'ALHO IMPORTADO N 8 - 203 nao apareceu no visual da pagina MC.');
  assert(closeTo(number(garlic203['Preço Compras base']), 8), 'O visual MC nao exibiu custo 8 para ALHO IMPORTADO N 8 - 203.');

  const reloadedTransforms = await request('/api/transforms', { headers });
  const reloadedList = Array.isArray(reloadedTransforms) ? reloadedTransforms : (reloadedTransforms.transforms || []);
  const reloadedCombined = reloadedList.find((transform) => canonical(transform.name) === 'faturamento e recebimento');
  assert(reloadedCombined && (reloadedCombined.steps || []).some((step) => canonical(step.newName) === 'custos produtos'), 'A coluna desapareceu ao recarregar as transformacoes.');

  assert(serverSource.includes('function pgDaxNormalizedLookupKeySql(valueSql)'), 'Normalizacao de chave nao esta no motor.');
  assert(serverSource.includes('var targetMeta = await getPgEffectiveMeta(filterTable);'), 'CALCULATE ainda nao resolve tabelas calculadas DAX.');
  assert(serverSource.includes('stripBalancedOuterParens(expandDaxVariables(expression))'), 'VAR/RETURN nao e aplicado a colunas calculadas.');

  console.log(JSON.stringify({
    ok: true,
    priceResults,
    matrixRows: matrixPrice.rows.length,
    costPreviewRows: modelingTest.preview.rows.length,
    costFilterValues: filterValues.values.length,
    product203: { company: mcCompany, cost: number(garlic203['Preço Compras base']) },
    persisted: true,
    reportsCovered: ['Gerencial'],
    visualsCovered: ['table', 'matrix']
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
