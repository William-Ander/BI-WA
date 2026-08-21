const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
const protectedFiles = ['data/reports.json', 'data/semantic_model.json', 'data/transform_queries.json', 'data/settings.json'];
const hashesBefore = Object.fromEntries(protectedFiles.map((file) => [file, sha256(file)]));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizeWidth(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(32, Math.min(1200, Math.round(numeric))) : null;
}

function resolveWidth(field, style, renderKey, legacyBug) {
  const widths = style && style.columnWidths || {};
  const fieldWidth = normalizeWidth(field && field.width);
  const instanceWidth = normalizeWidth(widths[field && field.instanceId]);
  const renderWidth = normalizeWidth(widths[renderKey]);
  const sourceWidth = normalizeWidth(widths[field && field.name]);
  if (instanceWidth !== null) return instanceWidth;
  const savedReportWidth = renderWidth ?? sourceWidth;
  if (fieldWidth === 32 && savedReportWidth !== null && savedReportWidth !== 32) return savedReportWidth;
  return legacyBug ? savedReportWidth ?? fieldWidth : fieldWidth ?? savedReportWidth;
}

function hasLegacyBug(fields, style) {
  return fields.length >= 2
    && fields.every((field) => normalizeWidth(field.width) === 32)
    && Object.values(style && style.columnWidths || {}).some((width) => normalizeWidth(width) !== null && normalizeWidth(width) !== 32);
}

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 300)));
  return body;
}

function sourceContracts() {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');
  const resizeStart = app.indexOf("page.addEventListener('mousedown'");
  const resizeEnd = app.indexOf("page.addEventListener('dragstart'", resizeStart);
  const resizeSource = app.slice(resizeStart, resizeEnd);
  assert(app.includes("if (value === null || value === undefined || String(value).trim() === '') return null;"), 'Frontend não diferencia largura ausente de zero.');
  assert(server.includes("rawWidth !== null && rawWidth !== undefined && String(rawWidth).trim() !== ''"), 'Backend não diferencia largura ausente de zero.');
  assert(!app.includes('const rawWidth = Number(item && item.width);'), 'Conversão antiga de null para 32 ainda está ativa.');
  assert(app.includes('data-field-ref='), 'Cabeçalho não informa a identidade da instância da coluna.');
  assert(resizeSource.includes('fields[fieldIndex].width = persistedWidth'), 'Resize não persiste a largura na instância do campo.');
  const moveStart = resizeSource.indexOf('const move =');
  const upStart = resizeSource.indexOf('const up =');
  assert(!resizeSource.slice(moveStart, upStart).includes('activeVisualForResize.style.columnWidths[colName]'), 'Resize ainda grava estado a cada pixel do movimento.');
  assert(app.includes('visualUsesLegacyMinimumWidthBug'), 'Compatibilidade para relatórios afetados por width:32 ausente.');
  assert(app.includes('preparedInstances.fieldRefs[c] || c'), 'Tabela não vincula coluna renderizada à instância.');
  assert(app.includes('fieldRef: column.fieldRef'), 'Matriz não vincula medida renderizada à instância.');
}

