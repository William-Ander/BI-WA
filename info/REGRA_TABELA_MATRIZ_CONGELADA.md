# REGRA PERMANENTE - Tabela e Matriz não podem ser alteradas

Esta regra foi criada depois da correção que fez o visual de **Tabela/Matriz** funcionar corretamente no construtor.

## Não mexer nesta regra

Para visual do tipo `table` ou `matrix`:

- Campo em **Eixo / Dimensão** deve virar coluna direta.
- Campo em **Valores** deve virar coluna direta.
- Campo marcado no painel **Dados** deve virar coluna direta.
- Campo removido deve sair da visualização imediatamente.
- A visualização deve atualizar automaticamente no canvas.
- Não pode gerar `SUM()` automático em campo texto.
- Não pode voltar a gerar `SUM(Cliente)`, `SUM(Descrição Comercial)`, `SUM(CFOP)`, `SUM(Natureza Operação)` ou qualquer texto.

## Como filtros devem funcionar

Filtros de popup, Calendário e relacionamentos podem adicionar apenas cláusulas `WHERE` na consulta.
Eles **não podem alterar** a montagem principal de colunas diretas da Tabela/Matriz.

Exemplo correto:

```sql
SELECT
  src.`Descrição Comercial` AS `Descrição Comercial`,
  src.`Cliente` AS `Cliente`,
  src.`Número Nota Fiscal` AS `Número Nota Fiscal`
FROM `faturamento2` src
WHERE YEAR(src.`Data Emissão`) = ?
LIMIT 200
```

Exemplo proibido:

```sql
SELECT
  src.`Descrição Comercial`,
  SUM(src.`Cliente`)
FROM `faturamento2` src
GROUP BY src.`Descrição Comercial`
```

Antes de gerar qualquer nova versão, executar:

```bash
npm run validate:all
```

Se essa validação falhar, a versão não deve ser entregue.
