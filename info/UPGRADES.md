
## v3.2.2 - Etapa 3: Performance e tempo real

- Adicionado cache de consultas SQL com TTL configurável.
- Adicionada deduplicação de consultas simultâneas iguais.
- Socket.IO agora atualiza por relatório, respeitando o intervalo individual.
- Dashboard cancela assinatura em aba oculta e reassina ao voltar.
- Adicionado diagnóstico `/api/realtime/status`.
- Adicionado endpoint administrativo para limpar cache.
- Adicionada base opcional para invalidar cache por evento no MySQL.

## v3.0.7 - Conexões com linhas visuais estilo Power BI

## v3.1.1 - Conexões com cards persistentes e linhas precisas

- Cards das tabelas/views permanecem salvos ao sair e voltar da tela Conexões.
- Posições dos cards são gravadas no modelo semântico.
- Linhas de relacionamento são redesenhadas entre as colunas exatas dos cards.
- Painel Tabelas e Views pode ser recolhido para ganhar espaço.
- Painel Criar relacionamento pode ser recolhido para ganhar espaço.
- Área visual de modelagem mantém rolagem própria e cards na tela.


- Tela Conexões ajustada para manter cards de tabelas/views no modelo visual.
- Relacionamentos salvos agora aparecem como linhas entre as colunas dos cards.
- Ao criar um vínculo arrastando coluna para coluna, a linha é desenhada automaticamente.
- Área de modelagem ganhou rolagem própria e mantém as tabelas/cards visíveis na tela.
- Regra permanente adicionada para manter o comportamento de modelagem visual nas próximas versões.


## v3.0.3 - Filtros dinâmicos estilo Power BI

- Popup de filtros com controles reais para suspenso, lista, pesquisa, entre e hoje.
- Filtro pode ser editado ao clicar sobre o visual no popup.
- Filtro pode ser excluído pelo botão X.
- Tamanho do filtro redimensionado é preservado no relatório.
- Tipo do campo passa a ser inferido pela coluna selecionada, principalmente datas e números.
- Regra adicionada para manter comportamento dinâmico dos filtros nas próximas versões.


## v2.9.2

- Criado popup responsivo para configurar filtros do usuário online.
- Adicionado suporte aos modelos de filtro suspenso, entre, hoje, pesquisa e lista.
- O botão Filtros da versão online agora abre popup para aplicar filtros liberados pelo administrador.

## v2.7.9 - Tela de relatórios estilo Power BI

- Reorganizada a tela Relatórios / Dashboards com canvas central, painel Visualizações e painel Dados.
- Adicionado fluxo de criação visual mais parecido com Power BI.
- Corrigido carregamento do painel de campos para não perder tabelas/views quando a modelagem falhar.
- Adicionado botão para recarregar dados no painel de criação de visual.


## v2.7.9 - Criador visual de relatórios e dashboards

- Adiciona fluxo visual para montar relatórios sem escrever SQL.
- Permite selecionar tabela/view, eixo, valor, agregação, filtro, ordenação, tipo de visual e salvar no dashboard.
- Mantém SQL seguro como modo avançado para usuários técnicos.
- Adiciona funções de modelagem ausentes no backend para salvar/gerar prévia do modelo sem erro.

# Upgrades do BI WA

## v2.6.7 - ICO oficial restaurado

- Restaurado o ICO oficial enviado pelo usuario como icone do app.
- O mesmo ICO oficial agora e usado para atalho Windows, barra de tarefas e favicon.
- O instalador voltou a apontar para `public/app-icon.ico`.
- O PNG `logo-bi-wa.png` permanece reservado para a tela inicial/menu lateral.
- Registrada regra para nao alterar o icone oficial sem novo envio do usuario.
- Criado marcador `info/marcadores/v2.6.7.md`.

## v2.6.5 - Ícone nítido na barra de tarefas

- Criado `public/taskbar-icon.ico` com desenho simplificado para uso em 16x16, 20x20, 24x24, 32x32 e tamanhos maiores.
- Mantida a logo PNG completa somente na interface/tela inicial do app.
- Manifest e favicon passaram a apontar para o ícone dedicado da barra de tarefas.
- Instalador agora remove o perfil/cache local do app e recria o atalho `BI WA.lnk`.
- `abrir_bi_wa_app.bat` passou a usar um perfil isolado `browser-profile-biwa` para evitar cache antigo do navegador.
- Criado marcador `info/marcadores/v2.6.5.md`.

# Histórico de upgrades do BI WA

## v2.6.4 - Indicador de ultima atualizacao no dashboard