function unitRegressions() {
  assert.strictEqual(normalizeWidth(null), null);
  assert.strictEqual(normalizeWidth(undefined), null);
  assert.strictEqual(normalizeWidth(''), null);
  assert.strictEqual(normalizeWidth(0), 32);
  assert.strictEqual(normalizeWidth(180), 180);

  const repeatedFields = [
    { instanceId: 'measure_value', name: 'Faturamento', width: 180 },
    { instanceId: 'measure_percent', name: 'Faturamento', width: 100 }
  ];
  const repeatedStyle = { columnWidths: { measure_value: 180, measure_percent: 100 } };
  assert.strictEqual(resolveWidth(repeatedFields[0], repeatedStyle, 'Faturamento', false), 180);
  assert.strictEqual(resolveWidth(repeatedFields[1], repeatedStyle, '__biwa_instance_percent', false), 100);
  assert.strictEqual(resolveWidth({ instanceId: 'legacy_partial', name: 'Cliente', width: 32 }, { columnWidths: { Cliente: 240 } }, 'Cliente', false), 240);
  assert.strictEqual(resolveWidth({ instanceId: 'manual_minimum', name: 'Cliente', width: 32 }, { columnWidths: { manual_minimum: 32, Cliente: 240 } }, 'Cliente', false), 32);

  const events = ['save', 'reload', 'filter', 'fast-filter', 'sort', 'data-refresh', 'visual-resize', 'page-change', 'online', 'mobile'];
  const snapshots = events.map(() => repeatedFields.map((field, index) => resolveWidth(field, repeatedStyle, index ? '__biwa_instance_percent' : field.name, false)));
  snapshots.forEach((widths) => assert.deepStrictEqual(widths, [180, 100]));

  const tableVisuals = reports.flatMap((report) => (report.visuals || []).filter((visual) => ['table', 'matrix'].includes(String(visual.visualization || '').toLowerCase())).map((visual) => ({ report, visual })));
  assert(tableVisuals.length, 'Nenhum visual Tabela/Matriz encontrado.');
  const affected = tableVisuals.filter(({ visual }) => hasLegacyBug(visual.selectedFields || [], visual.style || {}));
  assert(affected.length, 'Cenário real de regressão width:32 não foi encontrado.');
  for (const { report, visual } of affected) {
    for (const field of visual.selectedFields) {
      const expected = normalizeWidth(visual.style && visual.style.columnWidths && visual.style.columnWidths[field.instanceId])
        ?? normalizeWidth(visual.style && visual.style.columnWidths && visual.style.columnWidths[field.name]);
      if (expected !== null) {
        assert.strictEqual(resolveWidth(field, visual.style, field.name, true), expected, `${report.name}: largura de ${field.name} não foi recuperada.`);
      }
    }
  }
  const legacyWithoutWidth = tableVisuals.flatMap(({ visual }) => visual.selectedFields || []).find((field) => !Object.prototype.hasOwnProperty.call(field, 'width'));
  assert(legacyWithoutWidth, 'Relatório antigo sem largura não foi encontrado para compatibilidade.');
  assert.strictEqual(normalizeWidth(legacyWithoutWidth.width), null, 'Relatório antigo ganhou largura manual artificial.');
  return { affectedVisuals: affected.length, tableVisuals: tableVisuals.length, scenarios: events.length };
}

function widthSnapshot(visual) {
  return JSON.stringify({
    fields: (visual.selectedFields || []).map((field) => ({ name: field.name, width: normalizeWidth(field.width) })),
    columnWidths: visual.style && visual.style.columnWidths || {}
  });
}

