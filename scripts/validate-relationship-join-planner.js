const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();
const { Client } = require('pg');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const protectedFiles = ['data/reports.json', 'data/semantic_model.json', 'data/transform_queries.json', 'data/settings.json'];

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function quote(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }
function closeEnough(actual, expected) {
  const scale = Math.max(1, Math.abs(Number(expected)));
  return Math.abs(Number(actual) - Number(expected)) <= scale * 1e-9;
}

async function request(path, options = {}, expectedStatus = 200) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, { ...options, signal: AbortSignal.timeout(180000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert.strictEqual(response.status, expectedStatus, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 1200)));
  return { body, elapsedMs: Number((performance.now() - startedAt).toFixed(1)) };
}

function assertValidJoinSql(sql, label) {
  const source = String(sql || '');
  assert(source, label + ': SQL ausente.');
  assert(!/CROSS\s+JOIN/i.test(source), label + ': CROSS JOIN indevido.');
  const referenced = new Set([...source.matchAll(/\b(t\d+)\s*\./g)].map((match) => match[1]));
  for (const alias of referenced) {
    const declaration = new RegExp('(?:FROM|JOIN)\\s+[\\s\\S]{1,160}?\\s' + alias + '\\s+(?:ON|WHERE|GROUP|LEFT|RIGHT|INNER|JOIN|/\\*)', 'i');
    assert(declaration.test(source), label + ': alias ' + alias + ' foi referenciado sem fonte no mesmo plano.');
  }
  assert(!/JOIN\s+`Cliente e Fornecedor`\s+t\d+[\s\S]*JOIN\s+`Cliente e Fornecedor`\s+t\d+/i.test(source), label + ': JOIN duplicado de Cliente e Fornecedor.');
  assert(!/SELECT\s+DISTINCT\s+\*\s+FROM\s+`Faturamento e Recebimento`/i.test(source), label + ': tabela fato foi deduplicada com DISTINCT *.');
}