- Adicionado indicador **Ultima atualizacao** ao lado do botao **Atualizar agora**.
- O indicador mostra quando os dados do dashboard foram atualizados pela ultima vez.
- Durante a atualizacao manual, o indicador exibe **atualizando...**.
- O horario tambem e atualizado quando o dashboard recebe dados automaticos via WebSocket.
- Criado marcador `info/marcadores/v2.6.4.md`.

## v2.6.3 - Correção das telas em branco

- Corrigido HTML inválido na seção **Tabelas MySQL**.
- Corrigido ID duplicado entre a tela de tabelas e a aba de permissões em Configuração.
- Corrigida navegação das abas internas da tela **Configuração**.
- Ajustado o escopo dos painéis `.settings-panel` para não afetar outras telas.
- Criado marcador `info/marcadores/v2.6.3.md`.


## v2.6.2 - Ícone multiresolução para barra de tarefas

- Regerado `public/app-icon.ico` como ICO multiresolução com tamanhos 16, 24, 32, 48, 64, 128 e 256 px.
- Adicionados PNGs dedicados `app-icon-192.png`, `app-icon-256.png` e `app-icon-512.png` para manifest/navegador.
- Ajustado `public/manifest.json` para priorizar ícones PNG de alta resolução.
- Ajustado `index.html` para versionar favicon/manifest e evitar cache antigo.
- Ajustado instalador para recriar o atalho Windows usando `app-icon.ico,0`.
- Mantida `logo-bi-wa.png` somente como logo da tela inicial/interface.
- Criado marcador `info/marcadores/v2.6.2.md`.

## v2.6.1 - Ícone ICO no app/atalho e PNG na tela inicial

- Ajustado o app para usar o arquivo ICO como ícone do atalho Windows, favicon e identificação visual do app.
- Mantida a logo PNG na tela inicial/menu lateral do BI WA.
- Adicionado `public/app-icon.ico`.
- Adicionado `public/manifest.json` para reforçar a identidade visual no navegador/app.
- Criado marcador `info/marcadores/v2.6.1.md`.

## v2.6.0 - Configuração online e controle de versões

- Criada a pasta `info` para documentar upgrades, versões e regras do projeto.
- Adicionado `VERSION.json` com marcador da versão atual.
- Adicionado histórico consolidado de upgrades em `UPGRADES.md`.
- Adicionado marcador individual da versão em `info/marcadores/v2.6.0.md`.
- Mantida a configuração da **Versão Online / Somente Visualização** dentro do app.
- A versão online usa usuário e senha configurados no Desktop/Admin.
- O link web da versão online continua protegido por autenticação básica.
- A edição na versão online continua bloqueada no backend por `APP_MODE=online`.

## v2.5.0 - Conexão MySQL organizada

- Reorganizada a área de configuração do MySQL.
- Adicionado assistente de conexão para MySQL local, MySQL em servidor, gateway, túnel ou proxy.
- Adicionadas orientações sobre host/IP, porta, firewall, usuário, senha e base.
- Renomeado o botão para **Salvar e testar MySQL**.
- Adicionada explicação de que gateway do Power BI não é necessário para o BI WA.

## v2.4.0 - Desktop por atalho de app

- Removida a dependência do Electron para evitar falhas no Windows.
- Criado atalho **BI WA** na Área de Trabalho.
- O app passou a abrir em janela própria pelo Microsoft Edge/Chrome em modo aplicativo.
- Mantida a execução local do backend Node.js.

## v2.3.0 - Instalador automático e logos

- O instalador deixou de pedir configurações durante a instalação.
- Todas as configurações passaram a ser feitas dentro do app.
- Adicionada a logo BI WA no app.
- Adicionado favicon e ícone para o app.

## v2.2.0 - MySQL configurado dentro do app

- O instalador deixou de solicitar dados do MySQL.
- A conexão MySQL passou a ser cadastrada na aba **Configuração**.
- Adicionado botão de teste de conexão MySQL dentro do app.

## v2.1.0 - Instalador único

- Consolidados instaladores separados em um único instalador.
- A configuração da versão web/online foi movida para dentro do app.

## v2.0.0 - Desktop/Admin e Online/Viewer

- Criada separação entre modo Desktop/Admin e modo Online/Viewer.
- Desktop/Admin permite edição, criação de tabelas, relatórios e configurações.
- Online/Viewer fica somente para visualização.
- Publicação de relatórios do Desktop para Online via URL e token.

## v1.0.0 - MVP inicial

- Criado app web para conexão com MySQL.
- Adicionada listagem de tabelas.
- Adicionada visualização de dados.
- Adicionado criador de relatórios SQL.
- Adicionados dashboards com atualização automática.
## v2.6.6 - 2026-05-29

