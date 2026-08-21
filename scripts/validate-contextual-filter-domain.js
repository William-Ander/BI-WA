'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
const reportsFile = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reports.json'), 'utf8'));
const transformsFile = JSON.parse(fs.readFileSync(path.join(root, 'data', 'transform_queries.json'), 'utf8'));
const reports = Array.isArray(reportsFile) ? reportsFile : reportsFile.reports || [];
const transforms = Array.isArray(transformsFile) ? transformsFile : transformsFile.queries || transformsFile.transforms || [];

function canonical(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, { ...options, signal: options.signal || AbortSignal.timeout(120000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert(response.ok, pathname + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return body;
}

async function login(username, password, accessMode) {
  const body = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, accessMode })
  });
  return { authorization: 'Bearer ' + body.token };
}

async function domain(headers, table, field, contextFilters = null) {
  const query = new URLSearchParams({ table, field });
  if (contextFilters && Object.keys(contextFilters).length) query.set('contextFilters', JSON.stringify(contextFilters));
  return request('/api/filter-options?' + query.toString(), { headers });
}

function assertContextualResponse(body, label) {
  assert(Array.isArray(body.values), label + ': domínio ausente.');
  assert.strictEqual(body.domainQuery && body.domainQuery.contextualSemiJoin, true, label + ': consulta não usou existência contextual.');
  assert(body.domainQuery.contextualWitness, label + ': tabela fato testemunha ausente.');
  assert.strictEqual(body.cacheEngine, 'postgres-contextual-domain', label + ': engine contextual incorreto.');
  assert(Number(body.performance && body.performance.queryBuildCount) <= 1, label + ': domínio executou N+1.');
}

function sourceContracts() {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert(server.includes('function findFilterDomainWitnessPlan'), 'Planejador contextual de domínio ausente.');
  assert(server.includes('tryLoadViaContextualWitnessPg'), 'Execução set-based do domínio contextual ausente.');
  assert(server.includes("values._engine = 'postgres-contextual-domain'"), 'Engine contextual não é identificada.');
  assert(server.includes('getPgEffectiveMeta(target)'), 'Domínio não parte da tabela lógica efetiva após Transformar.');
  assert(server.includes("reason: 'self-filter'"), 'Self-filter não é separado do contexto permanente.');
  assert(server.includes("entry.origin === 'security'"), 'SecurityContext não participa do planejamento contextual.');
  assert(app.includes("FILTER_OPTIONS_CLIENT_CACHE_PREFIX = 'biwa.filter.options.v7:'"), 'Cache antigo do domínio não foi invalidado no cliente.');
  assert(!/REDE MERCANTIL|Grupo Cliente|Cliente e Fornecedor/.test(server), 'Cenário real foi hardcoded no servidor.');
  assert(!/filterDirection\s*=|\.filterDirection\s*=/.test(server.slice(server.indexOf('function findFilterDomainWitnessPlan'), server.indexOf('function relationshipColumnForTarget'))), 'Planejador alterou a direção dos relacionamentos.');
}

