# Regras de atualização do BI WA

Ao atualizar o app, siga este checklist:

1. Atualizar `package.json` com a nova versão.
2. Atualizar `info/VERSION.json` com a nova versão, data e marcador.
3. Adicionar um novo arquivo em `info/marcadores/`, por exemplo `v2.7.0.md`.
4. Registrar as mudanças em `info/UPGRADES.md`.
5. Manter as configurações sensíveis fora do ZIP:
   - não incluir `.env` real;
   - não incluir senha real;
   - não incluir banco de dados real;
   - não incluir dumps de produção.
6. Manter o instalador sem perguntas obrigatórias.
7. Manter as configurações de MySQL, usuários e versão online dentro do app.
8. Garantir que a versão online continue somente visualização.
9. Testar `npm run check` antes de gerar o ZIP.
10. Gerar novo ZIP completo do projeto.

## Padrão de versionamento

Use o formato:

```text
MAJOR.MINOR.PATCH
```

- **MAJOR**: mudança grande de arquitetura.
- **MINOR**: nova função relevante.
- **PATCH**: correção pequena ou ajuste visual.

## Exemplo

Se for adicionada uma nova tela de permissões:

- versão anterior: `2.6.0`
- nova versão: `2.7.0`
- marcador: `info/marcadores/v2.7.0.md`
## Regra de ícone oficial

A partir da versão v2.6.9, o arquivo oficial de ícone do app é baseado no `BI WA(4).ico` enviado pelo usuário. Não redesenhar, simplificar ou trocar o ícone sem autorização explícita. Para evitar ícone borrado no Windows, é permitido somente gerar versões multirresolução/PNG derivadas do mesmo visual oficial.



## Regra permanente de tabelas e views

Antes de gerar uma nova versão, conferir `info/REGRA_LISTAGEM_TABELAS_VIEWS.md`. A listagem de tabelas/views nunca pode ficar presa em `Carregando...`; precisa mostrar erro, diagnóstico e botão para tentar novamente.


- Consultar `info/REGRA_EDITOR_DASHBOARD_POWERBI.md` antes de alterar a tela de relatórios/dashboards.
## Regra: identificadores MySQL reais

O app deve aceitar nomes reais de tabelas, views e colunas do MySQL, incluindo espaços, acentos e caracteres comuns. No SQL gerado pelo criador visual, sempre usar crase e escapar crases internas. Não usar validação restrita apenas a `[A-Za-z0-9_]` para campos vindos do MySQL.

## Atualização automática do visual

Nas telas estilo Power BI, ao arrastar, marcar ou alterar campos, filtros, agregações ou tipo de gráfico, o visual deve atualizar automaticamente sem exigir clique em botão de atualização. Consulte `REGRA_AUTO_RENDER_VISUAL.md`.
- A opção **Conexões** deve permanecer no menu lateral e centralizar a seleção de tabelas/views e a criação de relacionamentos do modelo semântico.


## Regra da tabela Calendário

Antes de alterar modelagem/conexões, consultar `info/REGRA_TABELA_CALENDARIO.md`. A tabela nativa `Calendario` deve continuar disponível para relacionamentos de data e deve permanecer somente leitura.

## Campos removíveis no criador visual

Toda versão nova deve preservar a opção de remover campos adicionados ao visual, incluindo Eixo / dimensão, Valores e Filtros. A remoção deve atualizar o visual automaticamente e limpar os checkboxes correspondentes no painel Dados. Consulte `info/REGRA_CAMPOS_REMOVIVEIS_VISUAL.md`.

- Manter a regra `info/REGRA_FILTROS_POPUP_ONLINE.md`: filtros de usuário online devem ser configurados em popup pelo Admin e aplicados em popup na versão online.

## Filtros popup funcionais
- Manter `info/REGRA_FILTROS_POPUP_FUNCIONAIS.md` nas próximas versões.
- Filtros online devem aplicar alterações reais no dashboard e não apenas exibir cartões informativos.
## Tela Relatórios/Dashboards
- A tela de edição de relatórios deve permanecer compacta, sem rolagem geral da página.
- O canvas deve manter 1280x720 e os visuais devem ter rolagem interna quando necessário.
- Apenas menu principal, Visualizações e Dados podem ter rolagem própria.



## Propagação de filtros por relacionamento

Sempre preservar `info/REGRA_PROPAGACAO_FILTROS_RELACIONAMENTOS.md`: filtros de Calendario e de tabelas relacionadas devem respeitar os relacionamentos criados em Conexões.

- Manter `info/REGRA_FILTROS_DINAMICOS_POWERBI.md`: filtros do popup devem ser dinâmicos, editáveis, removíveis e funcionais no online.
- A tela **Tabelas e Views** deve ser somente visualização; criação/estrutura de tabelas manuais fica em **Criar Tabelas**. Ver `REGRA_TABELAS_VIEWS_VISUALIZACAO.md`.

- Manter a seção Criar Tabelas no padrão Inserir dados do Power BI. Ver `info/REGRA_CRIAR_TABELAS_POWERBI.md`.

- A tela Conexões deve manter linhas visuais entre colunas relacionadas, no estilo Power BI. Ver `info/REGRA_CONEXOES_POWERBI_LINHAS.md`.

- Manter `info/REGRA_STATUS_ONLINE_E_CARREGAMENTO.md`: tabelas/views devem carregar com cache/fallback e dashboard deve mostrar Online/Offline com ultima atualizacao recebida.