async function independentExpected() {
  const client = new Client(process.env.BIWA_PG_CACHE_URL || process.env.DATABASE_URL || {
    host: process.env.BIWA_PG_CACHE_HOST || '127.0.0.1',
    port: Number(process.env.BIWA_PG_CACHE_PORT || 5432),
    database: process.env.BIWA_PG_CACHE_DATABASE || 'bi_wa_cache',
    user: process.env.BIWA_PG_CACHE_USER || 'biwa_cache',
    password: process.env.BIWA_PG_CACHE_PASSWORD || 'biwa_cache'
  });
  await client.connect();
  try {
    const schema = process.env.BIWA_PG_CACHE_SCHEMA || 'biwa_cache';
    async function tableWithColumns(requiredColumns, allowedValues, valueColumn) {
      const result = await client.query(`
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = $1
        GROUP BY table_name
        HAVING ARRAY_AGG(column_name)::text[] @> $2::text[]
        ORDER BY CASE WHEN table_name LIKE 'dax_%' THEN 0 ELSE 1 END, table_name
      `, [schema, requiredColumns]);
      assert(result.rows[0], 'Tabela de cache não encontrada para: ' + requiredColumns.join(', '));
      if (allowedValues && valueColumn) {
        const allowed = new Set(allowedValues.map((value) => String(value || '').trim().toLocaleLowerCase('pt-BR')));
        let best = null;
        for (const candidate of result.rows) {
          const domain = await client.query(
            'SELECT DISTINCT BTRIM(CAST(' + quote(valueColumn) + ' AS TEXT)) AS value FROM ' + quote(schema) + '.' + quote(candidate.table_name) +
            ' WHERE ' + quote(valueColumn) + ' IS NOT NULL AND BTRIM(CAST(' + quote(valueColumn) + ' AS TEXT)) <> \'\'',
          );
          const values = domain.rows.map((row) => String(row.value || '').trim()).filter(Boolean);
          const compatible = values.every((value) => allowed.has(value.toLocaleLowerCase('pt-BR')));
          if (compatible && (!best || values.length > best.values.length)) best = { table: candidate.table_name, values };
        }
        assert(best, 'Nenhuma view efetiva corresponde ao TransformContext salvo de ' + valueColumn + '.');
        return quote(schema) + '.' + quote(best.table);
      }
      return quote(schema) + '.' + quote(result.rows[0].table_name);
    }
    const transforms = JSON.parse(fs.readFileSync('data/transform_queries.json', 'utf8'));
    const clientTransform = transforms.find((item) => String(item && item.name || '').trim().toLocaleLowerCase('pt-BR') === 'cliente e fornecedor');
    const clientFilter = (clientTransform && clientTransform.steps || []).find((step) => step && step.kind === 'filterRows' && step.column === 'Grupo Cliente');
    const allowedGroups = Array.isArray(clientFilter && clientFilter.values) && clientFilter.values.length
      ? clientFilter.values
      : String(clientFilter && clientFilter.value || '').split(',').map((value) => value.trim()).filter(Boolean);
    const clientTable = await tableWithColumns(['Chave 2', 'Grupo Cliente'], allowedGroups, 'Grupo Cliente');
    const factTable = await tableWithColumns(['Chave 2', 'CFOP', 'Preço Unitario Faturamento', 'Quantidade Faturamento']);
    const discountTable = await tableWithColumns(['Coluna1', 'Coluna2']);
    const groups = [
      'REDE G BARBOSA', 'REDE BOM PREÇO LOJAS', 'REDE ATACADÃO/WMS', 'REDE PERINI', 'REDE MIX',
      'REDE HIPERIDEAL', 'REDE ATAKAREJO / LOJAS', "REDE SAM'S CLUB", 'ALMACEN', 'REDE TOTAL ATACADO',
      'REDE CESTA DO POVO', 'REDE MATEUS', 'REDE MATEUS / LOJAS'
    ];
    const result = await client.query(`
      WITH fact_by_group AS (
        SELECT c.${quote('Grupo Cliente')} AS group_name,
          COALESCE(SUM(CASE WHEN f.${quote('CFOP')} IN ('5.102','6.102') THEN f.${quote('Preço Unitario Faturamento')} * f.${quote('Quantidade Faturamento')} ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN f.${quote('CFOP')} IN ('1.202','1.2020','1.202A','2.202') THEN f.${quote('Preço Unitario Faturamento')} * f.${quote('Quantidade Faturamento')} ELSE 0 END), 0) AS net_value
        FROM ${clientTable} c
        LEFT JOIN ${factTable} f ON f.${quote('Chave 2')} = c.${quote('Chave 2')}
        GROUP BY c.${quote('Grupo Cliente')}
      ), discount_by_group AS (
        SELECT d.${quote('Coluna1')} AS group_name, SUM(d.${quote('Coluna2')}) AS discount_value
        FROM ${discountTable} d GROUP BY d.${quote('Coluna1')}
      )
      SELECT f.group_name, f.net_value * d.discount_value AS expected_value
      FROM fact_by_group f JOIN discount_by_group d ON d.group_name = f.group_name
      WHERE f.group_name = ANY($1)
    `, [groups]);
    const values = Object.fromEntries(result.rows.map((row) => [row.group_name, Number(row.expected_value)]));
    return { values, total: Object.values(values).reduce((sum, value) => sum + value, 0) };
  } finally {
    await client.end();
  }
}