- Corrigido erro do instalador durante limpeza de cache de icones do Windows.
- Instalador nao interrompe mais caso o cache esteja bloqueado ou inacessivel.
- Mantido o icone dedicado para barra de tarefas e atalho BI WA.
## v2.6.9 - 2026-05-29

- Correção para forçar a aplicação do ICO oficial na barra de tarefas.
- Novo perfil local do navegador para evitar cache do ícone antigo.
- Atalho recriado apontando para `public/app-icon.ico`.

## v2.7.0 - 2026-05-29

- Criado teste dedicado de conexão MySQL em `/api/mysql/test`.
- O botão **Salvar e testar MySQL** agora mostra a mensagem real do MySQL em vez de apenas `Failed to fetch`.
- Adicionadas orientações automáticas para erro de senha/usuário, host, firewall, timeout, base inexistente e SSL.
- O teste valida a conexão antes de salvar definitivamente as configurações.


## v2.7.1 - Servidor local persistente e diagnostico de backend

- Adicionado endpoint local `/api/local/ping` para verificar se o backend do BI WA esta ativo.
- Ajustado o atalho do app para iniciar/reiniciar o servidor local antes de abrir a janela.
- Ajustado o teste MySQL para primeiro validar o servidor local e depois testar o MySQL.
- Melhorada a mensagem quando a tela nao consegue falar com `localhost:3000`.
- Mantido o icone oficial enviado pelo usuario.
## v2.7.2 - Views do MySQL na navegacao

- A listagem lateral agora traz tabelas base e views do MySQL.
- Views aparecem identificadas como `view`.
- Views podem ser visualizadas e usadas em relatórios/dashboards.
- Edição, inclusão, exclusão e alteração de estrutura continuam bloqueadas para views.
- A tela de Estrutura passa a listar apenas tabelas base para adicionar colunas.


## v2.7.3 - Tabelas externas somente leitura e tabelas manuais editáveis

- Tabelas base existentes no MySQL agora são tratadas como somente leitura no BI WA.
- Views continuam somente leitura.
- Apenas tabelas manuais criadas pelo próprio BI WA podem receber inclusão, edição, exclusão e novas colunas.
- A listagem lateral passa a indicar `mysql leitura`, `view` ou `manual/editável`.
- A tela de estrutura passa a focar em criação de tabelas manuais.
- O backend bloqueia escrita em qualquer tabela que não esteja marcada como manual em `data/manual_tables.json`.

## v2.7.4 - 2026-05-29

- Corrige a listagem de views do MySQL quando elas nao aparecem pelo metodo anterior.
- Busca objetos por tres caminhos: `INFORMATION_SCHEMA.TABLES`, `INFORMATION_SCHEMA.VIEWS` e `SHOW FULL TABLES`.
- Separa visualmente o menu lateral em **Tabelas** e **Views**.
- Mantem views e tabelas externas como somente leitura; apenas tabelas manuais criadas no BI WA continuam editaveis.

## v2.7.5 - Marcador de versão corrigido
- Corrigido o marcador de versão dentro do app.
- Launcher agora compara a versão do servidor local com a versão instalada.
- Se detectar versão antiga rodando na porta local, reinicia o servidor da pasta atual.
- Cache dos arquivos estáticos foi reduzido para evitar interface antiga.
## v2.7.6 - Modelagem estilo Power BI

