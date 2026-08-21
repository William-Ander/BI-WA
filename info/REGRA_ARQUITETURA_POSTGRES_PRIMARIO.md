# Regra - Arquitetura PostgreSQL Primário (MySQL somente sincronização)

A partir da v3.2.93, o BI WA funciona com **PostgreSQL como banco primário** para todas as operações de leitura.
O **MySQL é usado exclusivamente para sincronizar/atualizar** as tabelas do cache PostgreSQL.

## Regra permanente

- O PostgreSQL (`biwa-postgres`) é o banco de dados operacional do app. Todas as telas consultam o PG primeiro.
- MySQL é **somente sincronização**. Nenhuma tela pode depender de MySQL estar online para leitura de dados.
- Se MySQL estiver offline, o app deve continuar 100% funcional com os dados em cache PG/SQLite.
- Nenhuma atualização futura pode inverter essa arquitetura ou reintroduzir dependência de MySQL para leitura.
- O cache local SQLite é fallback secundário (quando PG também indisponível).

## Fluxo de dados

```
MySQL (origem, somente leitura)
    │
    └── sincroniza ──> PostgreSQL (cache operacional, consultas)
                       │
                       └── fallback ──> SQLite (cache local)
```

## Funções-chave no server.js e suas regras

| Função | Linha | Regra |
|--------|-------|-------|
| `runSelect()` | ~5236 | PG cache primeiro → SQLite → PG fallback SELECT * → vazio. **Nunca** adicionar MySQL como fallback de leitura. |
| `tryRunSelectFromPostgresCache()` | ~5099 | `noCache: true` bloqueia PG cache. **Nunca** usar `noCache: true` em endpoints de leitura. |
| `findDatabaseResourceByName()` | ~4528 | PG cache primeiro → INFORMATION_SCHEMA → varredura MySQL. PG SEMPRE antes de MySQL. |
| `getColumns()` | ~4644 | PG cache → SQLite → MySQL SHOW FULL COLUMNS. Ordem preservada. |
| `getRelationMeta()` | ~4581 | PG cache → SQLite → MySQL metadata. Ordem preservada. |
| `postgresCacheAvailable()` | ~7325 | Verifica se PG pool e POSTGRES_CACHE_ENABLED estão ativos. |
| `autoImportUnimportedTables()` | ~8250 | Auto-importa tabelas do cache PG para `imported_tables.json` sem depender de MySQL. Deve ser chamada no startup. |

## Endpoints e sua independência de MySQL

| Endpoint | Tela | Dependência MySQL | Comportamento sem MySQL |
|----------|------|-------------------|------------------------|
| `GET /api/tables` (default) | Tabelas, Transformar, Modelo | Nenhuma | Usa `imported_tables.json` + cache PG |
| `GET /api/tables?scope=mysql` | Importar Tabela | Fallback | Tenta MySQL, fallback para cache PG |
| `GET /api/tables/lite` | Listagem leve | Fallback | Tenta MySQL, fallback para cache PG |
| `GET /api/tables/:table/rows` | Navegador de tabelas | Fallback | PG → SQLite → MySQL (imported) |
| `GET /api/tables/:table/columns` | Colunas | Fallback | PG → SQLite → MySQL |
| `POST /api/transforms/preview` | Transformar | Fallback | `runSelect()` → PG cache |
| `POST /api/reports/:id/run` | Relatórios | Nenhuma | `runSelect()` → PG cache |
| `GET /api/reports/:id/export.*` | Exportação | Nenhuma | `runSelect()` → PG cache (nunca `noCache: true`) |
| `POST /api/visual-query` | Visuais | Nenhuma | PG → SQLite → vazio |
| `GET /api/filter-options` | Filtros/Slicers | Nenhuma | PG → SQLite → vazio |
| `GET/PUT /api/model` | Modelo | Nenhuma | JSON file apenas |
| `POST /api/imported-tables` | Importar Tabela | Escrita | Sem MySQL não importa, mas existing tables funcionam |

## O que NUNCA fazer

1. **NUNCA** usar `noCache: true` em `runSelect()` — isso bloqueia PG cache (linha 5100) e faz o endpoint retornar vazio.
2. **NUNCA** inverter a ordem de fallback em `findDatabaseResourceByName()` — PG cache SEMPRE primeiro.
3. **NUNCA** remover o fallback PG do `GET /api/tables?scope=mysql` — o dropdown de Importar Tabela depende disso.
4. **NUNCA** usar `dbQuery()` (MySQL direto) em endpoints de leitura visíveis ao usuário. Apenas `runSelect()`.
5. **NUNCA** esquecer de chamar `autoImportUnimportedTables()` se adicionar nova rota de startup.

## O que SEMPRE fazer

1. **SEMPRE** usar `runSelect()` para qualquer consulta de dados que o usuário vê.
2. **SEMPRE** verificar `postgresCacheAvailable()` antes de acessar recursos PG.
3. **SEMPRE** que uma tabela for adicionada ao cache PG, garantir que `autoImportUnimportedTables()` pode encontrá-la.
4. **SEMPRE** testar com `POSTGRES_CACHE_ENABLED=true` e MySQL offline antes de entregar versão nova.

## Operações que exigem MySQL (por design)

Estas são as ÚNICAS situações em que MySQL é obrigatório:

- Criar/alterar/excluir tabelas (`POST/DELETE /api/tables`)
- Inserir/atualizar/excluir linhas (`POST/DELETE /api/tables/:table/rows`)
- Sincronizar cache PG (`autoSyncAllTablesToPgCache()`)
- Importar nova tabela (`POST /api/imported-tables`)
- Testar conexão MySQL (`POST /api/mysql/test`)

Se MySQL estiver offline, essas operações falham com mensagem clara, mas **nenhuma tela de leitura pode quebrar**.
