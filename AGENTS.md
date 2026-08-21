# AGENTS.md — BI WA

## Escopo

Estas instruções valem para todo o projeto nesta pasta. O aplicativo real está aqui; a pasta pai contém ZIPs históricos e um perfil de navegador que não fazem parte do código-fonte.

## Fonte de verdade

Use esta ordem para decidir como o sistema funciona:

1. Código executável atual em server.js, public/app.js, public/index.html e desktop/main.js.
2. Comandos realmente declarados em package.json.
3. Normalizadores e contratos de persistência do backend.
4. Regras em info/ e REGRAS_CORRECOES.md, validando-as contra o código atual.
5. README.md e marcadores históricos apenas como contexto.

Há drift documental conhecido: package.json está em 3.4.80, enquanto info/VERSION.json ainda registra 3.2.93. Não corrija versão, marcador ou changelog como efeito colateral de outra tarefa.

## Arquitetura real

- server.js: backend principal Node.js/Express, Socket.IO, autenticação, permissões, persistência JSON, sincronização MySQL→PostgreSQL, compilador DAX, planner semântico, filtros, relatórios e publicação.
- public/app.js: frontend monolítico do Admin/Desktop e Online/Viewer; contém editor de relatório, dashboard, filtros, modelagem, transformações e controle de concorrência das consultas.
- public/index.html e public/styles.css: shell e estilos da interface.
- desktop/main.js: wrapper Electron que inicia server.js; o modo FastAPI é experimental.
- data/: estado local do usuário e metadados persistidos. Trate tudo, exceto arquivos *.example.json, como dados mutáveis da instalação.
- scripts/: validadores estáticos, testes de runtime, diagnósticos, empacotamento e deploy.
- python_backend/: implementação FastAPI parcial e antiga; não é equivalente ao backend Node atual.
- instalar no servidor/: espelho de entrega, não uma implantação ativa. Atualize-o somente quando o escopo pedir preparação do pacote/servidor.

## Invariantes obrigatórios

- Nunca leia, imprima, copie ou versione segredos de .env, data/settings.json, arquivos de autenticação, logs ou configurações reais.
- Não sobrescreva data/reports.json, data/semantic_model.json, data/transform_queries.json, data/imported_tables.json ou tabelas manuais sem pedido explícito e estratégia de preservação.
- Iniciar server.js executa ensureStore() e pode aplicar migrações/merges em data/; para testes de startup, prefira cópia isolada.
- Preserve a separação Desktop/Admin versus Online/Viewer. effectivePermissions() deve continuar negando escrita, alteração de schema, edição de relatório e publicação a viewers online.
- Relatórios e visuais aceitam apenas SQL de leitura por assertReadOnlySql()/assertReadOnlySqlPreservingRuntimeFilterMarkers().
- O caminho analítico atual é PostgreSQL operacional. runSelect() e /api/filter-options não devem ganhar leitura MySQL visível ao usuário como fallback casual; MySQL é origem de sincronização/importação e operações administrativas autorizadas.
- Não altere relacionamentos do modelo semântico implicitamente. Filtros, DAX e joins dependem de active, cardinalidade e direção.
- Em Tabela/Matriz, campos físicos permanecem colunas diretas; nunca reintroduza SUM() automático sobre texto.
- Respostas obsoletas de consultas devem continuar canceladas/ignoradas por visual, assinatura e versão.
- Não faça deploy, publicação online, SSH, empacotamento ou sincronização de dados sem solicitação explícita.

## Skills locais

Carregue a Skill mais específica antes de agir:

- bi-wa-production-safety: autenticação, permissões, persistência, atualização, pacote, publicação, deploy e qualquer operação com risco para dados/produção.
- bi-wa-dax: medidas DAX, compilação SQL, dependências, iteradores, contexto de filtro e formatação de medidas.
- bi-wa-report-engine: schema de relatório, editor, páginas, visuais, Tabela/Matriz, totais e execução do dashboard.
- bi-wa-filters: filtros online, visuais, página/todas as páginas, cross-filter, cascata, Calendário e RLS.
- bi-wa-performance: cache PostgreSQL/memória/cliente, timeouts, concorrência, realtime e diagnóstico de lentidão.
- bi-wa-qa: seleção e execução segura dos validadores e testes existentes.

Use mais de uma Skill quando a mudança atravessar fronteiras; por exemplo, uma medida lenta filtrada exige bi-wa-dax, bi-wa-filters e bi-wa-performance.

## Fluxo de trabalho

1. Localize símbolos e rotas com rg antes de editar os monólitos.
2. Trace o contrato ponta a ponta: estado persistido → normalização backend → API → estado frontend → renderização.
3. Faça a menor alteração compatível com relatórios já salvos e com o modo viewer.
4. Valide primeiro de forma estática; testes que iniciam o servidor ou usam banco devem rodar em ambiente local/isolado, nunca contra produção.
5. Como esta cópia não possui metadados Git, registre explicitamente os arquivos criados/alterados e confira-os por listagem ou hash.

## Validação básica

- npm run check valida a sintaxe de server.js, public/app.js e desktop/main.js.
- Escolha validadores adicionais pelo mapa da Skill bi-wa-qa.
- Não presuma que npm run validate:all, npm run validate:visual-rules ou npm run validate:filter-rules existem: aparecem em documentação antiga, mas não estão declarados no package.json atual.

