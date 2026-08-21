# Matriz de validação

## Baseline

npm run check executa node --check em:

- server.js;
- public/app.js;
- desktop/main.js.

É o primeiro gate e não inicia o aplicativo.

Não há script npm test genérico. Também não existem no package.json atual os aliases validate:all, validate:visual-rules e validate:filter-rules, embora documentos antigos os citem. Os arquivos scripts/validate-visual-rules.js e scripts/validate-filter-rules.js existem e podem ser chamados diretamente após inspeção.

## Validadores estáticos por área

### Segurança, viewer e publicação

- npm run validate:publication-seed
- npm run validate:online-user-publish-merge
- npm run validate:online-viewer-format-contract
- npm run validate:online-viewer
- npm run validate:online-admin
- npm run validate:user-profile
- npm run validate:user-data-security
- npm run validate:monitoring-settings
- npm run validate:online-status

### Filtros e UI

- npm run validate:filter-integrity
- npm run validate:filter-popup
- npm run validate:builder-layout
- npm run validate:report-pages-resources
- npm run validate:visual-resize
- npm run validate:mobile-portal
- npm run validate:connection-diagram
- node scripts/validate-filter-rules.js
- node scripts/validate-visual-rules.js
- node scripts/validate-visual-format-persistence.js

### DAX, transformações e persistência

- npm run validate:transform-modeling
- npm run validate:dax-variable-lookup
- npm run validate:dax-filtered-iterator
- npm run validate:dax-column-lookup
- npm run validate:dax-concat-text
- npm run validate:dax-comma-literal
- npm run validate:receipt-calculated-conversion
- npm run validate:conversion-decimals
- npm run validate:packaging-conversion
- npm run validate:freight-measures
- npm run validate:table-fields
- npm run validate:faturamento-migration
- npm run validate:pg-cache-recovery

Esses scripts leem código/arquivos e fazem assertions. Alguns validam presença textual de contratos; use runtime adicional quando a mudança altera comportamento.

## Validadores runtime

Os comandos abaixo usam fetch, normalmente contra BIWA_TEST_BASE_URL ou http://127.0.0.1:3000, e dependem de relatório/modelo/cache da instalação:

- filtros: validate:filter-multiselect, validate:all-reports-filters, validate:filter-domain-architecture, validate:contextual-filter-domain e validate:month-filter-domain;
- DAX/planner: validate:dax-variable-table, validate:dax-values-iterator, validate:relationship-planner, validate:visual-measure-pipeline, validate:measure-editor e validate:dax-price-cost;
- relatório/performance: validate:field-mutation-performance, validate:visual-table-origins, validate:report-builder-upgrades, validate:column-widths e validate:table-load-regression;
- diagnósticos expostos como validate:*: validate:dependent-measures, validate:sales-average, validate:filtered-totals e validate:effective-transform-pipeline.

Muitos enviam POST para consultas/diagnósticos read-only. Ainda assim, não os aponte para produção e não presuma custo baixo.

### Cuidados especiais

- validate:dax-isblank-all escreve temporariamente em data/semantic_model.json e depois restaura. Execute apenas em cópia isolada; valide hash antes/depois.
- validate:effective-transform-pipeline só ativa mutação quando BIWA_TEST_MUTATE_TRANSFORM=1 e exige BIWA_TEST_ISOLATED_COPY=1. Não defina essas flags no workspace real.
- validate:dax-price-cost, validate:relationship-planner e diagnósticos de mês/performance podem abrir conexão PostgreSQL direta.
- Alguns scripts exigem relatórios/tabelas/medidas com nomes do estado local atual; ausência é pré-condição não atendida.

## Testes que criam ambiente/processo

- npm run test:faturamento-migration
- npm run test:mysql-auth-guard
- npm run test:seed-conversion-migration
- npm run test:seed-cost-lookup-migration
- npm run test:online-status

Os testes de migração/guard criam cópias temporárias e/ou processos Node. Verifique caminho temporário e porta antes de executar. server.js pode alterar data/ via ensureStore() se o teste não estiver isolado.

## Pacote e release

- npm run validate:package: auditoria de arquivos proibidos/segredos óbvios; pode inspecionar o ZIP existente, mas não gera deploy.
- npm run package:clean: remove/substitui o ZIP da versão na pasta pai e cria artefato. Só execute quando o usuário pedir empacotamento.
- npm run build:win, pack:win, build:service e package:server criam binários/pacotes; não são gates normais.
- scripts deploy-cloud.*, Cloudflare, serviço e endpoints /api/deploy/* são operações externas, nunca QA implícito.

## Seleção mínima por mudança

- Apenas documentação/Skills: validar frontmatter/links e conferir lista de arquivos; não precisa iniciar o app.
- server.js segurança/permissão: check + validadores estáticos de viewer/admin/usuário; runtime isolado se a rota mudou.
- DAX: check + validadores estáticos da função + um pipeline runtime representativo.
- filtros: check + integridade/popup + domínio/multiselect runtime local.
- Tabela/Matriz/editor: check + validate-visual-rules.js + builder/runtime afetado.
- performance: compare queryBuildCount, Server-Timing, frio/quente e hashes, preservando resultado.
- persistência/migração: teste exclusivamente em cópia isolada com snapshots antes/depois.

