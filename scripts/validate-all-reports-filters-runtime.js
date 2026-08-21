'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
const protectedFiles = ['data/reports.json', 'data/semantic_model.json', 'data/transform_queries.json', 'data/settings.json'];
const hashesBefore = Object.fromEntries(protectedFiles.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));

async function request(path, options = {}) {
  const started = performance.now();
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return { body, elapsedMs: performance.now() - started };
}

function currentCalendarParts() {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date());
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

async function optionValue(filter, headers) {
  if (filter.ui === 'between' || filter.operator === 'BETWEEN') return '1|31';
  const params = new URLSearchParams({ table: filter.table, field: filter.field, limit: '250' });
  const response = await request('/api/filter-options?' + params.toString(), { headers });
  const values = Array.isArray(response.body.values) ? response.body.values.map(String).filter(Boolean) : [];
  assert(values.length, 'Filtro sem opções: ' + filter.table + '[' + filter.field + ']');
  const now = currentCalendarParts();
  if (filter.table === 'Calendario' && /ano/i.test(filter.field)) return values.includes(now.year) ? now.year : values[values.length - 1];
  if (filter.table === 'Calendario' && /mesnome/i.test(filter.field)) {
    const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const current = months[Math.max(0, Number(now.month) - 1)];
    return values.includes(current) ? current : values[0];
  }
  return values[0];
}

function pagesFor(report) {
  return Array.isArray(report.pages) && report.pages.length ? report.pages : [{ id: 'page_1', name: 'Página 1' }];
}

async function runReport(report, page, filters, headers, label) {
  const response = await request('/api/reports/' + encodeURIComponent(report.id) + '/run', {
    method: 'POST', headers,
    body: JSON.stringify({ filters, crossFilters: [], pageId: page.id })
  });
  const result = response.body.result || response.body;
  const visuals = Array.isArray(result.visualResults) ? result.visualResults : [];
  assert(visuals.length, report.name + ' / ' + page.name + ' não executou visuais (' + label + ').');
  const errors = visuals.map((visual) => visual && visual.error).filter(Boolean);
  assert(!errors.length, report.name + ' / ' + page.name + ' falhou em ' + label + ': ' + errors.join('; '));
  return {
    report: report.name,
    page: page.name,
    test: label,
    elapsedMs: Number(response.elapsedMs.toFixed(1)),
    visuals: visuals.length,
    rows: visuals.reduce((sum, visual) => sum + (Array.isArray(visual.rows) ? visual.rows.length : 0), 0)
  };
}

async function main() {
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };
  const results = [];

  for (const report of reports) {
    const filters = Array.isArray(report.onlineFilters) ? report.onlineFilters : [];
    const values = new Map();
    for (const filter of filters) values.set(filter.id, await optionValue(filter, headers));
    for (const page of pagesFor(report)) {
      const required = {};
      for (const filter of filters) {
        const pageRequired = Array.isArray(filter.requiredPageIds) && filter.requiredPageIds.includes(page.id);
        if (filter.mandatory === true || pageRequired) required[filter.id || filter.key || filter.field] = values.get(filter.id);
      }
      results.push(await runReport(report, page, required, headers, 'carga base'));
      for (const filter of filters) {
        const testFilters = { ...required, [filter.id || filter.key || filter.field]: values.get(filter.id) };
        results.push(await runReport(report, page, testFilters, headers, 'filtro ' + filter.label + '=' + values.get(filter.id)));
      }
    }
  }

  for (const [file, hash] of Object.entries(hashesBefore)) {
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, file + ' foi alterado durante os testes.');
  }
  const filtersCovered = reports.reduce((sum, report) => sum + (Array.isArray(report.onlineFilters) ? report.onlineFilters.length : 0), 0);
  console.log(JSON.stringify({
    ok: true,
    reports: reports.map((report) => report.name),
    pages: reports.reduce((sum, report) => sum + pagesFor(report).length, 0),
    filtersCovered,
    executions: results.length,
    maxElapsedMs: Math.max(...results.map((item) => item.elapsedMs)),
    totalVisualExecutions: results.reduce((sum, item) => sum + item.visuals, 0),
    results
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
