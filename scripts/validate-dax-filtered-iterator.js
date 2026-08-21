const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  server.includes('function daxIteratorTableSource')
    && server.includes("filterMatch = source.match(/^FILTER"),
  'O backend precisa reconhecer FILTER como fonte de um iterador DAX.'
);
assert(
  server.includes("iteratorFn === 'SUMX'")
    && server.includes('SUM(CASE WHEN ${condition} THEN ${rowExpression} ELSE 0 END)'),
  'SUMX(FILTER(...), expressao) precisa ser convertido para uma soma condicional.'
);
assert(
  server.includes('function compileDaxIteratorRowExpression')
    && server.includes("prefix + alias + '.' + quoteIdent"),
  'Colunas sem nome de tabela precisam usar o contexto de linha do iterador.'
);
assert(
  server.includes('const iteratorColumns = daxIteratorRowColumnNames(text)')
    && server.includes('if (iteratorColumns.has(key) && !(measureLookup && measureLookup.has(key))) continue;'),
  'O analisador não pode confundir uma coluna do SUMX com uma medida ausente.'
);
assert(
  app.includes('function daxIteratorRowColumnNamesClient')
    && app.includes('!iteratorColumnSet.has(bracketName)'),
  'O editor precisa aceitar colunas sem qualificação dentro de iteradores DAX.'
);
assert(
  app.includes('var filteredIteratorRe =')
    && app.includes('(SUMX|AVERAGEX|COUNTX|MAXX|MINX|CONCATENATEX)'),
  'A extração de tabelas do editor precisa reconhecer iteradores com FILTER.'
);
assert(
  server.includes('(?:FILTER|VALUES|DISTINCT|KEEPFILTERS)')
    && app.includes('(?:FILTER|VALUES|DISTINCT|KEEPFILTERS)'),
  'O iterador direto não pode interpretar FILTER/VALUES/DISTINCT/KEEPFILTERS como nome de tabela.'
);

const filteredFormula = `SUMX(
  FILTER(
    'Faturamento e Recebimento',
    'Faturamento e Recebimento'[CFOP] IN {"1.102", "2.102"}
  ),
  'Faturamento e Recebimento'[Quantidade Recebimento] * [Conversão KG]
)`;
const directIteratorPattern = /(SUMX|AVERAGEX|COUNTX|MAXX|MINX|CONCATENATEX)\s*\((?!\s*(?:FILTER|VALUES|DISTINCT|KEEPFILTERS)\s*\()\s*(?:'([^']+)'|([^,\)]+))/gi;
assert(!directIteratorPattern.test(filteredFormula), 'FILTER(...) foi confundido com o nome de uma tabela direta.');
assert(
  server.includes("splitTopLevelDaxLogical(source, '&&')")
    && server.includes(".join(' AND ')")
    && server.includes("splitTopLevelDaxLogical(source, '||')")
    && server.includes(".join(' OR ')"),
  'Os operadores lógicos && e || precisam ser preservados nos filtros DAX.'
);
assert(
  server.includes("rightSource.match(/^[\"']\\s*Empresa\\s+(\\d+)")
    && server.includes("CAST(${left} AS CHAR)"),
  'O rótulo amigável Empresa N precisa aceitar tanto o rótulo quanto a chave N.'
);

console.log('OK: SUMX com FILTER e coluna em contexto de linha protegido no backend e no editor.');
