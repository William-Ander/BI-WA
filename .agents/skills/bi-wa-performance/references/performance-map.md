# Mapa de performance

## Backend: limites e caches

Defaults atuais em server.js:

- recursos: query 8 s, total 15 s, cache 120 s;
- linhas de tabela: 90 s; colunas: 20 s;
- cache de resultados: TTL 15 s, até 250 itens;
- opções de filtro: TTL 300 s, até 300 itens, query 8 s;
- query analítica PostgreSQL: 30 s;
- health probe: 2,5 s; intervalo 5 s;
- stream MySQL: inatividade 300 s;
- modelo semântico em memória: 30 s.

cachedDbQuery() e cachedPgAnalyticsQuery() deduplicam requests em voo e clonam resultados serializados. clearQueryCache() avança uma geração para impedir que uma promise antiga repovoe cache após invalidação.

Funções/estruturas importantes:

- resourceListCache e collectDatabaseResourcesWithDiagnostics;
- queryCache, inFlightQueryCache e buildQueryCacheKey;
- filterOptionsCache e filterOptionsCacheKey;
- semanticModelMemCache;
- tryRunSelectFromPostgresCache e resolveSqlTableToPgCache;
- dashboardPostgresCacheCoverage e publicPgCacheStatus.

O cache analítico recebe cacheScope; preserve nele usuário/papel/revisão de restrição quando o dado depender de segurança.

## Frontend: limites e caches

Defaults atuais em public/app.js:

- API geral 15 s; tabelas 30 s; linhas 95 s; colunas 20 s; salvar modelo 60 s;
- preview visual: TTL 15 s, até 40 itens;
- resultado de filtro de relatório salvo: TTL 2 min, até 8 itens;
- opções de filtro: TTL 10 min, até 120 itens, 4 requests concorrentes e 400 opções iniciais;
- valores de tabela: TTL 5 min, até 60 itens;
- Tabela/Matriz: página de servidor 200, render inicial 100 e lotes de 100.

Chaves de dashboard/cache local incluem clientDataSecurityScope().

## Concorrência do editor

- visualAutoTimersById, visualAutoRequestsById e visualQueryVersionsById;
- scheduleVisualAutoUpdate() cancela trabalho anterior, gera versão e registra assinatura;
- buildVisualPreview() rejeita resposta cuja versão/configuração mudou;
- incrementalMeasureQueryPlan() consulta apenas dimensões + medida adicionada e faz merge seguro;
- remoção de campo projeta DOM imediatamente e só consulta se visualFieldRemovalNeedsQuery() indicar mudança semântica;
- scheduleVisualAuthoritativeTotals() separa total da primeira página.

## Filtros

/api/filter-options retorna performance.durationMs, queryBuildCount e cacheHit. O frontend cancela request anterior por controle, limita concorrência e aquece opções em background. Alterações devem preservar uma consulta set-based, evitando N+1 por valor/filtro.

## Realtime e saúde

Socket.IO usa subscription id e timers por relatório. runReportsForSocket() verifica se a assinatura ainda é atual antes de iniciar/publicar resultados. probeDataSourceHealth() acompanha MySQL e último sync PG sem transformar indisponibilidade MySQL em falha dos relatórios cacheados.

O scheduler de cache mantém pgCacheSchedulerState e respeita BIWA_PG_CACHE_SYNC_OWNER, intervalo e flag de startup. Não habilite sincronização automática nos dois processos por padrão.

## Instrumentação existente

- /api/visual-query: objeto performance, queryBuildCount e cabeçalho Server-Timing.
- frontend: visualFieldPerformanceClient() em window.__BIWA_FIELD_PERF__ (máximo 240 eventos).
- debug opcional: BIWA_FILTER_DEBUG_LOG, BIWA_VISUAL_FIELD_DEBUG e flags do frontend.
- /api/readiness/diagnostics, /api/postgres-cache/diagnostics, /api/realtime/status e /api/dashboard/connection-status.

Não habilite logs detalhados permanentemente; podem conter SQL/parâmetros e crescer até o limite de rotação.

## Validadores e benchmarks

- npm run validate:field-mutation-performance: uma query por mutação e integridade antes/depois.
- npm run validate:report-builder-upgrades: frio/quente, paginação, totais, cancelamento e Server-Timing.
- npm run validate:filter-domain-architecture: domínio set-based e queryBuildCount <= 1.
- npm run validate:contextual-filter-domain: witness contextual, cache e ausência de N+1.
- npm run validate:table-load-regression: contrato salvo, zero linhas e planner sem CROSS JOIN.
- npm run validate:pg-cache-recovery: fluxo estático de recuperação/sync.
- npm run validate:online-status: contrato estático de status.
- npm run validate:sales-average e validate:filtered-totals para cenários reais locais.

Os validadores de runtime usam a API/banco configurados e podem ser caros. Rode somente localmente e preserve hashes dos arquivos de estado quando o script oferecer essa garantia.

