# Mapa do motor DAX

## Persistência e edição

data/semantic_model.json usa o contrato normalizado por normalizeSemanticModel():

- tables, tableDetails, tablePositions e selectedColumns;
- relationships com fromTable, fromColumn, toTable, toColumn, joinType, cardinality, filterDirection, active, confidence e source;
- measures com table, name, displayName, formula, format, decimals, dataCategory, status, diagnóstico, dependências e funções não suportadas.

readSemanticModel() mantém cache de memória por 30 s; writeSemanticModel() normaliza, grava por .tmp+rename e atualiza o cache.

No frontend, os pontos principais são:

- validateDaxFormula, parseDaxMeasureDefinition e findDaxMeasureDefinitionSeparator;
- openDaxMeasureInlineEditor/openDaxMeasureModal;
- saveModel, showMeasureDiagnostics e refreshMeasureStatus;
- measureFormatToColumnFormat e visualColumnFormats.

Não chame renderReportPageVisuals() como efeito colateral de saveModel(): REGRAS_CORRECOES.md registra perda de estado de filtros/dropdowns.

## Parser, compilador e diagnóstico

Símbolos centrais em server.js:

- parsing: parseAtomicDaxMeasure, parseDaxVariableProgram, parseDaxColumnReference, parseDaxValuesIterator;
- expressão: compileDaxExpression, compileDaxCondition, compileCalculateExpression, compileDaxIteratorAggregate;
- dependências: buildMeasureLookup, daxMeasureReferences, daxMeasureDependencyOrder, compileReferencedDaxMeasure;
- diagnóstico: unsupportedDaxFunctions, analyzeDaxMeasure, daxMeasureDiagnostics, validateDaxMeasureForModel;
- planejamento: tablesUsedByMeasureWithDependencies, buildVisualMeasureJoinPlan, appendVisualMeasureJoins;
- execução: buildVisualQueryFromRequest, sqlForVisualRunDetails, sqlForVisualMeasureTotalsRunDetails.

## Subconjunto anunciado

SUPPORTED_DAX_FUNCTIONS contém atualmente:

- agregações: SUM, AVERAGE/AVG, MIN, MAX, COUNT, DISTINCTCOUNT, COUNTROWS;
- escalares/controle: DIVIDE, IF, SWITCH, COALESCE, SELECTEDVALUE, TRUE, FALSE, BLANK, ISBLANK;
- iteradores: SUMX, AVERAGEX, COUNTX, MAXX, MINX, CONCATENATEX;
- contexto/tabela: CALCULATE, FILTER, ALL, ALLEXCEPT, ALLSELECTED, KEEPFILTERS, VALUES, DISTINCT, TOPN;
- relacionamento/inspeção: RELATED, HASONEVALUE, ISFILTERED, ISCROSSFILTERED;
- ranking/texto/formato: RANKX, CONCATENATE, FORMAT;
- tempo: DATESYTD, DATESMTD, DATESQTD, TOTALYTD, SAMEPERIODLASTYEAR, DATEADD, DATESBETWEEN, períodos anteriores/seguintes e PARALLELPERIOD.

Esse conjunto é um filtro de diagnóstico, não garantia de suporte irrestrito. Funções de tabela/tempo lançam erro fora do contexto aceito de CALCULATE. FORMAT cobre poucos formatos conhecidos. VALUES/DISTINCT em posição escalar têm tradução específica do motor.

## Contexto de filtro e segurança

ensureDaxFilterContext, addDaxRemovedTable, addDaxRemovedColumn e daxFilterContextRemoves transportam remoções de filtro até buildReportFilterWhere().

Filtros opcionais podem ser removidos por semântica DAX; filtros com mandatory: true representam segurança/RLS e não devem ser descartados.

## Planner e PostgreSQL

Medidas multi-tabela dependem de relacionamentos ativos. O planner escolhe a tabela-base, cria aliases, materializa joins e pode pré-agregar medidas no lado relacionado. Depois, tryRunSelectFromPostgresCache() converte SQL MySQL-like para PostgreSQL e reescreve tabelas para o schema de cache.

Não corrija uma medida adicionando CROSS JOIN, hardcode por nome de medida/tabela ou desativando relação. Os validadores procuram explicitamente esses atalhos.

## Regressões protegidas

- REGRAS_CORRECOES.md: IF([medida], RANKX(...)), condição SQL pré-compilada e total autoritativo.
- info/REGRA_TABELA_MATRIZ_SEM_ERRO.md: colunas de texto não recebem SUM().
- scripts/validate-relationship-join-planner.js: aliases e joins de medidas relacionadas.
- scripts/validate-visual-measure-pipeline.js: medida do modelo até o visual.
- scripts/validate-table-load-regression.js: medidas iteradoras adicionais sem CROSS JOIN.

## Validadores

Estáticos, escolhendo apenas os relevantes:

- npm run validate:dax-variable-lookup
- npm run validate:dax-filtered-iterator
- npm run validate:dax-column-lookup
- npm run validate:dax-concat-text
- npm run validate:dax-comma-literal
- npm run validate:receipt-calculated-conversion
- npm run validate:conversion-decimals
- npm run validate:packaging-conversion
- npm run validate:freight-measures

Runtime local com API/cache configurados:

- npm run validate:dax-variable-table
- npm run validate:dax-values-iterator
- npm run validate:relationship-planner
- npm run validate:visual-measure-pipeline
- npm run validate:measure-editor
- npm run validate:dax-price-cost
- npm run validate:dependent-measures
- npm run validate:filtered-totals

npm run validate:dax-isblank-all modifica data/semantic_model.json durante o teste e restaura ao final; rode somente em cópia isolada e verifique o hash antes/depois.

