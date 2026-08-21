const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const formatting = fs.readFileSync(path.join(root, 'public', 'formatting.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function extractFunction(source, name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert(start >= 0, 'Funcao ausente: ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Funcao sem fechamento: ' + name);
}

const sandbox = {
  crypto,
  normalizeMeasureNameKey: (value) => String(value || '').trim().toLocaleLowerCase('pt-BR'),
  normalizeTableName: (value) => String(value || '').trim(),
  normalizeTableKey: (value) => String(value || '').trim().toLocaleLowerCase('pt-BR'),
  buildColumnFormatsForTable: () => ({})
};
vm.createContext(sandbox);
[
  'normalizeVisualQueryFieldObjects',
  'normalizeMeasureDisplayFormat',
  'semanticMeasureForVisualField',
  'publicVisualQueryFieldObjects',
  'visualRuntimeFormatFromFieldFormat',
  'visualColumnFormatsForRun'
].forEach((name) => vm.runInContext(extractFunction(server, name), sandbox));

const model = {
  measures: [
    { id: 'measure_margin', name: 'Margem', table: 'Faturamento e Recebimento', format: 'Porcentagem', decimals: 2 },
    { id: 'measure_margin_currency', name: 'Margem', table: 'Outra Tabela', format: 'Moeda', decimals: 2 }
  ]
};
const fields = [{
  instanceId: 'field_margin', measureId: 'measure_margin', name: 'Margem',
  table: 'Faturamento e Recebimento', type: 'measure'
}];
const publicFields = sandbox.publicVisualQueryFieldObjects(fields, model);
assert.deepStrictEqual(JSON.parse(JSON.stringify(publicFields[0].format)), {
  type: 'percentage', decimalPlaces: 2, prefix: '', suffix: '%', percentOfTotal: false
});

const runtimeFormats = sandbox.visualColumnFormatsForRun({ table: 'Faturamento e Recebimento', selectedFields: fields }, null, model);
assert.strictEqual(runtimeFormats.Margem.formatType, 'percentage');
assert.strictEqual(runtimeFormats.Margem.decimals, 2);
assert.strictEqual(runtimeFormats.Margem.suffix, '%');

const runtimeFormatsFromReportContext = sandbox.visualColumnFormatsForRun(
  { table: 'Faturamento e Recebimento', selectedFields: fields },
  { __biwaFormattingModel: model }
);
assert.strictEqual(runtimeFormatsFromReportContext.Margem.formatType, 'percentage', 'Execucao do visual deve preservar o modelo de formato no contexto do relatorio.');

const explicitVisualFormat = sandbox.publicVisualQueryFieldObjects([{
  ...fields[0], format: { type: 'currency', decimalPlaces: 1, prefix: 'R$ ', suffix: '' }
}], model);
assert.strictEqual(explicitVisualFormat[0].format.type, 'currency', 'Formato especifico do visual deve prevalecer sobre a medida.');

const sameNameOtherTable = sandbox.publicVisualQueryFieldObjects([{
  instanceId: 'field_margin_other', name: 'Margem', table: 'Outra Tabela', type: 'measure'
}], model);
assert.strictEqual(sameNameOtherTable[0].format.type, 'currency', 'Resolucao por tabela deve impedir colisao entre medidas de mesmo nome.');

assert(/const semanticModel = isOnlineViewerRole\(req\.authRole\) \? await readSemanticModel\(\) : null;/.test(server), 'Lista publica ainda nao materializa metadados de formato.');
assert(/publicVisualQueryFieldObjects\(v\.selectedFields, semanticModel\)/.test(server), 'Serializer publico nao envia formato resolvido por campo.');
assert(/visualInstanceColumnFormat\(field, null\)/.test(app), 'Renderer ainda ignora formato fornecido pelo contrato do visual.');
assert(/presentation:\s*\{/.test(app), 'Assinatura do cache nao inclui metadados de apresentacao.');
assert(index.includes('__BIWA_ASSET_VERSION__'), 'Assets do viewer ainda usam versao fixa.');
assert(!/app\.js\?v=3\.4\./.test(index), 'Cache-buster de app.js ainda esta fixado em uma versao antiga.');
assert(/template\.replace\(\/__BIWA_ASSET_VERSION__\/g, assetVersion\)/.test(server), 'Servidor nao materializa a versao atual nos assets do viewer.');

const formattingContext = { window: {} };
vm.createContext(formattingContext);
vm.runInContext(formatting, formattingContext);
assert.strictEqual(formattingContext.BiwaFormatting.formatNumber(0.1845, { type: 'percentage', decimalPlaces: 2, locale: 'pt-BR' }), '18,45%');
assert.strictEqual(formattingContext.BiwaFormatting.formatNumber(1234.5, { type: 'currency', decimalPlaces: 2, locale: 'pt-BR', prefix: 'R$ ' }), 'R$ 1.234,50');
assert.strictEqual(formattingContext.BiwaFormatting.formatNumber(1234.5, { type: 'decimal', decimalPlaces: 1, locale: 'pt-BR' }), '1.234,5');
assert.strictEqual(formattingContext.BiwaFormatting.formatNumber(1234.5, { type: 'integer', decimalPlaces: 0, locale: 'pt-BR' }), '1.235');

console.log(JSON.stringify({
  ok: true,
  publicMeasureFormat: publicFields[0].format,
  runtimeFormat: runtimeFormats.Margem,
  explicitVisualOverride: explicitVisualFormat[0].format.type,
  cachePresentationRevision: true,
  assetCacheRevision: true
}, null, 2));
