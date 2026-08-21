const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');

require('dotenv').config();

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const requestTimeoutMs = Math.max(10000, Number(process.env.BIWA_DIAG_TIMEOUT_MS) || 180000);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  return { status: response.status, body, elapsedMs: Number((performance.now() - startedAt).toFixed(3)) };
}

function reportsList(value) {
  return Array.isArray(value) ? value : (Array.isArray(value && value.reports) ? value.reports : []);
}

function measureField(measure) {
  return {
    name: measure.name,
    displayName: measure.displayName || measure.name,
    table: measure.table,
    type: 'measure',
    fieldType: 'measure',
    semanticType: 'measure',
    measureId: measure.id || measure.name,
    id: measure.id || measure.name,
    aggregation: 'NONE'
  };
}

function summarizeSql(sql, measureName) {
  const source = String(sql || '');
  const alias = '`' + String(measureName || '').replace(/`/g, '``') + '`';
  const aliasIndex = source.indexOf(alias);
  return {
    chars: source.length,
    sourceScans: (source.match(/FROM\s+`Faturamento e Recebimento`\s+src/gi) || []).length,
    targetOtherPlan: /__biwa_target/i.test(source) && /__biwa_other/i.test(source),
    measureFragment: aliasIndex >= 0
      ? source.slice(Math.max(0, aliasIndex - 320), Math.min(source.length, aliasIndex + alias.length + 80))
      : ''
  };
}

function quotePgIdent(value) {
  return '"' + String(value || '').replace(/"/g, '""') + '"';
}

function sqlForPostgres(sql, cacheTables) {
  let converted = String(sql || '');
  for (const [logicalTable, cacheTable] of Object.entries(cacheTables || {})) {
    const escapedLogical = logicalTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tablePattern = new RegExp('(\\b(?:FROM|JOIN)\\s+)(?:`' + escapedLogical + '`|"' + escapedLogical + '"|' + escapedLogical + ')(\\s+(?:AS\\s+)?\\w+)?', 'gi');
    converted = converted.replace(tablePattern, (_match, prefix, alias) => prefix + quotePgIdent(process.env.BIWA_PG_CACHE_SCHEMA || 'biwa_cache') + '.' + quotePgIdent(cacheTable) + (alias || ''));
  }
  converted = converted.replace(/`([^`]+)`/g, (_match, name) => quotePgIdent(name));
  converted = converted.replace(/\bDESC\b(?!\s+NULLS\s+(?:FIRST|LAST))/gi, 'DESC NULLS LAST');
  converted = converted.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+CHAR\s*\)/gi, 'CAST($1 AS TEXT)');
  converted = converted.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+SIGNED\s*\)/gi, 'CAST($1 AS INTEGER)');
  converted = converted.replace(/\bYEAR\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(YEAR FROM $1)');
  converted = converted.replace(/\bMONTH\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(MONTH FROM $1)');
  converted = converted.replace(/\bDAYOFMONTH\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(DAY FROM $1)');
  return converted.replace(/;\s*$/g, '');
}

function summarizeExplain(explainRows) {
  const root = explainRows && explainRows[0] && explainRows[0]['QUERY PLAN'] && explainRows[0]['QUERY PLAN'][0];
  if (!root || !root.Plan) return { available: false };
  const nodes = [];
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  let tempReadBlocks = 0;
  let tempWrittenBlocks = 0;
  const nodeCounts = {};
  const relationScans = {};
  function visit(plan, depth) {
    if (!plan) return;
    sharedHitBlocks += Number(plan['Shared Hit Blocks'] || 0);
    sharedReadBlocks += Number(plan['Shared Read Blocks'] || 0);
    tempReadBlocks += Number(plan['Temp Read Blocks'] || 0);
    tempWrittenBlocks += Number(plan['Temp Written Blocks'] || 0);
    nodeCounts[plan['Node Type']] = (nodeCounts[plan['Node Type']] || 0) + 1;
    if (plan['Relation Name']) relationScans[plan['Relation Name']] = (relationScans[plan['Relation Name']] || 0) + 1;
    nodes.push({
      depth,
      node: plan['Node Type'],
      relation: plan['Relation Name'] || '',
      join: plan['Join Type'] || '',
      rows: Number(plan['Actual Rows'] || 0),
      loops: Number(plan['Actual Loops'] || 0),
      timeMs: Number(plan['Actual Total Time'] || 0)
    });
    (plan.Plans || []).forEach((child) => visit(child, depth + 1));
  }
  visit(root.Plan, 0);
  return {
    available: true,
    planningMs: Number(root['Planning Time'] || 0),
    executionMs: Number(root['Execution Time'] || 0),
    sharedHitBlocks,
    sharedReadBlocks,
    tempReadBlocks,
    tempWrittenBlocks,
    nodeCounts,
    relationScans,
    slowestNodes: nodes.sort((left, right) => right.timeMs - left.timeMs).slice(0, 12)
  };
}

async function main() {
  const protectedFiles = [
    'data/reports.json',
    'data/semantic_model.json',
    'data/transform_queries.json',
    'data/settings.json'
  ];
  const protectedHashes = Object.fromEntries(protectedFiles.map((file) => [file, fileHash(file)]));
  const settings = readJson('data/settings.json');
  const persistedModel = readJson('data/semantic_model.json');
  const reports = reportsList(readJson('data/reports.json'));
  const report = reports.find((item) => /gerencial/i.test(String(item && (item.name || item.title) || '')));
  if (!report) throw new Error('Relatório Gerencial não encontrado.');
  const visual = (report.visuals || []).find((item) => String(item.visualization || '').toLowerCase() === 'table');
  if (!visual) throw new Error('Tabela do Relatório Gerencial não encontrada.');

  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: settings.access.adminUser,
      password: settings.access.adminPassword,
      accessMode: 'admin'
    })
  });
  if (login.status !== 200) throw new Error('Login HTTP ' + login.status + ': ' + (login.body.error || 'erro'));
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const pgPool = new Pool({
    host: process.env.BIWA_PG_CACHE_HOST || '127.0.0.1',
    port: Number(process.env.BIWA_PG_CACHE_PORT || 5432),
    database: process.env.BIWA_PG_CACHE_DATABASE || 'bi_wa_cache',
    user: process.env.BIWA_PG_CACHE_USER || 'biwa_cache',
    password: process.env.BIWA_PG_CACHE_PASSWORD || 'biwa_cache',
    max: 1
  });
  const cacheSchema = process.env.BIWA_PG_CACHE_SCHEMA || 'biwa_cache';
  const cacheMetaResult = await pgPool.query(
    'SELECT cache_table FROM ' + quotePgIdent(cacheSchema) + '.' + quotePgIdent('__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1) LIMIT 1',
    ['Faturamento e Recebimento']
  );
  let cacheTable = cacheMetaResult.rows[0] && cacheMetaResult.rows[0].cache_table;
  if (!cacheTable) {
    const calculatedViewResult = await pgPool.query(
      'SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND table_name LIKE $2 GROUP BY table_name HAVING BOOL_OR(column_name = $3) AND BOOL_OR(column_name = $4) ORDER BY table_name DESC LIMIT 1',
      [cacheSchema, 'dax_%', 'Código e Produto', 'Preço Unitario Faturamento']
    );
    cacheTable = calculatedViewResult.rows[0] && calculatedViewResult.rows[0].table_name;
  }
  if (!cacheTable) throw new Error('Tabela física do cache PostgreSQL não encontrada.');
  const companyCacheMetaResult = await pgPool.query(
    'SELECT cache_table FROM ' + quotePgIdent(cacheSchema) + '.' + quotePgIdent('__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1) LIMIT 1',
    ['Empresas']
  );
  const companyCacheTable = companyCacheMetaResult.rows[0] && companyCacheMetaResult.rows[0].cache_table;
  if (!companyCacheTable) throw new Error('Tabela física de Empresas no cache PostgreSQL não encontrada.');
  const explainCacheTables = { 'Faturamento e Recebimento': cacheTable, Empresas: companyCacheTable };
  const companyFilter = (report.onlineFilters || []).find((filter) => String(filter.field || '').toLocaleLowerCase('pt-BR') === 'fantasia');
  if (!companyFilter) throw new Error('Filtro obrigatório Empresa/Fantasia não encontrado no Gerencial.');
  const optionResult = await request('/api/filter-options?table=' + encodeURIComponent(companyFilter.table) + '&field=' + encodeURIComponent(companyFilter.field), { headers });
  const companyValues = Array.isArray(optionResult.body.values) ? optionResult.body.values : [];
  const company = process.env.BIWA_DIAG_COMPANY
    || companyValues.find((value) => /RLS HORTIFRUTI\s*-\s*CD/i.test(String(value)))
    || companyValues[0];
  if (!company) throw new Error('Nenhuma empresa disponível para o filtro obrigatório.');

  const table = 'Faturamento e Recebimento';
  const formulas = [
    {
      key: '01_sum_quantidade',
      name: '__DIAG Valor Vendas 01',
      formula: "SUM('Faturamento e Recebimento'[Quantidade Faturamento])"
    },
    {
      key: '02_sumx_quantidade',
      name: '__DIAG Valor Vendas 02',
      formula: "SUMX('Faturamento e Recebimento', 'Faturamento e Recebimento'[Quantidade Faturamento])"
    },
    {
      key: '03_sumx_multiplicacao',
      name: '__DIAG Valor Vendas 03',
      formula: "SUMX('Faturamento e Recebimento', 'Faturamento e Recebimento'[Preço Unitario Faturamento] * 'Faturamento e Recebimento'[Quantidade Faturamento])"
    },
    {
      key: '04_calculate_sum_in',
      name: '__DIAG Valor Vendas 04',
      formula: "CALCULATE(SUM('Faturamento e Recebimento'[Quantidade Faturamento]), 'Faturamento e Recebimento'[CFOP] IN {\"5.102\", \"6.102\"})"
    },
    {
      key: '05_calculate_sumx_in',
      name: '__DIAG Valor Vendas 05',
      formula: "CALCULATE(SUMX('Faturamento e Recebimento', 'Faturamento e Recebimento'[Preço Unitario Faturamento] * 'Faturamento e Recebimento'[Quantidade Faturamento]), 'Faturamento e Recebimento'[CFOP] IN {\"5.102\", \"6.102\"})"
    }
  ];
  const existingMeasure = (persistedModel.measures || []).find((measure) => String(measure.name || '').toLocaleLowerCase('pt-BR') === 'valor vendas');
  if (!existingMeasure) throw new Error('A medida persistida Valor Vendas não foi encontrada.');

  const codeField = (visual.selectedFields || []).find((field) => field && field.name === 'Código e Produto')
    || { name: 'Código e Produto', table, type: 'column', fieldType: 'column', semanticType: 'column' };
  const unitField = (visual.selectedFields || []).find((field) => field && field.name === 'Unidade 2');
  const basePayload = {
    table,
    visualization: 'table',
    dimension: codeField.name,
    aggregation: 'SUM',
    order: 'DESC',
    limit: 100,
    page: 1,
    pageSize: 100,
    deferTotals: true,
    visualFilters: visual.visualFilters || [],
    pageFilters: report.pageFilters || [],
    allPagesFilters: report.allPagesFilters || [],
    filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: String(company) },
    onlineFilters: report.onlineFilters || [],
    pageId: visual.pageId || 'page_1',
    performanceDiagnostics: true
  };

  async function clearQueryCache() {
    const result = await request('/api/realtime/cache/clear', { method: 'POST', headers, body: '{}' });
    if (result.status !== 200) throw new Error('Não foi possível limpar o cache de consulta: HTTP ' + result.status);
  }

  async function executeCase(testCase, runKind) {
    if (runKind === 'cold') await clearQueryCache();
    const result = await request('/api/visual-query', {
      method: 'POST',
      headers,
      body: JSON.stringify(testCase.payload)
    });
    const rows = Array.isArray(result.body.rows) ? result.body.rows : [];
    const sql = result.body.sql || result.body.baseSql || '';
    let explain = null;
    if (runKind === 'cold' && ['06_valor_vendas_isolada', '07_gerencial_sem_valor_vendas', '08_gerencial_com_valor_vendas'].includes(testCase.key) && result.status === 200 && sql) {
      const pgSql = sqlForPostgres(sql, explainCacheTables);
      const explainResult = await pgPool.query({
        text: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM (' + pgSql + ') AS bi_query LIMIT 101',
        statement_timeout: requestTimeoutMs
      });
      explain = summarizeExplain(explainResult.rows);
    }
    return {
      case: testCase.key,
      run: runKind,
      status: result.status,
      elapsedMs: result.elapsedMs,
      error: result.body.error || '',
      rows: rows.length,
      columns: rows[0] ? Object.keys(rows[0]) : (result.body.fields || []).map((field) => field && field.name).filter(Boolean),
      performance: result.body.performance || null,
      cacheEngine: result.body.cacheEngine || '',
      sql: summarizeSql(sql, testCase.measureName),
      explain
    };
  }

  const cases = formulas.map((entry) => {
    const measure = {
      id: 'measure_diag_' + entry.key,
      name: entry.name,
      displayName: entry.name,
      table,
      formula: entry.formula,
      expression: entry.formula,
      format: 'decimal',
      source: 'diagnostic-memory-only'
    };
    const model = clone(persistedModel);
    model.measures = (model.measures || []).concat(measure);
    return {
      key: entry.key,
      measureName: measure.name,
      payload: {
        ...basePayload,
        visualId: 'diag_' + entry.key,
        value: measure.name,
        fields: [codeField, measureField(measure)],
        model
      }
    };
  });

  const isolatedModel = clone(persistedModel);
  const valorField = measureField(existingMeasure);
  cases.push({
    key: '06_valor_vendas_isolada',
    measureName: existingMeasure.name,
    payload: {
      ...basePayload,
      visualId: 'diag_valor_vendas_isolada',
      value: existingMeasure.name,
      fields: [codeField, ...(unitField ? [unitField] : []), valorField],
      model: isolatedModel
    }
  });
  const currentFields = (visual.selectedFields || []).filter((field) => field && field.name !== existingMeasure.name);
  cases.push({
    key: '07_gerencial_sem_valor_vendas',
    measureName: String(visual.value || ''),
    payload: {
      ...basePayload,
      visualId: 'diag_gerencial_sem_valor_vendas',
      dimension: visual.dimension || codeField.name,
      value: visual.value || '',
      fields: currentFields,
      model: isolatedModel
    }
  });
  cases.push({
    key: '08_gerencial_com_valor_vendas',
    measureName: existingMeasure.name,
    payload: {
      ...basePayload,
      visualId: 'diag_gerencial_com_valor_vendas',
      dimension: visual.dimension || codeField.name,
      value: visual.value || '',
      fields: currentFields.concat(valorField),
      model: isolatedModel
    }
  });

  console.log(JSON.stringify({
    event: 'diagnostic-context',
    report: report.name,
    visualId: visual.id,
    company,
    currentFields: currentFields.map((field) => ({ name: field.name, type: field.type || field.fieldType || '' })),
    valorVendasFormula: existingMeasure.formula || existingMeasure.expression
  }));
  const results = [];
  for (const testCase of cases) {
    results.push(await executeCase(testCase, 'cold'));
    results.push(await executeCase(testCase, 'warm'));
    console.log(JSON.stringify(results[results.length - 2]));
    console.log(JSON.stringify(results[results.length - 1]));
  }

  const mathCase = cases.find((item) => item.key === '06_valor_vendas_isolada');
  const mathResult = await request('/api/visual-query', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...mathCase.payload, pageSize: 500, limit: 500, deferTotals: false })
  });
  if (mathResult.status !== 200) throw new Error('Não foi possível validar matematicamente Valor Vendas: HTTP ' + mathResult.status);
  const mathRows = Array.isArray(mathResult.body.rows) ? mathResult.body.rows : [];
  const rowSum = mathRows.reduce((total, row) => total + Number(row && row[existingMeasure.name] || 0), 0);
  const authoritativeTotal = Number(mathResult.body.totals && mathResult.body.totals[existingMeasure.name]);
  const tolerance = 1e-8 * Math.max(1, Math.abs(authoritativeTotal));
  if (!Number.isFinite(authoritativeTotal) || Math.abs(rowSum - authoritativeTotal) > tolerance) {
    throw new Error('Total de Valor Vendas divergente: linhas=' + rowSum + ', total=' + authoritativeTotal);
  }
  console.log(JSON.stringify({
    event: 'mathematical-validation',
    measure: existingMeasure.name,
    rows: mathRows.length,
    rowSum,
    authoritativeTotal,
    equalWithinTolerance: true
  }));

  const changedFiles = protectedFiles.filter((file) => fileHash(file) !== protectedHashes[file]);
  if (changedFiles.length) throw new Error('O diagnóstico alterou arquivos protegidos: ' + changedFiles.join(', '));
  await pgPool.end();
  console.log(JSON.stringify({ event: 'diagnostic-complete', protectedFilesUnchanged: true, caseCount: cases.length, runCount: results.length }));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
