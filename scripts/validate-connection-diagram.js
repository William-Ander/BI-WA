const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const failures = [];
const scrollSetupStart = app.indexOf('function setupConnectionDiagramScroll');
const scrollSetupEnd = app.indexOf('function scheduleConnectionRelationshipDraw', scrollSetupStart);
const scrollSetup = scrollSetupStart >= 0 && scrollSetupEnd > scrollSetupStart ? app.slice(scrollSetupStart, scrollSetupEnd) : '';
const internalScrollStart = scrollSetup.indexOf("columns.addEventListener('scroll'");
const internalScrollEnd = scrollSetup.indexOf('}, { passive: true });', internalScrollStart);
const internalScrollHandler = internalScrollStart >= 0 && internalScrollEnd > internalScrollStart ? scrollSetup.slice(internalScrollStart, internalScrollEnd) : '';

function requireMatch(source, expression, message) {
  if (!expression.test(source)) failures.push(message);
}

function rejectMatch(source, expression, message) {
  if (expression.test(source)) failures.push(message);
}

requireMatch(app, /function routeConnectionOrthogonally\s*\(/, 'Roteador ortogonal nao encontrado.');
requireMatch(app, /function connectionSegmentBlocked\s*\(/, 'Protecao contra linhas atravessando cards nao encontrada.');
requireMatch(app, /function connectionRelationshipEdgeCandidates\s*\(/, 'Faltou testar lados alternativos dos cards.');
requireMatch(app, /function connectionColumnAnchor\s*\(/, 'Ancora de coluna nao encontrada.');
requireMatch(internalScrollHandler, /clearConnectionRelationshipHover\(el\)/, 'Scroll interno precisa manter as linhas estaveis e apenas limpar o destaque.');
rejectMatch(internalScrollHandler, /scheduleConnectionRelationshipDraw/, 'Scroll interno nao pode recalcular as rotas das conexoes.');
requireMatch(app, /rowRect\.centerY\s*\+\s*columnScrollTop/, 'Ancora da coluna nao compensa o scroll interno do card.');
requireMatch(server, /async function getColumns\(table\)[\s\S]*transform\.daxExpression[\s\S]*getPgEffectiveMeta\(transform\.name\)/, 'Diagnostico nao usa os tipos reais da view DAX.');
requireMatch(server, /async function validateModelResources[\s\S]*async function loadPgColumns[\s\S]*getPgEffectiveMeta\(table\)/, 'Salvamento do modelo nao valida colunas pela view efetiva PostgreSQL.');
requireMatch(app, /svg\.style\.width\s*=\s*totalW[\s\S]*svg\.style\.height\s*=\s*totalH/, 'SVG nao esta fixado na mesma escala dos cards.');
requireMatch(app, /el\.addEventListener\('scroll'[\s\S]*clearConnectionRelationshipHover\(el\)/, 'Scroll externo ainda recalcula as rotas e pode causar atraso.');
requireMatch(app, /class=\"relationship-hit\"/, 'Area de interacao ampliada da linha nao encontrada.');
requireMatch(app, /function setConnectionRelationshipHover\s*\(/, 'Destaque das colunas relacionadas nao encontrado.');
requireMatch(app, /relationship-column-highlight/, 'Classe de destaque das duas colunas nao aplicada.');
requireMatch(app, /M -2 -4 L -9 0 L -2 4 Z M 2 -4 L 9 0 L 2 4 Z/, 'Setas bidirecionais nao estao apontando para lados opostos.');
rejectMatch(app, /relationship-path-clamped/, 'Relacionamento ativo nao pode ficar pontilhado por coluna fora da area visivel.');
requireMatch(css, /\.relationship-hit\s*\{[\s\S]*pointer-events:\s*stroke/, 'Linha nao possui area segura para mouse.');
requireMatch(css, /\.relationship-group\.is-hovered\s+\.relationship-path/, 'Linha nao muda de destaque ao passar o mouse.');
requireMatch(css, /\.diagram-column-row\.relationship-column-highlight/, 'Estilo das colunas relacionadas nao encontrado.');
requireMatch(css, /\.relationship-path-inactive\s*\{[\s\S]*stroke-dasharray/, 'Somente relacionamento inativo deve usar linha pontilhada.');
requireMatch(css, /\.relationship-svg\s*\{[\s\S]*z-index:\s*1\s*!important/, 'Linhas precisam ficar em uma camada abaixo dos cards.');
requireMatch(css, /\.diagram-card-board\s*\{[\s\S]*z-index:\s*2\s*!important[\s\S]*pointer-events:\s*none/, 'Camada dos cards nao esta protegida contra sobreposicao das linhas.');

if (failures.length) {
  console.error('Validacao do diagrama de conexoes falhou:');
  failures.forEach((failure) => console.error('- ' + failure));
  process.exit(1);
}

console.log('Diagrama de conexoes validado: rotas ortogonais, desvio de cards, ancoras sincronizadas e destaque das duas colunas.');
