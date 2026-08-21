const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });

const dataDir = path.join(root, 'data');
const outputFile = path.resolve(process.env.BIWA_MANUAL_SEED_OUTPUT || path.join(root, 'dados-iniciais-publicacao', 'manual_tables.snapshot.json'));
const schema = String(process.env.BIWA_PG_CACHE_SCHEMA || 'biwa_cache').trim() || 'biwa_cache';
const maxRowsPerTable = 5000;
const maxRowsTotal = 25000;

function quoteIdentifier(value) {
  return '"' + String(value || '').replace(/"/g, '""') + '"';
}

function key(value) {
  return String(value || '').trim().toLocaleLowerCase('pt-BR');
}

function poolConfig() {
  const connectionString = String(process.env.BIWA_PG_CACHE_URL || process.env.DATABASE_URL || '').trim();
  if (connectionString) return { connectionString, connectionTimeoutMillis: 15000 };
  return {
    host: String(process.env.BIWA_PG_CACHE_HOST || '127.0.0.1'),
    port: Number(process.env.BIWA_PG_CACHE_PORT || 5432),
    database: String(process.env.BIWA_PG_CACHE_DATABASE || process.env.BIWA_PG_CACHE_DB || 'bi_wa_cache'),
    user: String(process.env.BIWA_PG_CACHE_USER || process.env.BIWA_PG_CACHE_USERNAME || 'biwa_cache'),
    password: String(process.env.BIWA_PG_CACHE_PASSWORD || ''),
    connectionTimeoutMillis: 15000
  };
}

function normalizeColumns(columns, primaryKeys) {
  const primaryKeySet = new Set((Array.isArray(primaryKeys) ? primaryKeys : []).map(key));
  return (Array.isArray(columns) ? columns : []).map((column) => {
    const name = String(column && column.name || '').trim();
    if (!name) throw new Error('Metadado de coluna manual invalido.');
    const extra = String(column && column.extra || '');
    const primaryKey = primaryKeySet.has(key(name)) || Boolean(column && column.primaryKey) || String(column && (column.columnKey || column.key) || '').toUpperCase() === 'PRI';
    return {
      name,
      columnType: String(column && (column.columnType || column.dataType || column.type) || 'texto'),
      primaryKey,
      autoIncrement: Boolean(column && column.autoIncrement) || /auto_increment|serial/i.test(extra),
      allowNull: String(column && column.nullable || 'YES').toUpperCase() !== 'NO',
      extra
    };
  });
}

async function readManualNames() {
  const raw = await fs.readFile(path.join(dataDir, 'manual_tables.json'), 'utf8');
  const parsed = JSON.parse(raw || '[]');
  if (!Array.isArray(parsed)) throw new Error('data/manual_tables.json deve conter uma lista.');
  return Array.from(new Set(parsed.map((name) => String(name || '').trim()).filter(Boolean)));
}

async function exportSnapshot() {
  const manualNames = await readManualNames();
  const pool = new Pool(poolConfig());
  let totalRows = 0;
  try {
    const tables = [];
    for (const name of manualNames) {
      const metaResult = await pool.query(
        'SELECT source_table, cache_table, columns_json, primary_keys, sync_mode FROM ' + quoteIdentifier(schema) + '.' + quoteIdentifier('__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1) LIMIT 1',
        [name]
      );
      const meta = metaResult.rows[0];
      if (!meta || String(meta.sync_mode || '').toLowerCase() !== 'manual' || !meta.cache_table) {
        throw new Error('Tabela manual sem snapshot PostgreSQL valido: ' + name + '.');
      }
      const columns = normalizeColumns(meta.columns_json, meta.primary_keys);
      if (!columns.length) throw new Error('Tabela manual sem colunas: ' + name + '.');
      const tableRef = quoteIdentifier(schema) + '.' + quoteIdentifier(meta.cache_table);
      const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM ' + tableRef);
      const rowCount = Number(countResult.rows[0] && countResult.rows[0].count || 0);
      if (rowCount > maxRowsPerTable) throw new Error('Tabela manual excede o limite de ' + maxRowsPerTable + ' linhas: ' + name + '.');
      totalRows += rowCount;
      if (totalRows > maxRowsTotal) throw new Error('Snapshots manuais excedem o limite total de ' + maxRowsTotal + ' linhas.');
      const rowsResult = await pool.query('SELECT * FROM ' + tableRef + ' ORDER BY 1');
      tables.push({ name: String(meta.source_table || name), columns, rows: rowsResult.rows || [] });
    }
    const payload = {
      format: 'biwa-manual-tables-v1',
      generatedAt: new Date().toISOString(),
      tables
    };
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    const temp = outputFile + '.tmp';
    await fs.writeFile(temp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await fs.rename(temp, outputFile);
    console.log('Snapshot de tabelas manuais criado: ' + tables.length + ' tabela(s), ' + totalRows + ' linha(s).');
  } finally {
    await pool.end();
  }
}

exportSnapshot().catch((error) => {
  console.error('Falha ao criar snapshot de tabelas manuais:', error && error.message ? error.message : error);
  process.exitCode = 1;
});