- Adicionada aba **Modelo / Medidas**.
- Permite selecionar colunas de tabelas e views para montar relatórios sem escrever SQL.
- Permite criar relacionamentos entre tabelas/views, com LEFT JOIN ou INNER JOIN.
- Permite criar medidas DAX simples: `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `DISTINCTCOUNT` e `COUNTROWS`.
- Medidas são convertidas para SQL seguro no backend.
- Modelo salvo em `data/semantic_model.json`.
- Tabelas e views externas continuam somente leitura; tabelas manuais continuam sendo as únicas editáveis.
## v2.7.7 - Correção da listagem de tabelas e views
- Corrige travamento visual em “Carregando...” na lista lateral.
- Mostra erro real se a API de tabelas/views falhar.
- Adiciona diagnóstico interno para tabelas/views do MySQL.
## v2.8.0 - Interface compacta e visuais estilo Power BI

- App ajustado para abrir maximizado no Edge/Chrome em modo aplicativo.
- Layout geral mais compacto e responsivo.
- Tela de Configuração compactada, com menor espaçamento e melhor quebra de colunas.
- Tela Relatórios / Dashboards reorganizada para caber melhor em telas menores.
- Painel Visualizações ampliado com botões de visual parecidos com Power BI: tabela, matriz, cartão, barras, colunas, linhas, área, pizza, rosca, dispersão, funil, gauge, mapa, KPI e segmentação.
- Visuais ainda são gerados de forma segura pelo backend Node.js; alguns tipos avançados usam renderização compatível temporária até receberem comportamento específico.


## v2.8.1 - Correção permanente da listagem de tabelas e views

- Adicionado timeout no frontend para chamadas de `/api/tables`.
- Adicionado timeout nas consultas MySQL do backend.
- A lista lateral de tabelas/views não deve mais ficar presa em `Carregando...`.
- Em caso de falha, o app mostra erro e botão para tentar novamente.
- Criado `info/REGRA_LISTAGEM_TABELAS_VIEWS.md` para evitar regressão nas próximas atualizações.


## v2.8.2 - Editor de dashboards estilo Power BI

- Corrigidos botões de retrair/expandir dos painéis laterais.
- Adicionado botão para recolher menu lateral esquerdo.
- Canvas de edição com página fixa 1280x720, mantendo o tamanho padrão do dashboard para publicação online.
- Visual selecionado agora pode ser arrastado e redimensionado dentro da página.
- Conteúdo de tabela/matriz dentro do visual usa rolagem interna, sem expandir o tamanho do visual.
- Campos do painel Dados podem ser arrastados para a área do relatório.
- Regra registrada para manter comportamento de edição/página igual ao Power BI nas próximas versões.
## v2.8.3 - 2026-05-29

- Corrige identificadores SQL com espaços/acentos no criador visual.
- Compacta painel Dados e colunas de tabelas/matrizes.

## v2.8.4 - Atualização automática do visual

- Remove a dependência do botão Atualizar visual no criador de relatórios.
- O visual agora renderiza automaticamente ao selecionar, marcar ou arrastar campos.
- Mudanças de tipo de visual, agregação, filtros e limite também disparam atualização automática.
- Adiciona regra permanente em `info/REGRA_AUTO_RENDER_VISUAL.md`.

## v2.8.5 - Tela Conexões para modelagem

- Adicionada opção **Conexões** no menu lateral.
- Criada área para selecionar tabelas/views que entram no modelo.
- Criada área visual de modelo com cartões de tabelas/views.
- Criada criação de relacionamentos com cardinalidade, direção de filtro e tipo SQL.
- Relacionamentos continuam salvos em `data/semantic_model.json`.
- Adicionada regra permanente `info/REGRA_CONEXOES_MODELAGEM.md`.


## v2.8.6 - Tabela nativa Calendário

- Adicionada tabela nativa `Calendario` criada/atualizada pelo BI WA.
- A tabela contém colunas de calendário: Data, DataKey, Ano, Mês, Nome do mês, Ano/Mês, Dia, Dia da semana, Semana do ano, Trimestre, Semestre, Início/Fim do mês, Último dia do mês, Dia útil e Fim de semana.
- Adicionado botão **Criar/atualizar Calendário** na tela Conexões.
- A tabela Calendário aparece no grupo **Nativas** e pode ser usada em relacionamentos com qualquer tabela/view que possua campo de data.
- A tabela Calendário é somente leitura no BI WA e não deve ser editada manualmente.

## v2.8.7 - Conexões em cards estilo Power BI
- A tabela nativa Calendario passa a aparecer sempre como primeira opção em Conexões.
- A área de modelo usa cards de tabelas/views com colunas internas.
- Relacionamentos podem ser criados arrastando uma coluna para outra.
- A tela Conexões ficou mais compacta e responsiva.
- Reforçada a regra de que a tabela Calendario é nativa e somente leitura.
## v2.8.8 - Filtros do usuário online
- Adicionada configuração de filtros permitidos no criador de relatórios.
- A versão online exibe botão Filtros nos dashboards quando o administrador liberar campos.
- Filtros online são aplicados no backend apenas em campos autorizados no relatório.


## v2.8.9 - Correção crítica da listagem de tabelas/views
- Timeout e fallback no backend para listagem de tabelas/views.
- Diagnóstico por método de carregamento.
- Frontend deixa de ficar preso em `Carregando...`.
- Mantém `Calendario` visível mesmo quando MySQL falha.

## v2.9.0 - Campos removíveis na visualização

- Adicionado botão de remover no campo Eixo / dimensão.
- Adicionado botão de remover no campo Valores.
- Adicionado botão de remover no campo Filtros.
- Ao remover um campo, o visual atualiza automaticamente.
- Checkboxes do painel Dados agora refletem os campos efetivamente usados no visual.
- O criador visual permite ficar sem eixo, sem valor ou sem filtro sem prender seleção antiga.


## v2.9.1 - Múltiplos visuais no relatório
- Criado suporte a múltiplos visuais no mesmo canvas de relatório.
- Botão + Visual e arrasto de tipos de visual para a área de edição.
- Cada visual pode ser selecionado, arrastado, redimensionado e removido.
- O relatório salva o layout dos visuais para publicação online.

## v2.9.3 - Filtros online por tabela/view/nativa
- Popup de filtros agora permite escolher a fonte do filtro: tabela, view ou tabela nativa.
- A tabela Calendario pode ser escolhida diretamente no popup de filtros.
- Depois de escolher a fonte, o app carrega as colunas dessa fonte para liberar o filtro ao usuário online.
- O filtro salvo mantém a informação da tabela/view de origem para auditoria e publicação online.

## v2.9.4 - Filtros popup redimensionáveis e funcionais
- Adicionado controle real de filtros no popup.
- Adicionado carregamento de opções distintas por tabela/view/nativa.
- Adicionado suporte a lista, suspenso, entre, hoje e pesquisa.
## v2.9.5 - Tela de relatórios compacta
- Ajustada a tela Relatórios/Dashboards para não ter rolagem geral.
- Mantido canvas 1280x720 dentro de área fixa, como no Power BI.
- Rolagem restrita ao menu principal e painéis Visualizações/Dados.
- Adicionada regra permanente REGRA_TELA_RELATORIOS_COMPACTA.md.



## v2.9.6 - Calendário nativo virtual nos filtros

- Corrige erro `CREATE command denied` ao usar a tabela nativa `Calendario` nos filtros.
- O app não tenta mais criar tabela física no MySQL para carregar opções de filtro da tabela Calendario.
- A tabela Calendario passa a retornar opções de filtro em modo virtual, geradas pelo próprio BI WA.
- Mantém Calendario como tabela nativa somente leitura para modelagem e filtros.


## v2.9.7 - Propagação de filtros por relacionamento

- Filtros aplicados na tabela nativa Calendario agora propagam para tabelas relacionadas.
- Exemplo: Calendario[Data] filtrando hoje passa a filtrar a coluna de data relacionada da tabela faturamento.
- O filtro é aplicado no SQL do visual antes de GROUP BY/ORDER BY/LIMIT.
- Adicionada regra permanente REGRA_PROPAGACAO_FILTROS_RELACIONAMENTOS.md.

## v2.9.8 - Transformar Dados estilo Power Query
- Criada tela **Transformar Dados** no menu lateral.
- Adicionado editor de etapas aplicadas: selecionar/remover/renomear colunas, alterar tipo, filtrar, ordenar, substituir valores e remover duplicados.
- Consultas transformadas são salvas em `data/transform_queries.json` e aparecem como fonte de dados nos relatórios.
- As transformações são camada somente leitura e não alteram o MySQL original.

## v2.9.9 - Transformar Dados: etapas aplicadas e prévia

- Melhorada a tela Transformar Dados no padrão Power Query.
- Lista de etapas agora inclui a etapa Fonte e permite clicar para ver a prévia até cada etapa.
- Etapas aplicadas agora podem ser reorganizadas com botões para mover para cima/baixo.
- Prévia recalcula automaticamente depois de adicionar, editar, remover ou mover etapas.
- SQL gerado acompanha a prévia da etapa selecionada ou o resultado final.
- Mantida a regra de não alterar a base MySQL original.


## v3.0.0 - Transformar Dados: mesclar e acrescentar consultas

- Adicionadas as etapas **Mesclar consultas** e **Acrescentar consultas** no módulo Transformar Dados.
- Mesclar consultas permite combinar a consulta atual com tabela/view/consulta transformada por colunas correspondentes, usando LEFT/INNER/RIGHT JOIN.
- Acrescentar consultas permite empilhar linhas com UNION ALL, mantendo colunas de mesmo nome e preenchendo colunas ausentes com branco.
- A prévia recalcula automaticamente após aplicar, editar, mover ou remover essas etapas.
- Mantida a regra de não alterar tabelas/views originais do MySQL.

## v3.0.1 - Transformar Dados: colunas personalizadas e condicionais

- Adicionada etapa **Coluna personalizada** no módulo Transformar Dados.
- Adicionada etapa **Coluna condicional** no estilo IF/THEN/ELSE do Power Query.
- As novas colunas aparecem na prévia, nas etapas aplicadas e nas consultas transformadas salvas.
- Expressões aceitam colunas entre colchetes, exemplo: `[Valor Total] * 0.9`, `[Produto] & " - " & [Marca]`, `YEAR([Data])`.
- Registrada regra para manter essas etapas nas próximas versões.
## v3.0.2 - Usar consultas transformadas nos relatórios

- Consultas salvas em **Transformar Dados** agora entram oficialmente como fonte de dados em Relatórios / Dashboards.
- As consultas transformadas aparecem junto com tabelas, views e Calendario na seleção de fonte.
- O criador visual aceita consultas transformadas para eixo, valores, filtros e prévia.
- Opções de filtro do popup online podem vir de consultas transformadas.
- Se a listagem do MySQL falhar, consultas transformadas locais ainda podem aparecer para diagnóstico/uso quando possível.
- A fonte transformada continua somente leitura e não altera o MySQL original.

## v3.0.4 - Calendario nativo virtual corrigido

- Corrigido erro `Table ... Calendario doesn't exist` na tela Tabelas e Views.
- A tabela `Calendario` agora é tratada como fonte nativa/virtual antes de qualquer validação no MySQL.
- A visualização de linhas do Calendario é gerada pelo BI WA, sem consultar tabela física.
- O criador visual passa a gerar SQL derivado virtual quando a fonte do visual é `Calendario`.
- Título da tela de visualização identifica `Calendario` como `calendario nativo`, não como MySQL.

