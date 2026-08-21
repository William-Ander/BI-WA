Versão atual: v3.2.91 - Hotfix Inicialização

## v3.2.81 - Hotfix Inicialização

- Corrige travamento no instalador/inicialização removendo dependência nativa obrigatória do cache SQLite.
- O cache local fica em modo seguro quando o SQLite nativo não estiver disponível.
- O app volta a iniciar normalmente e continua consultando o MySQL como fonte oficial.
- Mantidas as regras de Tabela/Matriz e banco MySQL somente leitura.

## v3.2.78 - Cache Local Incremental

- Adicionada atualização incremental do cache local SQLite.
- Quando a tabela já possui cache, o botão principal passa a **Atualizar cache**.
- Adicionado botão **Recarregar completo** para reconstruir o cache do zero.
- O app detecta automaticamente estratégia por `id`, `auto_increment`, `updated_at`, `data_alteracao`, `ultima_atualizacao` ou janela recente por data.
- Marcadores de sincronização ficam salvos por tabela no SQLite local.
- Atualização por data de alteração usa chave primária para substituir linhas alteradas sem duplicar.
- Se a tabela não tiver coluna segura, o app mantém sincronização completa como fallback.
- Não altera o MySQL real.


## v3.2.77 - Cache Local SQLite Fase 1

- Adicionado cache local SQLite em `data/local_cache.db`.
- Tela **Tabelas e Views** ganhou botão **Sincronizar cache**.
- Cache é manual nesta fase e não altera o MySQL real.
- Quando uma tabela tem cache, a paginação, filtros, pesquisa e ordenação usam o SQLite local.
- Adicionado botão **Limpar cache** por tabela.
- Sincronização em lotes para reduzir travamentos em tabelas grandes.
- Índices automáticos em colunas prováveis de chave/data.
- Próxima etapa recomendada: atualização incremental por `id`, `updated_at` ou data de movimento.




## v3.2.76 - Tabela/Matriz avançada segura

- Adiciona Diagnóstico DAX na tela Modelo / Medidas.
- Lista medidas sem fórmula, medidas convertíveis, medidas com dependência, funções não suportadas e erros de conversão SQL.
- Adiciona resolvedor inicial para medidas que referenciam outras medidas, como `[Lucro]`, `[Faturamento]` e `DIVIDE([Lucro], [Faturamento])`.
- Adiciona botão Atualizar status DAX para gravar status, dependências e alertas no `semantic_model.json`.
- Amplia suporte DAX inicial com `IF`, `SWITCH` e `COUNTX` em fórmulas simples.
- Preserva medidas pendentes/importadas do PBIX: elas não são apagadas e não bloqueiam o salvamento do modelo.
- Mantém a regra congelada de Tabela/Matriz: texto continua como coluna direta e filtros apenas adicionam `WHERE`.


## v3.2.72 - Power Query ampliado

- Adiciona novas etapas em Transformar Dados: preencher vazios, duplicar coluna, dividir coluna, formatar texto e agrupar por.
- Agrupar por gera SQL seguro com `SUM`, `AVG`, `MIN`, `MAX`, `COUNT` e `COUNT DISTINCT`.
- Adiciona diagnóstico administrativo de consultas transformadas em `/api/transforms/diagnostics`.
- Mantém as transformações como camada de consulta somente leitura, sem alterar o MySQL original.
- Preserva a regra congelada de Tabela/Matriz: texto continua como coluna direta e filtros apenas adicionam `WHERE`.


## v3.2.69 - Filtros persistentes e slicer interativo

- Dashboard lembra filtros aplicados, selecoes de cross-filter, pagina ativa e zoom no navegador.
- Novo botao Limpar estado para resetar filtros temporarios e contexto local.
- Chips de filtros normais mostram valores aplicados e permitem remover um filtro individualmente.
- Visual do tipo slicer agora participa do cross-filter com selecao visual.
- Regra congelada de Tabela/Matriz preservada: texto vira coluna direta e filtros apenas adicionam WHERE.

## v3.2.68 - Cross-filter visual com seleção múltipla

- Permite selecionar mais de um valor no mesmo campo de cross-filter.
- Consolida valores selecionados em chips com contador.
- Destaca células, barras e fatias selecionadas no dashboard.
- Envia listas de seleção para o backend como filtros temporários seguros.
- Mantém a regra congelada de Tabela/Matriz: campos de texto continuam como coluna direta e filtros só adicionam WHERE.

