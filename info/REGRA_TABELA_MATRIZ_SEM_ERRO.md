# Regra obrigatoria - Tabela/Matriz sem erro de agregacao

Versao criada: 3.2.46

## Objetivo

Preservar o comportamento que funcionou no editor de relatorios: ao arrastar ou selecionar campos para um visual do tipo **Tabela** ou **Matriz**, o BI WA deve mostrar os dados imediatamente no canvas, sem exigir clique em atualizar e sem tentar somar campo de texto.

## Regra critica

Para visuais `table` e `matrix`:

1. Campo em **Eixo / Dimensao** deve virar coluna direta no SELECT.
2. Campo em **Valores** deve virar coluna direta no SELECT.
3. Campo marcado no painel **Dados** deve virar coluna direta no SELECT.
4. Campo removido deve sair imediatamente do visual.
5. O preview deve atualizar automaticamente no canvas.
6. Nunca gerar automaticamente `SUM(campo)` para tabela/matriz.
7. Nunca tentar `SUM()` em campo textual como Cliente, Descricao Comercial, CFOP, Natureza Operacao etc.
8. A consulta de preview deve usar `LIMIT` para evitar travamentos.

## Exemplo correto

Quando o usuario montar:

- Eixo / Dimensao: `Descricao Comercial`
- Valores: `Cliente`

A consulta correta para tabela/matriz e equivalente a:

```sql
SELECT
  src.`Descricao Comercial` AS `Descricao Comercial`,
  src.`Cliente` AS `Cliente`
FROM `faturamento2` src
LIMIT 200;
```

## Exemplo proibido

Nao pode voltar a gerar algo como:

```sql
SELECT
  src.`Descricao Comercial`,
  SUM(src.`Cliente`) AS `SUM_Cliente`
FROM `faturamento2` src
GROUP BY src.`Descricao Comercial`;
```

Esse foi o comportamento que causou erro/timeout.

## Arquivos protegidos

- `server.js`
  - `buildVisualQueryFromRequest`
  - `visualRawFieldNames`
  - `shouldRunVisualAsRawTable`
  - `sqlForVisualRun`

- `public/app.js`
  - `rawPreviewVisualType`
  - `collectPreviewFields`
  - `visualBuilderReady`
  - `scheduleVisualAutoUpdate`
  - `buildVisualPreview`
  - `generateVisualSql`

- `scripts/validate-visual-rules.js`
  - Valida automaticamente se a regra continua presente.

## Validacao obrigatoria antes de nova versao

Antes de gerar qualquer ZIP novo, executar:

```bash
npm run validate:all
```

Ou, no minimo:

```bash
npm run check
npm run validate:package
npm run validate:visual-rules
```

Se `validate:visual-rules` falhar, a versao nao deve ser entregue.

## Observacao

Graficos agregados como barras, linhas, pizza, cartao e KPI podem continuar usando agregacoes. A regra acima e especifica para **Tabela** e **Matriz**, porque nesses visuais o comportamento esperado e mostrar os campos como colunas, igual ao Power BI.