## v3.0.5 - Tabelas e Views somente visualização

- A tela **Tabelas e Views** passa a ser somente para visualizar dados e exportar CSV.
- O painel lateral de edição de linhas foi removido dessa tela.
- A seção **Criar Tabelas** fica responsável por criar e alterar tabelas manuais do BI WA.
- Tabelas/views externas, consultas transformadas e Calendario permanecem somente leitura.


## v3.0.6 - Criar Tabelas estilo Power BI
- Reformula a seção Criar Tabelas para funcionar como Inserir dados do Power BI.
- Adiciona grade editável para digitar ou colar dados do Excel.
- Permite usar a primeira linha como cabeçalho.
- Permite definir tipos das colunas antes de carregar a tabela.
- Cria tabela manual do BI WA com opção de ID automático para edição segura.
- Insere os dados da grade no carregamento da tabela.

## v3.0.9 - Carregamento otimizado e status online/offline

- Otimizado o carregamento de tabelas/views para usar caminho rapido e cache local.
- A listagem lateral pode mostrar a ultima lista carregada enquanto atualiza em segundo plano.
- Reduzidos timeouts padrao da listagem para evitar tela presa aguardando MySQL.
- Dashboard agora mostra status **Online** quando recebe dados em tempo real.
- Se perder conexao com o servidor local/internet, o dashboard mostra **Offline** e a ultima atualizacao recebida.
- Adicionada regra permanente para status de dashboard e carregamento rapido de fontes.



