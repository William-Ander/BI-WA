const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const start = source.indexOf('async function _syncTableToPostgresCacheInner');
const end = source.indexOf('\nfunction pgTypeForMysqlColumn', start);
assert(start >= 0 && end > start, 'Fluxo de sincronizacao PostgreSQL nao encontrado.');

const syncSource = source.slice(start, end);
const dateMetadataIndex = syncSource.indexOf('var fullIsDateColumn =');
const recoveryFilterIndex = syncSource.indexOf('var initialRecoveryStart =');
const sourceCountIndex = syncSource.indexOf('var sourceCountKnown =');

assert(syncSource.includes('await getMysqlColumnsMetadata(physicalTable)'), 'A sincronizacao deve usar somente colunas fisicas do MySQL.');
assert(!syncSource.includes("columns = await getColumns(physicalTable)"), 'A sincronizacao nao pode misturar colunas DAX/logicas no staging fisico.');
assert(dateMetadataIndex >= 0 && recoveryFilterIndex > dateMetadataIndex && sourceCountIndex > recoveryFilterIndex, 'O filtro de recuperacao precisa ser definido antes do COUNT e do streaming.');
assert(syncSource.includes("String(currentCalendarDefaultParts().year) + '-01-01'"), 'A recuperacao inicial deve usar dinamicamente o ano atual.');
assert(syncSource.includes("countSql = 'SELECT COUNT(*) AS cnt FROM ' + quoteIdent(physicalTable) + (fullWhere ? ' WHERE ' + fullWhere : '')"), 'O COUNT inicial precisa respeitar a mesma janela do streaming.');
assert(syncSource.includes('where: fullWhere'), 'O streaming inicial precisa receber o filtro de recuperacao.');
assert(!syncSource.includes("fullWhereParams = ['2026-01-01']"), 'Nao deixe ano fixo no fluxo de recuperacao.');
assert(syncSource.includes('BIWA_MYSQL_STREAM_INACTIVITY_TIMEOUT_MS || 300000'), 'Timeout seguro de streaming deve permanecer em cinco minutos.');
assert(source.includes('function summarizePostgresCacheStatus('), 'Diagnostico de prontidao precisa do resumo do cache PostgreSQL.');

assert(source.includes('async function pgCacheStorageSchemaCompatible('), 'A sincronizacao precisa reconhecer schemas fisicos compativeis.');
assert(syncSource.includes('mantendo sincronizacao incremental'), 'Mudanca apenas de formatacao ainda pode forcar full refresh desnecessario.');
assert(syncSource.includes("await client.query('TRUNCATE TABLE ' + tableSql)"), 'A atualizacao completa nao preserva a tabela referenciada por views.');
assert(syncSource.includes('sem remover as views dependentes'), 'A recuperacao nao registra a preservacao das views dependentes.');
assert((syncSource.match(/DROP TABLE IF EXISTS ' \+ tableSql \+ ' CASCADE'/g) || []).length >= 2, 'A troca com schema diferente ainda pode falhar por views DAX dependentes.');

console.log('Recuperacao do cache PostgreSQL validada.');
