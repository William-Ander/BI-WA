require('dotenv').config();
const { Client } = require('pg');

function q(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }

async function main() {
  const client = new Client(process.env.BIWA_PG_CACHE_URL || process.env.DATABASE_URL || {
    host: process.env.BIWA_PG_CACHE_HOST || '127.0.0.1',
    port: Number(process.env.BIWA_PG_CACHE_PORT || 5432),
    database: process.env.BIWA_PG_CACHE_DATABASE || 'bi_wa_cache',
    user: process.env.BIWA_PG_CACHE_USER || 'biwa_cache',
    password: process.env.BIWA_PG_CACHE_PASSWORD || 'biwa_cache'
  });
  await client.connect();
  const schema = process.env.BIWA_PG_CACHE_SCHEMA || 'biwa_cache';
  const names = ['Cliente e Fornecedor', 'Faturamento e Recebimento', 'Desconto Financeiro'];
  const meta = await client.query(`SELECT source_table, cache_table FROM ${q(schema)}.${q('__biwa_cache_meta')} WHERE LOWER(source_table) = ANY($1)`, [names.map((name) => name.toLowerCase())]);
  const tables = Object.fromEntries(meta.rows.map((row) => [row.source_table, row.cache_table]));
  async function mapped(name, requiredColumns) {
    const entry = meta.rows.find((row) => String(row.source_table).toLowerCase() === name.toLowerCase());
    if (entry) return `${q(schema)}.${q(entry.cache_table)}`;
    const discovered = await client.query(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = $1
      GROUP BY table_name
      HAVING ARRAY_AGG(column_name)::text[] @> $2::text[]
      ORDER BY CASE WHEN table_name LIKE 'dax_%' THEN 0 ELSE 1 END, table_name
      LIMIT 1
    `, [schema, requiredColumns]);
    if (!discovered.rows[0]) throw new Error('Cache não encontrado para ' + name + '.');
    return `${q(schema)}.${q(discovered.rows[0].table_name)}`;
  }
  const clientTable = await mapped('Cliente e Fornecedor', ['Chave 2', 'Grupo Cliente']);
  const factTable = await mapped('Faturamento e Recebimento', ['Chave 2', 'CFOP', 'Preço Unitario Faturamento', 'Quantidade Faturamento']);
  const discountTable = await mapped('Desconto Financeiro', ['Coluna1', 'Coluna2']);
  const groups = [
    'REDE G BARBOSA', 'REDE BOM PREÇO LOJAS', 'REDE ATACADÃO/WMS', 'REDE PERINI', 'REDE MIX',
    'REDE HIPERIDEAL', 'REDE ATAKAREJO / LOJAS', "REDE SAM'S CLUB", 'ALMACEN', 'REDE TOTAL ATACADO',
    'REDE CESTA DO POVO', 'REDE MATEUS', 'REDE MATEUS / LOJAS'
  ];
  const result = await client.query(`
    WITH fact_by_group AS (
      SELECT c.${q('Grupo Cliente')} AS group_name,
        COALESCE(SUM(CASE WHEN f.${q('CFOP')} IN ('5.102','6.102') THEN f.${q('Preço Unitario Faturamento')} * f.${q('Quantidade Faturamento')} ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN f.${q('CFOP')} IN ('1.202','1.2020','1.202A','2.202') THEN f.${q('Preço Unitario Faturamento')} * f.${q('Quantidade Faturamento')} ELSE 0 END), 0) AS net_value
      FROM ${clientTable} c
      LEFT JOIN ${factTable} f ON f.${q('Chave 2')} = c.${q('Chave 2')}
      GROUP BY c.${q('Grupo Cliente')}
    ), discount_by_group AS (
      SELECT d.${q('Coluna1')} AS group_name, SUM(d.${q('Coluna2')}) AS discount_value
      FROM ${discountTable} d
      GROUP BY d.${q('Coluna1')}
    )
    SELECT f.group_name, f.net_value, d.discount_value,
      f.net_value * d.discount_value AS expected_value
    FROM fact_by_group f
    JOIN discount_by_group d ON d.group_name = f.group_name
    WHERE f.group_name = ANY($1)
    ORDER BY f.group_name
  `, [groups]);
  console.log(JSON.stringify({ rows: result.rows, expectedTotal: result.rows.reduce((sum, row) => sum + Number(row.expected_value || 0), 0) }, null, 2));
  await client.end();
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