## v3.0.9 - Correção crítica da listagem de tabelas/views

- Corrigido erro de JavaScript `mergeTransformsIntoResources is not defined`.
- A listagem volta a combinar corretamente tabelas MySQL, views, Calendario e consultas transformadas.
- Reforçada regra para que a listagem nunca fique presa em carregando por erro de função auxiliar ausente.


## v3.1.0 - Visualização de tabelas paginada
- Corrigido timeout ao visualizar tabelas grandes.
- A tela Tabelas e Views passa a carregar somente uma página inicial de linhas.
- COUNT(*) deixa de ser obrigatório na visualização para evitar lentidão.
- Adicionados controles Anterior/Próxima.


## v3.1.2 - Painéis de Conexões recolhíveis sem sumir

- Ajusta a tela Conexões para manter os painéis no lado direito/final da página.
- Painéis recolhidos deixam uma aba visível para expandir novamente.
- O painel recolhido não desaparece nem deixa o usuário sem ação de retorno.
- O modelo visual passa a preservar cards derivados de tabelas salvas, relacionamentos e posições.
- Reforça que cards salvos e vínculos devem permanecer ao sair e voltar da tela.

## v3.2.0

Melhorias aplicadas nesta versao:

1. Frontend do dashboard online aprimorado com visual mais premium, status por card, zoom, pausa do tempo real e modo expandido por relatorio.
2. Reducao de carga no MySQL: o dashboard nao reassina WebSocket quando pausado ou com aba oculta.
3. Seguranca online: sem credenciais configuradas, o modo online bloqueia acesso por padrao. Defina `VIEWER_USER` e `VIEWER_PASSWORD`, ou use `BIWA_ALLOW_OPEN_ONLINE=true` apenas quando a visualizacao publica for desejada.
4. Endpoint de execucao de relatorio protegido com rate limit simples configuravel por `API_RATE_WINDOW_MS` e `API_RATE_MAX_REQUESTS`.
5. Entrega limpa: remover `.env`, `node_modules`, logs e perfil local do ZIP final.

