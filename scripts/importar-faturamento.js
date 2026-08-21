/**
 * Script para importar a view "faturamento" do MySQL para o BI WA.
 * 
 * Uso: node scripts/importar-faturamento.js
 * 
 * O script:
 * 1. Verifica se a view/tabela "faturamento" existe no MySQL
 * 2. Registra a importacao via API do BI WA
 * 3. Monitora o progresso da sincronizacao com PostgreSQL cache
 * 4. Cuida para nao travar com timeouts e limites de seguranca
 */

const http = require('http');
const https = require('https');
const { Buffer } = require('buffer');

// ============================================================
// CONFIGURACAO
// ============================================================

const BIWA_HOST = '127.0.0.1';
const BIWA_PORT = 3000;
const BIWA_ADMIN_USER = 'William Anderson';
const BIWA_ADMIN_PASS = '153197';

const SOURCE_TABLE = 'faturamento';
const APP_NAME = 'faturamento';

// Parametros de seguranca
const POLL_INTERVAL_MS = 3000;        // intervalo entre verificacoes de progresso (3s)
const MAX_WAIT_MS = 2 * 60 * 60 * 1000; // timeout maximo de 2 horas
const API_TIMEOUT_MS = 120000;        // timeout para cada chamada HTTP (2 min)
const MAX_CONSECUTIVE_ERRORS = 10;    // max erros consecutivos antes de abortar

// ============================================================
// UTILITARIOS HTTP
// ============================================================

function basicAuth() {
  return 'Basic ' + Buffer.from(BIWA_ADMIN_USER + ':' + BIWA_ADMIN_PASS).toString('base64');
}

