const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

assert(
  /function pgDaxConcatenationOperandSql[\s\S]{0,1400}\^\[\+\-\]\?\[0-9\]\+\$[\s\S]{0,400}AS NUMERIC/.test(server),
  'A concatenacao DAX nao normaliza colunas textuais compostas apenas por digitos.'
);
assert(
  (server.match(/compiledParts\.map\(pgDaxConcatenationOperandSql\)/g) || []).length >= 2,
  'A regra de concatenacao nao esta aplicada a colunas e tabelas calculadas DAX.'
);
assert(
  /colFmt\.isText\s*\|\|\s*colFmt\.isBinary\s*\|\|\s*String\(colFmt\.type\s*\|\|\s*''\)\.toLowerCase\(\)\s*===\s*'texto'/.test(app),
  'Campos tipados como texto ainda podem cair na formatacao numerica do visual.'
);
assert(
  (server.match(/columnFormats:\s*buildColumnFormatsFromMetadata\(projection\.columns\)/g) || []).length >= 2,
  'A previa de modelagem nao devolve os tipos reais das colunas calculadas.'
);
assert(
  /previewColumnFormats\s*=\s*buildColumnFormatsFromImported\(transform\.source\)[\s\S]{0,700}columnFormats:\s*previewColumnFormats/.test(server),
  'A previa da fonte no Transformar nao devolve a formatacao textual das colunas calculadas.'
);
assert(
  /var transformVisual = \{ preserveRawFormatting: !columnFormats \}/.test(app),
  'A tela Transformar ignora o tipo Texto retornado pela modelagem.'
);

console.log('Concatenacao DAX validada: zeros de preenchimento removidos de codigos numericos e resultado textual sem separador de milhar.');
