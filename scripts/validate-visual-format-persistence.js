const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const app = fs.readFileSync('public/app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');

function serverNormalizeVisualStyle() {
  const start = server.indexOf('function normalizeVisualStyle(style = {}) {');
  const end = server.indexOf('\nfunction normalizeReportPages', start);
  assert(start >= 0 && end > start, 'Normalização de estilo do servidor não foi encontrada.');
  const context = {};
  vm.runInNewContext(server.slice(start, end) + '\nresult = normalizeVisualStyle;', context);
  return context.result;
}

function serverNormalizeReportVisuals() {
  const styleStart = server.indexOf('function normalizeVisualStyle(style = {}) {');
  const styleEnd = server.indexOf('\nfunction normalizeReportPages', styleStart);
  const bucketsStart = server.indexOf('function normalizeVisualBucketNames(fields) {');
  const reportsStart = server.indexOf('function normalizeReportVisuals(visuals) {');
  const reportsEnd = server.indexOf('\nfunction publicReport', reportsStart);
  assert(styleStart >= 0 && styleEnd > styleStart && bucketsStart >= 0 && reportsStart > bucketsStart && reportsEnd > reportsStart, 'Normalização de visuais do servidor não foi encontrada.');
  const context = {
    VISUAL_TYPES: ['table', 'matrix', 'textbox'],
    crypto: { randomUUID: () => 'test-visual-id' },
    assertReadOnlySql: (sql) => sql,
    normalizeVisualQueryFieldObjects: (fields) => Array.isArray(fields) ? fields : []
  };
  vm.runInNewContext(
    server.slice(styleStart, styleEnd)
      + '\n' + server.slice(bucketsStart, reportsStart)
      + '\n' + server.slice(reportsStart, reportsEnd)
      + '\nresult = normalizeReportVisuals;',
    context
  );
  return context.result;
}

function run() {
  const normalize = serverNormalizeVisualStyle();
  const style = normalize({
    textColor: '#123456',
    fontFamily: 'Arial, sans-serif',
    textbox: {
      textColor: '#654321',
      fontSize: 24,
      fontFamily: 'Arial, sans-serif',
      fontWeight: 700,
      fontStyle: 'italic',
      textDecoration: 'underline',
      verticalAlign: 'center'
    },
    conditionalFormat: {
      field_receita: {
        enabled: true,
        defaultColorsEnabled: true,
        defaultTextColor: '#112233',
        defaultBackgroundColor: '#ddeeff',
        valueColorsEnabled: true,
        negativeTextColor: '#aa0000',
        negativeBackgroundColor: '#ffeeee',
        zeroTextColor: '#333333',
        zeroBackgroundColor: '#eeeeee',
        positiveTextColor: '#008800',
        positiveBackgroundColor: '#eeffee',
        iconsEnabled: true,
        iconPosition: 'after',
        negativeIcon: 'minus',
        zeroIcon: 'dash',
        positiveIcon: 'plus',
        negativeIconColor: '#cc0000',
        zeroIconColor: '#666666',
        positiveIconColor: '#009900',
        dataBarsEnabled: true,
        positiveBarColor: '#00aa00',
        negativeBarColor: '#dd0000',
        dataBarShowValue: false
      }
    }
  });

  assert.deepStrictEqual(JSON.parse(JSON.stringify(style.textbox)), {
    textColor: '#654321',
    fontSize: 24,
    fontFamily: 'Arial, sans-serif',
    fontWeight: 700,
    fontStyle: 'italic',
    textDecoration: 'underline',
    verticalAlign: 'center'
  });
  assert.strictEqual(style.conditionalFormat.field_receita.defaultTextColor, '#112233');
  assert.strictEqual(style.conditionalFormat.field_receita.defaultBackgroundColor, '#ddeeff');
  assert.strictEqual(style.conditionalFormat.field_receita.iconPosition, 'after');
  assert.strictEqual(style.conditionalFormat.field_receita.dataBarsEnabled, true);
  assert.strictEqual(style.conditionalFormat.field_receita.dataBarShowValue, false);

  const normalizeVisuals = serverNormalizeReportVisuals();
  const storedVisuals = normalizeVisuals([
    { id: 'text', visualization: 'textbox', style: { textbox: style.textbox } },
    { id: 'table', visualization: 'table', selectedFields: [{ instanceId: 'field_receita', name: 'Receita' }], style: { conditionalFormat: style.conditionalFormat } },
    { id: 'matrix', visualization: 'matrix', selectedFields: [{ instanceId: 'field_receita', name: 'Receita' }], matrixValues: ['field_receita'], style: { conditionalFormat: style.conditionalFormat } }
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(storedVisuals[0].style.textbox)), JSON.parse(JSON.stringify(style.textbox)));
  assert.strictEqual(storedVisuals[1].style.conditionalFormat.field_receita.defaultTextColor, '#112233');
  assert.strictEqual(storedVisuals[2].style.conditionalFormat.field_receita.dataBarShowValue, false);

  ['visualTextboxTextColor', 'visualTextboxFontSize', 'visualTextboxFontFamily', 'visualTextboxBold', 'visualTextboxItalic', 'visualTextboxUnderline', 'visualTextboxVerticalAlign'].forEach((id) => {
    assert(html.includes(`id="${id}"`), `Controle da Caixa de Texto ausente: ${id}`);
  });
  ['--visual-textbox-color', '--visual-textbox-size', '--visual-textbox-font', '--visual-textbox-weight', '--visual-textbox-style', '--visual-textbox-decoration', '--visual-textbox-vertical-align'].forEach((token) => {
    assert(app.includes(token), `Renderer não recebe ${token}.`);
  });
  ['display: flex', 'justify-content: var(--visual-textbox-vertical-align', 'color: var(--visual-textbox-color', 'font-size: var(--visual-textbox-size', 'font-family: var(--visual-textbox-font', 'font-weight: var(--visual-textbox-weight', 'font-style: var(--visual-textbox-style', 'text-decoration: var(--visual-textbox-decoration'].forEach((token) => {
    assert(css.includes(token), `CSS da Caixa de Texto não aplica ${token}.`);
  });
  assert(server.includes('style: normalizeVisualStyle(item.style)'), 'Persistência do visual não passa pela normalização de estilo.');
  assert(server.includes('conditionalFormat,'), 'Servidor ainda descarta a formatação condicional por coluna.');
  assert(app.includes('value="${escapeHtml(field.id)}"'), 'Editor de coluna não usa o identificador estável da instância.');
  assert(app.includes('visualConditionalFormatRule(style, fieldRef, field)'), 'Matriz não resolve a formatação pelo identificador estável.');
  assert(app.includes('reportSaveRequestChain'), 'Salvamentos concorrentes do relatório não são serializados.');

  console.log(JSON.stringify({
    textbox: 'persistência e renderização validadas',
    columns: 'configuração por instanceId validada',
    saveOrdering: 'serializado'
  }, null, 2));
}

run();
