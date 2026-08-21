const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const errors = [];

function requireText(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

requireText(index, /id="dashboardLastUpdate"[\s\S]{0,320}data-user-menu-toggle/, 'Cabeçalho administrativo não mostra o perfil após o status.');
requireText(index, /id="userAccountMenu"[\s\S]{0,900}Editar perfil[\s\S]{0,500}>Sair</, 'Menu de conta está incompleto.');
requireText(index, /id="profileModal"[\s\S]{0,1800}profileCurrentPasswordInput[\s\S]{0,900}profileNewPasswordInput/, 'Modal de edição do perfil está incompleto.');
requireText(app, /online-portal-status last-update-badge[\s\S]{0,700}online-portal-user-button/, 'Portal não mostra o perfil depois do status Online/Offline.');
requireText(app, /async function saveCurrentUserProfile[\s\S]{0,1600}\/api\/auth\/profile/, 'Frontend não salva o perfil pela rota protegida.');
requireText(app, /function logout\(\)[\s\S]{0,800}showLoginScreen/, 'Opção Sair não retorna para a tela de login.');

requireText(server, /app\.put\('\/api\/auth\/profile', rateLimitApi,/, 'Rota protegida de edição do perfil ausente.');
requireText(server, /if \(!currentPassword\) throw apiError\('Informe a senha atual/, 'Alteração do perfil não exige a senha atual.');
requireText(server, /verification\.role !== req\.authRole/, 'Confirmação da senha não valida o perfil autenticado.');
requireText(server, /if \(req\.authRole === 'admin'\)[\s\S]{0,1800}else \{/, 'Rota não separa atualização de administrador e visualizador.');
requireText(server, /throw apiError\('Este login já está sendo usado/, 'Rota não impede logins duplicados.');
requireText(server, /const token = buildAuthToken\(updatedUser\)/, 'Rota não renova o token após alterar o login.');
requireText(server, /passwordChanged: Boolean\(newPassword\)/, 'Auditoria não registra alteração de senha sem expor seu valor.');
requireText(server, /function applyPublishedOnlineAccess[\s\S]{0,2600}currentUpdatedAt <= incomingUpdatedAt/, 'Publicação pode sobrescrever uma alteração de perfil mais recente.');

if (errors.length) {
  console.error('Validação do menu e perfil falhou:');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}

console.log('Menu de conta validado para administrador e visualizador, com edição protegida por senha atual.');
