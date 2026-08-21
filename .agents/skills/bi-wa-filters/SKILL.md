---
name: bi-wa-filters
description: Desenvolve e diagnostica filtros do BI WA, incluindo popup online, filtros visual/página, cross-filter, cascata, Calendário, relacionamentos e RLS. Use para qualquer mudança no domínio ou aplicação de filtros; não use para DAX sem filtros.
---

# BI WA — filtros

Preserve a semântica e a segurança dos filtros desde a configuração no Admin até a consulta do visual no Viewer.

## Preparação

Leia [o mapa do pipeline de filtros](references/filter-pipeline-map.md) antes de editar filtro, slicer, domínio de opções, propagação ou cache de filtros.

Identifique a camada:

- onlineFilters persistidos no relatório;
- filtros de visual, página e todas as páginas;
- cross-filter temporário vindo de visual/slicer;
- restrição obrigatória do usuário ou RLS;
- domínio de opções/cascata em /api/filter-options.

## Método

Trace sempre:

1. identidade do filtro: id, table.field e alias curto quando único;
2. escopo global/report/page/visual e página/visual ativo;
3. valor codificado: || para multiseleção e | para intervalo;
4. relacionamento ativo e direção permitida;
5. buildReportFilterWhere() e parâmetros;
6. chave/invalidação de cache no servidor e cliente;
7. resultado em visual salvo, editor, viewer e exportação.

## Invariantes

- Segurança é validada no backend; esconder controles no frontend não é autorização.
- Restrições obrigatórias falham fechado. Nunca faça fallback para domínio amplo ou consulta sem filtro.
- Alias de um mesmo filtro não pode gerar predicados duplicados.
- Self-filter é excluído da consulta de domínio, não da execução do relatório.
- Relação single propaga apenas no sentido permitido; reverso exige both ou witness contextual seguro.
- Calendário é dimensão virtual nativa e não deve ser criada no MySQL.
- Filtros entram antes de agrupamento, inclusive por marcadores de runtime em subconsultas DAX.
- ALL/contexto DAX pode remover filtro opcional, nunca restrição mandatory.
- Não introduza hardcodes por relatório, usuário, cliente, tabela ou valor real.
- Preserve cancelamento de requests e descarte de respostas antigas ao trocar filtro rapidamente.

## Validação

Execute npm run check, validadores estáticos de integridade/popup e, com servidor/cache local, validadores de multiseleção, domínios e todos os relatórios. Verifique tanto o conjunto de opções quanto as linhas dos visuais.

Relate direção de propagação, contexto de segurança, número de queries e comportamento fail-closed.

