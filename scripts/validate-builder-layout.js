const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const errors = [];

function requireText(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

requireText(index, /class="ribbon-fixed-actions"[\s\S]{0,500}id="ribbonContextTitle"[\s\S]{0,500}id="toolbarOpenFiltersBtn"/, 'Filtros nao esta fixo ao lado de Ferramentas do construtor.');
requireText(index, /id="ribbonPanelHome"[\s\S]{0,1000}id="reportName"[\s\S]{0,600}id="reportRefresh"/, 'Nome e taxa de atualizacao nao estao na aba Pagina Inicial.');
requireText(index, /class="report-page-navigation-bar"[\s\S]{0,500}id="reportPageTabs"[\s\S]{0,900}id="fullscreenCanvasBtn"[\s\S]{0,900}id="canvasZoomOutBtn"[\s\S]{0,500}id="canvasZoomInBtn"/, 'Paginas nao estao a esquerda com o zoom no extremo direito.');
requireText(index, /id="ribbonTabMeasure"[^>]+data-ribbon-tab="measure"[^>]+aria-controls="ribbonPanelMeasure"/, 'A aba contextual de medida nao existe na faixa principal.');
requireText(index, /id="ribbonPanelMeasure"[^>]+data-ribbon-panel="measure"[\s\S]+id="ribbonMeasureName"[\s\S]+id="ribbonMeasureFormat"[\s\S]+id="ribbonMeasureCategory"/, 'As opcoes de medida nao estao agrupadas na nova aba contextual.');
requireText(index, /id="ribbonMeasureName"\s+type="hidden"/, 'O nome separado da medida ainda esta visivel no construtor.');
requireText(index, /id="measureFormulaInput"[^>]+placeholder="Nome da Medida = expressão DAX"/, 'O editor unico nao orienta Nome da Medida = expressao DAX.');
if (/id="measureFormulaEditorTitle"/.test(index)) errors.push('A faixa adicional Nova medida DAX ainda existe no editor ativo.');
if (/class="report-page-toolbar"/.test(index)) errors.push('A faixa intermediaria antiga ainda ocupa espaco acima do canvas.');
if (/id="measureToolsRibbon"/.test(index)) errors.push('O painel separado antigo de medidas ainda existe no construtor.');

for (const id of ['reportName', 'reportRefresh', 'toolbarOpenFiltersBtn', 'canvasZoomOutBtn', 'canvasZoomResetBtn', 'canvasZoomInBtn', 'fullscreenCanvasBtn']) {
  const count = (index.match(new RegExp(`id="${id}"`, 'g')) || []).length;
  if (count !== 1) errors.push(`Controle ${id} deve existir exatamente uma vez.`);
}

for (const id of ['ribbonTabMeasure', 'ribbonPanelMeasure', 'ribbonMeasureName', 'ribbonMeasureFormat', 'ribbonMeasureDecimals', 'ribbonMeasureCategory', 'measureFormulaBar']) {
  const count = (index.match(new RegExp(`id="${id}"`, 'g')) || []).length;
  if (count !== 1) errors.push(`Controle contextual ${id} deve existir exatamente uma vez.`);
}

requireText(styles, /\.report-page-navigation-bar\s*\{[\s\S]{0,300}display:\s*flex[\s\S]{0,250}justify-content:\s*space-between/, 'Posicionamento original das paginas nao foi preservado.');
requireText(styles, /\.report-page-navigation-bar\s*\{[\s\S]{0,500}width:\s*100%/, 'Barra de paginas nao ocupa toda a largura do construtor.');
requireText(styles, /body\.report-editor-active \.report-page-navigation-bar \.page-tabs\s*\{[\s\S]{0,100}order:\s*0/, 'Regra antiga ainda move as paginas para depois do zoom.');
requireText(styles, /\.page-navigation-tools\s*\{[\s\S]{0,100}order:\s*1/, 'Controles de zoom nao estao depois das paginas.');
requireText(styles, /\.page-navigation-tools\s*\{[\s\S]{0,350}justify-content:\s*flex-end[\s\S]{0,180}margin-left:\s*auto/, 'Zoom nao esta alinhado na extremidade direita da barra.');
requireText(styles, /\.ribbon-tab-buttons\s*\{[\s\S]{0,350}overflow-x:\s*auto/, 'Abas nao preservam os controles fixos em telas menores.');
requireText(styles, /\.ribbon-report-settings\s*\{[\s\S]{0,350}grid-template-columns:/, 'Configuracoes do relatorio nao possuem layout compacto.');
requireText(styles, /body\.report-editor-active \.report-canvas-panel > \.measure-formula-bar:not\(\[hidden\]\)\s*\{[\s\S]{0,180}position:\s*absolute/, 'A barra de formula da medida nao esta sobreposta ao relatorio.');
requireText(styles, /body\.report-editor-active \.report-canvas-panel\s*\{[\s\S]{0,80}position:\s*relative/, 'O editor sobreposto nao esta ancorado ao painel do canvas.');
requireText(styles, /\.ribbon-measure-panel\s*\{[\s\S]{0,120}align-items:\s*stretch/, 'A aba de medida nao possui layout integrado a faixa principal.');

const openMeasureStart = app.indexOf('function openDaxMeasureInlineEditor');
const openMeasureEnd = app.indexOf('function openDaxMeasureModal', openMeasureStart);
const openMeasureBlock = openMeasureStart >= 0 && openMeasureEnd > openMeasureStart ? app.slice(openMeasureStart, openMeasureEnd) : '';
requireText(openMeasureBlock, /state\.measureEditorOpen\s*=\s*true[\s\S]+setMainRibbonTab\('measure'\)/, 'A edicao de medida nao abre a nova aba contextual.');
requireText(openMeasureBlock, /previous\.name\s*\|\|\s*'Medida'\)\s*\+\s*' =\\n'\s*\+\s*\(previous\.formula/, 'A edicao nao apresenta nome e expressao no mesmo campo DAX.');
if (/mainRibbon\.style\.display\s*=\s*['"]none['"]/.test(openMeasureBlock)) errors.push('Criar medida ainda oculta a faixa principal do construtor.');

const closeMeasureStart = app.indexOf('function closeMeasureToolsRibbon');
const closeMeasureEnd = app.indexOf('function positionMeasureFormulaBar', closeMeasureStart);
const closeMeasureBlock = closeMeasureStart >= 0 && closeMeasureEnd > closeMeasureStart ? app.slice(closeMeasureStart, closeMeasureEnd) : '';
requireText(closeMeasureBlock, /state\.measureEditorOpen\s*=\s*false/, 'Fechar a medida nao encerra corretamente o estado contextual.');

if (errors.length) {
  console.error('Validacao do layout do construtor falhou:');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}

console.log('Layout do construtor validado: editor DAX unico sobreposto, sem faixa extra, canvas estavel e zoom junto das paginas.');
