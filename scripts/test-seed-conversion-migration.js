'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const functionMatch = server.match(/async function mergeSeedConversionKgModeling\(\) \{[\s\S]*?\n\}\n\nasync function ensureStore/);
if (!functionMatch) throw new Error('A migracao mergeSeedConversionKgModeling nao foi encontrada.');
const functionSource = functionMatch[0].replace(/\n\nasync function ensureStore$/, '');

const seedTables = JSON.parse(fs.readFileSync(path.join(root, 'data', 'imported_tables.json'), 'utf8'));
const activeTables = JSON.parse(JSON.stringify(seedTables));
const canonical = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const billing = activeTables.find((item) => canonical(item && item.name) === 'faturamento');
const receipt = activeTables.find((item) => canonical(item && item.name) === 'recebimento');
if (!billing || !receipt) throw new Error('As tabelas de teste nao foram encontradas.');

billing.steps = (billing.steps || []).filter((step) => !(step && step.kind === 'daxColumn' && canonical(step.newName) === 'conversao kg'));
billing.steps.push({ kind: 'fillValues', column: 'Conversão KG', value: '1' });
const receiptStep = (receipt.steps || []).find((step) => step && step.kind === 'daxColumn' && canonical(step.newName) === 'conversao kg');
receiptStep.expression = "Conversão KG = IF('Recebimento'[Unidade] IN { \"KG\", \"UN\" }, 1, LOOKUPVALUE('Conversao'[Valor Conversão], 'Conversao'[Unidade Origem], 'Recebimento'[Unidade], 'Conversao'[Unidade Destino], \"KG\"))";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'biwa-seed-conversion-test-'));
fs.mkdirSync(path.join(tempRoot, 'dados-iniciais-publicacao'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'dados-iniciais-publicacao', 'imported_tables.json'), JSON.stringify(seedTables), 'utf8');

let savedTables = null;
const context = {
  fs: fs.promises,
  path,
  __dirname: tempRoot,
  console: { log() {}, error() {} },
  readImportedTables: async () => activeTables,
  writeImportedTables: async (tables) => { savedTables = JSON.parse(JSON.stringify(tables)); },
  normalizeTransformStep: (step) => JSON.parse(JSON.stringify(step)),
  parseDaxColumnDefinition: (formula) => ({ name: String(formula || '').split('=')[0].trim() }),
  clearQueryCache() {},
  resourceListCache: null
};

(async () => {
  try {
    vm.runInNewContext(functionSource, context);
    const result = await context.mergeSeedConversionKgModeling();
    if (!result.changed || !savedTables) throw new Error('A migracao nao alterou a configuracao antiga.');
    const savedBilling = savedTables.find((item) => canonical(item && item.name) === 'faturamento');
    const savedReceipt = savedTables.find((item) => canonical(item && item.name) === 'recebimento');
    const savedBillingStep = (savedBilling.steps || []).find((step) => step && step.kind === 'daxColumn' && canonical(step.newName) === 'conversao kg');
    const savedReceiptStep = (savedReceipt.steps || []).find((step) => step && step.kind === 'daxColumn' && canonical(step.newName) === 'conversao kg');
    if (!savedBillingStep || savedBillingStep.replaceExisting !== true) throw new Error('Faturamento nao recebeu a regra DAX de substituicao.');
    if ((savedBilling.steps || []).some((step) => step && step.kind === 'fillValues' && canonical(step.column) === 'conversao kg')) throw new Error('O preenchimento constante com 1 permaneceu em Faturamento.');
    if (!/\[Unidade\]\s*=\s*"CX"/i.test(savedReceiptStep && savedReceiptStep.expression || '')) throw new Error('Recebimento nao recebeu a excecao da unidade CX.');
    if ((savedBilling.steps || []).filter((step) => step && step.kind === 'changeType').length !== (billing.steps || []).filter((step) => step && step.kind === 'changeType').length) throw new Error('A migracao removeu formatacoes existentes.');
    console.log('Migracao online da Conversao KG validada sem substituir as demais etapas.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
