const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3011';
const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
const sourceModel = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));
const reportHashBefore = crypto.createHash('sha256').update(fs.readFileSync('data/reports.json')).digest('hex');

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  if (response.status !== expectedStatus) {
    throw new Error(path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  }
  return body;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceOrAddMeasure(model, measure) {
  const copy = clone(model);
  copy.measures = Array.isArray(copy.measures) ? copy.measures : [];
  const index = copy.measures.findIndex((item) => String(item.name).toLocaleLowerCase('pt-BR') === String(measure.name).toLocaleLowerCase('pt-BR'));
  if (index >= 0) copy.measures[index] = { ...copy.measures[index], ...measure };
  else copy.measures.push(measure);
  return copy;
}

function firstRowValue(response, field) {
  const row = response && Array.isArray(response.rows) && response.rows[0];
  return row ? row[field] : undefined;
}

async function main() {
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
  const apiModel = (await request('/api/model', { headers })).model;
  const results = { isblank: {}, all: {}, validation: {}, persistence: {}, layout: {} };

  for (const test of [
    { name: 'Teste ISBLANK 1', formula: 'ISBLANK(BLANK())', expected: true },
    { name: 'Teste ISBLANK 2', formula: 'ISBLANK(0)', expected: false },
    { name: 'Teste ISBLANK texto', formula: 'ISBLANK("")', expected: false }
  ]) {
    const model = replaceOrAddMeasure(apiModel, { name: test.name, displayName: test.name, table: 'Faturamento e Recebimento', formula: test.formula });
    const response = await request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({ table: 'Faturamento e Recebimento', visualization: 'card', value: test.name, aggregation: 'SUM', model, limit: 5 })
    });
    assert(response.rows.length > 0, test.name + ' não retornou linhas.');
    assert(response.rows.every((row) => row[test.name] === test.expected), test.name + ' retornou resultado incorreto.');
    results.isblank[test.name] = test.expected;
  }

  let dependencyModel = replaceOrAddMeasure(apiModel, { name: 'Base em Branco', displayName: 'Base em Branco', table: 'Faturamento e Recebimento', formula: 'BLANK()' });
  dependencyModel = replaceOrAddMeasure(dependencyModel, {
    name: 'Teste ISBLANK dependência', displayName: 'Teste ISBLANK dependência', table: 'Faturamento e Recebimento',
    formula: 'IF(ISBLANK([Base em Branco]), 0, [Base em Branco])'
  });
  for (const visualization of ['table', 'matrix']) {
    const response = await request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({
        table: 'Faturamento e Recebimento', visualization, dimension: 'Origem', value: 'Teste ISBLANK dependência',
        fields: [{ name: 'Origem', table: 'Faturamento e Recebimento' }, { name: 'Teste ISBLANK dependência', table: 'Faturamento e Recebimento' }],
        aggregation: 'SUM', model: dependencyModel, limit: 5
      })
    });
    assert(response.rows.length > 0, 'ISBLANK não retornou linhas em ' + visualization + '.');
    assert(response.rows.every((row) => Number(row['Teste ISBLANK dependência']) === 0), 'ISBLANK falhou em ' + visualization + '.');
    results.isblank[visualization] = response.rows.length;
  }

  const priceBase = (apiModel.measures || []).find((measure) => /ISBLANK/i.test(measure.formula || ''));
  assert(priceBase, 'Medida Preço Compras base não encontrada.');
  const priceDateOptions = await request('/api/filter-options?table=' + encodeURIComponent('Faturamento e Recebimento') + '&field=' + encodeURIComponent('Data Emissão') + '&limit=1', { headers });
  const priceDate = Array.isArray(priceDateOptions.values) ? priceDateOptions.values[0] : null;
  assert(priceDate, 'Não foi encontrada uma data real para testar Preço Compras base.');
  const priceResponse = await request('/api/visual-query', {
    method: 'POST', headers,
    body: JSON.stringify({
      table: 'Faturamento e Recebimento', visualization: 'card', value: priceBase.name, aggregation: 'SUM', model: apiModel, limit: 5,
      pageFilters: [{ table: 'Faturamento e Recebimento', column: 'Data Emissão', values: [String(priceDate)] }]
    })
  });
  const priceValue = Number(firstRowValue(priceResponse, priceBase.name));
  assert(Number.isFinite(priceValue), 'Preço Compras base não retornou valor numérico.');
  results.isblank.priceBase = priceValue;

  const vendas = reports.find((report) => String(report.name).toLocaleLowerCase('pt-BR') === 'vendas');
  assert(vendas, 'Relatório Vendas não encontrado.');
  const byField = Object.fromEntries((vendas.onlineFilters || []).map((filter) => [filter.field, filter]));
  assert(byField.Dia && byField.Dia.table === 'Calendario' && byField.Dia.field === 'Dia', 'Filtro de dia não usa Calendario[Dia].');
  const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const now = new Date();
  const periodFilters = { [byField.Ano.id]: String(now.getFullYear()), [byField.MesNome.id]: monthNames[now.getMonth()] };

  async function runMeta(filters) {
    const response = await request('/api/reports/' + vendas.id + '/run', {
      method: 'POST', headers,
      body: JSON.stringify({ filters, pageId: 'page_1', crossFilters: [] })
    });
    const card = (response.result.visualResults || []).find((visual) => visual.value === 'Meta Empresa');
    assert(card && !card.error && card.rows && card.rows[0], 'Card Meta Empresa falhou: ' + (card && card.error || 'ausente'));
    return Number(card.rows[0]['Meta Empresa']);
  }

  const monthlyMeta = await runMeta(periodFilters);
  assert(Number.isFinite(monthlyMeta) && monthlyMeta > 0, 'Meta mensal inválida.');
  for (const day of ['1', '2', '14', '2||14']) {
    const value = await runMeta({ ...periodFilters, [byField.Dia.id]: day });
    assert.strictEqual(value, monthlyMeta, 'ALL(Calendario[Dia]) não preservou a meta para dia ' + day + '.');
    results.all['dia_' + day] = value;
  }

  const companyOptions = await request('/api/filter-options?table=' + encodeURIComponent(byField.Fantasia.table) + '&field=' + encodeURIComponent(byField.Fantasia.field), { headers });
  if (Array.isArray(companyOptions.values) && companyOptions.values.length) {
    const company = String(companyOptions.values[0]);
    const companyBase = await runMeta({ ...periodFilters, [byField.Fantasia.id]: company });
    const companyDay = await runMeta({ ...periodFilters, [byField.Fantasia.id]: company, [byField.Dia.id]: '14' });
    assert.strictEqual(companyDay, companyBase, 'ALL removeu ou alterou o contexto de empresa.');
    results.all.company = { company, value: companyDay };
  }

  const calendarFilters = [
    { table: 'Calendario', column: 'Ano', values: [String(now.getFullYear())] },
    { table: 'Calendario', column: 'MesNome', values: [monthNames[now.getMonth()]] },
    { table: 'Calendario', column: 'Dia', values: ['14'] }
  ];
  for (const scope of ['visualFilters', 'pageFilters', 'allPagesFilters']) {
    const response = await request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({ table: 'Metas Empresa', visualization: 'card', value: 'Meta Empresa', aggregation: 'SUM', [scope]: calendarFilters, model: apiModel, limit: 5 })
    });
    assert.strictEqual(Number(firstRowValue(response, 'Meta Empresa')), monthlyMeta, 'ALL falhou em ' + scope + '.');
    results.all[scope] = monthlyMeta;
  }

  const validationCases = [
    { name: 'Medida válida com acento', formula: "AVERAGE('Faturamento e Recebimento'[Custos Produtos])", status: 200 },
    { name: 'Função inválida', formula: 'FUNCAO_EXEMPLO(BLANK())', status: 422, message: 'Função DAX ainda não suportada' },
    { name: 'Tabela inválida', formula: "SUM('Tabela Fantasma'[Valor])", status: 422, message: 'Tabela não encontrada' },
    { name: 'Coluna inválida', formula: "SUM('Faturamento e Recebimento'[Coluna Fantasma])", status: 422, message: 'Coluna não encontrada' },
    { name: 'Sintaxe inválida', formula: "SUM('Faturamento e Recebimento'[Custos Produtos]", status: 422 }
  ];
  for (const test of validationCases) {
    const model = replaceOrAddMeasure(apiModel, { name: test.name, displayName: test.name, table: 'Faturamento e Recebimento', formula: test.formula });
    const response = await request('/api/model/measures/validate', {
      method: 'POST', headers, body: JSON.stringify({ model, measureName: test.name })
    }, test.status);
    if (test.status === 200) assert(response.diagnostic.valid, test.name + ' deveria ser válida.');
    else {
      assert(response.diagnostic && !response.diagnostic.valid, test.name + ' deveria ser inválida.');
      if (test.message) assert(String(response.error).includes(test.message), test.name + ' retornou mensagem incorreta: ' + response.error);
    }
    results.validation[test.name] = response.diagnostic.status;
  }

  let circularModel = replaceOrAddMeasure(apiModel, { name: 'Circular A', displayName: 'Circular A', table: 'Faturamento e Recebimento', formula: '[Circular B]' });
  circularModel = replaceOrAddMeasure(circularModel, { name: 'Circular B', displayName: 'Circular B', table: 'Faturamento e Recebimento', formula: '[Circular A]' });
  const circular = await request('/api/model/measures/validate', {
    method: 'POST', headers, body: JSON.stringify({ model: circularModel, measureName: 'Circular A' })
  }, 422);
  assert(/circular/i.test(circular.error || ''), 'Referência circular não foi identificada.');
  results.validation.circular = circular.diagnostic.status;

  const formulasBefore = Object.fromEntries((apiModel.measures || []).map((measure) => [measure.name, measure.formula]));
  await request('/api/model/measures/refresh-status', {
    method: 'POST', headers, body: JSON.stringify({ measureName: priceBase.name })
  });
  await request('/api/model/measures/refresh-status', { method: 'POST', headers, body: JSON.stringify({}) });
  const reloadedModel = (await request('/api/model', { headers })).model;
  for (const measure of reloadedModel.measures || []) {
    assert.strictEqual(measure.formula, formulasBefore[measure.name], 'Revalidação alterou a fórmula de ' + measure.name + '.');
    assert(String(measure.diagnosticStatus || '').trim(), 'Revalidar todas não atualizou o status de ' + measure.name + '.');
    assert(String(measure.lastValidatedAt || '').trim(), 'Revalidar todas não registrou a data de ' + measure.name + '.');
  }
  const reloadedPrice = (reloadedModel.measures || []).find((measure) => measure.name === priceBase.name);
  assert(reloadedPrice && ['ok', 'ok_com_dependencia'].includes(reloadedPrice.diagnosticStatus), 'Preço Compras base permaneceu não validada.');
  results.persistence.priceStatus = reloadedPrice.diagnosticStatus;
  results.persistence.validatedAt = reloadedPrice.lastValidatedAt;

  const styles = fs.readFileSync('public/styles.css', 'utf8');
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert(/\.model-measure-cards[\s\S]{0,500}overflow-y:\s*auto/.test(styles), 'Lista de medidas não possui rolagem vertical.');
  assert(html.includes('revalidateSelectedMeasureBtn') && html.includes('revalidateAllMeasuresBtn'), 'Controles de revalidação não encontrados.');
  assert(!/FunÃ§Ã£o|nÃ£o|compilaÃ§Ã£o|validaÃ§Ã£o/.test(fs.readFileSync('server.js', 'utf8').slice(0, 750000)), 'Mensagens DAX ainda possuem mojibake.');
  results.layout.scroll = true;
  results.layout.revalidationControls = true;

  const reportHashAfter = crypto.createHash('sha256').update(fs.readFileSync('data/reports.json')).digest('hex');
  assert.strictEqual(reportHashAfter, reportHashBefore, 'Os relatórios salvos foram alterados durante a validação.');
  // A revalidacao persiste apenas status, mas o teste de regressao nao deve
  // modificar nem mesmo metadados do modelo real usado pelo aplicativo.
  fs.writeFileSync('data/semantic_model.json', JSON.stringify(sourceModel, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
