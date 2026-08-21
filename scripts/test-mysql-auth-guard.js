const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(root, '.tmp-mysql-auth-guard-'));
const dataDir = path.join(tempRoot, 'data');
let child = null;
let mockMysql = null;
let authAttempts = 0;
let rejectAuthentication = true;

function packet(payload, sequence) {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}

function mysqlGreeting() {
  const capabilities = 0x00088208;
  const firstSalt = Buffer.from('12345678', 'ascii');
  const secondSalt = Buffer.from('abcdefghijkl\0', 'ascii');
  const payload = Buffer.concat([
    Buffer.from([10]),
    Buffer.from('8.0.36-bi-wa-test\0', 'ascii'),
    Buffer.from([1, 0, 0, 0]),
    firstSalt,
    Buffer.from([0]),
    Buffer.from([capabilities & 0xff, (capabilities >> 8) & 0xff]),
    Buffer.from([45]),
    Buffer.from([2, 0]),
    Buffer.from([(capabilities >> 16) & 0xff, (capabilities >> 24) & 0xff]),
    Buffer.from([21]),
    Buffer.alloc(10),
    secondSalt,
    Buffer.from('mysql_native_password\0', 'ascii')
  ]);
  return packet(payload, 0);
}

function accessDeniedPacket() {
  const message = Buffer.from("Access denied for user 'biwa_test'@'127.0.0.1' (using password: YES)", 'utf8');
  const payload = Buffer.concat([
    Buffer.from([0xff, 0x15, 0x04, 0x23]),
    Buffer.from('28000', 'ascii'),
    message
  ]);
  return packet(payload, 2);
}

