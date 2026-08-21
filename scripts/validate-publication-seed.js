const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, 'instalar no servidor');
const sourceData = path.join(root, 'data');
const seedData = path.join(packageRoot, 'dados-iniciais-publicacao');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (value) => String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');

const sourceTransforms = readJson(path.join(sourceData, 'transform_queries.json'));
const seededTransforms = readJson(path.join(seedData, 'transform_queries.json'));
const sourceManualNames = readJson(path.join(sourceData, 'manual_tables.json'));
const manualSnapshot = readJson(path.join(seedData, 'manual_tables.snapshot.json'));
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const deployGuide = fs.readFileSync(path.join(root, 'ATUALIZAR_SERVIDOR_BI_WA.txt'), 'utf8');

assert.strictEqual(hash(seededTransforms), hash(sourceTransforms), 'O pacote nao contem as definicoes atuais de transformacao.');
assert.strictEqual(manualSnapshot.format, 'biwa-manual-tables-v1', 'Snapshot manual com formato invalido.');
assert(Array.isArray(manualSnapshot.tables), 'Snapshot manual sem tabelas.');
assert.strictEqual(manualSnapshot.tables.length, sourceManualNames.length, 'Snapshot manual nao contem todas as tabelas manuais registradas.');
assert.deepStrictEqual(
  manualSnapshot.tables.map((table) => key(table.name)).sort(),
  sourceManualNames.map(key).sort(),
  'Nomes das tabelas manuais divergem entre origem e pacote.'
);
assert(manualSnapshot.tables.every((table) => Array.isArray(table.columns) && table.columns.length && Array.isArray(table.rows)), 'Snapshot manual sem estrutura ou linhas.');
assert(manualSnapshot.tables.every((table) => table.rows.length <= 5000), 'Snapshot manual excede o limite por tabela.');
assert(manualSnapshot.tables.reduce((total, table) => total + table.rows.length, 0) <= 25000, 'Snapshot manual excede o limite total.');
const financialDiscount = manualSnapshot.tables.find((table) => key(table.name) === key('Desconto Financeiro'));
assert(financialDiscount && financialDiscount.columns.length && Array.isArray(financialDiscount.rows), 'Desconto Financeiro nao esta completo no snapshot manual.');
assert(/async function mergeMissingSeedTransforms\(\)/.test(serverSource), 'Servidor nao mescla transformacoes ausentes do pacote.');
assert(/!existingIds\.has[\s\S]{0,180}!existingNames\.has/.test(serverSource), 'Mesclagem de transformacoes nao protege ids e nomes existentes.');
assert(/async function mergeMissingSeedManualTables\(\)/.test(serverSource), 'Servidor nao mescla tabelas manuais ausentes do pacote.');
assert(/syncManualTableSnapshots\(missing\)/.test(serverSource), 'Mesclagem manual nao limita a importacao aos itens ausentes.');
assert(/incluindo dados-iniciais-publicacao/i.test(deployGuide), 'Guia de deploy nao exige a pasta de seeds.');
assert(/nao substitui transformacoes nem tabelas manuais ja registradas/i.test(deployGuide), 'Guia de deploy nao documenta a protecao contra sobrescrita.');

console.log(JSON.stringify({
  ok: true,
  transforms: sourceTransforms.length,
  manualTables: manualSnapshot.tables.length,
  manualRows: manualSnapshot.tables.reduce((total, table) => total + table.rows.length, 0),
  descontoFinanceiroRows: financialDiscount.rows.length,
  missingOnlyMerge: true
}, null, 2));
