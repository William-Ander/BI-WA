'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const imported = JSON.parse(fs.readFileSync(path.join(root, 'data', 'imported_tables.json'), 'utf8'));
const reports = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reports.json'), 'utf8'));
const errors = [];
const canonical = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const functionMatch = app.match(/function toNumber\(value\) \{[\s\S]*?\n\}/);
if (!functionMatch) errors.push('A funcao toNumber nao foi encontrada.');
else {
  const toNumber = vm.runInNewContext('(' + functionMatch[0] + ')');
  const cases = [
    ['0.336', 0.336],
    ['0.181', 0.181],
    ['1.875', 1.875],
    ['10.500', 10.5],
    ['0,336', 0.336],
    ['6.560,00', 6560],
    ['1.234.567', 1234567]
  ];
  for (const [raw, expected] of cases) {
    const actual = toNumber(raw);
    if (Math.abs(actual - expected) > 1e-12) errors.push(raw + ' foi interpretado como ' + actual + ', esperado ' + expected + '.');
  }
}

const receipt = imported.find((item) => canonical(item && item.name) === 'recebimento');
const conversionStep = receipt && (receipt.steps || []).find((step) => step && step.kind === 'daxColumn' && canonical(step.newName) === 'conversao kg');
if (!conversionStep || !/'Recebimento'\[Unidade\]\s*=\s*"CX"/i.test(conversionStep.expression || '') || !/'Conversao'\[Unidade Destino\]\s*,\s*"KG"/i.test(conversionStep.expression || '')) {
  errors.push('A unidade generica CX de recebimento nao restringe o LOOKUPVALUE ao destino KG.');
}

const billing = imported.find((item) => canonical(item && item.name) === 'faturamento');
const billingConversion = billing && (billing.steps || []).find((step) => step && step.kind === 'daxColumn' && canonical(step.newName) === 'conversao kg');
if (!billingConversion || billingConversion.replaceExisting !== true) errors.push('A Conversao KG fisica de faturamento nao foi substituida pela regra DAX.');
if (billing && (billing.steps || []).some((step) => step && step.kind === 'fillValues' && canonical(step.column) === 'conversao kg')) errors.push('Faturamento ainda preenche toda Conversao KG vazia com uma constante.');

const report = reports.find((item) => canonical(item && item.name) === 'gerencial');
const visual = report && (report.visuals || []).find((item) => (item.selectedFields || []).some((field) => canonical(field && field.name) === 'conversao kg'));
// A medida Conversao KG pode ser removida pelo usuario. Se ainda estiver no
// relatorio, preserve a regra historica de tres casas; a formatacao generica
// abaixo continua sendo validada independentemente do campo salvo.
if (visual && Number(visual.style && visual.style.numberDecimals) !== 3) errors.push('O visual Gerencial com Conversao KG nao exibe tres casas decimais.');
if (!/\^\(numeric\|number\)\$[\s\S]{0,180}delete inferred\[field\.name\]\.decimals/.test(app)) {
  errors.push('Campos numeric genericos ainda forcam duas casas e ignoram o visual.');
}

if (errors.length) {
  console.error(errors.map((error) => '- ' + error).join('\n'));
  process.exit(1);
}

console.log('Conversoes decimais, excecao CX e visual Gerencial validados.');
