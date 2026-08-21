# Mapa de segurança e produção

## Limites de confiança no backend

- server.js define APP_MODE como desktop ou online.
- defaultSettings() deriva permissões de ALLOW_TABLE_WRITES, ALLOW_SCHEMA_CHANGES, ALLOW_REPORT_EDITING e ALLOW_PUBLISH.
- effectivePermissions() força todas essas permissões para false quando isOnlineViewerRole() é verdadeiro.
- apiAuthRequired protege /api após as rotas públicas de login/configuração.
- requireDesktopAdmin() exige papel admin; requirePermission() exige admin e a permissão correspondente.
- requireSyncToken() protege /api/sync/* usando SYNC_TOKEN/token persistido e comparação constante por safeEqual().
- runtimeSecurityFiltersForReport() converte restrições do usuário e RLS em filtros obrigatórios. Falha de propagação obrigatória deve continuar retornando 403, nunca dados amplos.

## Persistência local

server.js usa estes arquivos:

- data/settings.json: conexão, usuários, permissões, publicação e VPS; pode conter segredo.
- data/reports.json: relatórios, páginas, visuais, filtros e segurança.
- data/semantic_model.json: tabelas, relacionamentos e medidas DAX.
- data/transform_queries.json: consultas transformadas e etapas.
- data/imported_tables.json: aliases importados, filtros, etapas e coluna incremental.
- data/manual_tables.json, data/column_formats.json e data/hidden_tables.json.
- data/mysql_auth_guard.json, data/audit_log.json e data/erros/.

writeSettings, writeReports, writeSemanticModel, writeTransforms e gravadores afins usam arquivo .tmp seguido de rename. Preserve esse padrão. appendAuditLog() mantém até 1000 eventos, mas grava diretamente; não use o audit log como transação ou fonte única de verdade.

### Efeito de startup

ensureStore() pode criar arquivos ausentes e executar:

- migração de referências legadas de Faturamento2;
- merges de coluna incremental e regras seed;
- inclusão de transforms/tabelas manuais ausentes;
- autodetecção de charset.

Portanto, iniciar o app não é estritamente read-only para data/.

## SQL e bancos

- assertReadOnlySql() aceita uma única consulta iniciada por SELECT ou WITH e bloqueia comandos de escrita/admin.
- runSelect() injeta filtros parametrizados e tenta tryRunSelectFromPostgresCache(); se não houver resultado/cache, retorna vazio. Não faz fallback MySQL analítico.
- /api/filter-options usa Calendário virtual, views lógicas e cache PostgreSQL; com restrições de usuário, falha fechado.
- MySQL continua necessário para sincronização, importação, teste de conexão e operações administrativas autorizadas.
- POSTGRES_CACHE_SYNC_OWNER controla se o scheduler pertence a server, desktop, all ou disabled.

## Superfícies mutáveis

Rotas com alto impacto incluem:

- /api/settings, /api/model, /api/reports e /api/transforms;
- /api/tables*, /api/imported-tables* e /api/hidden-tables*;
- /api/postgres-cache/:table/sync e remoção de cache;
- /api/sync/*, /api/publish/*, /api/deploy/test e /api/deploy/run.

Ações de deploy também existem em deployToVps(), scripts/deploy-cloud.ps1, scripts/deploy-cloud.sh, scripts Cloudflare/PostgreSQL e gerenciadores de serviço. Uma tarefa de código não autoriza executá-las.

## Empacotamento e espelho do servidor

- scripts/validate-package.js varre arquivos proibidos/segredos óbvios e inspeciona um ZIP existente da versão atual.
- scripts/make-clean-package.js remove/substitui BI_WA_limpo_v<versão>.zip na pasta pai; é uma ação material.
- empacotar_servidor_com_servico.ps1 e instalar no servidor/ formam outro fluxo de entrega.
- O espelho contém server.js, public/, lib/, data/, dados-iniciais-publicacao/, executável e scripts operacionais.

Não copie dados locais para dados-iniciais-publicacao/ sem revisar se são seeds deliberados. Preserve a regra de atualização de não sobrescrever estado já existente no destino.

## Validadores relevantes

Estáticos e normalmente seguros:

- npm run check
- npm run validate:online-viewer
- npm run validate:online-admin
- npm run validate:online-viewer-format-contract
- npm run validate:user-profile
- npm run validate:user-data-security
- npm run validate:online-user-publish-merge
- npm run validate:monitoring-settings
- npm run validate:publication-seed

Consulte bi-wa-qa antes dos testes que iniciam servidor, conectam ao banco ou escrevem temporariamente em data/.

