'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const imported = JSON.parse(fs.readFileSync(path.join(root, 'data', 'imported_tables.json'), 'utf8'));
const transforms = JSON.parse(fs.readFileSync(path.join(root, 'data', 'transform_queries.json'), 'utf8'));
const canonical = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const errors = [];

function conversionStep(tableName) {
  const table = imported.find((item) => canonical(item && item.name) === canonical(tableName));
  return table && (table.steps || []).find((step) => step && step.kind === 'daxColumn' && canonical(step.newName) === 'conversao kg');
}

function validateFormula(tableName, step) {
  const formula = String(step && step.expression || '');
  if (!step) return errors.push('A regra Conversao KG nao existe em ' + tableName + '.');
  if (!new RegExp("'" + tableName + "'\\[Unidade\\]\\s+IN\\s*\\{\\s*\"KG\"\\s*,\\s*\"UN\"", 'i').test(formula)) errors.push(tableName + ' nao mantem KG/UN como 1.');
  if (!new RegExp("'" + tableName + "'\\[Unidade\\]\\s*=\\s*\"CX\"", 'i').test(formula)) errors.push(tableName + ' nao trata a unidade generica CX separadamente.');
  if (!/'Conversao'\[Unidade Destino\]\s*,\s*"KG"/i.test(formula)) errors.push(tableName + ' nao direciona a unidade CX para KG.');
  if ((formula.match(/'Conversao'\[Unidade Origem\]/gi) || []).length < 2) errors.push(tableName + ' nao possui a busca geral para embalagens como CX12UN.');
}

const billingStep = conversionStep('Faturamento');
const receiptStep = conversionStep('Recebimento');
validateFormula('Faturamento', billingStep);
validateFormula('Recebimento', receiptStep);
if (!billingStep || billingStep.replaceExisting !== true) errors.push('Faturamento deve substituir explicitamente a coluna fisica Conversao KG.');

const billing = imported.find((item) => canonical(item && item.name) === 'faturamento');
if (billing && (billing.steps || []).some((step) => step && step.kind === 'fillValues' && canonical(step.column) === 'conversao kg')) {
  errors.push('A regra antiga que preenchia toda Conversao KG com 1 ainda existe em Faturamento.');
}

const calculated = transforms.find((item) => canonical(item && item.name) === 'faturamento e recebimento');
const calculatedFormula = String(calculated && calculated.daxExpression || '');
if (!calculatedFormula.includes('"Conversão KG", faturamento[Conversão KG]')) errors.push('A tabela calculada nao usa a Conversao KG corrigida de Faturamento.');
if (!calculatedFormula.includes('"Conversão KG", Recebimento[Conversão KG]')) errors.push('A tabela calculada nao usa a Conversao KG corrigida de Recebimento.');

if (!/step\.replaceExisting !== undefined/.test(server) || !/duplicate && !step\.replaceExisting/.test(server)) errors.push('O backend nao preserva a substituicao explicita de coluna existente.');
if (!/lookupJoins:\s*\[\]/.test(server) || !/context\.lookupJoins\.push\('LEFT JOIN \(SELECT /.test(server)) errors.push('LOOKUPVALUE ainda nao foi otimizado como juncao PostgreSQL.');
if (!/async function mergeSeedConversionKgModeling\(\)/.test(server) || !/await mergeSeedConversionKgModeling\(\)/.test(server)) errors.push('A atualizacao online nao migra a regra Conversao KG preservando os dados ativos.');
if (!/Regra Conversao KG atualizada sem ressincronizar o MySQL/.test(server)) errors.push('A migracao online pode acionar sincronizacao MySQL indevida.');

if (errors.length) {
  console.error(errors.map((error) => '- ' + error).join('\n'));
  process.exit(1);
}

console.log('Conversoes de embalagem CX12UN, CX generica, KG/UN e LOOKUPVALUE otimizado validados.');
