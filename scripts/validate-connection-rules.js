const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const errors = [];

function requireText(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

requireText(html, /toggleConnectionsFullscreenBtn/, 'Faltou botao para abrir o Modelo visual em tela cheia.');
requireText(html, /toggleConnectionsModelFullscreenInlineBtn/, 'Faltou botao dentro do Modelo visual para tela cheia.');
requireText(html, /fitConnectionsModelBtn/, 'Faltou botao para visualizar todos os cards do modelo.');
requireText(app, /function toggleConnectionsFullscreen/, 'Faltou funcao de tela cheia apenas do Modelo visual.');
requireText(app, /connections-model-fullscreen/, 'A tela cheia precisa ser aplicada apenas no painel Modelo visual.');
requireText(app, /function fitConnectionsModelToCards/, 'Faltou funcao para centralizar/visualizar cards do modelo.');
requireText(app, /function setupConnectionCardActions/, 'Faltou acao de clique/remocao nos cards de conexao.');
requireText(app, /function selectConnectionCardForRelationship/, 'Faltou selecao de cards para criar relacionamento.');
requireText(app, /data-remove-connection-card/, 'Faltou botao/acao para remover card do modelo visual.');
requireText(app, /relationship-cardinality/, 'Faltou cardinalidade visual nas linhas de relacionamento.');

requireText(app, /posicao visual nunca pode ressuscitar card removido/, 'tablePositions nao pode ressuscitar cards removidos do Modelo visual.');
requireText(app, /Clique em Salvar conexões para gravar/, 'Remocao de card deve avisar que precisa salvar conexoes.');
requireText(app, /pointerdown'[\s\S]*mousedown'[\s\S]*dragstart/, 'Botao x dos cards deve bloquear drag/click concorrente para remover corretamente.');
requireText(css, /connections-model-fullscreen/, 'Faltou estilo de tela cheia apenas para o Modelo visual.');
requireText(css, /selected-relationship-card/, 'Faltou destaque visual do card selecionado para relacionamento.');


requireText(app, /function connectionColumnAnchor/, 'Faltou ancora robusta para linhas ficarem presas aos cards\/colunas corretos.');
requireText(app, /relationship-label-main/, 'Faltou rotulo de origem nas linhas de relacionamento.');
requireText(app, /relationship-label-sub/, 'Faltou rotulo de destino nas linhas de relacionamento.');
requireText(app, /scheduleConnectionModelAutosave/, 'Faltou salvamento automatico das posicoes e relacionamentos do modelo.');
requireText(css, /relationship-path-clamped/, 'Faltou estilo para linha quando a coluna esta fora da area visivel do card.');

if (errors.length) {
  console.error('Validacao de regras de conexoes falhou:');
  for (const err of errors) console.error('- ' + err);
  process.exit(1);
}
console.log('Regras de conexoes validadas: tela cheia apenas do Modelo visual, cards clicaveis/removiveis e linhas presas aos cards/colunas, rotulos claros e persistencia preservadas.');
