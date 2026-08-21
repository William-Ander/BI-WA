'use strict';

const assert = require('assert');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));

function canonical(value) {
  return String(value == null ? '' : value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR');
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value == null ? '' : value).trim()).filter(Boolean))];
}

function stepValues(step) {
  if (Array.isArray(step && step.values) && step.values.length) return unique(step.values);
  return unique(String(step && step.value || '').split(','));
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

async function filterOptions(headers, table, field, contextFilters) {
  const params = new URLSearchParams({ table, field });
  if (contextFilters && Object.keys(contextFilters).length) params.set('contextFilters', JSON.stringify(contextFilters));
  const response = await request('/api/filter-options?' + params.toString(), { headers });
  return {
    values: unique(response.body.values),
    domainQuery: response.body.domainQuery || {},
    performance: response.body.performance || {},
    cacheEngine: response.body.cacheEngine || '',
    elapsedMs: response.elapsedMs
  };
}

function assertSameValues(actual, expected, label) {
  assert.deepStrictEqual(actual.map(canonical).sort(), expected.map(canonical).sort(), label);
}

function sourceContracts() {
  const server = fs.readFileSync('server.js', 'utf8');
  assert(server.includes('async function buildPgEffectiveTransformPipeline'), 'Pipeline efetivo de transformação ausente.');
  assert(server.includes('function pgImportedEffectiveSteps'), 'Filtros intrínsecos de tabela importada não entram no TransformContext.');
  assert(server.includes('const queryPgMeta = await getPgEffectiveMeta(queryTable)'), 'Visual Query não usa metadado da tabela lógica efetiva.');
  assert(server.includes('cacheMeta = await getPgEffectiveMeta(name)'), 'Executor SQL não resolve tabelas pelo metadado efetivo.');
  assert(server.includes("clearQueryCache('transform-change')"), 'Salvar transformação não invalida o cache de consulta.');
  assert(server.includes('effectivePipelineVersion: 2'), 'Versão da transformação não participa da assinatura da tabela lógica.');
  assert(server.includes('TransformContext ja faz parte da tabela logica efetiva'), 'VISUAL_QUERY não documenta a precedência do TransformContext.');
  assert(!server.includes('const importedFilterWhere = buildImportedTableFilterWhere'), 'VISUAL_QUERY ainda duplica o filtro intrínseco fora da tabela lógica.');
  assert(!/if\s*\(\s*(?:table|column|empresa)\s*===?\s*['"](?:Cliente e Fornecedor|Grupo Cliente|Empresas|1|3)['"]/i.test(server), 'Hardcode do cenário de reprodução encontrado no runtime.');
}

async function main() {
  sourceContracts();
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const transformsResponse = await request('/api/transforms', { headers });
  const transforms = transformsResponse.body.transforms || transformsResponse.body || [];
  const partyTransform = transforms.find((item) => canonical(item.name) === canonical('Cliente e Fornecedor'));
  assert(partyTransform, 'Transformação Cliente e Fornecedor não foi reaberta pela API.');
  const partyStep = (partyTransform.steps || []).find((step) => step.kind === 'filterRows' && canonical(step.column) === canonical('Grupo Cliente'));
  assert(partyStep, 'Filtro de Linha de Grupo Cliente não persistiu.');
  const configuredGroups = stepValues(partyStep);
  assert(configuredGroups.length >= 3, 'Cenário real não possui grupos suficientes para validar a transformação.');

  const groupDomain = await filterOptions(headers, partyTransform.name, partyStep.column);
  assert(groupDomain.values.length > 0, 'Domínio efetivo de Grupo Cliente ficou vazio.');
  const configuredKeys = new Set(configuredGroups.map(canonical));
  const unexpectedGroups = groupDomain.values.filter((value) => !configuredKeys.has(canonical(value)));
  assert.deepStrictEqual(unexpectedGroups, [], 'FILTER_DOMAIN devolveu grupos eliminados em Transformar.');
  const selfFiltered = await filterOptions(headers, partyTransform.name, partyStep.column, {
    [partyTransform.name + '.' + partyStep.column]: groupDomain.values[0]
  });
  assertSameValues(selfFiltered.values, groupDomain.values, 'Self-filter removeu o TransformContext ou prendeu o domínio.');

  const imported = JSON.parse(fs.readFileSync('data/imported_tables.json', 'utf8'));
  const companyTable = imported.find((item) => canonical(item.name) === canonical('Empresas'));
  assert(companyTable, 'Tabela importada Empresas ausente.');
  const companyStep = (companyTable.steps || []).find((step) => step.kind === 'filterRows' && canonical(step.column) === canonical('Empresa'));
  assert(companyStep, 'Filtro de Linha de Empresas não persistiu.');
  const configuredCompanies = stepValues(companyStep);
  const companyDomain = await filterOptions(headers, companyTable.name, companyStep.column);
  assertSameValues(companyDomain.values, configuredCompanies, 'Domínio Empresa não corresponde ao resultado transformado.');
  const companyNameDomain = await filterOptions(headers, companyTable.name, 'Fantasia');
  assert(companyNameDomain.values.length === configuredCompanies.length, 'Domínio Fantasia contém empresas eliminadas.');

  const visual = await request('/api/visual-query', {
    method: 'POST', headers,
    body: JSON.stringify({
      table: companyTable.name,
      visualId: '__effective_transform_companies',
      visualization: 'table',
      dimension: companyStep.column,
      value: '',
      fields: [
        { name: companyStep.column, table: companyTable.name, type: 'column' },
        { name: 'Fantasia', table: companyTable.name, type: 'column' }
      ],
      aggregation: 'SUM', order: 'ASC', page: 1, pageSize: 50, limit: 50,
      deferTotals: true, onlineFilters: [], filters: {}, model
    })
  });
  const visualCompanies = unique((visual.body.rows || []).map((row) => row[companyStep.column]));
  assertSameValues(visualCompanies, configuredCompanies, 'VISUAL_QUERY contém empresas eliminadas em Transformar.');

  const viewerResults = [];
  const onlineUsers = Array.isArray(settings.access && settings.access.onlineUsers) ? settings.access.onlineUsers : [];
  for (const user of onlineUsers.filter((item) => item && item.active !== false && item.username && item.password)) {
    const viewerLogin = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: user.password, accessMode: 'viewer' })
    });
    const viewerHeaders = { authorization: 'Bearer ' + viewerLogin.body.token };
    const viewerGroups = await filterOptions(viewerHeaders, partyTransform.name, partyStep.column);
    const viewerCompanies = await filterOptions(viewerHeaders, companyTable.name, companyStep.column);
    assertSameValues(viewerGroups.values, groupDomain.values, 'Usuário de visualização recebeu outro TransformContext para Grupo Cliente.');
    assertSameValues(viewerCompanies.values, companyDomain.values, 'Usuário de visualização recebeu outro TransformContext para Empresas.');
    const allowedReports = user.allReports
      ? reports
      : reports.filter((report) => (user.reportIds || []).map(String).includes(String(report.id)));
    assert(allowedReports.length > 0, 'Usuário de visualização não possui relatório para validar o runtime online.');
    const viewerReport = allowedReports[0];
    const viewerRun = await request('/api/reports/' + encodeURIComponent(viewerReport.id) + '/run', {
      method: 'POST', headers: { ...viewerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ filters: {}, crossFilters: [], pageId: viewerReport.pages && viewerReport.pages[0] && viewerReport.pages[0].id || 'page_1' })
    });
    const viewerVisuals = viewerRun.body.result && viewerRun.body.result.visualResults || [];
    assert(viewerVisuals.length > 0 && !viewerVisuals.some((item) => item && item.error), 'Relatório online falhou para usuário de visualização.');
    viewerResults.push({ role: user.role || 'viewer', groups: viewerGroups.values.length, companies: viewerCompanies.values, report: viewerReport.name, visuals: viewerVisuals.length });
  }

  let mutation = null;
  if (process.env.BIWA_TEST_MUTATE_TRANSFORM === '1') {
    assert.strictEqual(process.env.BIWA_TEST_ISOLATED_COPY, '1', 'Mutação só pode rodar em cópia isolada do pacote.');
    const presentGroups = groupDomain.values.slice(0, 3);
    assert.strictEqual(presentGroups.length, 3, 'São necessários três grupos presentes para o teste A/B/C -> A/C.');
    const original = JSON.parse(JSON.stringify(partyTransform));
    const saveWith = async (groups) => {
      const changed = JSON.parse(JSON.stringify(original));
      changed.steps = (changed.steps || []).map((step) => {
        if (step.kind !== 'filterRows' || canonical(step.column) !== canonical(partyStep.column)) return step;
        return { ...step, operator: 'in', value: groups.join(','), values: groups };
      });
      return request('/api/transforms', { method: 'POST', headers, body: JSON.stringify(changed) });
    };
    try {
      await saveWith(presentGroups);
      const three = await filterOptions(headers, partyTransform.name, partyStep.column);
      assertSameValues(three.values, presentGroups, 'Salvar A/B/C não atualizou a tabela lógica.');
      const reduced = [presentGroups[0], presentGroups[2]];
      await saveWith(reduced);
      const twoCold = await filterOptions(headers, partyTransform.name, partyStep.column);
      const twoWarm = await filterOptions(headers, partyTransform.name, partyStep.column);
      assertSameValues(twoCold.values, reduced, 'Salvar A/C não invalidou o domínio anterior.');
      assertSameValues(twoWarm.values, reduced, 'Cache reconstruído divergiu da transformação A/C.');
      assert(!twoCold.values.some((value) => canonical(value) === canonical(presentGroups[1])), 'Grupo B reapareceu após a alteração da transformação.');
      const reopened = await request('/api/transforms', { headers });
      const reopenedTransform = (reopened.body.transforms || reopened.body || []).find((item) => item.id === partyTransform.id);
      const reopenedStep = (reopenedTransform.steps || []).find((step) => step.kind === 'filterRows' && canonical(step.column) === canonical(partyStep.column));
      assertSameValues(stepValues(reopenedStep), reduced, 'Fechar/reabrir Transformar perdeu A/C.');
      mutation = { three: presentGroups, two: reduced, removed: presentGroups[1], cacheInvalidated: true, reopened: true };
    } finally {
      await request('/api/transforms', { method: 'POST', headers, body: JSON.stringify(original) });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    transform: {
      id: partyTransform.id,
      version: partyTransform.updatedAt,
      table: partyTransform.name,
      field: partyStep.column,
      configured: configuredGroups.length,
      effective: groupDomain.values.length,
      unexpected: unexpectedGroups,
      cacheEngine: groupDomain.cacheEngine,
      domainQuery: groupDomain.domainQuery,
      elapsedMs: Number(groupDomain.elapsedMs.toFixed(1)),
      selfFilterPreservedTransform: true
    },
    companies: {
      configured: configuredCompanies,
      domain: companyDomain.values,
      names: companyNameDomain.values,
      visualRows: visualCompanies,
      cacheEngine: companyDomain.cacheEngine
    },
    viewers: viewerResults,
    mutation,
    hardcode: false
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