## v3.2.67 - Cross-filter por relacionamentos

- Evolui o cross-filter temporario para usar caminhos do modelo semantico entre tabelas relacionadas.
- Permite que filtros de dimensao, como Cliente/Fornecedor/Calendario, sejam aplicados em visuais de tabelas fato relacionadas quando o relacionamento existe.
- Usa clausulas `EXISTS` seguras na execucao, sem alterar SQL salvo, banco de dados ou estrutura do visual.
- Mantem a regra congelada de Tabela/Matriz: texto continua como coluna direta e filtros apenas adicionam `WHERE`.


## v3.2.66 - Motor semântico Power BI ampliado

- Amplia o compilador DAX seguro com suporte inicial a `CALCULATE`, filtros simples, `SUMX`, `AVERAGEX`, `SELECTEDVALUE` e `COALESCE`.
- Melhora o Auto relacionar para considerar Calendário, colunas de data, chaves primárias/índices, compatibilidade de tipo e nível de confiança.
- Evolui o Diagnóstico do modelo com componentes de relacionamento, tabelas desconectadas, filtros online incompletos e relacionamentos suspeitos.
- Mantém a regra congelada de Tabela/Matriz: texto continua como coluna direta, sem `SUM()` indevido.

## v3.2.64 - Modelagem semântica reforçada

Esta versão melhora a base para se aproximar do Power BI: preserva medidas importadas do PBIX sem fórmula, adiciona diagnóstico do modelo, botão de auto relacionamento por colunas equivalentes e validação mais segura da montagem de JOINs.

A regra congelada de Tabela/Matriz continua preservada: campos textuais são exibidos como colunas diretas e nunca são transformados em `SUM()`.



## v3.2.31 - Fase 5 aplicada: Python/FastAPI e Windows profissional

Esta versão adiciona uma API Python/FastAPI funcional em paralelo ao backend Node.js atual.

Comandos principais:

```bash
npm run app
npm run build:win
npm run pack:win
npm run python:install
npm run python:dev
```

Arquivos úteis no Windows:

- comando `npm run python:install`
- comando `npm run python:start`
- modo experimental via `BIWA_SERVER_ENGINE=python npm run app`

O backend Node.js continua sendo o modo estável. O backend Python deve ser validado por rota antes da troca definitiva.

# BI WA

## v3.2.40 - Correção de timeout em tabelas/views

Esta versão melhora a tela **Tabelas e Views** para bancos/views mais pesados. O tempo de consulta foi ampliado, a amostra inicial ficou mais leve e, se a view demorar demais, a tela exibe um aviso orientando aplicar filtros em vez de quebrar com erro.


## v3.2.30 - Fase 5: Python/FastAPI e app Windows profissional

Esta versao inicia a Fase 5 sem quebrar o app atual.

O BI WA continua rodando com backend Node.js/Express, mas agora o pacote inclui:

- plano tecnico de migracao gradual para **Python/FastAPI**;
- scaffold inicial em `python_backend`;
- configuracao para empacotar o BI WA como aplicativo profissional de Windows com **Electron Builder**;
- scripts para instalar, abrir como app e gerar instalador `.exe`.

Versao atual: **v3.2.30 - Fase 5: preparacao Python/FastAPI + Windows profissional**

> Importante: o pacote final nao deve conter `.env` real, senhas, tokens, `node_modules`, logs ou perfil local do navegador.

## Arquitetura atual

```text
server.js                 Backend Express atual, ainda principal nesta fase
public/index.html         Interface web
public/app.js             Logica da interface, designer, dashboard e filtros
public/styles.css         Visual do app
desktop/main.js           Janela Electron para abrir como app Windows
python_backend/           Scaffold FastAPI para migracao futura
data/                     Relatorios e configuracoes limpas
info/                     Regras, planos tecnicos e marcadores de versao
.env.example              Modelo Desktop/Admin
.env.online.example       Modelo Online/Viewer
instalar_bi_wa.bat      Instalador unico do BI WA
Atalho BI WA            Criado pelo instalador na Area de Trabalho
npm run build:win       Gera instalador Windows em dist-windows
```

## Como usar como app Windows profissional

1. Extraia o ZIP.
2. Execute `instalar_bi_wa.bat`.
3. Depois use o atalho BI WA na Area de Trabalho.
4. Para gerar instalador `.exe`, execute `npm run build:win` em uma maquina Windows.

Requisitos para desenvolvimento/build: **Node.js 20 ou superior**.

