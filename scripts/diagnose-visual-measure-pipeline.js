const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(180000)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  return { status: response.status, body };
}

function reportList(value) {
  return Array.isArray(value) ? value : (Array.isArray(value && value.reports) ? value.reports : []);
}

function resultColumns(result) {
  const firstRow = result && result.body && Array.isArray(result.body.rows) && result.body.rows[0];
  return firstRow ? Object.keys(firstRow) : [];
}

async function main() {
  const modelPath = 'data/semantic_model.json';
  const reportsPath = 'data/reports.json';
  const hashes = { model: fileHash(modelPath), reports: fileHash(reportsPath) };
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const reports = reportList(JSON.parse(fs.readFileSync(reportsPath, 'utf8')));
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
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
  const companyFilter = (report.onlineFilters || []).find((filter) => String(filter.field || '').toLocaleLowerCase('pt-BR') === 'fantasia');
  if (!companyFilter) throw new Error('Filtro Empresa do Relatório Gerencial não encontrado.');
  const companyOptions = await request('/api/filter-options?table=' + encodeURIComponent(companyFilter.table) + '&field=' + encodeURIComponent(companyFilter.field), { headers });
  const company = process.env.BIWA_DIAG_COMPANY ||
    (companyOptions.body.values || []).find((value) => /(?:CD|LOJA)$/i.test(String(value))) ||
    (companyOptions.body.values || [])[0];
  if (!company) throw new Error('Nenhuma opção do filtro Empresa foi encontrada.');
  const measures = new Map((model.measures || []).map((measure) => [String(measure.name || '').toLocaleLowerCase('pt-BR'), measure]));
  const cost = measures.get('custo');
  const returns = measures.get('conversão devolução vendas');
  if (!cost || !returns) throw new Error('As medidas Custo e Conversão Devolução Vendas precisam existir no modelo.');

  const configuredFields = Array.isArray(visual.selectedFields) ? visual.selectedFields : [];
  const codeField = configuredFields.find((field) => field.name === 'Código e Produto') || configuredFields[0];
  const costField = configuredFields.find((field) => field.name === cost.name) || {
    name: cost.name, table: cost.table, type: 'measure', measureId: cost.name
  };
  const returnsField = {
    name: returns.name, table: returns.table, type: 'measure', measureId: returns.name
  };

  console.log('[MODEL MEASURES]');
  console.log(JSON.stringify({
    cost: { name: cost.name, table: cost.table, formula: cost.formula, source: cost.source || '', status: cost.diagnosticStatus || cost.status || '' },
    returns: { name: returns.name, table: returns.table, formula: returns.formula, source: returns.source || '', status: returns.diagnosticStatus || returns.status || '' }
  }, null, 2));
  console.log('[SAVED VISUAL STATE]');
  console.log(JSON.stringify({
    id: visual.id,
    table: visual.table,
    dimension: visual.dimension,
    value: visual.value,
    fields: configuredFields.map((field) => ({ name: field.name, type: field.type, table: field.table, measureId: field.measureId || null }))
  }, null, 2));

  const basePayload = {
    table: visual.table,
    visualId: visual.id,
    pageId: visual.pageId || 'page_1',
    visualization: 'table',
    dimension: visual.dimension || '',
    value: visual.value || '',
    aggregation: visual.aggregation || 'SUM',
    order: visual.order || 'DESC',
    limit: 25,
    page: 1,
    pageSize: 25,
    deferTotals: true,
    visualFilters: visual.visualFilters || [],
    pageFilters: report.pageFilters || [],
    allPagesFilters: report.allPagesFilters || [],
    filters: { [companyFilter.id || companyFilter.key || companyFilter.field]: String(company) },
    onlineFilters: report.onlineFilters || [],
    model
  };
  if (process.env.BIWA_DIAG_FULL_FILTERS === '1') {
    const now = new Date();
    const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'America/Bahia' })
      .format(now)
      .replace(/^./, (letter) => letter.toLocaleUpperCase('pt-BR'));
    (report.onlineFilters || []).forEach((filter) => {
      const key = filter.id || filter.key || filter.field;
      const field = String(filter.field || '').toLocaleLowerCase('pt-BR');
      if (field === 'dia') basePayload.filters[key] = '1|31';
      else if (field === 'mesnome') basePayload.filters[key] = monthName;
      else if (field === 'ano') basePayload.filters[key] = String(now.getFullYear());
    });
  }
  const cases = [
    ['gerencial_sem_custo', configuredFields.filter((field) => field.name !== cost.name)],
    ['gerencial_com_custo', configuredFields],
    ['gerencial_custo_como_primaria', configuredFields, cost.name],
    ['tabela_simples_custo', [codeField, costField]],
    ['tabela_simples_custo_como_primaria', [codeField, costField], cost.name],
    ['tabela_simples_devolucao', [codeField, returnsField]],
    ['gerencial_com_devolucao', configuredFields.filter((field) => field.name !== returns.name).concat(returnsField)]
  ];
  console.log('[FILTER CONTEXT] Empresa=' + company);

  for (const [name, fields, primaryValue] of cases) {
    const startedAt = Date.now();
    console.log('[QUERY REQUEST] ' + name);
    console.log(JSON.stringify({ value: primaryValue || basePayload.value, fields: fields.map((field) => ({ name: field.name, type: field.type, table: field.table })) }));
    let result;
    try {
      result = await request('/api/visual-query', {
        method: 'POST', headers, body: JSON.stringify({ ...basePayload, visualId: name, value: primaryValue || basePayload.value, fields })
      });
    } catch (error) {
      console.log(JSON.stringify({ name, transportError: error.message, elapsedMs: Date.now() - startedAt }));
      continue;
    }
    console.log('[QUERY RESULT] ' + name);
    console.log(JSON.stringify({
      status: result.status,
      elapsedMs: Date.now() - startedAt,
      error: result.body.error || '',
      rowCount: Array.isArray(result.body.rows) ? result.body.rows.length : 0,
      columns: resultColumns(result),
      responseFields: result.body.fields || [],
      sql: result.body.sql || result.body.baseSql || ''
    }, null, 2));
  }

  if (fileHash(modelPath) !== hashes.model || fileHash(reportsPath) !== hashes.reports) {
    throw new Error('O diagnóstico alterou o modelo ou os relatórios persistidos.');
  }
  console.log('[PERSISTENCE] arquivos de modelo e relatório permaneceram inalterados.');
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
