'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const functionMatch = server.match(/async function mergeSeedCostProductLookupModeling\(\) \{[\s\S]*?\n\}\n\nasync function ensureStore/);
if (!functionMatch) throw new Error('A migracao mergeSeedCostProductLookupModeling nao foi encontrada.');
const functionSource = functionMatch[0].replace(/\n\nasync function ensureStore$/, '');

const seedTransforms = JSON.parse(fs.readFileSync(path.join(root, 'data', 'transform_queries.json'), 'utf8'));
let activeTransforms = JSON.parse(JSON.stringify(seedTransforms));
const canonical = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const activeCombined = activeTransforms.find((item) => canonical(item && item.name) === 'faturamento e recebimento');
const seedCombined = seedTransforms.find((item) => canonical(item && item.name) === 'faturamento e recebimento');
if (!activeCombined || !seedCombined) throw new Error('A tabela calculada de teste nao foi encontrada.');

const activeCostStep = (activeCombined.steps || []).find((step) => canonical(step && step.newName) === 'custos produtos');
const seedCostStep = (seedCombined.steps || []).find((step) => canonical(step && step.newName) === 'custos produtos');
if (!activeCostStep || !seedCostStep) throw new Error('A coluna Custos Produtos de teste nao foi encontrada.');
activeCostStep.expression = `Custos Produtos =
VAR ChaveAtual = 'Faturamento e Recebimento'[Chave]
RETURN
CALCULATE(
    SELECTEDVALUE('Tabela Custos'[Valor Custo]),
    FILTER(
        'Tabela Custos',
        'Tabela Custos'[Chave] = ChaveAtual
    )
)`;
activeCombined.steps.push({ kind: 'changeType', column: 'Custos Produtos', dataType: 'decimal' });

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'biwa-seed-cost-test-'));
fs.mkdirSync(path.join(tempRoot, 'dados-iniciais-publicacao'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'dados-iniciais-publicacao', 'transform_queries.json'), JSON.stringify(seedTransforms), 'utf8');

let savedTransforms = null;
let cleared = false;
const context = {
  fs: fs.promises,
  path,
  __dirname: tempRoot,
  console: { log() {}, error() {} },
  readTransforms: async () => activeTransforms,
  writeTransforms: async (items) => {
    savedTransforms = JSON.parse(JSON.stringify(items));
    activeTransforms = savedTransforms;
    return savedTransforms;
  },
  normalizeTransformStep: (step) => step ? JSON.parse(JSON.stringify(step)) : null,
  parseDaxColumnDefinition: (formula) => ({ name: String(formula || '').split('=')[0].trim() }),
  clearQueryCache() { cleared = true; },
  resourceListCache: null
};

(async () => {
  try {
    vm.runInNewContext(functionSource, context);
    const result = await context.mergeSeedCostProductLookupModeling();
    if (!result.changed || !savedTransforms || !cleared) throw new Error('A formula legada nao foi migrada/invalida corretamente.');
    const savedCombined = savedTransforms.find((item) => canonical(item && item.name) === 'faturamento e recebimento');
    const savedCostStep = (savedCombined.steps || []).find((step) => canonical(step && step.newName) === 'custos produtos');
    if (savedCostStep.expression !== seedCostStep.expression) throw new Error('A formula segura do seed nao foi aplicada integralmente.');
    if (!(savedCombined.steps || []).some((step) => step.kind === 'changeType' && canonical(step.column) === 'custos produtos')) {
      throw new Error('A migracao removeu uma etapa nao relacionada.');
    }
    if (/ALHO|\b203\b/i.test(functionSource)) throw new Error('A migracao contem excecao hardcoded para produto.');

    savedTransforms = null;
    const secondRun = await context.mergeSeedCostProductLookupModeling();
    if (secondRun.changed || savedTransforms) throw new Error('A migracao nao e idempotente.');

    const customTransforms = JSON.parse(JSON.stringify(seedTransforms));
    const customCombined = customTransforms.find((item) => canonical(item && item.name) === 'faturamento e recebimento');
    const customStep = (customCombined.steps || []).find((step) => canonical(step && step.newName) === 'custos produtos');
    customStep.expression = "Custos Produtos = AVERAGE('Faturamento e Recebimento'[Preço Unitario Recebimento])";
    activeTransforms = customTransforms;
    savedTransforms = null;
    const customRun = await context.mergeSeedCostProductLookupModeling();
    if (customRun.changed || savedTransforms) throw new Error('Uma formula personalizada foi sobrescrita.');

    console.log('Migracao de Custos Produtos validada: generica, idempotente e preservando regras personalizadas.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