## Migracao para Python/FastAPI

A pasta `python_backend` e apenas o inicio da migracao. O app principal continua em Node.js para preservar estabilidade.

Leia:

- `info/PLANO_MIGRACAO_PYTHON_FASTAPI.md`
- `info/PLANO_APP_WINDOWS_PROFISSIONAL.md`

## Como usar como Power BI interno

Fluxo recomendado:

1. Abrir o **Desktop/Admin**.
2. Configurar a conexao MySQL.
3. Usar **Conexoes** para organizar tabelas/views e relacionamentos.
4. Usar **Transformar dados** para criar consultas tratadas sem alterar o MySQL original.
5. Usar **Relatorio** para montar paginas, visuais, filtros, medidas e formatacao.
6. Salvar o relatorio no dashboard.
7. Configurar a versao Online/Viewer.
8. Publicar os relatorios para a URL online.
9. Os usuarios acessam apenas a versao Online/Viewer.

## Publicar a versao Online/Viewer

No servidor online, use `.env.online.example` como base e configure:

```env
APP_MODE=online
ALLOW_TABLE_WRITES=false
ALLOW_SCHEMA_CHANGES=false
ALLOW_REPORT_EDITING=false
ALLOW_PUBLISH=false
```

Recomendacao de seguranca: use um usuario MySQL somente leitura para a versao online.

Exemplo:

```sql
CREATE USER 'bi_viewer'@'%' IDENTIFIED BY 'senha_forte';
GRANT SELECT ON sua_base.* TO 'bi_viewer'@'%';
FLUSH PRIVILEGES;
```

## Rodar manualmente

```bash
cp .env.example .env
npm install
npm start
```

Para testar o modo online localmente no Windows:

```text
modo Online configurado pelo app/servidor
```

## Visual parecido com Power BI

Esta versao ja esta organizada para evoluir no padrao Power BI:

- canvas central de relatorio;
- paginas de relatorio;
- painel de visualizacoes;
- painel de dados/campos;
- painel de formatacao;
- filtros online;
- dashboard somente leitura;
- modo Admin separado do modo Viewer.

A evolucao ideal e manter o app atual e melhorar gradualmente o editor visual. Uma reescrita completa em Python e possivel, mas neste momento nao e recomendada porque esta base Node.js ja possui designer, dashboard, sincronizacao e bloqueios de permissao.

## Checklist antes de entregar nova versao

1. Atualizar `package.json`, `package-lock.json`, `info/VERSION.json` e `info/marcadores/vX.Y.Z.md`.
2. Executar `npm run check`.
3. Remover `.env`, `node_modules`, `*.log`, `browser-profile-*`, `dist`, `build` e arquivos temporarios do ZIP final.
4. Conferir se `data/settings.json` nao contem senha, token, host real ou usuario real.
5. Conferir se o modo online continua bloqueando edicoes.


## v3.2.29 - Login e permissões do Online

Nesta versão, o BI WA Online abre em uma tela de login própria. No Admin, em **Configuração > Versão Online / Visualização**, é possível cadastrar usuários, definir senhas e liberar quais relatórios e páginas cada usuário pode acessar.

A versão online permanece somente leitura e filtra relatórios, páginas, execução, exportação e atualização em tempo real conforme as permissões do usuário logado.


## v3.2.29 - Central de publicação Online

Esta versão adiciona uma central no Admin para acompanhar status de publicação, relatórios locais, permissões de usuários e verificação da versão Online.


## Melhorias da v3.2.30

- Fase 5 iniciada com plano de migracao Python/FastAPI.
- Adicionado scaffold `python_backend` com FastAPI.
- Adicionada configuracao Electron Builder para gerar instalador Windows.
- Adicionados scripts `instalar_bi_wa.bat`, `atalho BI WA` e `npm run build:win`.
- `desktop/main.js` agora espera o backend responder antes de abrir a janela.


## Como executar no Windows

1. Extraia o ZIP em uma pasta fixa.
2. Execute apenas `instalar_bi_wa.bat`.
3. Depois use o atalho **BI WA** criado na Area de Trabalho.


## Correção v3.2.36

- O instalador único foi corrigido para executar o `npm.cmd` diretamente no Windows.
- Essa correção evita o erro `Unknown command: "pm"` durante a instalação das dependências.
- Continua existindo apenas um arquivo `.bat`: `instalar_bi_wa.bat`.


## v3.2.36 - Ajuste de filtros online

