const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const formatting = fs.readFileSync(path.join(root, 'public', 'formatting.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const errors = [];

function requireText(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

requireText(app, /async function ensureOnlineFilterSourceColumns\(sourceName\)\s*\{\s*if \(isOnlineMode\(\)\) return \[\];/, 'Modo online ainda pode consultar colunas do editor de filtros.');
requireText(app, /async function renderOnlineFilterBuilder\(\)\s*\{\s*if \(isOnlineMode\(\)\) return;/, 'Modo online ainda pode renderizar o construtor de filtros.');
requireText(app, /function clearReportEditor\(\)\s*\{\s*if \(isOnlineMode\(\)\) return;/, 'Modo online ainda pode inicializar o editor de relatorios.');
requireText(app, /async function bootAfterAuth\(\)[\s\S]{0,500}if \(!isOnlineMode\(\)\) clearReportEditor\(\);/, 'Login online ainda inicializa recursos de edicao.');
requireText(app, /function renderDashboard\(\)[\s\S]{0,350}if \(onlinePortalModeEnabled\(\)\)\s*\{\s*renderOnlinePortal\(grid\);/, 'Modo online deixou de renderizar o portal de visualizacao.');
requireText(app, /function refreshOnlinePortalData\(updatedReportIds = \[\]\)[\s\S]{0,2600}updateOnlinePortalVisualFrame\([\s\S]{0,500}return true;/, 'Portal online nao possui atualizacao incremental dos visuais.');
requireText(app, /function onlineVisualRuntimeSignature\(reportId, runtimeResult\)[\s\S]{0,1100}Math\.imul\(hash, 16777619\)/, 'Atualizacao incremental nao evita redesenhar visuais com dados identicos.');
requireText(app, /function visualFrameClassNames\(visual, style = \{\}, extraClasses = \[\]\)[\s\S]{0,900}show-legend[\s\S]{0,500}visual-card-frame/, 'Classes visuais compartilhadas entre Construtor e Online nao foram encontradas.');
requireText(app, /function renderOnlinePortalVisual\([\s\S]{0,1200}visualFrameClassNames\(visual, style, \['visual-frame', 'online-portal-visual'\]\)/, 'Portal Online nao reutiliza as classes do quadro do Construtor.');
requireText(app, /function renderReportPageVisuals\([\s\S]{0,1800}visualFrameClassNames\(visual, style, active \? \['selected', 'active-visual'\] : \[\]\)/, 'Construtor nao reutiliza as classes visuais compartilhadas.');
requireText(app, /const usesAuthoritativeTotals = Boolean\(visual && visual\.totalsAuthoritative === true\);[\s\S]{0,500}const totalColumns = usesAuthoritativeTotals/, 'Tabelas online ainda podem somar somente as linhas limitadas no rodape.');
requireText(app, /useGrouping:\s*Math\.abs\(value\)\s*>=\s*1000/, 'Numeros entre 1.000 e 9.999 continuam sem separador de milhar no app.');
requireText(app, /window\.BiwaFormatting\.formatNumber[\s\S]{0,500}useGrouping:\s*colFmt\.useGrouping !== false/, 'Visuais nao utilizam o formatador numerico compartilhado.');
requireText(app, /runtimeColumnFormats:\s*runtimeResult\.columnFormats[\s\S]{0,180}columnFormats:\s*visual\.columnFormats|columnFormats:\s*visual\.columnFormats[\s\S]{0,180}runtimeColumnFormats:\s*runtimeResult\.columnFormats/, 'Portal online mistura a escala tecnica do banco com a formatacao salva no visual.');
requireText(app, /function setVisualRuntimeColumnFormats\(visual, formats\)[\s\S]{0,320}enumerable:\s*false/, 'Metadados de formato retornados pela consulta podem ser persistidos indevidamente no relatorio.');
requireText(app, /Prioridade: instancia\/coluna do visual > visual > medida\/modelo > tipo do banco\.[\s\S]{0,420}visualDecimals !== null/, 'Prioridade das casas decimais nao respeita a configuracao do visual.');
requireText(formatting, /new Intl\.NumberFormat\(locale,[\s\S]{0,260}useGrouping:\s*opts\.useGrouping !== false/, 'Formatador compartilhado nao preserva o separador de milhar.');
requireText(app, /function compactDateDisplayValue\(value\)[\s\S]{0,850}return String\(day\)\.padStart\(2, '0'\) \+ '\/'[\s\S]{0,260}function formatValue\(value\)[\s\S]{0,320}compactDateDisplayValue\(value\)/, 'Datas compactas ainda podem receber separador de milhar.');
requireText(app, /Campo tipado como data nunca deve cair no formatador numerico\.[\s\S]{0,180}return rawDateValue/, 'Data invalida ou parcial ainda pode cair no formatador numerico.');
requireText(app, /function visualColumnFormats\(visual\)[\s\S]{0,900}fields\.map\(\(field\) => String\(field\.table[\s\S]{0,900}buildColumnFormatMapFromColumns/, 'Visuais nao preservam o tipo de data vindo de tabelas relacionadas.');
requireText(app, /if \(!options\.skipDashboardRender\) refreshDashboardAfterDataChange\(\[reportId\]\);/, 'Execucao manual do relatorio ainda recria todo o portal online.');
requireText(app, /root\.querySelectorAll\('\[data-online-fullscreen\]'\)[\s\S]{0,260}const fullscreenTarget = root;[\s\S]{0,260}fullscreenTarget\.requestFullscreen/, 'Tela cheia do portal ainda depende de um elemento recriado ao trocar de relatorio.');
requireText(app, /<footer class="online-portal-footer"><span class="online-portal-footer-text">[\s\S]{0,260}<div class="online-portal-zoom">/, 'Controles de zoom do portal nao estao integrados ao rodape.');
requireText(styles, /\.online-portal-host:fullscreen\s*\{[\s\S]{0,220}height:\s*100dvh;/, 'Container persistente do portal nao possui layout de tela cheia.');
requireText(styles, /\.online-portal-footer\s*\{[\s\S]{0,320}grid-template-columns:[^;]+;[\s\S]{0,420}\.online-portal-footer \.online-portal-zoom/, 'Rodape do portal nao possui layout responsivo para os controles de zoom.');
requireText(styles, /body\.report-editor-active \.visual-frame,\s*\.online-portal-canvas > \.online-portal-visual\s*\{[\s\S]{0,450}box-sizing:\s*border-box;[\s\S]{0,450}padding:\s*0 !important;/, 'Online e Construtor nao compartilham o mesmo box model do quadro.');
requireText(styles, /body\.report-editor-active \.visual-frame \.visual-content,\s*\.online-portal-canvas > \.online-portal-visual \.visual-content\s*\{[\s\S]{0,500}height:\s*auto;[\s\S]{0,350}padding:\s*0 !important;/, 'Conteudo Online ainda pode alterar o tamanho interno salvo no Construtor.');
requireText(server, /app\.get\('\/api\/tables\/:table\/columns', requireDesktopAdmin,/, 'Rota de metadados do editor deixou de exigir administrador desktop.');
requireText(server, /async function visualTotalsMetadataForRun\([\s\S]{0,1700}sqlForVisualMeasureTotalsRunDetails\([\s\S]{0,2800}metadata\.totals =/, 'Servidor nao calcula totais completos das medidas separadamente das linhas exibidas.');

const realtimeStart = app.indexOf("socket.on('dashboard:update'");
const realtimeEnd = app.indexOf("socket.on('dashboard:cacheInvalidated'", realtimeStart);
const realtimeHandler = realtimeStart >= 0 && realtimeEnd > realtimeStart ? app.slice(realtimeStart, realtimeEnd) : '';
if (!/refreshDashboardAfterDataChange\(updatedReportIds\)/.test(realtimeHandler)) {
  errors.push('Atualizacao em tempo real nao usa o fluxo incremental do portal.');
}
if (/renderDashboard\(\)/.test(realtimeHandler)) {
  errors.push('Atualizacao em tempo real ainda recria todo o portal e pode causar piscadas.');
}

if (errors.length) {
  console.error('Validacao do portal visualizador falhou:');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}

console.log('Portal visualizador validado: atualizacao incremental sem recriar a tela e sem recursos protegidos do editor.');
