const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const canonical = (value) => String(value || '').trim().toLocaleLowerCase('pt-BR');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));

const functionalFiles = [
  'reports.json',
  'semantic_model.json',
  'transform_queries.json',
  'manual_tables.json',
  'column_formats.json',
  'hidden_tables.json',
  'settings.json'
].filter((name) => fs.existsSync(path.join(dataDir, name)));

for (const name of functionalFiles) {
  const content = fs.readFileSync(path.join(dataDir, name), 'utf8');
  assert(!/faturamento2/i.test(content), `A configuracao funcional ${name} ainda referencia Faturamento2.`);
}

assert(/await migrateLegacyFaturamento2State\(\)/.test(serverSource), 'O servidor nao executa a migracao automatica dos dados persistidos ao iniciar.');
assert(/async function migrateLegacyFaturamento2State\(\)[\s\S]{0,7000}migrateImportedTableAliasReferences/.test(serverSource), 'A migracao automatica nao atualiza relatorios, modelo e transformacoes.');
assert(/migrateLegacyFaturamento2State[\s\S]{0,7000}writeColumnFormats[\s\S]{0,1200}writeSettings/.test(serverSource), 'A migracao automatica nao cobre formatos e restricoes de usuario.');
assert(/target_cache_missing/.test(serverSource), 'A migracao nao preserva as referencias legadas quando o cache de Faturamento esta ausente.');
assert(/savePgCacheMeta[\s\S]{0,1400}migrateLegacyFaturamento2State\(\)/.test(serverSource), 'A migracao nao e retomada depois da primeira sincronizacao valida de Faturamento.');
assert(serverSource.includes('var doIncremental = !forceFull && incrementalColumnValid;'), 'A sincronizacao incremental nao valida a coluna incremental antes de executar.');
assert(serverSource.includes("incrementalRebuiltFull ? 'incremental-reconcile-full' : 'incremental-window'"), 'A estrategia incremental por janela nao esta registrada no cache.');

const model = readJson('semantic_model.json');
const reportsData = readJson('reports.json');
const imported = readJson('imported_tables.json');
const reports = Array.isArray(reportsData) ? reportsData : (reportsData.reports || []);
const tables = Array.isArray(model.tables) ? model.tables : [];
const measures = Array.isArray(model.measures) ? model.measures : [];
const relationships = Array.isArray(model.relationships) ? model.relationships : [];

assert(tables.some((table) => canonical(table && table.name) === 'faturamento'), 'Faturamento nao esta no modelo semantico.');
assert(!tables.some((table) => canonical(table && table.name) === 'faturamento2'), 'Faturamento2 ainda esta nas tabelas do modelo semantico.');

const expectedMeasures = [
  'Valor Faturamento',
  'Valor Devolucao',
  'Faturamento Liquido',
  'Qtde Faturada vendas',
  'Ranking Faturamento'
];
const plain = (value) => canonical(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
for (const expected of expectedMeasures) {
  const measure = measures.find((item) => plain(item && (item.name || item.displayName)) === plain(expected));
  assert(measure, `Medida obrigatoria nao encontrada: ${expected}.`);
  assert.strictEqual(canonical(measure.table), 'faturamento', `A medida ${expected} nao pertence a Faturamento.`);
  assert(!/faturamento2/i.test(String(measure.formula || '')), `A formula da medida ${expected} ainda usa Faturamento2.`);
}

const requiredRelationships = [
  ['grupo_produto', 'codigo produto', 'codigo produto'],
  ['cliente', 'cliente', 'cliente'],
  ['empresas', 'empresa', 'empresa'],
  ['calendario', 'data', 'data emissao da nf']
];
for (const [fromTable, fromColumn, toColumn] of requiredRelationships) {
  const relationship = relationships.find((item) =>
    canonical(item && item.fromTable) === fromTable
    && plain(item && item.fromColumn) === fromColumn
    && canonical(item && item.toTable) === 'faturamento'
    && plain(item && item.toColumn) === toColumn
    && item.active !== false
  );
  assert(relationship, `Relacionamento ativo ausente: ${fromTable}[${fromColumn}] -> Faturamento[${toColumn}].`);
}

const targetImport = imported.find((table) => canonical(table && (table.name || table.sourceTable)) === 'faturamento');
assert(targetImport, 'Faturamento nao esta registrada nas tabelas importadas.');
assert.strictEqual(canonical(targetImport.sourceTable || targetImport.name), 'faturamento', 'A origem importada de Faturamento esta incorreta.');

const legacyImport = imported.find((table) => canonical(table && (table.name || table.sourceTable)) === 'faturamento2');
if (legacyImport) {
  assert.deepStrictEqual(targetImport.steps || [], legacyImport.steps || [], 'As transformacoes de Faturamento diferem das transformacoes legadas de Faturamento2.');
  assert.deepStrictEqual(targetImport.rowFilter || null, legacyImport.rowFilter || null, 'O filtro de linhas nao foi preservado em Faturamento.');
  assert.deepStrictEqual(targetImport.dateFilter || null, legacyImport.dateFilter || null, 'O filtro de data nao foi preservado em Faturamento.');
  assert.strictEqual(canonical(targetImport.incrementalColumn), canonical(legacyImport.incrementalColumn), 'A coluna incremental nao foi preservada em Faturamento.');
}

const vendas = reports.find((report) => canonical(report && report.name) === 'vendas');
assert(vendas, 'Relatorio Vendas nao encontrado.');
assert(!/faturamento2/i.test(JSON.stringify(vendas)), 'O relatorio Vendas ainda possui dependencia de Faturamento2.');
// reports.sql representa o ultimo visual selecionado e pode apontar para uma
// tabela manual (por exemplo Metas Empresa). A origem deve ser validada em cada
// visual que efetivamente declara usar Faturamento.

const vendasVisuals = Array.isArray(vendas.visuals) ? vendas.visuals : [];
for (const visual of vendasVisuals) {
  const fields = Array.isArray(visual && visual.selectedFields) ? visual.selectedFields : [];
  const usesFaturamento = canonical(visual && visual.table) === 'faturamento'
    || fields.some((field) => canonical(field && field.table) === 'faturamento');
  if (!usesFaturamento) continue;
  if (String(visual.sql || '').trim()) {
    assert(/FROM\s+`?faturamento`?\s+src\b/i.test(String(visual.sql)), `O visual ${visual.id || '(sem id)'} nao consulta Faturamento.`);
  }
}

console.log(`Migracao validada: ${expectedMeasures.length} medidas, ${requiredRelationships.length} relacionamentos e ${vendasVisuals.length} visuais de Vendas sem dependencia funcional de Faturamento2.`);