async function main() {
  const source = fs.readFileSync('server.js', 'utf8');
  assert(source.includes('function buildVisualMeasureJoinPlan'), 'Plano lógico de JOIN multi-hop ausente.');
  assert(source.includes('function visualPreAggregatedMeasureJoinSourceSql'), 'Subplano agregado por tabela ausente.');
  assert(source.includes('SQL ALIAS VALIDATION'), 'Validação estrutural de aliases ausente.');
  assert(!/alias\s*===\s*["']t2["']/i.test(source), 'Foi criado hardcode para t2.');
  assert(!/measure(?:Name)?\s*===\s*["']Descontado["']/i.test(source), 'Foi criado hardcode para Descontado.');
  assert(!/table(?:Name)?\s*===\s*["'](?:Desconto Financeiro|Cliente e Fornecedor)["']/i.test(source), 'Foi criado hardcode para tabela do cenário.');

  const before = Object.fromEntries(protectedFiles.map((file) => [file, hash(file)]));
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const measure = (model.measures || []).find((item) => item && item.name === 'Descontado');
  assert(measure, 'Medida Descontado não encontrada no modelo salvo.');
  let expected = await independentExpected();

  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  async function visual(name, options) {
    return request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({
        table: options.table,
        visualId: '__relationship_plan_' + name,
        visualization: options.visualization,
        dimension: options.dimension || '',
        value: options.value || measure.name,
        fields: options.fields,
        aggregation: 'SUM', order: 'DESC', limit: options.limit || 50, pageSize: options.limit || 50,
        deferTotals: true,
        onlineFilters: options.onlineFilters || [], filters: options.filters || {},
        model
      })
    });
  }

  const measureField = { name: measure.name, table: measure.table, type: 'measure', measureId: measure.name };
  const discountFields = [
    { name: 'Coluna1', table: 'Desconto Financeiro', type: 'text' },
    { name: 'Coluna2', table: 'Desconto Financeiro', type: 'number' }
  ];
  const groupField = { name: 'Grupo Cliente', table: 'Cliente e Fornecedor', type: 'text' };
  const factField = { name: 'CFOP', table: 'Faturamento e Recebimento', type: 'text' };

  const card = await visual('card', { table: measure.table, visualization: 'card', fields: [measureField], limit: 1 });
  const cardValue = Number(card.body.rows[0] && card.body.rows[0][measure.name]);
  assert(closeEnough(cardValue, expected.total), 'Card divergente: ' + cardValue + ' != ' + expected.total);
  assertValidJoinSql(card.body.sql, 'Card');

  const groupTable = await visual('group_table', { table: 'Cliente e Fornecedor', visualization: 'table', dimension: groupField.name, fields: [groupField, measureField] });
  assert(groupTable.body.rows.length > 0, 'Tabela Grupo Cliente não retornou linhas.');
  assertValidJoinSql(groupTable.body.sql, 'Tabela Grupo Cliente');

  // O cache de produção continua recebendo sincronizações incrementais enquanto a
  // suíte roda. Renove o oráculo imediatamente antes da comparação por grupo para
  // não comparar a consulta atual com um snapshot anterior do banco vivo.
  expected = await independentExpected();
  const discountTable = await visual('discount_table', { table: 'Desconto Financeiro', visualization: 'table', dimension: 'Coluna1', fields: [...discountFields, measureField] });
  assert.strictEqual(discountTable.body.rows.length, Object.keys(expected.values).length, 'Tabela de reprodução ganhou/perdeu grupos.');
  for (const row of discountTable.body.rows) {
    assert(Object.prototype.hasOwnProperty.call(expected.values, row.Coluna1), 'Grupo inesperado: ' + row.Coluna1);
    assert(closeEnough(row[measure.name], expected.values[row.Coluna1]), 'Valor divergente para ' + row.Coluna1 + '.');
  }
  assert(closeEnough(discountTable.body.rows.reduce((sum, row) => sum + Number(row[measure.name]), 0), expected.total), 'Soma das linhas diverge do total independente.');
  assertValidJoinSql(discountTable.body.sql, 'Tabela Desconto Financeiro');
  assert(/JOIN\s+`Cliente e Fornecedor`\s+t1\s+ON/i.test(discountTable.body.sql), 'Primeiro trecho do relacionamento ausente.');
  assert(/JOIN\s+\(SELECT[\s\S]+FROM\s+`Desconto Financeiro`[\s\S]+\)\s+t2\s+ON/i.test(discountTable.body.sql), 'Subplano agregado de Desconto Financeiro ausente.');

  const matrix = await visual('discount_matrix', { table: 'Desconto Financeiro', visualization: 'matrix', dimension: 'Coluna1', fields: [...discountFields, measureField] });
  assert.strictEqual(matrix.body.rows.length, discountTable.body.rows.length, 'Matriz divergiu da Tabela.');
  assertValidJoinSql(matrix.body.sql, 'Matriz');

  const threeTables = await visual('three_tables', {
    table: 'Desconto Financeiro', visualization: 'table', dimension: 'Grupo Cliente',
    fields: [groupField, discountFields[0], factField, measureField], limit: 20
  });
  assert(threeTables.body.rows.length > 0, 'Visual com as três tabelas não retornou linhas.');
  assertValidJoinSql(threeTables.body.sql, 'Três tabelas');

  const warmRuns = [];
  for (let index = 0; index < 2; index += 1) {
    const warm = await visual('discount_table_warm', { table: 'Desconto Financeiro', visualization: 'table', dimension: 'Coluna1', fields: [...discountFields, measureField] });
    warmRuns.push({ elapsedMs: warm.elapsedMs, serverMs: warm.body.performance && warm.body.performance.totalServerMs, queryBuildCount: warm.body.performance && warm.body.performance.queryBuildCount });
    assert.strictEqual(warm.body.performance && warm.body.performance.queryBuildCount, 1, 'Execução warm gerou mais de um plano.');
  }

  const companyFilter = { id: '__company', table: 'Empresas', field: 'Fantasia', key: 'Empresas.Fantasia', label: 'Empresa', operator: '=', type: 'text', ui: 'dropdown', scope: 'report' };
  const yearFilter = { id: '__year', table: 'Calendario', field: 'Ano', key: 'Calendario.Ano', label: 'Ano', operator: '=', type: 'number', ui: 'search', scope: 'report' };
  const monthFilter = { id: '__months', table: 'Calendario', field: 'MesNome', key: 'Calendario.MesNome', label: 'Mês', operator: '=', type: 'text', ui: 'dropdown', multiSelect: true, scope: 'report' };
  const companies = await request('/api/filter-options?table=Empresas&field=Fantasia', { headers: { authorization: headers.authorization } });
  const company = companies.body.values && companies.body.values[0];
  assert(company, 'Empresa não encontrada para teste de filtro.');
  const filtered = await visual('filtered', {
    table: 'Desconto Financeiro', visualization: 'table', dimension: 'Coluna1', fields: [...discountFields, measureField],
    onlineFilters: [companyFilter, yearFilter, monthFilter],
    filters: { [companyFilter.id]: company, [yearFilter.id]: '2026', [monthFilter.id]: 'Janeiro||Março||Agosto' }
  });
  assertValidJoinSql(filtered.body.sql, 'Filtros');
  assert(/IN\s*\(\s*'Janeiro'\s*,\s*'Março'\s*,\s*'Agosto'\s*\)/i.test(filtered.body.sql), 'Multisseleção não chegou como conjunto ao SQL.');
  assert.strictEqual(filtered.body.performance && filtered.body.performance.queryBuildCount, 1, 'Filtros geraram planos duplicados.');

  for (const file of protectedFiles) assert.strictEqual(hash(file), before[file], 'O teste alterou ' + file + '.');
  console.log(JSON.stringify({
    ok: true,
    relationships: [
      'Desconto Financeiro[Coluna1] -> Cliente e Fornecedor[Grupo Cliente]',
      'Cliente e Fornecedor[Chave 2] -> Faturamento e Recebimento[Chave 2]'
    ],
    expectedTotal: expected.total,
    card: { value: cardValue, elapsedMs: card.elapsedMs, serverMs: card.body.performance && card.body.performance.totalServerMs },
    table: { rows: discountTable.body.rows.length, elapsedMs: discountTable.elapsedMs, serverMs: discountTable.body.performance && discountTable.body.performance.totalServerMs },
    matrix: { rows: matrix.body.rows.length, elapsedMs: matrix.elapsedMs },
    threeTables: { rows: threeTables.body.rows.length, elapsedMs: threeTables.elapsedMs },
    warmRuns,
    filters: { company, rows: filtered.body.rows.length, elapsedMs: filtered.elapsedMs, queryBuildCount: filtered.body.performance && filtered.body.performance.queryBuildCount },
    aliases: { base: 'src', clienteFornecedor: 't1', descontoFinanceiro: 't2', valid: true },
    protectedFiles: 'inalterados'
  }, null, 2));
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
