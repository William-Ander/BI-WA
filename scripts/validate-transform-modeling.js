'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error('Falhou: ' + name);
}

check('daxColumn e uma etapa persistida valida', /allowed = new Set\(\[[^\]]*'daxColumn'/.test(server));
check('modelagem aceita somente DAX e preenchimento', /step\.kind === 'daxColumn' \|\| step\.kind === 'fillValues'/.test(server));
check('cache fisico e separado da view modelada', /CREATE(?: OR REPLACE)? VIEW[\s\S]*projection\.sql/.test(server) && /physical_cache_table/.test(server));
check('view modelada muda de versao quando as etapas alteram o esquema', /pgModelViewNameFor\(physical, projection\.signature\)/.test(server) && /pgModelViewPrefixFor/.test(server));
check('excluir a ultima etapa nao remove view ainda usada por tabela DAX', /if \(!projection\.steps\.length\) \{[\s\S]*pgModelViewCache\.delete\(key\);[\s\S]*return null;/.test(server));
check('consultas SQL usam metadado efetivo', /resolveSqlTableToPgCache[\s\S]*getPgEffectiveMeta\(name\)/.test(server));
check('visualizacao da tabela usa metadado efetivo', /readRowsFromPostgresCache[\s\S]*getPgEffectiveMeta\(sourceTable\)/.test(server));
check('painel de dados expoe colunas calculadas', /api\/tables\/:table\/columns[\s\S]*getPgEffectiveMeta\(cacheLookupTable\)/.test(server));
check('salvamento de modelagem nao entra no gatilho changeType', /physicalChangeTypeSteps\(previous\.steps\)[\s\S]*physicalChangeTypeSteps\(incoming\.steps\)/.test(server));
check('formula invalida restaura configuracao anterior', /current\[idx\] = previous;[\s\S]*refreshPgModelView\(previous\)/.test(server));
check('sincronizacao fisica restaura a view ao terminar', /finally[\s\S]*refreshPgModelView\(modeledImported\)/.test(server));
check('editor tem teste no PostgreSQL', /api\/transforms\/modeling\/test/.test(server) && /testTransformDaxColumn/.test(app));
check('editor DAX usa o mesmo realce de sintaxe das medidas', /transformDaxFormulaHighlight/.test(app) && /window\.highlightDax\(input\.value\)/.test(app));
check('autocomplete DAX sugere tabelas e colunas', /transformDaxSuggestions/.test(app) && /columnsForTransformSource\(ctx\.table\)/.test(app));
const addPanel = (html.match(/data-transform-ribbon-panel="add"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
const ribbonStart = html.indexOf('class="transform-ribbon"');
const ribbonEnd = html.indexOf('<div class="transform-layout">', ribbonStart);
const ribbonHtml = ribbonStart >= 0 && ribbonEnd > ribbonStart ? html.slice(ribbonStart, ribbonEnd) : '';
check('comandos estao em uma faixa superior com abas', /class="transform-ribbon"/.test(html) && (html.match(/data-transform-ribbon-tab=/g) || []).length === 5);
check('menus suspensos antigos foram removidos', !/transform-command-menu/.test(html) && !/<details[^>]*class="[^"]*transform-command/.test(html));
check('painel lateral antigo foi removido', !/class="transform-left\b/.test(html) && !/legacyTransformSourceSelect/.test(html));
check('Adicionar coluna mostra somente DAX e preencher vazios', /data-transform-action="daxColumn"/.test(addPanel) && /data-transform-action="fillValues"/.test(addPanel) && (addPanel.match(/data-transform-action=/g) || []).length === 2);
check('formatacao esta dentro da faixa superior', /data-transform-ribbon-panel="format"/.test(ribbonHtml) && /id="formatColumnSelect"/.test(ribbonHtml) && /id="applyFormatBtn"/.test(ribbonHtml));
check('somente uma aba da faixa fica ativa', /function activateTransformRibbonTab/.test(app) && /panel\.hidden = !active/.test(app));
check('layout principal reserva apenas previa e etapas', /\.transform-layout \{ grid-template-columns: minmax\(0, 1fr\) minmax\(280px, 330px\) !important; \}/.test(css));
check('tabela DAX e compilada no PostgreSQL', /function buildDaxCalculatedTableProjection/.test(server) && /UNION ALL/.test(server) && /postgres-dax-table/.test(server));
check('validacao de tabela DAX nao salva nem consulta MySQL', /api\/transforms\/dax-table\/test/.test(server) && /pgCacheQueryWithTimeout\('SELECT \* FROM \('/.test(server));
check('tabela DAX e exposta como view calculada', /function ensureDaxCalculatedTableView/.test(server) && /CREATE OR REPLACE VIEW/.test(server) && /getPgEffectiveMeta[\s\S]*calculatedTransform/.test(server));
check('tabela DAX aplica colunas modeladas sobre o UNION', /buildDaxCalculatedTableProjection[\s\S]*applyPgModelingStepsToFields[\s\S]*FROM \(' \+ baseSql \+ '\) src/.test(server));
check('teste de coluna DAX aceita tabela calculada', /api\/transforms\/modeling\/test[\s\S]*findTransformByName\(source\)[\s\S]*previewDaxCalculatedModelingSteps/.test(server));
check('previa de tabela DAX usa o compilador modelado', /api\/transforms\/preview[\s\S]*previewDaxCalculatedModelingSteps\(calculatedTransform/.test(server));
check('editor restaura etapas de tabela calculada', /function savedTransformStepsForSource/.test(app) && /item\.name === source && item\.daxExpression/.test(app));
check('salvamento preserva etapas da tabela DAX', /if \(calculated\)[\s\S]*body: JSON\.stringify\(\{ \.\.\.calculated, steps \}\)/.test(app) && /editingTransform[\s\S]*steps: editingTransform/.test(app));
check('modal de nova tabela contem somente editor DAX e acoes essenciais', /id="novaTabelaDaxFormula"/.test(html) && /id="novaTabelaDaxTestBtn"/.test(html) && /id="novaTabelaDaxCreateBtn"/.test(html) && !/id="novaSqlTableName"|id="novaSqlExpression"|class="nova-tabela-tabs"/.test(html));
check('criacao exige formula DAX validada sem alteracao posterior', /input\.dataset\.testedFormula !== formula/.test(app) && /Valide o código novamente/.test(app));
check('editor da tabela DAX usa realce e sugestoes', /novaTabelaDaxHighlight/.test(app) && /novaTabelaDaxSuggestions/.test(app) && /window\.highlightDax\(input\.value\)/.test(app));
check('autocomplete DAX nao duplica colchete de coluna', (app.match(/input\.value\.slice\(cursor\)\.startsWith\('\]'\)/g) || []).length >= 2 && (app.match(/replaceEnd \+= 1/g) || []).length >= 2);

console.log('Transformar/modelagem: ' + checks.length + ' verificacoes aprovadas.');