Esta versão melhora o construtor de filtros do usuário online: botão Aplicar / inserir filtro, botão Deselecionar filtro, clique fora para deselecionar, preservação do campo selecionado e rolagem estável no popup.

## v3.2.36 - Atualizacao segura sem apagar dados locais

Esta versao corrige o problema de perder configuracoes ao copiar uma nova versao por cima da antiga.

A partir desta versao, o pacote ZIP nao leva mais arquivos `data/*.json` vazios. Assim, ao atualizar, os dados locais do usuario permanecem na pasta antiga, incluindo:

- configuracao do MySQL;
- relatorios e dashboards;
- modelo semantico;
- transformacoes;
- usuarios online;
- permissoes por relatorio/pagina;
- configuracao de publicacao online.

O instalador tambem cria um backup local em `_backup_dados_bi_wa` antes de iniciar a instalacao e preserva as variaveis existentes no `.env`.


### v3.2.40
- Popup de filtros online com cards mais compactos.
- Filtros arrastáveis livremente dentro do popup.
- Posição, largura e altura dos filtros passam a ser salvas no relatório.


## v3.2.40

- Corrigido o arraste dos filtros no popup usando alça **mover**.
- Cards de filtros mais compactos.
- Escopo do filtro reorganizado: **Global**, **Relatório atual** e **Página específica**.
- Correção para preservar filtros por página junto com permissões de usuário.

## Gerar pacote limpo para entrega

Antes de enviar o app para outra máquina ou pessoa, use:

```bash
npm run validate:package
npm run package:clean
```

O pacote limpo não deve conter `.env`, `data/settings.json`, `node_modules`, cache de navegador, backups locais, logs ou credenciais reais. Use `.env.example` e `data/settings.example.json` apenas como modelo.

## Segurança

Nunca compartilhe credenciais reais no ZIP. Configure usuário, senha e banco apenas no computador/servidor de uso, usando `.env` local ou a tela de configuração do app.


## v3.2.42 - Importação FINANCEIRO PBIX

- Adicionado relatório `FINANCEIRO - importado do Power BI` com 11 páginas detectadas no PBIX.
- Adicionado inventário técnico em `data/pbix_financeiro_inventory.json`.
- Adicionado relatório de importação em `info/IMPORTACAO_PBIX_FINANCEIRO_3.2.42.md`.
- Aumentado limite interno de visuais por relatório para suportar páginas grandes do Power BI.
- Observação: SQLs importados estão como placeholders seguros; para números reais em tempo real, mapear medidas DAX para SQL/MySQL.


## Destaques v3.2.74

- Diagnóstico dedicado de relacionamentos do modelo semântico.
- Sugestões de relacionamento por confiança: alta, média e baixa.
- Relacionamentos podem ser pausados/reativados sem apagar o vínculo.
- Relacionamentos inativos não entram na geração SQL nem na propagação de filtros.
- Detecção de duplicidade, colunas/tabelas ausentes, tipos incompatíveis e tabelas desconectadas.

## Destaques v3.2.76

- Ordenação por clique no cabeçalho da tela Tabelas e Views.
- Seletor de quantidade de linhas por página: 25, 50, 100, 250 e 500.
- Totais mais seguros: somente colunas integralmente numéricas são totalizadas.
- Subtotais iniciais para Matriz por primeiro campo textual quando os dados vêm agrupados/ordenados.
- Formatação visual segura para números positivos, negativos e zeros.
- Regra preservada: texto nunca vira SUM(), Cliente não vira SUM(Cliente) e Descrição Comercial não vira SUM(Descrição Comercial).

## v3.2.81 - Painéis estilo Power BI

- Painel Visualizações com abas Construir, Formatar e Analisar.
- Opções de Formatar visual ficam acessíveis como no Power BI.
- Correção da barra de rolagem no painel Visualizações.
- Painel Dados permite recolher/expandir a tabela atual sem perder campos selecionados.
- Lista de tabelas no painel Dados ficou mais próxima do Power BI.
- Mantém MySQL somente leitura e preserva a regra de Tabela/Matriz sem somar texto.


## v3.2.86 - Cache PostgreSQL seguro

Esta versao adiciona cache PostgreSQL opcional para acelerar tabelas grandes. Execute `instalar_postgresql_cache_bi_wa.bat` no Windows para instalar/configurar o PostgreSQL, reinicie o BI WA e use **Inserir Dados > Atualizar cache** nas tabelas inseridas. O MySQL continua sendo a fonte oficial e nao e alterado.
