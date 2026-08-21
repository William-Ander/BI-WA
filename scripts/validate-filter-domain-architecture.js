'use strict';

const assert = require('assert');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
const monthOrder = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function canonical(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, { ...options, signal: options.signal || AbortSignal.timeout(120000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert(response.ok, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return { body, elapsedMs: performance.now() - startedAt };
}

async function filterOptions(headers, table, field, contextFilters = null) {
  const params = new URLSearchParams({ table, field });
  if (contextFilters && Object.keys(contextFilters).length) params.set('contextFilters', JSON.stringify(contextFilters));
  const response = await request('/api/filter-options?' + params.toString(), { headers });
  return {
    values: Array.isArray(response.body.values) ? response.body.values.map(String) : [],
    domainQuery: response.body.domainQuery || {},
    performance: response.body.performance || {},
    cacheEngine: response.body.cacheEngine || '',
    elapsedMs: response.elapsedMs
  };
}

function reportFilter(report, table, field) {
  return (report.onlineFilters || []).find((filter) => canonical(filter.table) === canonical(table) && canonical(filter.field) === canonical(field));
}

function sourceContracts() {
  const server = fs.readFileSync('server.js', 'utf8');
  const app = fs.readFileSync('public/app.js', 'utf8');
  assert(server.includes('function findFilterPropagationPath'), 'Relationship Graph dirigido não existe.');
  assert(server.includes('function findFilterDomainWitnessPlan'), 'Planejador contextual de domínio não existe.');
  assert(server.includes('tryLoadViaContextualWitnessPg'), 'Domínio contextual não usa execução set-based.');
  assert(server.includes("values._engine = 'postgres-contextual-domain'"), 'Engine do domínio contextual não está identificada.');
  assert(server.includes("reason: 'reverse-filter-not-allowed'"), 'Reverse filtering single não é bloqueado no domínio.');
  assert(server.includes("reason: 'self-filter'"), 'Self-filter não é removido da consulta de domínio.');
  assert(server.includes("queryType: 'FILTER_DOMAIN_QUERY'"), 'FILTER_DOMAIN_QUERY não está identificada separadamente.');
  assert(!server.includes('const commonFactValues = await tryLoadViaCommonFactPg()'), 'O domínio ainda usa o caminho legado por fato comum.');
  assert(!/REDE MERCANTIL|Grupo Cliente|Cliente e Fornecedor/.test(server), 'Cenário real foi hardcoded no servidor.');
  assert(app.includes("FILTER_OPTIONS_CLIENT_CACHE_PREFIX = 'biwa.filter.options.v7:'"), 'Cache antigo de opções não foi versionado.');
  assert(app.includes('invalidateFilterOptionsClientCache();'), 'Invalidação do cache do backend não limpa os domínios no viewer.');
  assert(app.includes('requestTarget.__filterOptionsAbortController.abort()'), 'Request anterior de domínio não é cancelado.');
  assert(app.includes('state.dashboardRunRequestIds[reportId] !== requestId'), 'Resposta visual antiga não é descartada.');
  assert(app.includes('await Promise.all(visuals.map(async (visual)'), 'Visuais afetados não são executados concorrentemente.');
  assert(!/reportName\s*===\s*['"]Gerencial|user\s*===\s*['"]Rodrigo|table\s*===\s*['"]Metas Empresa/i.test(server + '\n' + app), 'Foi encontrado hardcode do cenário de reprodução.');
}

async function main() {
  sourceContracts();
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token };
  const reportResults = [];
  for (const report of reports) {
    const month = reportFilter(report, 'Calendario', 'MesNome');
    const company = reportFilter(report, 'Empresas', 'Fantasia');
    assert(month, report.name + ': filtro Calendario[MesNome] ausente.');
    const companyValues = company ? await filterOptions(headers, company.table, company.field) : { values: [] };
    const companyValue = companyValues.values.find((value) => /(?:CD|LOJA)$/i.test(value)) || companyValues.values[0] || '';
    const base = await filterOptions(headers, month.table, month.field);
    const companyAndYear = await filterOptions(headers, month.table, month.field, {
      ...(companyValue && company ? { [company.table + '.' + company.field]: companyValue } : {}),
      'Calendario.Ano': '2026'
    });
    const trapped = await filterOptions(headers, month.table, month.field, {
      'Calendario.Ano': '2026',
      'Calendario.MesNome': 'Agosto',
      'Calendario.Dia': '1|31',
      ...(companyValue && company ? { [company.table + '.' + company.field]: companyValue } : {})
    });
    assert.deepStrictEqual(base.values, monthOrder, report.name + ': domínio base de Mês incorreto.');
    assert.deepStrictEqual(companyAndYear.values, monthOrder, report.name + ': Empresa/Ano reduziram a dimensão Calendario.');
    assert.deepStrictEqual(trapped.values, monthOrder, report.name + ': self-filter/Data prenderam o domínio de Mês.');
    assert(companyAndYear.performance.queryBuildCount <= 1, report.name + ': domínio gerou mais de uma consulta.');
    reportResults.push({
      report: report.name,
      months: companyAndYear.values.length,
      reversePropagation: companyAndYear.domainQuery.reversePropagation || 'CACHE',
      queryBuildCount: companyAndYear.performance.queryBuildCount,
      elapsedMs: Number(companyAndYear.elapsedMs.toFixed(1))
    });
  }

  const gerencial = reports.find((report) => canonical(report.name) === 'gerencial');
  const gerencialCompany = reportFilter(gerencial, 'Empresas', 'Fantasia');
  const companiesBase = await filterOptions(headers, gerencialCompany.table, gerencialCompany.field);
  const gerencialFact = (gerencial.visuals || []).find((visual) => canonical(visual.visualization) === 'table')?.table || 'Faturamento e Recebimento';
  const factContextField = 'Cliente e Fornecedor';
  const factContextValues = await filterOptions(headers, gerencialFact, factContextField);
  assert(factContextValues.values.length, 'Não foi possível obter um valor da fato para testar reverse filtering.');
  const companiesReverseAttempt = await filterOptions(headers, gerencialCompany.table, gerencialCompany.field, {
    [gerencialFact + '.' + factContextField]: factContextValues.values[0]
  });
  assert.deepStrictEqual(companiesReverseAttempt.values, companiesBase.values, 'A fato reduziu Empresas contra uma relação single.');

  const bothRelationship = (model.relationships || []).filter((relationship) => relationship.active !== false && canonical(relationship.filterDirection) === 'both').at(-1);
  assert(bothRelationship, 'Modelo não possui relação both para teste.');
  const reverseSource = await filterOptions(headers, bothRelationship.toTable, bothRelationship.toColumn);
  const reverseTargetBase = await filterOptions(headers, bothRelationship.fromTable, bothRelationship.fromColumn);
  assert(reverseSource.values.length, 'Relação both sem valores na coluna de origem reversa.');
  const reverseTargetValues = new Set(reverseTargetBase.values);
  const reverseValue = reverseSource.values.find((value) => reverseTargetValues.has(value));
  assert(reverseValue, 'Relação both sem chave comum disponível para o teste.');
  const reverseDomain = await filterOptions(headers, bothRelationship.fromTable, bothRelationship.fromColumn, {
    [bothRelationship.toTable + '.' + bothRelationship.toColumn]: reverseValue
  });
  assert(reverseDomain.values.includes(reverseValue), 'Relação both não propagou no sentido reverso explícito.');
  assert(reverseDomain.values.length <= reverseTargetBase.values.length, 'Relação both ampliou indevidamente o domínio.');

  const singleRelationship = (model.relationships || []).find((relationship) => relationship.active !== false && canonical(relationship.filterDirection || 'single') === 'single' && canonical(relationship.fromTable) === 'empresas');
  assert(singleRelationship, 'Relação single de Empresas não encontrada.');
  const forwardSource = await filterOptions(headers, singleRelationship.fromTable, singleRelationship.fromColumn);
  assert(forwardSource.values.length, 'Relação single sem valores na dimensão.');
  const forwardValue = forwardSource.values[0];
  const forwardDomain = await filterOptions(headers, singleRelationship.toTable, singleRelationship.toColumn, {
    [singleRelationship.fromTable + '.' + singleRelationship.fromColumn]: forwardValue
  });
  assert(forwardDomain.values.includes(forwardValue), 'Relação single não propagou da dimensão para a fato.');
  assert(forwardDomain.performance.queryBuildCount <= 1, 'Propagação single gerou N+1.');

  const cachedMonth = await filterOptions(headers, 'Calendario', 'MesNome', { 'Calendario.Ano': '2026' });
  assert.deepStrictEqual(cachedMonth.values, monthOrder, 'Cache alterou o domínio de Mês.');
  assert(cachedMonth.performance.cacheHit === true || cachedMonth.performance.queryBuildCount === 1, 'Metadado de cache/query do domínio ausente.');

  console.log(JSON.stringify({
    ok: true,
    queryType: 'FILTER_DOMAIN_QUERY',
    reports: reportResults,
    singleDirection: {
      forward: singleRelationship.fromTable + ' -> ' + singleRelationship.toTable,
      reverseFactToEmpresasBlocked: true,
      values: forwardDomain.values.length,
      queryBuildCount: forwardDomain.performance.queryBuildCount
    },
    bothDirection: {
      relationship: bothRelationship.fromTable + ' <-> ' + bothRelationship.toTable,
      reverseValuePreserved: true,
      values: reverseDomain.values.length
    },
    selfFilterRemoved: true,
    temporalConflictRemoved: true,
    monthOrder: true,
    cacheVersion: 'v7',
    staleRequests: 'AbortController + requestId',
    hardcode: false
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
