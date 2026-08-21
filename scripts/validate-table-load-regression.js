const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const protectedFiles = [
  'data/reports.json',
  'data/semantic_model.json',
  'data/transform_queries.json',
  'data/settings.json'
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function canonical(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function reportList(value) {
  return Array.isArray(value) ? value : (Array.isArray(value && value.reports) ? value.reports : []);
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(baseUrl + path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(180000)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert(response.ok, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 800)));
  return { body, elapsedMs: Number((performance.now() - startedAt).toFixed(2)) };
}

function fieldSnapshot(visual) {
  return (visual.selectedFields || []).map((field) => ({
    instanceId: field.instanceId || '',
    name: field.name,
    displayName: field.displayName || field.name,
    table: field.table || '',
    type: field.type || '',
    width: field.width == null ? null : Number(field.width)
  }));
}

function assertSourceContracts() {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');
  assert(app.includes('function reportRuntimeDefinitionSignature'), 'Assinatura da configuração persistida não foi implementada.');
  assert(app.includes('function cachedVisualSatisfiesConfiguration'), 'Cache não valida o contrato dos campos do visual.');
  assert(app.includes('runtimeVisual.error'), 'Cache com erro ainda pode ser tratado como resultado válido.');
  assert(app.includes('dashboardResultMatchesReportRuntime(report, result, payload)'), 'Load do relatório ainda valida somente filtros.');
  assert(app.includes("const rendersConfiguredEmptyStructure = ['table', 'matrix'].includes(v)"), 'Construtor ainda apaga a estrutura em dataset vazio.');
  assert(app.includes('if (!rows.length && !normalizeSelectedFields(visual && visual.selectedFields).length)'), 'Tabela não preserva cabeçalhos configurados sem linhas.');
  assert(app.includes('visual-table-empty-row'), 'Estado sem linhas com cabeçalhos não foi implementado.');
  assert(app.includes('if (state.editingReportId && !state.reportEditorHydrated)'), 'Autosave/salvamento não está protegido durante hidratação.');
  assert(app.includes("['table', 'matrix'].includes(visualization) && normalizeSelectedFields(visual.selectedFields).length"), 'Online ainda oculta cabeçalhos configurados sem linhas.');
  assert(server.includes('const iteratorAggregateSql = function(entry, outputName, rowAlias)'), 'Subplano genérico para medidas iteradoras adicionais está ausente.');
  assert(server.includes('const iteratorMeasures = otherMeasures.filter'), 'Medidas iteradoras ainda podem ser compiladas como agregação escalar aninhada.');
  const plannerStart = server.indexOf('const iteratorAggregateSql = function(entry, outputName, rowAlias)');
  const plannerSource = server.slice(plannerStart, plannerStart + 6500);
  assert(!/Custo|Descontado|Gerencial/.test(plannerSource), 'A correção do planner contém hardcode do cenário de reprodução.');
}

async function main() {
  const hashesBefore = Object.fromEntries(protectedFiles.map((file) => [file, sha256(file)]));
  assertSourceContracts();

  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const reports = reportList(JSON.parse(fs.readFileSync('data/reports.json', 'utf8')));
  const report = reports.find((item) => canonical(item.name || item.title) === 'gerencial');
  assert(report, 'Relatório Gerencial não encontrado.');
  const savedVisual = (report.visuals || []).find((visual) => String(visual.visualization || '').toLowerCase() === 'table');
  assert(savedVisual, 'Visual de Tabela do Relatório Gerencial não encontrado.');

  const savedFields = fieldSnapshot(savedVisual);
  assert(savedFields.length >= 2, 'Configuração persistida da Tabela está vazia ou incompleta.');
  assert(new Set(savedFields.map((field) => field.instanceId || field.name)).size === savedFields.length, 'Configuração persistida contém identidades duplicadas.');
  const savedOrder = (savedVisual.style && savedVisual.style.columnOrder || []).slice();
  assert.deepStrictEqual(savedOrder, savedFields.map((field) => field.instanceId || field.name), 'Ordem persistida diverge das instâncias salvas.');
  const savedMeasures = savedFields.filter((field) => canonical(field.type) === 'measure');
  assert(savedMeasures.length > 0, 'Configuração persistida da Tabela não contém nenhuma medida.');

  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: settings.access.adminUser,
      password: settings.access.adminPassword,
      accessMode: 'admin'
    })
  });
  const headers = {
    authorization: 'Bearer ' + login.body.token,
    'content-type': 'application/json'
  };

  const pageId = savedVisual.pageId || (report.pages && report.pages[0] && report.pages[0].id) || 'page_1';
  const requiredFilters = {};
  for (const filter of report.onlineFilters || []) {
    const requiredPages = Array.isArray(filter.requiredPageIds) ? filter.requiredPageIds.map(String) : [];
    if (filter.allowAll !== false && !requiredPages.includes(String(pageId))) continue;
    const options = await request('/api/filter-options?table=' + encodeURIComponent(filter.table) + '&field=' + encodeURIComponent(filter.field), { headers });
    const value = options.body.values && options.body.values[0];
    assert(value !== undefined, 'Filtro obrigatório sem opção: ' + (filter.label || filter.field));
    requiredFilters[filter.id || filter.key || filter.field] = String(value);
  }
  const reportRun = await request('/api/reports/' + encodeURIComponent(report.id) + '/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({ filters: requiredFilters, crossFilters: [], pageId })
  });
  const result = reportRun.body.result || reportRun.body;
  const runtimeVisual = (result.visualResults || []).find((visual) => String(visual.id) === String(savedVisual.id));
  assert(runtimeVisual, 'Tabela salva não chegou ao runtime do relatório.');
  assert(!runtimeVisual.error, 'Tabela falhou no runtime: ' + runtimeVisual.error);
  assert(runtimeVisual.rows.length > 0, 'Tabela não retornou dados no contexto padrão.');
  assert.deepStrictEqual(fieldSnapshot(runtimeVisual), savedFields, 'Runtime alterou campos, tipos, larguras ou ordem persistidos.');
  assert.deepStrictEqual(runtimeVisual.style && runtimeVisual.style.columnOrder || [], savedOrder, 'Runtime alterou columnOrder.');

  const firstRowColumns = Object.keys(runtimeVisual.rows[0] || {});
  for (const field of savedFields) {
    assert(firstRowColumns.includes(field.name), 'Dataset não projetou o campo configurado: ' + field.name);
    assert(new RegExp('AS\\s+[`"]' + field.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[`"]', 'i').test(runtimeVisual.sql || ''), 'SQL não projetou: ' + field.name);
  }
  assert(runtimeVisual.sql, 'SQL do runtime da Tabela está ausente.');
  assert(!/CROSS\s+JOIN/i.test(runtimeVisual.sql || ''), 'Foi introduzido CROSS JOIN para contornar o planner.');

  const impossibleValue = '__BIWA_REGRESSION_NO_ROWS__';
  const zeroRun = await request('/api/visual-query', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      table: savedVisual.table,
      visualId: '__table_load_zero_rows__',
      pageId,
      visualization: 'table',
      dimension: savedVisual.dimension || savedFields[0].name,
      value: savedVisual.value || savedFields.find((field) => String(field.type).toLowerCase() === 'measure')?.name || '',
      secondaryValue: savedVisual.secondaryValue || '',
      fields: savedVisual.selectedFields,
      aggregation: savedVisual.aggregation || 'SUM',
      order: savedVisual.order || 'DESC',
      filterColumn: savedFields[0].name,
      filterOperator: '=',
      filterValue: impossibleValue,
      visualFilters: savedVisual.visualFilters || [],
      pageFilters: report.pageFilters || [],
      allPagesFilters: report.allPagesFilters || [],
      page: 1,
      pageSize: 50,
      limit: 50,
      deferTotals: true,
      onlineFilters: report.onlineFilters || [],
      filters: requiredFilters,
      model
    })
  });
  assert.strictEqual(zeroRun.body.rows.length, 0, 'Filtro impossível deveria produzir zero linhas.');
  const zeroMetadata = (zeroRun.body.fields || []).map((field) => field && field.name).filter(Boolean);
  savedFields.forEach((field) => assert(zeroMetadata.includes(field.name), 'Metadata de zero linhas perdeu: ' + field.name));

  for (const [file, before] of Object.entries(hashesBefore)) {
    assert.strictEqual(sha256(file), before, file + ' foi alterado durante o diagnóstico/teste.');
  }

  console.log(JSON.stringify({
    ok: true,
    report: report.name,
    visualId: savedVisual.id,
    pipeline: {
      savedFields: savedFields.map((field) => field.displayName),
      runtimeFields: (runtimeVisual.selectedFields || []).map((field) => field.displayName || field.name),
      queryFields: (runtimeVisual.selectedFields || []).map((field) => field.name),
      sqlProjections: savedFields.map((field) => field.name),
      datasetColumns: firstRowColumns,
      columnDefinitionsSource: 'selectedFields + result metadata',
      renderedColumnsSource: 'selectedFields + result metadata'
    },
    persistence: {
      order: savedOrder,
      widths: Object.fromEntries(savedFields.map((field) => [field.displayName, field.width])),
      protectedFiles: 'inalterados'
    },
    runtime: {
      rows: runtimeVisual.rows.length,
      elapsedMs: reportRun.elapsedMs,
      requiredFilters,
      hasAdditionalIteratorPlan: /__biwa_iterator_\d+|__biwa_values_rows/.test(runtimeVisual.sql || ''),
      crossJoin: false
    },
    zeroRows: {
      rows: zeroRun.body.rows.length,
      metadataColumns: zeroMetadata,
      elapsedMs: zeroRun.elapsedMs,
      headersPreservedByRendererContract: true
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