## v3.2.1 - Etapa 2: Visual estilo Power BI

Esta versão adiciona a segunda etapa de melhorias visuais do BI WA:

- canvas de relatório em proporção 16:9;
- controles de zoom e tela cheia;
- snap na grade;
- painel de propriedades/formatação;
- temas claro, escuro e executivo;
- persistência de estilos por visual;
- preparação para gráficos com Apache ECharts, com fallback interno.

Não inclui `.env`, `node_modules`, logs ou perfis locais no pacote final.

## v3.2.3 - Etapa 4 - BI avançado
- Medidas DAX simples com expressões aritméticas e `DIVIDE()`.
- Calendário automático com relacionamento para colunas de data.
- Exportação CSV/JSON por relatório.
- Exportação CSV da prévia do modelo.
- Botão Imprimir/PDF no dashboard.
- Base inicial de drill-down por duplo clique em tabelas com filtro online correspondente.



## v3.2.4 - Validação frontend e responsividade geral

- Adicionado bloco final de CSS responsivo para corrigir telas que cortavam informações em resoluções comuns de notebook/desktop.
- Tela Conexões: canvas, lista de tabelas/views e painel de relacionamento passam a respeitar melhor a largura disponível.
- Ajustada rolagem interna do canvas de modelagem, mantendo os cards e linhas visuais sem quebrar o restante da página.
- Botões, selects, cards, tabelas e formulários receberam regras de `min-width: 0`, quebra de texto e rolagem segura.
- Telas Transformar Dados, Modelo/Medidas, Criar Tabelas, Tabelas e Views e Dashboard receberam ajustes preventivos de overflow.
- Nenhuma alteração estrutural no banco de dados.


## v3.2.5 - Conexões com recolhimento real de painéis

- Ajuste final de CSS para impedir que os painéis recolhidos da tela Conexões continuem reservando largura grande.
- As colunas recolhidas agora ficam com 44px e o canvas ganha o espaço restante.
- Em telas menores, painéis recolhidos são ocultados para priorizar o canvas.
- Não há alteração de banco, credenciais ou configuração real.


## v3.2.6 - Correção de salvamento de conexões

- Ajustado timeout de `/api/model` no frontend para 60 segundos.
- Corrigida mensagem que confundia timeout de validação do modelo com servidor local fora do ar.
- Adicionado estado visual `Salvando...` no botão de salvar conexões.
- Não altera banco de dados, `.env` ou credenciais reais.


## v3.2.7 - Menu profissional e correção do recolhimento

- Corrigido o bug em que o menu lateral recolhido ficava inconsistente e não permitia reabrir com segurança.
- Adicionado botão flutuante de expansão do menu para garantir a reabertura.
- Redesenhado o menu lateral com visual mais limpo e profissional.
- Removidas informações excessivas do cabeçalho do menu, mantendo logo, modo e versão de forma mais discreta.
- Navegação lateral ganhou melhor hierarquia visual, estados de hover/ativo e melhor aproveitamento de espaço.
- Não altera banco de dados, credenciais reais ou configuração do MySQL.


## v3.2.8 - Etapa 5: Visual premium e ícones no menu

- Menu lateral agora usa ícones SVG profissionais em todos os itens.
- Ao recolher o menu, ficam visíveis apenas a logo no topo e os ícones de navegação.
- Removidos os atalhos por letras no menu recolhido.
- Aplicado refinamento visual premium em cabeçalhos, cards, botões, formulários, tabelas, dashboard e área de modelagem.
- Melhorados estados de hover/foco e hierarquia visual geral do app.
- Não altera banco de dados, `.env` ou credenciais reais.


## v3.2.9 - Relatórios com páginas e zoom reorganizado

- Corrigido o botão `+` para criação de novas páginas no editor de relatórios.
- Adicionada navegação funcional entre páginas do relatório.
- Controles de zoom, ajuste de página, tela cheia e grade foram movidos para baixo das abas de páginas.
- Removidos textos desnecessários do cabeçalho da tela de relatório.
- Modo SQL avançado ficou mais discreto e opcional.
- Não altera banco de dados, `.env` ou credenciais reais.


## v3.2.10 - Tela cheia com painéis flutuantes

