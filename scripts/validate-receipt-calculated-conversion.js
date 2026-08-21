'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const imported = JSON.parse(fs.readFileSync(path.join(root, 'data', 'imported_tables.json'), 'utf8'));
const transforms = JSON.parse(fs.readFileSync(path.join(root, 'data', 'transform_queries.json'), 'utf8'));
const canonical = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const errors = [];

const receipt = imported.find((item) => canonical(item && item.name) === 'recebimento');
const daxSteps = receipt && Array.isArray(receipt.steps) ? receipt.steps.filter((step) => step && step.kind === 'daxColumn') : [];
if (!receipt) errors.push('A tabela recebimento nao foi encontrada.');
if (daxSteps.some((step) => canonical(step.newName) === 'conversao')) errors.push('A etapa antiga Conversao ainda esta salva em recebimento.');
if (!daxSteps.some((step) => canonical(step.newName) === 'conversao kg')) errors.push('A etapa correta Conversao KG nao esta salva em recebimento.');

const calculated = transforms.find((item) => canonical(item && item.name) === 'faturamento e recebimento');
const formula = String(calculated && calculated.daxExpression || '');
if (!calculated) errors.push('A tabela calculada Faturamento e Recebimento nao foi encontrada.');
if (!/"Conversão KG"\s*,\s*faturamento\[Conversão KG\]/i.test(formula)) errors.push('O ramo Faturamento nao usa sua Conversao KG modelada.');
if (!formula.includes('"Convers\u00e3o KG", Recebimento[Convers\u00e3o KG]')) errors.push('O ramo Recebimento nao usa a coluna calculada correta.');
if (formula.includes(']]')) errors.push('A formula da tabela calculada contem colchete duplicado.');

if (errors.length) {
  console.error(errors.map((error) => '- ' + error).join('\n'));
  process.exit(1);
}

console.log('Exclusao da etapa antiga e Conversao KG da tabela calculada validadas.');
