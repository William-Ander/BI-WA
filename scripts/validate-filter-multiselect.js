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

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, { ...options, signal: options.signal || AbortSignal.timeout(180000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert(response.ok, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 600)));
  return { body, elapsedMs: performance.now() - startedAt };
}

function sourceContracts() {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');
  const html = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/styles.css', 'utf8');

  assert(html.includes('id="onlineFilterMultiSelectInput"'), 'Opção Permitir seleção múltipla ausente do modal.');
  assert(/multiSelect:\s*ui === 'dropdown' && Boolean/.test(app), 'Compatibilidade multiSelect=false ausente no frontend.');
  assert(/multiSelect:\s*ui === 'dropdown' && raw\.multiSelect === true/.test(server), 'Persistência segura de multiSelect ausente no backend.');
  assert(app.includes('data-filter-dropdown-select-all'), 'Ação Selecionar todos ausente.');
  assert(app.includes('data-filter-dropdown-clear'), 'Ação Limpar seleção ausente.');
  assert(app.includes("selected.join('||')"), 'Valores múltiplos não são serializados como conjunto.');
  assert(/selectedValues\.join\('\|\|'\)/.test(app), 'Seleção múltipla não é persistida como valor padrão do filtro salvo.');
  assert(server.includes('synchronizeCalendarFilterEntries'), 'Sincronização temporal do conjunto de meses ausente.');
  assert(app.includes('synchronizeCalendarNavigationInputs'), 'Sincronização Data/Mês no controle ausente.');
  assert(server.includes('findFilterPropagationPath'), 'Relationship Graph dirigido ausente do backend.');
  assert(server.includes('filterDomainContextForTarget'), 'Separação do contexto da FILTER_DOMAIN_QUERY ausente.');
  assert(!server.includes('const commonFactValues = await tryLoadViaCommonFactPg()'), 'FILTER_DOMAIN_QUERY ainda é executada por uma fato comum.');
  assert(app.includes('domainTable: String(filter && filter.domainTable || \'\').trim()'), 'Configuração de domínio não é preservada no frontend.');
  assert(app.includes("biwa.filter.options.v7:"), 'Versão de invalidação do cache de domínio não foi atualizada.');
  assert(app.includes('invalidateFilterOptionsClientCache();'), 'Evento de invalidação não limpa o cache de domínio do viewer.');
  assert(app.includes('requestTarget.__filterOptionsAbortController.abort()'), 'Consultas antigas de domínio não são canceladas.');
  assert(css.includes('.filter-dropdown-select-all'), 'Estilo dos controles de multiseleção ausente.');
  assert(!/multiSelect[\s\S]{0,100}(?:Janeiro|Agosto|Cliente e Fornecedor|Gerencial)/.test(app), 'Frontend contém hardcode de cenário na implementação multiSelect.');
  assert(!/multiSelect[\s\S]{0,100}(?:Janeiro|Agosto|Cliente e Fornecedor|Gerencial)/.test(server), 'Backend contém hardcode de cenário na implementação multiSelect.');
}

function filterBy(filters, table, field) {
  return (filters || []).find((filter) => canonical(filter.table) === canonical(table) && canonical(filter.field) === canonical(field));
}

async function filterOptions(filter, headers, context = null) {
  const params = new URLSearchParams({ table: filter.table, field: filter.field });
  if (filter.domainTable) params.set('domainTable', filter.domainTable);
  if (context) params.set('contextFilters', JSON.stringify(context));
  const response = await request('/api/filter-options?' + params.toString(), { headers });
  return {
    values: (response.body.values || []).map(String),
    elapsedMs: response.elapsedMs,
    engine: response.body.cacheEngine || '',
    domainQuery: response.body.domainQuery || {},
    performance: response.body.performance || {}
  };
}

