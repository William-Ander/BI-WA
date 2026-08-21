const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

const checks = [
  ['estado de zoom exclusivo do portal', app.includes('onlinePortalZoom: 1')],
  ['persistência do zoom do portal', app.includes('onlinePortalZoom: state.onlinePortalZoom || 1')],
  ['zoom calculado pelo encaixe do canvas', app.includes('targetScale / metrics.fit')],
  ['zoom móvel acima do antigo limite', app.includes('Math.min(8, targetScale / metrics.fit)')],
  ['reação à rotação do aparelho', app.includes("window.addEventListener('orientationchange', handleOnlinePortalViewportChange)")],
  ['reação ao viewport visual móvel', app.includes("window.visualViewport.addEventListener('resize', handleOnlinePortalViewportChange)")],
  ['navegação inferior no modo retrato', css.includes('@media (max-width: 700px) and (orientation: portrait)') && css.includes('"navigation"')],
  ['cabeçalho compacto no modo paisagem', css.includes('@media (max-height: 520px) and (orientation: landscape)') && css.includes('grid-template-columns: minmax(96px, 1fr) auto !important')],
  ['camada móvel após as regras legadas', css.lastIndexOf('v3.4.13 - Camada móvel final') > css.lastIndexOf('@media (max-width: 420px)')],
  ['rolagem segura do canvas', css.includes('touch-action: pan-x pan-y') && css.includes('-webkit-overflow-scrolling: touch')],
  ['canvas acessível quando ampliado', css.includes('.online-portal-canvas-stage {\n  margin: auto;')]
];

const failures = checks.filter(([, passed]) => !passed);
checks.forEach(([label, passed]) => console.log(`${passed ? 'OK' : 'FALHA'} - ${label}`));

if (failures.length) {
  console.error(`\n${failures.length} validação(ões) móvel(is) falharam.`);
  process.exit(1);
}

console.log('\nPortal móvel validado.');
