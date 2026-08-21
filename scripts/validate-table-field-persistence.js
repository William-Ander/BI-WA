const assert = require('assert');
const fs = require('fs');

const appSource = fs.readFileSync('public/app.js', 'utf8');
const reports = JSON.parse(fs.readFileSync('data/reports.json', 'utf8'));

assert(
  /function recoverTableFieldsFromColumnOrder[\s\S]{0,2600}recoveredNames\.has\(ref\)[\s\S]{0,1200}columnOrder = recovered\.map\(visualFieldRef\)/.test(appSource),
  'A recuperacao de columnOrder ainda pode transformar o nome legado em outra instancia.'
);
const removalStart = appSource.indexOf('function removeVisualFieldState');
const removalEnd = appSource.indexOf('\nfunction ', removalStart + 20);
const removalSource = appSource.slice(removalStart, removalEnd);
assert(
  removalSource.includes('!removedRefs.has(visualFieldRef(field))') &&
  removalSource.includes('visual.style.columnOrder = remainingFields.map(visualFieldRef)'),
  'A remocao de um campo nao limpa a ordem pelas identidades das instancias.'
);
assert(
  /activeVizType === 'table'[\s\S]{0,700}columnOrder = visualOrderedSelectedFields\(visual\)\.map\(visualFieldRef\)/.test(appSource),
  'A inclusao de campo em tabela ainda mistura nome e instanceId em columnOrder.'
);

const report = reports.find((item) => String(item.name || '').toLocaleLowerCase('pt-BR') === 'gerencial');
assert(report, 'Relatorio Gerencial nao encontrado.');
const visual = (report.visuals || []).find((item) => item.id === 'vis_msoky19v_ir4lf');
assert(visual && visual.visualization === 'table', 'Visual de tabela da pagina MC nao encontrado.');

const fields = Array.isArray(visual.selectedFields) ? visual.selectedFields : [];
const refs = fields.map((field) => String(field.instanceId || field.name || ''));
assert(fields.length > 0, 'A tabela da pagina MC perdeu todas as colunas configuradas.');
assert.strictEqual(new Set(refs).size, refs.length, 'Existem instanceId repetidos no visual MC.');
assert.strictEqual(new Set(fields.map((field) => field.name)).size, fields.length, 'Existem colunas inseridas automaticamente no visual MC.');
assert.deepStrictEqual(visual.style && visual.style.columnOrder, refs, 'columnOrder nao corresponde exatamente as instancias configuradas.');
fields.forEach((field) => {
  assert(String(field.name || '').trim(), 'Existe campo configurado sem nome.');
  if (field.width != null) assert(Number(field.width) >= 32, 'Existe coluna salva com largura invisível: ' + field.name);
});

console.log(JSON.stringify({
  ok: true,
  report: report.name,
  page: 'MC',
  visual: visual.id,
  fields: fields.map((field) => field.displayName || field.name),
  instanceOrder: refs
}, null, 2));
