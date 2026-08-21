const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(root, '.tmp-faturamento-migration-'));
const dataDir = path.join(tempRoot, 'data');
let child = null;

const writeJson = (name, value) => fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
const canonical = (value) => String(value || '').trim().toLocaleLowerCase('pt-BR');

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function requestVersion(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/version', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (err) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await requestVersion(port);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 250));
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

(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(root, 'server.js'), path.join(tempRoot, 'server.js'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(tempRoot, 'package.json'));
  fs.copyFileSync(path.join(root, 'lib', 'logger.js'), path.join(tempRoot, 'lib', 'logger.js'));

  writeJson('reports.json', [{
    id: 'report_test',
    name: 'Vendas',
    sql: 'SELECT * FROM `faturamento2` src LIMIT 10',
    visuals: [{ id: 'visual_test', table: 'Faturamento2', sql: 'SELECT * FROM `faturamento2` src LIMIT 10', selectedFields: [{ table: 'Faturamento2', name: 'Empresa', type: 'integer' }] }]
  }]);
  writeJson('semantic_model.json', {
    tables: [{ name: 'Faturamento' }, { name: 'Faturamento2' }],
    tableDetails: { Faturamento: { color: 'blue' }, Faturamento2: { legacy: true } },
    tablePositions: { Faturamento: { x: 10, y: 20 }, Faturamento2: { x: 30, y: 40 } },
    selectedColumns: [{ table: 'Faturamento2', column: 'Empresa', alias: 'Empresa' }],
    relationships: [
      { fromTable: 'Empresas', fromColumn: 'Empresa', toTable: 'Faturamento', toColumn: 'Empresa', active: true },
      { fromTable: 'Empresas', fromColumn: 'Empresa', toTable: 'Faturamento2', toColumn: 'Empresa', active: true }
    ],
    measures: [
      { table: 'Faturamento', name: 'Valor Faturamento', formula: "SUM('Faturamento'[Valor])" },
      { table: 'Faturamento2', name: 'Faturamento Liquido', formula: '[Valor Faturamento]' }
    ]
  });
  writeJson('transform_queries.json', [{ name: 'Consulta', source: 'Faturamento2', sql: 'SELECT * FROM `faturamento2` src' }]);
  writeJson('imported_tables.json', [
    { name: 'Faturamento', sourceTable: 'faturamento', steps: [], incrementalColumn: null },
    { name: 'Faturamento2', sourceTable: 'faturamento2', steps: [{ kind: 'changeType', column: 'Empresa', dataType: 'inteiro' }], incrementalColumn: 'Data Emissao' }
  ]);
  writeJson('column_formats.json', { Faturamento: { Valor: { format: '#,##0.00' } }, Faturamento2: { Empresa: { format: '#,##0' } } });
  writeJson('settings.json', { access: { onlineUsers: [{ username: 'teste', password: 'teste', active: true, dataFilters: [{ table: 'Faturamento2', field: 'Empresa', value: '3', type: 'number' }] }] } });

  const port = await availablePort();
  child = spawn(process.execPath, ['server.js'], {
    cwd: tempRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      APP_MODE: 'desktop',
      BIWA_PG_CACHE_ENABLED: 'false',
      BIWA_PG_CACHE_STARTUP_SYNC: 'false',
      MYSQL_DATABASE: '',
      ONLINE_MYSQL_DATABASE: ''
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const response = await waitForServer(port);
  assert(response, 'O servidor de teste nao iniciou. ' + stderr.slice(-1000));
  assert.strictEqual(response.status, 200, 'O servidor de teste nao respondeu com HTTP 200.');

  const reports = readJson('reports.json');
  const model = readJson('semantic_model.json');
  const transforms = readJson('transform_queries.json');
  const imported = readJson('imported_tables.json');
  const formats = readJson('column_formats.json');
  const settings = readJson('settings.json');
  const legacySections = Object.entries({ reports, model, transforms, formats, settings })
    .filter(([, value]) => /faturamento2/i.test(JSON.stringify(value)))
    .map(([name]) => name);
  assert.deepStrictEqual(legacySections, [], 'Ainda restou referencia funcional a Faturamento2 em: ' + legacySections.join(', ') + '. Log: ' + stderr.slice(-1200));
  assert(/FROM\s+`Faturamento`\s+src/i.test(reports[0].sql), 'O SQL do relatorio nao foi migrado.');
  assert.strictEqual(model.tables.filter((item) => canonical(item.name) === 'faturamento').length, 1, 'A tabela do modelo foi duplicada.');
  assert.strictEqual(model.relationships.length, 1, 'O relacionamento equivalente foi duplicado.');
  assert(model.measures.some((item) => canonical(item.table) === 'faturamento' && canonical(item.name) === 'faturamento liquido'), 'A medida legada nao foi movida.');
  assert(formats.Faturamento && formats.Faturamento.Valor && formats.Faturamento.Empresa, 'Os formatos de coluna nao foram combinados.');
  const target = imported.find((item) => canonical(item.name) === 'faturamento');
  assert(target && target.steps.length === 1, 'As transformacoes ausentes nao foram copiadas para Faturamento.');
  assert.strictEqual(target.incrementalColumn, 'Data Emissao', 'A coluna incremental nao foi copiada.');
  assert.strictEqual(settings.access.onlineUsers[0].dataFilters[0].table, 'Faturamento', 'A restricao de usuario nao foi migrada.');

  console.log('Migracao de inicializacao validada em ambiente isolado: relatorios, modelo, transformacoes, formatos, indices logicos e restricoes de usuario atualizados.');
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
}).finally(async () => {
  await stopChild();
  const resolved = path.resolve(tempRoot);
  if (resolved.startsWith(root + path.sep + '.tmp-faturamento-migration-')) fs.rmSync(resolved, { recursive: true, force: true });
});
