const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const start = server.indexOf('function splitTopLevelArgs(text)');
const end = server.indexOf('\nfunction stripOuterParentheses', start);
assert(start >= 0 && end > start, 'Nao foi possivel localizar splitTopLevelArgs no backend.');
const splitTopLevelArgs = new Function(server.slice(start, end) + '\nreturn splitTopLevelArgs;')();

const values = splitTopLevelArgs('"9.999", "0,002"');
assert(values.length === 2, 'A virgula dentro de um texto DAX foi interpretada como separador de argumentos.');
assert(values[0] === '"9.999"' && values[1] === '"0,002"', 'Os textos do conjunto IN nao foram preservados.');

const iterator = splitTopLevelArgs(`FILTER(
  'Faturamento e Recebimento',
  'Faturamento e Recebimento'[CFOP] IN {"9.999", "0,002"}
),
'Faturamento e Recebimento'[Quantidade Faturamento] * [Conversao KG]`);
assert(iterator.length === 2, 'SUMX com FILTER e texto contendo virgula perdeu sua estrutura de dois argumentos.');

assert(
  server.includes("if (ch === '\"' || ch === \"'\") { quote = ch; current += ch; continue; }"),
  'O separador DAX precisa reconhecer textos entre aspas duplas e nomes entre aspas simples.'
);
assert(
  server.includes('A medida "\' + f + \'" nao pode ser compilada:'),
  'Uma medida adicional invalida nao pode voltar a ser consultada como coluna fisica src.<medida>.'
);

console.log('Literal DAX com virgula validado: SUMX/FILTER preserva "0,002" e medidas nunca viram colunas fisicas.');
