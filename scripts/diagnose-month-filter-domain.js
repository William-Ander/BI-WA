'use strict';

const assert = require('assert');
const { Client } = require('pg');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const settings = require('../data/settings.json');
const reportsFile = require('../data/reports.json');
const model = require('../data/semantic_model.json');
const reports = Array.isArray(reportsFile) ? reportsFile : reportsFile.reports;
const monthNameOrder = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function canonical(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function quoteIdent(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function monthFilter(report) {
  return (report.onlineFilters || []).find((filter) => canonical(filter.table) === 'calendario' && canonical(filter.field) === 'mesnome');
}

function companyFilter(report) {
  return (report.onlineFilters || []).find((filter) => canonical(filter.table) === 'empresas' && canonical(filter.field) === 'fantasia');
}

async function api(path, headers, options = {}) {
  const response = await fetch(baseUrl + path, { ...options, headers: options.headers || headers, signal: AbortSignal.timeout(120000) });
  const body = await response.json();
  assert(response.ok, body.error || path + ' HTTP ' + response.status);
  return body;
}

function filterOptionsPath(filter, contextFilters = null) {
  const query = new URLSearchParams({ table: filter.table, field: filter.field });
  if (filter.domainTable) query.set('domainTable', filter.domainTable);
  if (contextFilters && Object.keys(contextFilters).length) query.set('contextFilters', JSON.stringify(contextFilters));
  return '/api/filter-options?' + query.toString();
}

function filterKey(filter) {
  return filter.id || filter.key || (filter.table + '.' + filter.field);
}

async function main() {
  const selectedReports = ['Vendas', 'Compras', 'Gerencial'].map((name) => {
    const report = reports.find((item) => canonical(item.name || item.title) === canonical(name));
    assert(report, 'Relatório ausente: ' + name);
    return report;
  });
  const login = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' }),
    signal: AbortSignal.timeout(120000)
  });
  const loginBody = await login.json();
  assert(login.ok, loginBody.error || 'Falha no login de diagnóstico');
  const headers = { authorization: 'Bearer ' + loginBody.token };
  const commonCompany = 'RLS HORTIFRUTI - CD';
  const domains = [];
  for (const report of selectedReports) {
    const month = monthFilter(report);
    const company = companyFilter(report);
    assert(month, 'Filtro de Mês ausente: ' + (report.name || report.title));
    const noContext = await api(filterOptionsPath(month), headers);
    const companyContext = company
      ? await api(filterOptionsPath(month, { [company.table + '.' + company.field]: commonCompany }), headers)
      : null;
    const companyAndYearContext = company
      ? await api(filterOptionsPath(month, { [company.table + '.' + company.field]: commonCompany, 'Calendario.Ano': '2026' }), headers)
      : null;
    // O frontend remove Data/Mês/Dia do domínio do próprio navegador de Mês.
    // Esta é a requisição equivalente que o componente deve enviar.
    const currentPeriodContext = await api(filterOptionsPath(month, { 'Calendario.Ano': '2026' }), headers);
    const selfRestrictedContext = await api(filterOptionsPath(month, { 'Calendario.Ano': '2026', 'Calendario.MesNome': 'Agosto', 'Calendario.Dia': '1|31' }), headers);
    domains.push({
      report: report.name || report.title,
      monthFilter: { id: month.id, key: month.key, table: month.table, field: month.field, domainTable: month.domainTable || '', operator: month.operator, multiSelect: Boolean(month.multiSelect) },
      companyFilter: company && { id: company.id, key: company.key, operator: company.operator, requiredPageIds: company.requiredPageIds || [] },
      noContext: noContext.values,
      withCompany: companyContext && companyContext.values,
      withCompanyAndYear: companyAndYearContext && companyAndYearContext.values,
      withCurrentPeriodContext: currentPeriodContext.values,
      withSelfMonthIncluded: selfRestrictedContext.values
    });
  }

  const pg = new Client({
    host: process.env.BIWA_PG_CACHE_HOST || '127.0.0.1',
    port: Number(process.env.BIWA_PG_CACHE_PORT || 5432),
    database: process.env.BIWA_PG_CACHE_DATABASE || 'bi_wa_cache',
    user: process.env.BIWA_PG_CACHE_USER || 'biwa_cache',
    password: process.env.BIWA_PG_CACHE_PASSWORD || 'biwa_cache'
  });
  await pg.connect();
  const meta = await pg.query(`SELECT source_table, cache_table FROM biwa_cache.__biwa_cache_meta
    WHERE lower(source_table) IN ('metas empresa', 'faturamento', 'faturamento e recebimento', 'recebimento', 'empresas')
    ORDER BY source_table`);
  const metaByName = new Map(meta.rows.map((row) => [canonical(row.source_table), row]));
  const empresas = metaByName.get('empresas');
  assert(empresas, 'Metadado de Empresas ausente no cache PostgreSQL');
  const factMonths = [];
  for (const sourceName of ['Metas Empresa', 'faturamento', 'Faturamento e Recebimento', 'recebimento']) {
    const entry = metaByName.get(canonical(sourceName));
    if (!entry) continue;
    const columns = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'biwa_cache' AND table_name = $1`, [entry.cache_table]);
    const names = columns.rows.map((row) => row.column_name);
    const calendarRelationship = (model.relationships || []).find((relationship) => {
      const calendarFrom = canonical(relationship.fromTable) === 'calendario';
      const calendarTo = canonical(relationship.toTable) === 'calendario';
      return (calendarFrom && canonical(relationship.toTable) === canonical(sourceName)) ||
        (calendarTo && canonical(relationship.fromTable) === canonical(sourceName));
    });
    const relationshipDateField = calendarRelationship && (canonical(calendarRelationship.fromTable) === 'calendario'
      ? calendarRelationship.toColumn
      : calendarRelationship.fromColumn);
    const dateField = relationshipDateField || ['Data', 'Data Emissão', 'Data Emissão da NF', 'Data Recebimento'].find((name) => names.includes(name));
    if (!dateField || !names.includes('Empresa')) continue;
    const result = await pg.query(
      `SELECT to_char(date_trunc('month', src.${quoteIdent(dateField)}::date), 'YYYY-MM') AS month,
              count(*)::int AS rows
       FROM biwa_cache.${quoteIdent(entry.cache_table)} src
       WHERE src.${quoteIdent('Empresa')} IN (
         SELECT ${quoteIdent('Empresa')} FROM biwa_cache.${quoteIdent(empresas.cache_table)}
         WHERE CAST(${quoteIdent('Fantasia')} AS TEXT) LIKE $1
       )
       GROUP BY 1 ORDER BY 1`,
      ['%' + commonCompany + '%']
    );
    factMonths.push({
      table: sourceName,
      dateField,
      months2026: result.rows.filter((row) => String(row.month).startsWith('2026-'))
    });
  }
  await pg.end();
  const gerencial = domains.find((entry) => entry.report === 'Gerencial');
  for (const entry of domains) {
    assert.deepStrictEqual(entry.noContext, monthNameOrder, entry.report + ': domínio base da Calendario não contém os 12 meses em ordem.');
    assert.deepStrictEqual(entry.withCompany, monthNameOrder, entry.report + ': Empresa reduziu Calendario contra uma relação single.');
    assert.deepStrictEqual(entry.withCompanyAndYear, monthNameOrder, entry.report + ': Empresa/Ano reduziram indevidamente o domínio de Mês.');
    assert.deepStrictEqual(entry.withCurrentPeriodContext, monthNameOrder, entry.report + ': o período atual prendeu o domínio de Mês.');
    assert.deepStrictEqual(entry.withSelfMonthIncluded, monthNameOrder, entry.report + ': self-filter/Data/Dia prenderam o domínio de Mês.');
  }
  const gerencialReport = selectedReports.find((report) => canonical(report.name || report.title) === 'gerencial');
  const gerencialMonth = monthFilter(gerencialReport);
  const gerencialCompany = companyFilter(gerencialReport);
  const gerencialYear = (gerencialReport.onlineFilters || []).find((filter) => canonical(filter.table) === 'calendario' && canonical(filter.field) === 'ano');
  const gerencialTable = (gerencialReport.visuals || []).find((visual) => canonical(visual.visualization) === 'table');
  assert(gerencialTable, 'Tabela do Relatório Gerencial ausente.');
  const pageId = gerencialTable.pageId || (gerencialReport.pages && gerencialReport.pages[0] && gerencialReport.pages[0].id) || 'page_1';
  async function runGerencialMonth(month) {
    const filters = {
      [filterKey(gerencialCompany)]: commonCompany,
      [filterKey(gerencialMonth)]: month
    };
    if (gerencialYear) filters[filterKey(gerencialYear)] = '2026';
    const execution = await api('/api/reports/' + encodeURIComponent(gerencialReport.id) + '/run', headers, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ filters, crossFilters: [], pageId })
    });
    const result = execution.result || execution;
    const runtimeTable = (result.visualResults || []).find((visual) => String(visual.id) === String(gerencialTable.id));
    assert(runtimeTable && !runtimeTable.error, 'Tabela falhou ao navegar para ' + month + ': ' + (runtimeTable && runtimeTable.error || 'resultado ausente'));
    assert(Array.isArray(runtimeTable.rows) && runtimeTable.rows.length > 0, 'Tabela não retornou dados ao navegar para ' + month + '.');
    return { month, rows: runtimeTable.rows.length };
  }
  const navigation = [];
  for (const month of ['Agosto', 'Janeiro']) {
    if (gerencial.withCompanyAndYear.includes(month)) navigation.push(await runGerencialMonth(month));
  }
  assert(navigation.some((entry) => entry.month === 'Janeiro'), 'Janeiro não ficou navegável no Relatório Gerencial.');
  console.log(JSON.stringify({
    ok: true,
    domains,
    navigation,
    factMonths,
    calendarRelationships: (model.relationships || []).filter((relationship) => canonical(relationship.fromTable) === 'calendario').map((relationship) => ({ from: relationship.fromTable, to: relationship.toTable, column: relationship.toColumn }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
