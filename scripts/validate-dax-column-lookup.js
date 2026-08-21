const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const imported = JSON.parse(fs.readFileSync(path.join(root, 'data', 'imported_tables.json'), 'utf8'));
const errors = [];

function requireText(pattern, message) {
  if (!pattern.test(server)) errors.push(message);
}

requireText(/async function compileDaxColumnCondition\(expression, context\)/, 'Colunas DAX nao compilam condicoes.');
if (!server.includes("var inMatch = text.match(/^([\\s\\S]+?)\\s+IN\\s*\\{")) errors.push('A condicao IN com conjunto DAX nao foi implementada.');
requireText(/async function daxLookupValueExpression\(expression, context\)/, 'LOOKUPVALUE nao foi implementado para colunas DAX.');
requireText(/COUNT\(DISTINCT [^\n]+\) = 1 THEN MIN/, 'LOOKUPVALUE nao protege resultados ambiguos.');
requireText(/async function daxIfExpression\(expression, context\)/, 'IF nao foi implementado para colunas DAX.');
requireText(/\^IF\\s\*\\\(/, 'O compilador escalar nao encaminha IF.');
requireText(/\^LOOKUPVALUE\\s\*\\\(/, 'O compilador escalar nao encaminha LOOKUPVALUE.');

const canonical = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const recebimento = imported.find((item) => canonical(item && item.name) === 'recebimento');
const conversionColumn = recebimento && (recebimento.steps || []).find((step) => step && step.kind === 'daxColumn' && canonical(step.newName) === 'conversao kg');
if (!conversionColumn) errors.push('A coluna Conversao KG nao foi salva em recebimento.');
else {
  if (!/^Conversão KG\s*=\s*IF\s*\(/i.test(conversionColumn.expression || '')) errors.push('A coluna salva nao usa IF.');
  if (!/LOOKUPVALUE\s*\(/i.test(conversionColumn.expression || '')) errors.push('A coluna salva nao usa LOOKUPVALUE.');
  if (!/'Recebimento'\[Unidade\]\s+IN\s*\{/i.test(conversionColumn.expression || '')) errors.push('A coluna salva nao aplica a regra KG/UN.');
}

if (errors.length) {
  console.error(errors.map((error) => '- ' + error).join('\n'));
  process.exit(1);
}

console.log('Coluna DAX Conversao KG com IF/IN/LOOKUPVALUE validada em recebimento.');
