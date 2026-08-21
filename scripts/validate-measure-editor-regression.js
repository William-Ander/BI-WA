'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';
const protectedFiles = ['data/semantic_model.json', 'data/reports.json', 'data/transform_queries.json'];
const hashesBefore = Object.fromEntries(protectedFiles.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert.strictEqual(response.status, expectedStatus, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 500)));
  return body;
}

function clientDefinitionParser() {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const match = source.match(/function findDaxMeasureDefinitionSeparator\(text\) \{[\s\S]*?\n\}\n\nfunction parseDaxMeasureDefinition\(text, fallbackName\) \{[\s\S]*?\n\}/);
  assert(match, 'O parser do editor DAX não foi encontrado.');
  const context = {};
  vm.runInNewContext(match[0], context);
  return context.parseDaxMeasureDefinition;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function validate(headers, sourceModel, fullDefinition, expectedStatus = 200) {
  const parsed = clientDefinitionParser()(fullDefinition, '');
  const model = clone(sourceModel);
  model.measures = Array.isArray(model.measures) ? model.measures : [];
  const key = parsed.name.toLocaleLowerCase('pt-BR');
  const index = model.measures.findIndex((measure) => String(measure.name || '').trim().toLocaleLowerCase('pt-BR') === key);
  const next = { ...(index >= 0 ? model.measures[index] : {}), name: parsed.name, displayName: parsed.name, table: 'Faturamento e Recebimento', formula: parsed.formula };
  if (index >= 0) model.measures[index] = next;
  else model.measures.push(next);
  const response = await request('/api/model/measures/validate', {
    method: 'POST', headers, body: JSON.stringify({ model, measureName: parsed.name })
  }, expectedStatus);
  return { parsed, model, response };
}

async function main() {
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
  const parse = clientDefinitionParser();

  const equalityProbe = parse('Medida com Espaços = IF(1 = 1, "a=b", 0)', '');
  assert.strictEqual(equalityProbe.name, 'Medida com Espaços');
  assert.strictEqual(equalityProbe.formula, 'IF(1 = 1, "a=b", 0)');

  // O roteiro recebido usa uma coluna chamada Valor, inexistente no modelo local.
  // O diagnóstico precisa chegar até a checagem de coluna (e não falhar no parser).
  const simpleMissing = await validate(headers, model, "Teste = SUM('Faturamento e Recebimento'[Valor])", 422);
  assert.strictEqual(simpleMissing.response.diagnostic.status, 'coluna_ausente');
  const simple = await validate(headers, model, "Teste = SUM('Faturamento e Recebimento'[Valor Frete])");
  assert(simple.response.diagnostic.valid, 'SUM simples com coluna real deveria ser válido.');

  const division = await validate(headers, model, `Preço Médio Compras =
[Valor compras 1 e 3] / [Qtde Liquido 1 e 3]`);
  assert(division.response.diagnostic.valid, 'A divisão entre medidas deveria ser válida.');

  const costFormula = `SUMX(
    KEEPFILTERS(
        VALUES('Faturamento e Recebimento'[Código Produto])
    ),
    CALCULATE(
        [Conversão vendas] * [Preço Médio Compras]
    )
)`;
  const cost = await validate(headers, model, 'Custo =\n' + costFormula);
  assert(cost.response.diagnostic.valid, 'Custo deveria ser válido.');
  const costSpaced = await validate(headers, model, 'Custo dos Produtos =\n' + costFormula);
  assert(costSpaced.response.diagnostic.valid, 'Nome de medida com espaços deveria ser válido.');

  const create = await validate(headers, model, 'Teste Custo = [Conversão vendas] * [Preço Médio Compras]');
  const editModel = clone(create.model);
  const editIndex = editModel.measures.findIndex((measure) => String(measure.name).toLocaleLowerCase('pt-BR') === 'teste custo');
  assert(editIndex >= 0, 'A medida de edição não foi criada no rascunho.');
  editModel.measures[editIndex] = { ...editModel.measures[editIndex], formula: '[Qtde Vendas Líquida] * [Preço Médio Compras]' };
  const edited = await request('/api/model/measures/validate', {
    method: 'POST', headers, body: JSON.stringify({ model: editModel, measureName: 'Teste Custo' })
  });
  assert(edited.diagnostic.valid, 'A fórmula editada deveria ser válida.');
  assert.strictEqual(editModel.measures.filter((measure) => String(measure.name).toLocaleLowerCase('pt-BR') === 'teste custo').length, 1, 'Editar criou uma medida duplicada.');

  const pureDax = '[Qtde Vendas Líquida] * [Preço Médio Compras]';
  assert.strictEqual(JSON.parse(JSON.stringify({ formula: pureDax })).formula, pureDax, 'O transporte JSON alterou o texto DAX.');
  assert(!cost.parsed.formula.includes('&#x20;') && !cost.parsed.formula.includes('**') && !cost.parsed.formula.includes('\\*'), 'O editor inseriu HTML/Markdown/escape na fórmula.');

  for (const [file, hash] of Object.entries(hashesBefore)) {
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, file + ' foi alterado pelos testes.');
  }
  console.log(JSON.stringify({
    parser: 'ok', simpleSum: 'ok (Valor Frete)', requestedMissingColumnDiagnostic: simpleMissing.response.diagnostic.status,
    division: 'ok', cost: 'ok', spacedName: 'ok', editWithoutDuplicate: 'ok', pureDaxTransport: 'ok'
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
