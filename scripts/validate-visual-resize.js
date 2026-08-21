const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const errors = [];
const corners = ['nw', 'ne', 'sw', 'se'];

function requireText(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) return '';
  const parametersEnd = source.indexOf(')', start);
  const bodyStart = source.indexOf('{', parametersEnd);
  if (bodyStart < 0) return '';
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

const frameTemplateStart = app.indexOf('const pageVisuals = currentPageVisuals()');
const frameTemplateEnd = app.indexOf('pageVisuals.forEach((visual)', frameTemplateStart);
const frameTemplate = frameTemplateStart >= 0 && frameTemplateEnd > frameTemplateStart
  ? app.slice(frameTemplateStart, frameTemplateEnd)
  : '';

for (const corner of corners) {
  requireText(index, new RegExp(`data-visual-resize-corner="${corner}"`), `Fallback do visual sem alca ${corner}.`);
  requireText(frameTemplate, new RegExp(`data-visual-resize-corner="${corner}"`), `Visuais renderizados sem alca ${corner}.`);
  requireText(styles, new RegExp(`\\.visual-resize-handle-${corner}\\s*\\{`), `Estilo da alca ${corner} nao encontrado.`);
}

requireText(app, /querySelectorAll\('\[data-visual-resize-corner\]'\)/, 'Eventos nao sao ligados a todas as alcas de redimensionamento.');
requireText(app, /resizeHandles\.forEach[\s\S]{0,500}handle\.dataset\.visualResizeCorner/, 'Direcao da alca nao e considerada no evento.');
requireText(app, /frame\.style\.left\s*=\s*next\.x[\s\S]{0,300}frame\.style\.top\s*=\s*next\.y[\s\S]{0,300}frame\.style\.width\s*=\s*next\.width[\s\S]{0,300}frame\.style\.height\s*=\s*next\.height/, 'Redimensionamento nao atualiza posicao e tamanho juntos.');
if (/const handle = frame\.querySelector\('\.visual-resize-handle'\)/.test(app)) errors.push('Ligacao antiga de uma unica alca ainda existe.');

const clampFunction = extractFunction(app, 'clampNumber');
const normalizeFunction = extractFunction(app, 'normalizeVisualLayout');
const resizeFunction = extractFunction(app, 'resizeVisualLayoutFromCorner');
if (!clampFunction || !normalizeFunction || !resizeFunction) {
  errors.push('Funcoes de calculo do redimensionamento nao foram encontradas.');
} else {
  const sandbox = {};
  vm.runInNewContext(`
    const VISUAL_MIN_WIDTH = 8;
    const VISUAL_MIN_HEIGHT = 8;
    const REPORT_CANVAS_WIDTH = 1280;
    const REPORT_CANVAS_HEIGHT = 720;
    const state = { designerSnapToGrid: false };
    function applySnap(value) { return Number(value) || 0; }
    ${clampFunction}
    ${normalizeFunction}
    ${resizeFunction}
    globalThis.resizeVisual = resizeVisualLayoutFromCorner;
  `, sandbox);

  const start = { x: 100, y: 100, width: 200, height: 120, zIndex: 2 };
  const expected = {
    nw: { x: 80, y: 70, width: 220, height: 150 },
    ne: { x: 100, y: 80, width: 240, height: 140 },
    sw: { x: 70, y: 100, width: 230, height: 160 },
    se: { x: 100, y: 100, width: 250, height: 170 }
  };
  const deltas = {
    nw: [-20, -30],
    ne: [40, -20],
    sw: [-30, 40],
    se: [50, 50]
  };

  for (const corner of corners) {
    const result = sandbox.resizeVisual(start, corner, deltas[corner][0], deltas[corner][1]);
    for (const key of ['x', 'y', 'width', 'height']) {
      if (result[key] !== expected[corner][key]) {
        errors.push(`Calculo ${corner} incorreto para ${key}: esperado ${expected[corner][key]}, recebido ${result[key]}.`);
      }
    }
  }

  const boundedTopLeft = sandbox.resizeVisual(start, 'nw', -2000, -2000);
  if (boundedTopLeft.x !== 0 || boundedTopLeft.y !== 0) errors.push('Canto superior esquerdo ultrapassa o canvas.');
  const boundedBottomRight = sandbox.resizeVisual(start, 'se', 2000, 2000);
  if (boundedBottomRight.x + boundedBottomRight.width !== 1280 || boundedBottomRight.y + boundedBottomRight.height !== 720) {
    errors.push('Canto inferior direito ultrapassa o canvas.');
  }
  const minimum = sandbox.resizeVisual(start, 'nw', 2000, 2000);
  if (minimum.width !== 8 || minimum.height !== 8) errors.push('Tamanho minimo do visual nao foi preservado.');
}

if (errors.length) {
  console.error('Validacao do redimensionamento dos visuais falhou:');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}

console.log('Redimensionamento validado nos quatro cantos, com zoom, limites e tamanho minimo preservados.');
