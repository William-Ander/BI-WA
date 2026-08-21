const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const errors = [];

function requireText(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  if (start < 0 || end <= start) return '';
  return source.slice(start, end);
}

requireText(app, /data-drag-report-page=/, 'As páginas não possuem alça de arraste.');
requireText(app, /setupReportPageOrdering\(tabs\)/, 'A ordenação das páginas não é ativada após renderizar as abas.');
requireText(app, /pages:\s*ensureReportPages\(\)\.map/, 'A ordem das páginas não é incluída ao salvar o relatório.');
requireText(styles, /\.page-tab-wrap\.drop-before::before[\s\S]+\.page-tab-wrap\.drop-after::after/, 'Os indicadores visuais da ordenação de páginas estão ausentes.');

const reorderSource = extractFunction(app, 'reorderReportPages', 'setupReportPageOrdering');
if (!reorderSource) {
  errors.push('A função de reordenação das páginas não foi encontrada.');
} else {
  const sandbox = {
    state: {
      reportPages: [
        { id: 'page_a', name: 'A' },
        { id: 'page_b', name: 'B' },
        { id: 'page_c', name: 'C' }
      ]
    },
    ensureReportPages() {}
  };
  vm.runInNewContext(`${reorderSource}; this.reorderReportPages = reorderReportPages;`, sandbox);
  sandbox.reorderReportPages('page_c', 'page_a', false);
  if (sandbox.state.reportPages.map((page) => page.id).join(',') !== 'page_c,page_a,page_b') {
    errors.push('Arrastar uma página para antes de outra produz ordem incorreta.');
  }
  sandbox.reorderReportPages('page_c', 'page_b', true);
  if (sandbox.state.reportPages.map((page) => page.id).join(',') !== 'page_a,page_b,page_c') {
    errors.push('Arrastar uma página para depois de outra produz ordem incorreta.');
  }
}

requireText(server, /return\s+\{\s*type:\s*'exists',\s*prefixSql:\s*sql,\s*columnSql:\s*filterExpr,\s*suffixSql:\s*'\)'\s*\}/, 'O filtro relacionado não mantém a coluna separada do EXISTS.');
requireText(server, /wrapResolvedFilterPredicate\(condition,\s*`\$\{filterColumnSql\}\s+\$\{op\}\s+\?`\)/, 'O filtro textual relacionado ainda pode envolver o EXISTS inteiro em CAST.');
requireText(server, /function preferManySideVisualBaseTable\([\s\S]{0,1800}cardinality === 'many-to-one'[\s\S]{0,250}return normalizeTableName\(manyTable\)/, 'Tabelas e matrizes não priorizam a tabela fato no lado muitos.');
requireText(server, /function sqlForVisualRunDetails\([\s\S]{0,1400}fields:\s*visualRawFieldObjects\(visual\)[\s\S]{0,1400}table:\s*built\.table/, 'A execução não preserva as tabelas dos campos nem a tabela base efetiva.');
requireText(server, /targetTable:\s*visualQuery\.table\s*\|\|\s*visual\.table/, 'Os filtros do relatório não usam a tabela base efetiva do visual.');
requireText(server, /importedSources\s*=\s*new Set\([\s\S]{0,250}sourceTable/, 'A API não considera a tabela física das importações ao eliminar duplicados.');
requireText(server, /imported\.flatMap\(function\(item\)[\s\S]{0,250}item\.sourceTable[\s\S]{0,120}item\.physicalName/, 'O cache PostgreSQL ainda pode duplicar uma tabela importada.');

requireText(app, /sourceTable:\s*String\(\(item\s*&&\s*item\.sourceTable\)/, 'O cliente não preserva a tabela física dos recursos.');
requireText(app, /function resourceIdentityKey\(item\)[\s\S]{0,180}resource\.sourceTable\s*\|\|\s*resource\.physicalName\s*\|\|\s*resource\.name/, 'O cliente não deduplica recursos pela identidade física.');

const malformedExistsCast = /CAST\(EXISTS\s*\(/i;
const wrapperSource = extractFunction(server, 'wrapResolvedFilterPredicate', 'onlineFilterAppliesToTarget');
if (!wrapperSource) {
  errors.push('O encapsulador de predicados relacionados não foi encontrado.');
} else {
  const sandbox = {};
  vm.runInNewContext(`${wrapperSource}; this.wrapResolvedFilterPredicate = wrapResolvedFilterPredicate;`, sandbox);
  const sql = sandbox.wrapResolvedFilterPredicate(
    { type: 'exists', prefixSql: 'EXISTS (SELECT 1 WHERE ', suffixSql: ')' },
    'CAST(xf0.`Ano` AS CHAR) LIKE ?'
  );
  if (malformedExistsCast.test(sql) || sql !== 'EXISTS (SELECT 1 WHERE CAST(xf0.`Ano` AS CHAR) LIKE ?)') {
    errors.push('A composição do filtro relacionado ainda gera SQL inválido.');
  }
}

if (errors.length) {
  console.error('Validação de páginas, filtros e recursos falhou:');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}

console.log('Páginas, filtros relacionados e recursos importados validados.');
