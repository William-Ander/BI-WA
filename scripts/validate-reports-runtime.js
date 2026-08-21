const fs = require('fs');
const assert = require('assert');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
const access = settings.access || {};

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 300)));
  return body;
}

async function main() {
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: access.adminUser, password: access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
  const results = [];
  for (const report of reports) {
    const runtimeFilters = {};
    for (const filter of Array.isArray(report.onlineFilters) ? report.onlineFilters : []) {
      const requiredPages = Array.isArray(filter.requiredPageIds) ? filter.requiredPageIds.map(String) : [];
      const activePage = report.pages && report.pages[0] && String(report.pages[0].id) || 'page_1';
      if (!requiredPages.includes(activePage)) continue;
      const options = await request('/api/filter-options?table=' + encodeURIComponent(filter.table) + '&field=' + encodeURIComponent(filter.field), { headers });
      if (Array.isArray(options.values) && options.values.length) runtimeFilters[filter.id || filter.key || filter.field] = String(options.values[0]);
    }
    const startedAt = Date.now();
    const response = await request('/api/reports/' + report.id + '/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filters: runtimeFilters, crossFilters: [], pageId: report.pages && report.pages[0] && report.pages[0].id || 'page_1' })
    });
    const result = response.result || response;
    const visuals = Array.isArray(result.visualResults) ? result.visualResults : [];
    const reportResult = {
      report: report.name || report.title || report.id,
      elapsedMs: Date.now() - startedAt,
      visuals: visuals.length,
      rows: visuals.reduce((total, visual) => total + (Array.isArray(visual.rows) ? visual.rows.length : 0), 0),
      errors: visuals.map((visual) => visual.error).filter(Boolean)
    };
    if (String(report.name || '').toLocaleLowerCase('pt-BR') === 'gerencial') {
      const companyFilter = (report.onlineFilters || []).find((filter) => filter.field === 'Fantasia');
      assert(companyFilter, 'Filtro Empresa do Gerencial não encontrado.');
      const companyOptions = await request('/api/filter-options?table=' + encodeURIComponent(companyFilter.table) + '&field=' + encodeURIComponent(companyFilter.field), { headers });
      const expectedCompanies = (companyOptions.values || []).filter((value) => /(?:CD|LOJA)$/i.test(String(value)));
      reportResult.companyFilters = [];
      for (const company of expectedCompanies) {
        const companyStartedAt = Date.now();
        const companyResponse = await request('/api/reports/' + report.id + '/run', {
          method: 'POST',
          headers,
          body: JSON.stringify({ filters: { [companyFilter.id || companyFilter.key]: String(company) }, crossFilters: [], pageId: 'page_1' })
        });
        const companyVisual = companyResponse.result && companyResponse.result.visualResults && companyResponse.result.visualResults[0];
        assert(companyVisual && !companyVisual.error, 'Gerencial falhou para ' + company + ': ' + (companyVisual && companyVisual.error || 'visual ausente'));
        assert(Array.isArray(companyVisual.rows) && companyVisual.rows.length > 0, 'Gerencial ficou sem linhas para ' + company + '.');
        const valueField = (companyVisual.selectedFields || []).find((field) => field.name === 'Valor compras 1 e 3');
        assert(valueField && valueField.displayName === 'Valor Compras', 'O título visual da medida deve ser Valor Compras.');
        assert(companyVisual.rows.some((row) => Number(row['Valor compras 1 e 3']) !== 0), 'A medida Valor Compras ficou sem valores para ' + company + '.');
        reportResult.companyFilters.push({ company, elapsedMs: Date.now() - companyStartedAt, rows: companyVisual.rows.length, total: companyVisual.totals && companyVisual.totals['Valor compras 1 e 3'] });
      }
    }
    results.push(reportResult);
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
