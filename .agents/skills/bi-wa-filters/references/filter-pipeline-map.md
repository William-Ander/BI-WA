# Mapa do pipeline de filtros

## Contratos persistidos

normalizeOnlineFilters() produz filtros com:

- identidade: id, table, field, key e label;
- operação: operator, type, ui, multiSelect, defaultValue e allowAll;
- obrigatoriedade: requiredPageIds e mandatory;
- destino: scope, pageId e visualId;
- layout: largura, altura, posição e cores.

UIs aceitas: dropdown, between, relativeToday, search e list. Operadores: =, LIKE, >=, <= e BETWEEN.

Filtros internos de visual/página/todas as páginas são arrays separados no estado do visual/relatório. Cross-filters são normalizados por normalizeRuntimeCrossFilters() e viram filtros runtime.

## Backend: aplicação

Símbolos centrais em server.js:

- normalização/defaults: normalizeOnlineFilters, defaultOnlineFilterValue e withDefaultOnlineFilterValues;
- grafo: relationshipAllowsFilterPropagation, findFilterPropagationPath e findFilterDomainWitnessPlan;
- resolução: resolveFilterCondition, calendarFilterExpression e wrapResolvedFilterPredicate;
- SQL: buildReportFilterWhere e injectWhereIntoSelectSql;
- segurança: runtimeSecurityFiltersForReport e normalizeOnlineUserDataFilters;
- domínio: filterDomainContextForTarget, loadFilterOptionsWithContext e GET /api/filter-options.

buildReportFilterWhere():

- aplica defaults e valida seleção obrigatória;
- deduplica aliases por identidade;
- sincroniza filtros Calendário conflitantes;
- otimiza um conjunto Calendário para faixa de datas quando há relação direta;
- usa coluna direta ou EXISTS por caminho de relacionamento;
- parametriza multiseleção, intervalo, pesquisa e igualdade;
- retorna warning para filtro opcional sem caminho e 403 para obrigatório não resolvido.

Marcadores __BIWA_RUNTIME_FILTER_WHERE__ e __BIWA_RUNTIME_FILTER_AND__ permitem injeção dentro da fonte correta de medidas iteradoras.

## Backend: domínio de opções

GET /api/filter-options combina:

- contexto enviado pelo cliente;
- restrições obrigatórias do usuário;
- modelo semântico e direção das relações;
- domainTable/witness contextual quando necessário.

Com segurança ativa, erro de cascata retorna lista vazia/restrita ou conflito; nunca consulta ampla. Calendário usa calendarVirtualRows(). Transforms e tabelas calculadas usam relação lógica/view efetiva. O caminho comum lê PostgreSQL.

O cache do servidor usa filterOptionsCacheKey() com tabela, campo, limite, contexto, escopo de segurança e domínio. Defaults: TTL 300 s, até 300 itens, timeout de query 8 s.

## Frontend

Estado e defaults:

- dashboardFilters, dashboardCrossFilters e dashboardActivePages;
- canonicalDashboardFiltersForReport e applyDashboardFilterDefaultsForReport;
- dashboardRunPayload e dashboardRuntimeFilterSignature.

Opções/cascata:

- loadFilterOptions, fila scheduleFilterOptionsClientRequest e limite de 4 requests concorrentes;
- dashboardFilterContextForTarget, refreshOtherFilterOptions e bindCascadeEvents;
- AbortController por controle e tokens de hidratação impedem aplicar resposta antiga;
- cache biwa.filter.options.v7: com TTL de 10 min e até 120 itens, separado por escopo de segurança.

UI/runtime:

- renderDashboardFilterPanel, openDashboardFilterPopup e collectDashboardFilterInputs;
- renderRuntimeFilterCards e renderOnlineAppliedFilters;
- applyDashboardCrossFilterFromVisual e setupDashboardCrossFilterEvents;
- renderVisualFilterCards, renderPageFilterCards e renderAllPagesFilterCards;
- scheduleReportFilterVisualUpdate e refresh concorrente dos visuais afetados.

## Calendário

A tabela Calendario é virtual/nativa. Defaults reconhecem Data/DataKey, Ano, mês numérico/nome, AnoMes e Dia, respeitando BIWA_TIME_ZONE (default America/Bahia). Filtros relacionados são convertidos para a coluna de data da fato antes do agrupamento.

## Validadores

Estáticos:

- npm run validate:filter-integrity
- npm run validate:filter-popup
- node scripts/validate-filter-rules.js

Runtime local:

- npm run validate:filter-multiselect
- npm run validate:all-reports-filters
- npm run validate:filter-domain-architecture
- npm run validate:contextual-filter-domain
- npm run validate:month-filter-domain
- npm run validate:filtered-totals

Os testes de domínio afirmam queryBuildCount <= 1, bloqueio de reverse filtering indevido, exclusão de self-filter, witness contextual set-based e ausência de hardcodes de cenários reais.

