const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const port = 31800 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testAuthorizationHeader() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
    const access = settings && settings.access || {};
    if (access.adminUser && access.adminPassword) {
      return 'Basic ' + Buffer.from(`${access.adminUser}:${access.adminPassword}`).toString('base64');
    }
    const viewer = (Array.isArray(access.onlineUsers) ? access.onlineUsers : [])
      .find((item) => item && item.active !== false && item.username && item.password);
    if (viewer) return 'Basic ' + Buffer.from(`${viewer.username}:${viewer.password}`).toString('base64');
  } catch (err) {}
  return '';
}

async function waitForServer(child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor de teste encerrou com código ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/public-config`, { cache: 'no-store' });
      if (response.ok) return;
    } catch (err) {}
    await delay(200);
  }
  throw new Error('Servidor de teste não iniciou no tempo esperado.');
}

async function readConnectionStatus(authorization) {
  const headers = authorization ? { Authorization: authorization } : {};
  const response = await fetch(`${baseUrl}/api/dashboard/connection-status?ts=${Date.now()}`, {
    headers,
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Endpoint de status retornou HTTP ${response.status}.`);
  return response.json();
}

function testReportTimestampStability() {
  const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const start = appSource.indexOf('function normalizeDashboardLastUpdate');
  const end = appSource.indexOf('function setDashboardLastUpdate', start);
  if (start < 0 || end <= start) throw new Error('Funções de horário por relatório não encontradas.');

  const context = {
    state: {
      dashboardLastUpdatedByReport: {},
      dashboard: {},
      onlineActiveReportId: 'vendas',
      dashboardLastUpdated: null
    },
    onlinePortalModeEnabled: () => true,
    setDashboardLastUpdate: () => {}
  };
  vm.createContext(context);
  vm.runInContext(appSource.slice(start, end), context);

  const vendas = '2026-07-22T16:53:00.000Z';
  const compras = '2026-07-23T12:10:00.000Z';
  context.rememberDashboardReportLastUpdate('vendas', vendas);
  context.rememberDashboardReportLastUpdate('compras', compras);
  const activeTimestamp = context.dashboardReportLastUpdated('vendas');
  if (activeTimestamp !== vendas) {
    throw new Error(`Horário do relatório ativo foi sobrescrito: ${activeTimestamp}`);
  }

  const heartbeatStart = appSource.indexOf("socket.on('dashboard:connectionStatus'");
  const heartbeatEnd = appSource.indexOf("socket.on('dashboard:cacheInvalidated'", heartbeatStart);
  const heartbeatHandler = appSource.slice(heartbeatStart, heartbeatEnd);
  if (/setDashboardLastUpdate|setDashboardReportLastUpdate|rememberDashboardReportLastUpdate/.test(heartbeatHandler)) {
    throw new Error('Heartbeat ainda altera o horário da última atualização.');
  }
}

async function run() {
  const authorization = testAuthorizationHeader();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_MODE: 'online',
      BIWA_ALLOW_OPEN_ONLINE: 'true',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '1',
      ONLINE_MYSQL_HOST: '127.0.0.1',
      ONLINE_MYSQL_PORT: '1',
      BIWA_PG_CACHE_ENABLED: 'false',
      BIWA_PG_CACHE_SYNC_OWNER: 'disabled',
      BIWA_DATA_SOURCE_HEALTH_INTERVAL_MS: '3000',
      BIWA_DATA_SOURCE_HEALTH_TIMEOUT_MS: '1000',
      BIWA_TIME_ZONE: 'America/Bahia'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    await waitForServer(child);
    const first = await readConnectionStatus(authorization);
    if (first.mysqlAvailable !== false) throw new Error('MySQL indisponível foi informado como online.');
    if (!first.checkedAt || Number.isNaN(new Date(first.checkedAt).getTime())) throw new Error('Horário da checagem inválido.');
    if (first.timeZone !== 'America/Bahia') throw new Error(`Fuso inesperado: ${first.timeZone}`);

    await delay(3400);
    const second = await readConnectionStatus(authorization);
    if (second.mysqlAvailable !== false) throw new Error('Status offline não foi mantido no heartbeat.');
    if (new Date(second.checkedAt).getTime() <= new Date(first.checkedAt).getTime()) {
      throw new Error('Heartbeat não atualizou o horário da verificação.');
    }

    const reference = new Date('2026-07-23T12:00:00.000Z');
    const formatted = reference.toLocaleString('pt-BR', { timeZone: second.timeZone });
    if (!formatted.includes('09:00')) throw new Error(`Conversão de fuso incorreta: ${formatted}`);

    console.log('OK - MySQL indisponível detectado em até um ciclo de 3 segundos.');
    console.log('OK - Heartbeat manteve o portal offline sem aguardar atualização dos relatórios.');
    console.log('OK - Horário convertido de UTC para America/Bahia corretamente.');
    testReportTimestampStability();
    console.log('OK - Horários de relatórios diferentes permanecem isolados e estáveis.');
  } finally {
    child.kill();
    await delay(250);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  if (stderr && /EADDRINUSE|SyntaxError|ReferenceError/.test(stderr)) {
    throw new Error(stderr.trim());
  }
}

run().catch((err) => {
  console.error(`FALHA - ${err.message}`);
  process.exit(1);
});