async function validateWith(headers, identity) {
  const groupTable = 'Cliente e Fornecedor';
  const groupField = 'Grupo Cliente';
  const mercantil = 'REDE MERCANTIL';
  const january = { 'Calendario.Ano': '2026', 'Calendario.MesNome': 'Janeiro' };
  const august = { 'Calendario.Ano': '2026', 'Calendario.MesNome': 'Agosto' };
  const companyJanuary = { ...january, 'Empresas.Empresa': '1' };
  const companyAugust = { ...august, 'Empresas.Empresa': '1' };

  const base = await domain(headers, groupTable, groupField);
  const jan = await domain(headers, groupTable, groupField, january);
  const aug = await domain(headers, groupTable, groupField, august);
  const companyJan = await domain(headers, groupTable, groupField, companyJanuary);
  const companyAug = await domain(headers, groupTable, groupField, companyAugust);
  [jan, aug, companyJan, companyAug].forEach((body, index) => assertContextualResponse(body, identity + ' caso ' + index));

  assert(base.values.includes(mercantil), identity + ': Transformar retirou Mercantil do conjunto permanente de teste.');
  assert(jan.values.includes(mercantil), identity + ': Mercantil não apareceu no mês com movimento.');
  assert(!aug.values.includes(mercantil), identity + ': Mercantil apareceu no mês sem movimento.');
  assert(companyJan.values.includes(mercantil), identity + ': Empresa 1 + Janeiro perdeu Mercantil.');
  assert(!companyAug.values.includes(mercantil), identity + ': Empresa 1 + Agosto incluiu Mercantil sem movimento.');

  const allowed = new Set(base.values.map(String));
  for (const response of [jan, aug, companyJan, companyAug]) {
    assert(response.values.every((value) => allowed.has(String(value))), identity + ': domínio contextual ultrapassou Transformar.');
  }

  const self = await domain(headers, groupTable, groupField, { ...january, [groupTable + '.' + groupField]: 'REDE G BARBOSA' });
  assert.deepStrictEqual(self.values, jan.values, identity + ': a seleção do próprio slicer prendeu o domínio.');
  assert(Number(self.domainQuery.excludedSelfFilters) >= 1 || self.performance.cacheHit === true, identity + ': exclusão do self-filter não foi diagnosticada.');

  const clientJanuary = await domain(headers, groupTable, 'Cliente e Fornecedor', january);
  const clientAugust = await domain(headers, groupTable, 'Cliente e Fornecedor', august);
  assertContextualResponse(clientJanuary, identity + ' Cliente/Janeiro');
  assertContextualResponse(clientAugust, identity + ' Cliente/Agosto');
  assert.notDeepStrictEqual(clientJanuary.values, clientAugust.values, identity + ': Cliente não respondeu ao período.');

  const productJanuary = await domain(headers, 'Grupo_Produto', 'Grupo Pai', january);
  const productAugust = await domain(headers, 'Grupo_Produto', 'Grupo Pai', august);
  assertContextualResponse(productJanuary, identity + ' Produto/Janeiro');
  assertContextualResponse(productAugust, identity + ' Produto/Agosto');
  assert.notDeepStrictEqual(productJanuary.values, productAugust.values, identity + ': Produto não respondeu ao período.');

  const cachedAugust = await domain(headers, groupTable, groupField, companyAugust);
  assert.strictEqual(cachedAugust.performance && cachedAugust.performance.cacheHit, true, identity + ': cache contextual não reutilizou a chave exata.');
  assert.deepStrictEqual(cachedAugust.values, companyAug.values, identity + ': cache alterou o domínio contextual.');

  return {
    identity,
    witness: jan.domainQuery.contextualWitness,
    januaryGroups: jan.values.length,
    augustGroups: aug.values.length,
    companyJanuaryGroups: companyJan.values.length,
    companyAugustGroups: companyAug.values.length,
    mercantilJanuary: true,
    mercantilAugust: false,
    clientJanuary: clientJanuary.values.length,
    clientAugust: clientAugust.values.length,
    productJanuary: productJanuary.values.length,
    productAugust: productAugust.values.length,
    queryBuildCount: Math.max(...[jan, aug, companyJan, companyAug].map((item) => Number(item.performance.queryBuildCount || 0))),
    cachedDurationMs: Number(cachedAugust.performance.durationMs || 0)
  };
}

async function main() {
  sourceContracts();
  const gerencial = reports.find((report) => canonical(report.name) === 'gerencial');
  assert(gerencial, 'Relatório Gerencial ausente.');
  assert((gerencial.onlineFilters || []).some((filter) => canonical(filter.table) === canonical('Cliente e Fornecedor') && canonical(filter.field) === canonical('Grupo Cliente')), 'Filtro Grupo Cliente ausente no Gerencial.');
  const transform = transforms.find((item) => canonical(item.name) === canonical('Cliente e Fornecedor'));
  assert(transform, 'Transformação Cliente e Fornecedor ausente.');
  const groupStep = (transform.steps || []).find((step) => canonical(step.kind) === 'filterrows' && canonical(step.column) === canonical('Grupo Cliente'));
  assert(groupStep, 'Filtro de linha de Grupo Cliente não está persistido em Transformar.');

  const adminHeaders = await login(settings.access.adminUser, settings.access.adminPassword, 'admin');
  const results = [await validateWith(adminHeaders, 'Administrador')];
  const viewerUser = process.env.BIWA_TEST_VIEWER_USER;
  const viewerPassword = process.env.BIWA_TEST_VIEWER_PASSWORD;
  if (viewerUser && viewerPassword) {
    results.push(await validateWith(await login(viewerUser, viewerPassword, 'viewer'), 'Visualizador'));
  }

  console.log(JSON.stringify({
    ok: true,
    transformId: transform.id,
    transformVersion: transform.updatedAt || transform.version || '',
    transformStep: { kind: groupStep.kind, column: groupStep.column, operator: groupStep.operator },
    results,
    selfFilterRemoved: true,
    transformPreserved: true,
    securityContextPreserved: true,
    relationshipDirectionsChanged: false,
    nPlusOne: false,
    productionHardcode: false
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