function apiRequest(method, path, body) {
  return new Promise(function (resolve, reject) {
    const url = new URL('http://' + BIWA_HOST + ':' + BIWA_PORT + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      timeout: API_TIMEOUT_MS,
      headers: {
        'Authorization': basicAuth(),
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, function (res) {
      let data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.message || json.error || 'HTTP ' + res.statusCode + ' ' + (json.message || '')));
          } else {
            resolve({ status: res.statusCode, data: json });
          }
        } catch (e) {
          if (res.statusCode >= 400) {
            reject(new Error('HTTP ' + res.statusCode + ': ' + (data || '').slice(0, 200)));
          } else {
            reject(new Error('Invalid JSON response: ' + (data || '').slice(0, 200)));
          }
        }
      });
    });

    req.on('error', function (err) { reject(err); });
    req.on('timeout', function () { req.destroy(); reject(new Error('Timeout na requisicao (' + path + ')')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function logProgress(percent, copied, total, status) {
  const bar = '='.repeat(Math.round(percent / 2)) + ' '.repeat(50 - Math.round(percent / 2));
  process.stdout.write('\r[' + new Date().toLocaleTimeString() + '] Sincronizando: [' + bar + '] ' + percent + '%  ' + copied + '/' + total + ' linhas  ' + (status || ''));
}

// ============================================================
// PASSO 1 - Verificar se a tabela/view existe no MySQL
// ============================================================

async function verificarTabelaMySQL() {
  log('Verificando se "' + SOURCE_TABLE + '" existe no MySQL...');
  try {
    const resp = await apiRequest('GET', '/api/tables?scope=mysql');
    const tables = resp.data || [];
    const found = tables.find(function (t) {
      return String(t.name || '').toLowerCase() === SOURCE_TABLE.toLowerCase();
    });
    if (found) {
      log('OK - "' + SOURCE_TABLE + '" encontrada no MySQL (tipo: ' + (found.tableType || '?') + ', source: ' + (found.source || '?') + ')');
      return found;
    }
    log('AVISO - "' + SOURCE_TABLE + '" nao foi listada pelo endpoint /api/tables?scope=mysql.');
    return null;
  } catch (err) {
    log('ERRO ao consultar tabelas MySQL: ' + err.message);
    return null;
  }
}

// ============================================================
// PASSO 2 - Importar a tabela/view via API
// ============================================================

async function importarTabela() {
  log('Verificando se "' + APP_NAME + '" ja existe como importada...');
  try {
    const existing = await apiRequest('GET', '/api/imported-tables');
    const found = (existing.data || []).find(function(t) {
      return String(t.name || '').toLowerCase() === APP_NAME.toLowerCase();
    });
    if (found) {
      log('AVISO - "' + APP_NAME + '" ja existe. Removendo para re-importar do zero...');
      await apiRequest('DELETE', '/api/imported-tables/' + encodeURIComponent(APP_NAME));
      log('OK - Importacao anterior removida.');
    }
  } catch (err) {
    log('AVISO ao verificar tabelas importadas: ' + err.message);
  }

  log('Importando "' + SOURCE_TABLE + '" com nome "' + APP_NAME + '" no app...');
  const resp = await apiRequest('POST', '/api/imported-tables', {
    sourceTable: SOURCE_TABLE,
    name: APP_NAME
  });
  const imported = resp.data.imported;
  log('OK - Tabela registrada no app.');
  log('  sourceTable: ' + imported.sourceTable);
  log('  nome no app: ' + imported.name);
  log('  pgCacheSync: ' + (resp.data.pgCacheSync || 'N/A'));
  if (resp.data.autoHidden) {
    log('  autoHidden: ' + resp.data.autoHidden);
  }
  return resp.data;
}

// ============================================================
// PASSO 3 - Monitorar progresso da sincronizacao
// ============================================================

async function monitorarSincronizacao() {
  log('');
  log('Monitorando sincronizacao do PostgreSQL cache...');
  log('(pressione Ctrl+C para cancelar - a sincronizacao continua em background)');
  log('');

  const startTime = Date.now();
  let consecutiveErrors = 0;
  let lastProgress = '';
  let firstPoll = true;

  while (true) {
    const elapsed = Date.now() - startTime;

    if (elapsed > MAX_WAIT_MS) {
      log('');
      log('TIMEOUT - Sincronizacao ultrapassou ' + (MAX_WAIT_MS / 3600000).toFixed(0) + ' horas.');
      log('Os dados podem estar parcialmente carregados. Use "Recarregar completo" no painel Inserir Dados.');
      return false;
    }

    try {
      await new Promise(function (r) { setTimeout(r, firstPoll ? 2000 : POLL_INTERVAL_MS); });
      firstPoll = false;

      const resp = await apiRequest('GET', '/api/postgres-cache/progress?table=' + encodeURIComponent(APP_NAME));
      const progress = resp.data && resp.data.progress;

      if (progress) {
        consecutiveErrors = 0;
        const pct = Math.max(0, Math.min(100, progress.percent || 0));
        const copied = progress.rowsCopied || 0;
        const total = progress.totalRows || 0;
        const status = progress.status || '';

        if (status === 'done' || pct >= 100) {
          logProgress(100, copied, total, status);
          log('');
          log('CONCLUIDO - Sincronizacao finalizada!');
          log('  Total de linhas: ' + total);
          log('  Cache table: ' + (progress.previewCacheTable || 'N/A'));
          log('');
          return true;
        }

        if (status === 'error') {
          log('');
          log('ERRO - Sincronizacao falhou: ' + (progress.error || 'Erro desconhecido'));
          return false;
        }

        logProgress(pct, copied, total, status);
        lastProgress = pct + ' ' + copied + '/' + total + ' ' + status;
      } else {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log('');
          log('AVISO - Sem progresso apos ' + MAX_CONSECUTIVE_ERRORS + ' tentativas. A sincronizacao pode ja ter terminado ou estar em andamento sem reportar progresso.');
          return true;
        }
      }
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log('');
        log('AVISO - ' + MAX_CONSECUTIVE_ERRORS + ' erros consecutivos ao verificar progresso: ' + err.message);
        log('A sincronizacao pode ainda estar em andamento no servidor.');
        return false;
      }
    }
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('');
  console.log('========================================');
  console.log('  Importar View FATURAMENTO no BI WA');
  console.log('========================================');
  console.log('');
  console.log('  Origem MySQL: ' + SOURCE_TABLE);
  console.log('  Nome no App:  ' + APP_NAME);
  console.log('  Servidor:     ' + BIWA_HOST + ':' + BIWA_PORT);
  console.log('');

  const tabela = await verificarTabelaMySQL();

  await importarTabela();

  const sucesso = await monitorarSincronizacao();

  // Resumo final
  console.log('');
  if (sucesso) {
    console.log('========================================');
    console.log('  IMPORTACAO CONCLUIDA COM SUCESSO!');
    console.log('========================================');
    console.log('');
    console.log('  A view "' + APP_NAME + '" esta disponivel no BI WA.');
    console.log('  Acesse o app em http://' + BIWA_HOST + ':' + BIWA_PORT);
    console.log('');
  } else {
    console.log('========================================');
    console.log('  IMPORTACAO PARCIAL OU COM ERROS');
    console.log('========================================');
    console.log('');
    console.log('  Verifique o progresso no app:');
    console.log('  Inserir Dados > tabelas importadas');
    console.log('');
  }
}

main().catch(function (err) {
  console.error('');
  console.error('ERRO FATAL: ' + err.message);
  console.error('');
  console.error('Possiveis causas:');
  console.error('  1. Servidor BI WA nao esta rodando em ' + BIWA_HOST + ':' + BIWA_PORT);
  console.error('  2. A view/tabela MySQL "' + SOURCE_TABLE + '" nao existe');
  console.error('  3. Problema de conectividade com o MySQL');
  console.error('  4. Credenciais de admin invalidas');
  console.error('');
  console.error('Detalhes do erro:');
  console.error(err.stack || err);
  process.exit(1);
});