function okPacket(sequence) {
  return packet(Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]), sequence);
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestJson(port, pathname, options = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 1000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (err) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await requestJson(port, '/api/version');
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

async function startApp(mysqlPort, password) {
  const appPort = await availablePort();
  child = spawn(process.execPath, ['server.js'], {
    cwd: tempRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_MODE: 'online',
      BIWA_ALLOW_OPEN_ONLINE: 'true',
      APP_USER: 'admin_guard_test',
      APP_PASSWORD: 'admin_guard_test_password',
      ALLOW_REPORT_EDITING: 'true',
      BIWA_PG_CACHE_ENABLED: 'false',
      BIWA_PG_CACHE_SYNC_OWNER: 'disabled',
      BIWA_DATA_SOURCE_HEALTH_INTERVAL_MS: '3000',
      BIWA_DATA_SOURCE_HEALTH_TIMEOUT_MS: '1000',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: String(mysqlPort),
      MYSQL_USER: 'biwa_test',
      MYSQL_PASSWORD: password,
      MYSQL_DATABASE: 'biwa_test',
      MYSQL_SSL: 'false',
      MYSQL_CHARSET: 'utf8mb4',
      ONLINE_MYSQL_HOST: '',
      ONLINE_MYSQL_PORT: '',
      ONLINE_MYSQL_USER: '',
      ONLINE_MYSQL_PASSWORD: '',
      ONLINE_MYSQL_DATABASE: ''
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const response = await waitForServer(appPort);
  assert(response, 'O servidor de teste nao iniciou. ' + stderr.slice(-1000));
  assert.strictEqual(response.status, 200, 'O endpoint de versao nao respondeu com HTTP 200.');
  return { port: appPort, stderr: () => stderr };
}

(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(root, 'server.js'), path.join(tempRoot, 'server.js'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(tempRoot, 'package.json'));
  fs.copyFileSync(path.join(root, 'lib', 'logger.js'), path.join(tempRoot, 'lib', 'logger.js'));
  fs.writeFileSync(path.join(dataDir, 'reports.json'), '[]\n', 'utf8');

  mockMysql = net.createServer((socket) => {
    let authenticated = false;
    socket.on('error', () => {});
    if (!socket.destroyed) socket.write(mysqlGreeting());
    socket.on('data', () => {
      if (!authenticated) {
        authAttempts += 1;
        if (rejectAuthentication) {
          if (!socket.destroyed) socket.end(accessDeniedPacket());
          return;
        }
        authenticated = true;
        if (!socket.destroyed) socket.write(okPacket(2));
        return;
      }
      if (!socket.destroyed) socket.write(okPacket(1));
    });
  });
  const mysqlPort = await listen(mockMysql);
  const adminHeaders = {
    Authorization: 'Basic ' + Buffer.from('admin_guard_test:admin_guard_test_password').toString('base64'),
    'Content-Type': 'application/json'
  };

  const first = await startApp(mysqlPort, 'senha-incorreta-1');
  await new Promise((resolve) => setTimeout(resolve, 3800));
  const firstStatus = await requestJson(first.port, '/api/dashboard/connection-status', { headers: adminHeaders });
  assert(firstStatus && firstStatus.status === 200, 'Nao foi possivel ler o status da conexao.');
  assert.strictEqual(firstStatus.body.mysqlAvailable, false, 'O MySQL com autenticacao recusada foi marcado como disponivel.');
  assert.strictEqual(firstStatus.body.mysqlAuthBlocked, true, 'A protecao de autenticacao nao foi exibida no status.');
  assert.strictEqual(authAttempts, 1, 'Mais de uma autenticacao foi enviada no primeiro processo: ' + authAttempts + '.');
  assert(fs.existsSync(path.join(dataDir, 'mysql_auth_guard.json')), 'A protecao nao foi persistida em disco.');

  const manualRetry = await requestJson(first.port, '/api/dashboard/resume-updates', { method: 'POST', headers: adminHeaders, body: '{}', timeout: 5000 });
  assert(manualRetry && manualRetry.status >= 400, 'A tentativa manual recusada deveria retornar erro.');
  assert.strictEqual(authAttempts, 2, 'O botao Atualizar nao liberou exatamente uma tentativa manual.');
  const protectedRetry = await requestJson(first.port, '/api/dashboard/resume-updates', { method: 'POST', headers: adminHeaders, body: '{}', timeout: 5000 });
  assert(protectedRetry && protectedRetry.status === 429, 'A repeticao manual imediata nao foi bloqueada pelo cooldown.');
  assert.strictEqual(authAttempts, 2, 'A repeticao manual protegida chegou ao MySQL.');
  await stopChild();

  const second = await startApp(mysqlPort, 'senha-incorreta-1');
  await new Promise((resolve) => setTimeout(resolve, 3800));
  assert.strictEqual(authAttempts, 2, 'O reinicio repetiu a credencial bloqueada: ' + authAttempts + ' tentativas.');
  await stopChild();

  const third = await startApp(mysqlPort, 'senha-corrigida-2');
  await new Promise((resolve) => setTimeout(resolve, 3800));
  assert.strictEqual(authAttempts, 3, 'A alteracao de credencial nao liberou uma unica nova tentativa.');
  rejectAuthentication = false;
  const resumed = await requestJson(third.port, '/api/dashboard/resume-updates', { method: 'POST', headers: adminHeaders, body: '{}', timeout: 10000 });
  assert(resumed && resumed.status === 200 && resumed.body && resumed.body.resumed === true, 'O botao Atualizar nao retomou a mesma credencial depois do desbloqueio.');
  const resumedStatus = await requestJson(third.port, '/api/dashboard/connection-status', { headers: adminHeaders });
  assert(resumedStatus && resumedStatus.body && resumedStatus.body.mysqlAuthBlocked === false, 'A protecao permaneceu ativa depois de uma retomada bem-sucedida.');
  await stopChild();

  console.log('Protecao MySQL validada: uma tentativa automatica, cooldown contra cliques repetidos, persistencia apos reinicio e retomada da mesma credencial pelo Dashboard depois do desbloqueio.');
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
}).finally(async () => {
  await stopChild();
  if (mockMysql) await closeServer(mockMysql).catch(() => {});
  const resolved = path.resolve(tempRoot);
  if (resolved.startsWith(root + path.sep + '.tmp-mysql-auth-guard-')) fs.rmSync(resolved, { recursive: true, force: true });
});
