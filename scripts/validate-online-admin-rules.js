const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const packager = fs.readFileSync(path.join(root, 'empacotar_servidor_com_servico.ps1'), 'utf8');
const errors = [];

function requireText(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

function forbidText(text, pattern, message) {
  if (pattern.test(text)) errors.push(message);
}

requireText(index, /data-login-access="viewer"[^>]*>Visualização</, 'Tela de login sem opção de visualização.');
requireText(index, /data-login-access="admin"[^>]*>Acesso admin</, 'Tela de login sem opção de acesso administrativo.');
requireText(app, /JSON\.stringify\(\{ username, password, accessMode \}\)/, 'Frontend não informa o tipo de acesso ao autenticar.');
requireText(app, /function isOnlineMode\(\)[\s\S]{0,180}!isAdminSession\(\)/, 'Sessão administrativa online ainda é tratada como visualizador.');
requireText(app, /data-online-logout/, 'Portal visualizador não oferece saída para trocar de perfil.');

requireText(server, /const requestedRole = [^;]+=== 'admin' \? 'admin' : 'viewer';/, 'Servidor não normaliza o perfil solicitado no login.');
requireText(server, /if \(!result\.ok \|\| result\.role !== requestedRole\)/, 'Servidor aceita credencial de perfil diferente do selecionado.');
requireText(server, /function isOnlineViewerRole\(role\)[\s\S]{0,150}!== 'admin'/, 'Separação entre visualizador online e administrador ausente.');
requireText(server, /onlineViewOnly: isOnlineViewerRole\(req\.authRole\)/, 'Configuração do cliente não distingue administrador online.');
requireText(server, /effectivePermissions\(req\.authRole\)/, 'Permissões não são calculadas pelo perfil autenticado.');
requireText(server, /const bootstrapOnlineAdmin = APP_MODE === 'online'[\s\S]{0,800}Object\.assign\(mergedPermissions, base\.permissions\)/, 'Servidor antigo não migra as permissões do administrador configurado no novo pacote.');
requireText(server, /const allowedReports = isOnlineViewerRole\(req\.authRole\) \? reportsForAuthUser[\s\S]{0,180}: reports;/, 'Administrador online não recebe a definição completa dos relatórios.');
requireText(server, /function onlineAccessPayload\(settings\)[\s\S]{0,800}admin:[\s\S]{0,280}permissions:/, 'Publicação não sincroniza acesso administrativo e permissões.');
requireText(server, /applyPublishedOnlineAccess\(nextSettings, onlineAccess\)/, 'Servidor online não aplica a credencial administrativa publicada.');
forbidText(server, /function requireDesktopAdmin[\s\S]{0,220}APP_MODE === 'online'/, 'Administrador continua bloqueado apenas por estar no servidor online.');

const sanitizeStart = server.indexOf('function sanitizeSettingsForClient');
const sanitizeEnd = server.indexOf('\n}\n', sanitizeStart);
const sanitizeBody = sanitizeStart >= 0 && sanitizeEnd > sanitizeStart ? server.slice(sanitizeStart, sanitizeEnd) : '';
forbidText(sanitizeBody, /adminPassword\s*:/, 'Senha administrativa está sendo devolvida ao navegador.');
requireText(sanitizeBody, /hasAdminPassword:/, 'Cliente perdeu o indicador seguro de senha administrativa configurada.');

requireText(packager, /\$values\['APP_USER'\]/, 'Pacote do servidor não recebe o usuário administrador configurado.');
requireText(packager, /\$values\['APP_PASSWORD'\]/, 'Pacote do servidor não recebe a senha administrativa configurada.');
requireText(packager, /\$values\['ALLOW_REPORT_EDITING'\] = ConvertTo-BoolText/, 'Pacote mantém a edição de relatórios sempre bloqueada.');

if (errors.length) {
  console.error('Validação do acesso administrativo online falhou:');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}

console.log('Acesso online validado: visualizador somente leitura e administrador isolado no modo editor.');
