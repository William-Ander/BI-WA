# Mapa do motor de relatórios

## Contrato persistido

data/reports.json contém uma lista de relatórios. O normalizador atual preserva estes grupos:

- relatório: id, name, sql, visualization, visuals, refreshSeconds, limit, layout, pages, onlineFilters, theme, security e timestamps;
- compatibilidade adicional existente: pageFilters e allPagesFilters;
- visual: id, title, sql, visualization, table, dimension, value, selectedFields, buckets de matriz, agregação, ordem, filtros, estilo, layout e pageId;
- página: id e name;
- campo selecionado: objeto normalizado com nome, tabela/tipo/medida, identidade de instância, formato e largura quando presentes.

normalizeReportVisuals() limita a lista, valida tipo e SQL, normaliza buckets, estilo e layout. normalizeReportPages(), normalizeReportTheme() e normalizeReportSecurity() completam o contrato. publicReport() remove SQL e fórmulas sensíveis do payload público.

Tipos em VISUAL_TYPES: table, matrix, barras/colunas empilhadas ou não, line, area, pie, donut, scatter, funnel, gauge, card, kpi, map, slicer, textbox e image.

## Backend

Símbolos principais em server.js:

- construção: normalizeVisualQueryFields, inferVisualBaseTableForFields e buildVisualQueryFromRequest;
- modo raw: visualRawFieldNames, visualRawFieldObjects e shouldRunVisualAsRawTable;
- execução salva: sqlForVisualRunDetails, normalizeReportSqlForDashboard e executeReportVisualRun;
- totais: sqlForVisualMeasureTotalsRunDetails, visualTotalsMetadataForRun e reutilização de totais de card;
- armazenamento: readReports, writeReports e normalizeReportsForImport;
- realtime: runReportsForSocket, assinatura da subscription e timers por relatório.

Rotas:

- GET/POST /api/reports e PUT/DELETE /api/reports/:id;
- POST /api/visual-query para preview/construtor;
- POST /api/reports/:id/run para dashboard;
- GET /api/reports/:id/export.csv|xls|json;
- diagnósticos/modelo relacionados em /api/model/*.

POST /api/visual-query mede build/banco/resposta, usa queryBuildCount, pagina Tabela/Matriz e pode retornar totalsPending. O runtime salvo usa a mesma família de builders para evitar divergência entre editor e dashboard.

## Frontend

Persistência e hidratação:

- saveReport, loadReportIntoEditor, editReport e loadReports;
- reportEditorHydrated protege contra salvamento durante hidratação;
- reportRuntimeDefinitionSignature, dashboardResultMatchesReportRuntime e cachedVisualSatisfiesConfiguration validam cache contra configuração salva.

Páginas e visuais:

- ensureReportPages, renderReportPageTabs e switchReportPage;
- ensureReportVisuals, defaultReportVisual, addReportVisual e removeReportVisual;
- renderReportPageVisuals, renderVisualFromCachedRows e renderViz;
- tableHtml, matrixHtml e renderizadores de gráfico/card/slicer.

Campos e consultas:

- normalizeSelectedFields, collectPreviewFields e normalizeVisualBucketsForType;
- assignBuilderField, removeSelectedVisualField, projeção DOM imediata e reconciliação;
- visualBuilderReady, scheduleVisualAutoUpdate e buildVisualPreview;
- visualQueryVersionsById, visualAutoRequestsById e configSignature descartam respostas antigas.

## Regra Tabela/Matriz

info/REGRA_TABELA_MATRIZ_SEM_ERRO.md protege buildVisualQueryFromRequest, shouldRunVisualAsRawTable, collectPreviewFields, rawPreviewVisualType e buildVisualPreview.

Campos físicos de Eixo, Valores e painel Dados entram diretamente no SELECT; filtros adicionam predicados, não mudam projeção. Medidas DAX continuam compiladas. A estrutura de colunas deve sobreviver mesmo com zero linhas.

## Totais e paginação

- UI: VISUAL_TABLE_SERVER_PAGE_SIZE = 200, render progressivo inicial/lotes de 100.
- Preview envia deferTotals para Tabela/Matriz.
- scheduleVisualAuthoritativeTotals() busca totais após a primeira página.
- Backend usa visualTotalsMetadataForRun(); não monte uma segunda implementação paralela.

## Validadores

Estáticos:

- npm run validate:builder-layout
- npm run validate:report-pages-resources
- npm run validate:visual-resize
- npm run validate:table-fields
- node scripts/validate-visual-rules.js
- node scripts/validate-visual-format-persistence.js

Runtime local:

- npm run validate:visual-measure-pipeline
- npm run validate:field-mutation-performance
- npm run validate:visual-table-origins
- npm run validate:report-builder-upgrades
- npm run validate:column-widths
- npm run validate:table-load-regression

Os validadores runtime dependem de relatórios/modelo/cache reais e usam API local. Não os execute contra Online/produção.