async function runtimeRegressions() {
  const access = settings.access || {};
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: access.adminUser, password: access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
  const sanitized = await request('/api/reports', { headers });
  const sanitizedReports = Array.isArray(sanitized) ? sanitized : sanitized.reports || [];
  let legacyLocation = null;
  for (const report of reports) {
    for (const visual of report.visuals || []) {
      const field = (visual.selectedFields || []).find((item) => !Object.prototype.hasOwnProperty.call(item, 'width'));
      if (field) { legacyLocation = { reportId: report.id, visualId: visual.id, field }; break; }
    }
    if (legacyLocation) break;
  }
  if (legacyLocation) {
    const sanitizedReport = sanitizedReports.find((report) => report.id === legacyLocation.reportId);
    const sanitizedVisual = sanitizedReport && (sanitizedReport.visuals || []).find((visual) => visual.id === legacyLocation.visualId);
    const sanitizedLegacy = sanitizedVisual && (sanitizedVisual.selectedFields || []).find((field) => field.name === legacyLocation.field.name && (!legacyLocation.field.table || field.table === legacyLocation.field.table));
    assert(sanitizedLegacy && sanitizedLegacy.width == null, 'API transformou largura ausente em 32 px.');
  }

  const results = [];
  for (const report of reports.filter((item) => ['vendas', 'gerencial', 'compras'].includes(String(item.name || '').toLocaleLowerCase('pt-BR')))) {
    const pages = Array.isArray(report.pages) && report.pages.length ? report.pages : [{ id: 'page_1' }];
    for (const page of pages) {
      const requiredFilters = {};
      for (const requiredFilter of report.onlineFilters || []) {
        const requiredPages = Array.isArray(requiredFilter.requiredPageIds) ? requiredFilter.requiredPageIds.map(String) : [];
        if (!requiredPages.includes(String(page.id || 'page_1'))) continue;
        const options = await request('/api/filter-options?table=' + encodeURIComponent(requiredFilter.table) + '&field=' + encodeURIComponent(requiredFilter.field), { headers });
        if (Array.isArray(options.values) && options.values.length) requiredFilters[requiredFilter.id || requiredFilter.key || requiredFilter.field] = String(options.values[0]);
      }
      const base = await request('/api/reports/' + report.id + '/run', {
        method: 'POST', headers,
        body: JSON.stringify({ filters: requiredFilters, crossFilters: [], pageId: page.id || 'page_1' })
      });
      const baseVisuals = base.result && base.result.visualResults || [];
      assert(baseVisuals.every((visual) => !visual.error), `${report.name}/${page.id}: ${baseVisuals.map((visual) => visual.error).filter(Boolean).join('; ')}`);
      const sourceVisuals = (report.visuals || []).filter((visual) => String(visual.pageId || 'page_1') === String(page.id || 'page_1'));
      for (const visual of baseVisuals.filter((item) => ['table', 'matrix'].includes(String(item.visualization || '').toLowerCase()))) {
        const source = sourceVisuals.find((item) => item.id === visual.id);
        if (source) assert.strictEqual(widthSnapshot(visual), widthSnapshot(source), `${report.name}/${page.id}: execução alterou larguras de ${visual.id}.`);
      }

      let filteredVisuals = [];
      const filter = (report.onlineFilters || []).find((item) => !item.pageId || String(item.pageId) === String(page.id));
      if (filter) {
        const options = await request('/api/filter-options?table=' + encodeURIComponent(filter.table) + '&field=' + encodeURIComponent(filter.field), { headers });
        if (Array.isArray(options.values) && options.values.length) {
          const filtered = await request('/api/reports/' + report.id + '/run', {
            method: 'POST', headers,
            body: JSON.stringify({ filters: { ...requiredFilters, [filter.id || filter.key || filter.field]: String(options.values[0]) }, crossFilters: [], pageId: page.id || 'page_1' })
          });
          filteredVisuals = filtered.result && filtered.result.visualResults || [];
          assert(filteredVisuals.every((visual) => !visual.error), `${report.name}/${page.id} filtrado: ${filteredVisuals.map((visual) => visual.error).filter(Boolean).join('; ')}`);
          for (const visual of filteredVisuals.filter((item) => ['table', 'matrix'].includes(String(item.visualization || '').toLowerCase()))) {
            const before = baseVisuals.find((item) => item.id === visual.id);
            if (before) assert.strictEqual(widthSnapshot(visual), widthSnapshot(before), `${report.name}/${page.id}: filtro alterou larguras de ${visual.id}.`);
          }
        }
      }
      results.push({ report: report.name, page: page.name || page.id, visuals: baseVisuals.length, rows: baseVisuals.reduce((total, visual) => total + (visual.rows || []).length, 0), filteredVisuals: filteredVisuals.length });
    }
  }
  return results;
}

async function main() {
  sourceContracts();
  const units = unitRegressions();
  const runtime = await runtimeRegressions();
  for (const [file, hash] of Object.entries(hashesBefore)) assert.strictEqual(sha256(file), hash, file + ' foi alterado durante os testes.');
  console.log(JSON.stringify({ sourceContracts: 'ok', unitRegressions: units, runtime, protectedFiles: 'inalterados' }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