async function main() {
  sourceContracts();
  const before = Object.fromEntries(protectedFiles.map((file) => [file, hash(file)]));
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const report = reports.find((item) => canonical(item.name) === 'gerencial');
  assert(report, 'Relatório Gerencial não encontrado.');
  const filters = report.onlineFilters || [];
  const companyFilter = filterBy(filters, 'Empresas', 'Fantasia');
  const yearFilter = filterBy(filters, 'Calendario', 'Ano');
  const monthFilter = filterBy(filters, 'Calendario', 'MesNome');
  const dayFilter = filterBy(filters, 'Calendario', 'Dia');
  const partyFilter = filterBy(filters, 'Cliente e Fornecedor', 'Cliente e Fornecedor');
  assert(companyFilter && yearFilter && monthFilter && dayFilter && partyFilter, 'Filtros obrigatórios do cenário não encontrados.');
  const tableVisual = (report.visuals || []).find((visual) => String(visual.visualization || '').toLowerCase() === 'table');
  assert(tableVisual, 'Tabela do Gerencial não encontrada.');
  const factTable = tableVisual.table || 'Faturamento e Recebimento';
  // Espelha o payload real do viewer: todos os filtros da página carregam a
  // fato dominante para o backend escolher a testemunha contextual correta.
  [companyFilter, yearFilter, monthFilter, dayFilter, partyFilter].forEach((filter) => { filter.domainTable = factTable; });
  assert.strictEqual(Boolean(monthFilter.multiSelect), false, 'Filtro legado foi alterado automaticamente para multiseleção.');

  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };

  const companies = await filterOptions(companyFilter, headers);
  assert(companies.values.length, 'Nenhuma empresa disponível.');
  const company = companies.values.find((value) => /(?:CD|LOJA)$/i.test(value)) || companies.values[0];
  const year = '2026';
  const domainContext = {
    [companyFilter.table + '.' + companyFilter.field]: company,
    [yearFilter.table + '.' + yearFilter.field]: year,
    [dayFilter.table + '.' + dayFilter.field]: '1|31'
  };
  const months = await filterOptions(monthFilter, headers, domainContext);
  assert(months.values.length, 'Empresa/Ano não retornaram meses disponíveis.');
  const selectedMonth = months.values.includes('Agosto') ? 'Agosto' : months.values[months.values.length - 1];

  const partyContext = { ...domainContext, [monthFilter.table + '.' + monthFilter.field]: selectedMonth };
  const partyBase = await filterOptions(partyFilter, headers);
  const parties = await filterOptions(partyFilter, headers, partyContext);
  assert(parties.values.length, 'Domínio de Cliente e Fornecedor ficou vazio.');
  const baseParties = new Set(partyBase.values);
  assert(parties.values.every((value) => baseParties.has(value)), 'Domínio contextual ultrapassou a dimensão efetiva.');
  assert(parties.values.length < partyBase.values.length, 'Empresa/período não restringiram Cliente e Fornecedor por existência de movimento.');
  assert.strictEqual(parties.domainQuery.contextualSemiJoin, true, 'Cliente e Fornecedor não usou o domínio contextual pelo Relationship Graph.');
  assert(Number(parties.performance.queryBuildCount || 0) <= 1, 'Domínio contextual gerou N+1.');

  const physicalDimension = (tableVisual.selectedFields || []).find((field) => String(field.type || '').toLowerCase() !== 'measure') || { name: 'Código Produto', table: factTable, type: 'column' };
  const quantityField = { name: 'Quantidade Faturamento', table: factTable, type: 'column', aggregation: 'SUM' };
  const syntheticDateFilter = {
    id: '__test_date_range', table: 'Calendario', field: 'Data', key: 'Calendario.Data', label: 'Data',
    operator: 'BETWEEN', type: 'date', ui: 'between', allowAll: true, scope: 'report'
  };
  const syntheticMonthFilter = { ...monthFilter, multiSelect: true };
  const visualPayload = {
    table: factTable,
    visualId: '__test_multiselect',
    pageId: tableVisual.pageId || 'page_1',
    visualization: 'table',
    dimension: physicalDimension.name,
    value: quantityField.name,
    fields: [{ ...physicalDimension, table: physicalDimension.table || factTable }, quantityField],
    aggregation: 'SUM', order: 'ASC', page: 1, pageSize: 20, limit: 20, deferTotals: true,
    onlineFilters: [yearFilter, syntheticMonthFilter, syntheticDateFilter, companyFilter],
    filters: {
      [yearFilter.id]: year,
      [monthFilter.id]: 'Janeiro||Março',
      [syntheticDateFilter.id]: '2026-08-01|2026-08-31',
      [companyFilter.id]: company
    },
    model
  };
  const nonContiguous = await request('/api/visual-query', { method: 'POST', headers, body: JSON.stringify(visualPayload) });
  const sql = String(nonContiguous.body.sql || nonContiguous.body.baseSql || '');
  const monthIn = sql.match(/\bIN\s*\(\s*'Janeiro'\s*,\s*'Mar(?:ç|\\u00e7)o'\s*\)/i);
  assert(monthIn, 'Janeiro + Março não foi traduzido para IN. SQL: ' + sql.slice(0, 1000));
  assert(!sql.includes('2026-08-01') && !sql.includes('2026-08-31'), 'Intervalo antigo de Agosto permaneceu junto do conjunto de meses.');
  assert(!/Fevereiro/i.test(monthIn[0]), 'Fevereiro entrou indevidamente no conjunto Janeiro + Março.');
  assert(nonContiguous.body.performance && nonContiguous.body.performance.queryBuildCount === 1, 'Multiseleção compilou mais de uma consulta.');

  const cleared = await request('/api/visual-query', {
    method: 'POST', headers,
    body: JSON.stringify({ ...visualPayload, visualId: '__test_multiselect_clear', onlineFilters: [yearFilter, syntheticMonthFilter, companyFilter], filters: { [yearFilter.id]: year, [monthFilter.id]: '', [companyFilter.id]: company } })
  });
  const clearedSql = String(cleared.body.sql || cleared.body.baseSql || '');
  assert(!/THEN\s+'(?:Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto)'[\s\S]{0,300}=\s*'(?:Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto)'/i.test(clearedSql), 'Limpar seleção ainda aplicou um mês padrão invisível.');

  const combinedFilters = {
    [companyFilter.id]: company,
    [yearFilter.id]: year,
    [monthFilter.id]: months.values.slice(0, Math.min(2, months.values.length)).join('||'),
    [dayFilter.id]: '1|31',
    [partyFilter.id]: parties.values[0]
  };
  const combined = await request('/api/reports/' + encodeURIComponent(report.id) + '/run', {
    method: 'POST', headers,
    body: JSON.stringify({ filters: combinedFilters, crossFilters: [], pageId: tableVisual.pageId || 'page_1' })
  });
  const combinedResult = combined.body.result || combined.body;
  const visualResults = combinedResult.visualResults || [];
  assert(visualResults.length, 'Contexto Empresa + Cliente/Fornecedor + meses não executou os visuais.');
  assert(!visualResults.some((visual) => visual && visual.error), 'Contexto combinado apresentou erro: ' + visualResults.map((visual) => visual.error).filter(Boolean).join('; '));

  for (const [file, original] of Object.entries(before)) assert.strictEqual(hash(file), original, file + ' foi alterado durante os testes.');
  console.log(JSON.stringify({
    ok: true,
    legacyDefault: 'multiSelect=false',
    monthDomain: { company, year, values: months.values, elapsedMs: Number(months.elapsedMs.toFixed(1)) },
    dimensionDomain: { baseCount: partyBase.values.length, contextualCount: parties.values.length, contextualWitness: parties.domainQuery.contextualWitness, queryBuildCount: parties.performance.queryBuildCount, elapsedMs: Number(parties.elapsedMs.toFixed(1)), engine: parties.engine },
    nonContiguous: { selection: ['Janeiro', 'Março'], usesIn: true, includesFebruary: false, oldAugustRangeRemoved: true, queryBuildCount: nonContiguous.body.performance.queryBuildCount, elapsedMs: Number(nonContiguous.elapsedMs.toFixed(1)) },
    clearSelection: { monthPredicateRemoved: true, elapsedMs: Number(cleared.elapsedMs.toFixed(1)) },
    combinedContext: { months: combinedFilters[monthFilter.id], party: parties.values[0], visuals: visualResults.length, elapsedMs: Number(combined.elapsedMs.toFixed(1)) },
    protectedFiles: 'inalterados'
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