- O botão Tela cheia agora abre o editor inteiro de relatórios, não apenas o canvas.
- Painéis Visualizações e Dados ficam como gavetas flutuantes sobre a tela cheia.
- Ao entrar em tela cheia, os painéis iniciam recolhidos para não ocupar espaço do canvas.
- É possível abrir Dados ou Visualizações sem sair da tela cheia para montar, formatar e ajustar relatórios.
- Apenas um painel flutuante fica aberto por vez para preservar espaço de edição.
- Não altera banco de dados, credenciais reais ou configurações locais.


## v3.2.11 - Topo do menu com logo em destaque

- Removidos os textos grandes do topo do menu lateral.
- A logo passa a ser a identidade principal do cabeçalho.
- Mantidas apenas as informações essenciais: modo Admin/Viewer, versão do app e banco de dados.
- Ajustado visual do menu recolhido para manter logo no topo e ícones de navegação.
- Não altera banco de dados, credenciais reais ou arquivos `.env`.


## v3.2.12 - Ajuste de ordem do menu lateral

- Movido o item **Relatórios / Dashboards** para logo abaixo de **Dashboard**.
- Mantida a estrutura restante do menu lateral.
- Não altera banco de dados, `.env` ou credenciais reais.


## v3.2.13 - Editor Power BI com páginas excluíveis

- Adicionada opção de excluir páginas diretamente nas abas do relatório.
- O editor de Relatórios / Dashboards foi reorganizado para deixar o canvas como área predominante.
- Painéis Visualizações e Dados ficaram mais compactos, com visual mais próximo do Power BI.
- Barra de páginas e controles do canvas foram refinados para melhor uso do espaço.
- Não altera banco de dados, `.env` ou credenciais reais.


## v3.2.14 - Editor de relatórios sem corte

- Corrigido o corte lateral na tela Relatórios / Dashboards.
- O editor agora respeita a largura disponível da janela e impede overflow horizontal global.
- O canvas passa a ser a área predominante, com os painéis Visualizações e Dados mais compactos.
- Em telas menores, painéis abertos passam a se comportar como gavetas sobrepostas para preservar a área de criação.
- Ajustadas larguras, truncamento de textos, rolagem interna e distribuição das colunas do editor.


## v3.2.15 - Tela cheia limpa para edição

- No modo tela cheia do editor de relatórios, ficam visíveis apenas o canvas de edição e os painéis flutuantes de Visualizações e Dados.
- Cabeçalho, barra de campos do relatório, abas de páginas, controles inferiores e SQL avançado ficam ocultos para maximizar a área útil.
- Painéis flutuantes permanecem acessíveis em forma recolhida/expandida.
- O usuário pode sair do modo tela cheia pela tecla Esc.


## v3.2.16 - Filtros em Tabelas e Views

- Adicionado painel de filtros estilo Power BI na tela Tabelas e Views.
- Incluída pesquisa geral em todas as colunas visíveis.
- Incluídos filtros por coluna com operadores: contém, igual, diferente, começa com, termina com, maior/igual, menor/igual, entre, em branco e não está em branco.
- Filtros são aplicados na consulta de tabelas MySQL e também funcionam em calendário nativo e consultas transformadas.
- Mantida exportação CSV e paginação da consulta.


## v3.2.17 - Painel Dados limpo

- Painel Dados do editor agora mostra somente o nome da fonte/tabela e as colunas.
- Removidos badges técnicos como mysql leitura, calendario nativo e tipos de dados da lista de campos.
- Mantidos os tipos internamente apenas para drag/drop e geração de visuais.


## v3.2.18 - Editor compacto e páginas renomeáveis

- Compactado o cabeçalho da tela Relatórios / Dashboards.
- Reduzidos botões de zoom, ajuste e tela cheia para ganhar espaço no canvas.
- Controles do canvas movidos para cima, antes da área de edição.
- Abas de páginas ficaram menores.
- Páginas agora podem ser renomeadas com duplo clique na aba da página.
- Não altera banco de dados nem credenciais reais.


## v3.2.19 - Mais espaço no editor de relatórios

- Botões **Salvar relatório** e **Novo** ficam lado a lado no cabeçalho.
- Controles de zoom e ações do canvas ficam abaixo das abas de páginas.
- Campos superiores do relatório foram compactados para ganhar área útil.
- Abas de páginas ficaram um pouco menores mantendo renomeação e exclusão.


## v3.2.20 - Formatação avançada do visual

- Painel **Formatação** ampliado no editor de relatórios.
- Opções para título, cabeçalho, cores, fonte, tamanho de texto, tabela compacta/normal/confortável, linhas alternadas, grade, borda, sombra, raio, espaçamento, prefixo/sufixo e casas decimais.
- Tabelas e matrizes passam a respeitar visualmente as configurações aplicadas.
- Configurações são salvas junto com o visual e preservadas no dashboard publicado.
