---
name: bi-wa-dax
description: Desenvolve e diagnostica o compilador DAX do BI WA, medidas, dependências, contexto de filtro, iteradores, joins semânticos e formatação. Use para mudanças DAX; não use para filtros de UI ou layout sem impacto em medidas.
---

# BI WA — DAX

Trabalhe no subconjunto DAX implementado pelo BI WA e preserve a semântica entre medida, relacionamento, filtro e SQL PostgreSQL.

## Preparação

Leia [o mapa do motor DAX](references/dax-engine-map.md) antes de alterar parsing, compilação, diagnóstico ou execução de medidas.

Identifique a classe do problema:

- parsing/validação da fórmula;
- variável VAR/RETURN ou referência a outra medida;
- iterador e contexto de linha;
- CALCULATE e modificadores de filtro;
- relacionamento/join entre tabelas;
- projeção da medida em Tabela/Matriz;
- total autoritativo ou formatação do resultado.

## Método

Trace a fórmula por estes estágios:

1. normalizeSemanticModel() e metadados da medida.
2. editor/validação no frontend e APIs /api/model/measures/*.
3. analyzeDaxMeasure() e ordem de dependências.
4. compileDaxExpression() e helpers contextuais.
5. buildVisualMeasureJoinPlan()/appendVisualMeasureJoins().
6. buildVisualQueryFromRequest() e runSelect() no cache PostgreSQL.
7. totais e visualColumnFormats() no frontend.

Não conclua que uma função é suportada apenas por aparecer em SUPPORTED_DAX_FUNCTIONS: vários modificadores só são válidos dentro de CALCULATE, e combinações dependem de aliases, relacionamentos e planner.

## Invariantes

- Não altere relacionamentos persistidos para “fazer a medida funcionar” sem pedido explícito.
- Preserve detecção de ciclos e cache de medidas compiladas.
- Não permita SQL arbitrário, comentários ou referências de coluna sem agregação/contexto aceito.
- Preserve os tokens internos de SQL/medida para não recompilar SQL gerado como DAX.
- BLANK mapeia para NULL; em expressões aditivas, medidas usam COALESCE(..., 0) para semântica compatível.
- Em Tabela/Matriz, medida é compilada; coluna física permanece coluna direta.
- Filtros removidos por ALL/contexto DAX não podem remover restrições obrigatórias de segurança.
- Formato, casas decimais e categoria de dados devem sobreviver a normalização, persistência e renderização.

## Validação

Execute npm run check e os validadores DAX diretamente relacionados. Testes que chamam /api/visual-query precisam de servidor/cache local; validate:dax-isblank-all escreve temporariamente no modelo e deve rodar apenas em cópia isolada.

Relate a fórmula testada, as tabelas/relacionamentos usados, o SQL/plano observado e qualquer limitação contextual restante.

