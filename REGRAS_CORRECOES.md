# Regras e Correções - BI WA

> Última atualização: 2026-07-31
> Estas regras foram aplicadas para resolver: medida DAX de ranking, formatação de medidas, totais no rodapé.

---

## 1. Medida DAX: Ranking Faturamento

### Fórmula final
```dax
IF([Faturamento Líquido], RANKX(ALLSELECTED('Cliente'), [Faturamento Líquido], , DESC, SKIP))
```

### Regras
- **NÃO usar operadores de comparação (`>`, `<`, `=`) em `IF` com medidas inlineadas** — o compilador DAX inlineia a medida como SQL complexo e o parser de condição quebra.
- **NÃO usar `BLANK()` explícito como terceiro argumento do `IF`** — `IF(cond, valor)` sem else já retorna vazio.
- **Usar `IF(medida, valor)` sem operador** — DAX trata 0 como falso e ≠0 como verdadeiro.

---

## 2. `compileDaxCondition` no server.js

### O que foi alterado
No início da função, detectar se a condição já é SQL pré-compilado (contém `CASE`, `WHEN`, `SUM(`, etc.) e converter para booleano com `(expr) <> 0`:

```javascript
if (/(?:\bCASE\b|\bWHEN\b|\bTHEN\b|\bELSE\b|\bEND\b|\bSUM\s*\(|\bCOUNT\s*\(|\bMIN\s*\(|\bMAX\s*\(|\bAVG\s*\(|\bRANK\s*\(|\bOVER\s*\(|\bCOALESCE\b|\bNULL\b)/i.test(source)) {
    return `(${compileDaxRowExpression(source, aliases)}) <> 0`;
}
```

### Por que é necessário
- Medidas inlineadas (`[Faturamento Líquido]`) viram SQL complexo com `CASE WHEN ... THEN ... END`
- O parser de condição original tenta encontrar `=`, `>`, `<` no SQL e quebra
- PostgreSQL exige condição booleana no `CASE WHEN` (MySQL aceita numérica)
- O wrap `<> 0` converte expressão numérica para booleana

### O que NÃO fazer
- **NÃO** adicionar verificação complexa de "nível 0" — quebrou filtros CALCULATE
- **NÃO** colocar essa verificação depois do `stripOuterParentheses` — ela deve vir ANTES dos handlers NOT/IN/operadores

---

## 3. Formatação de Medidas

### `normalizeSemanticModel` — persistir formato
Adicionar ao objeto da medida:
```javascript
format: String(item.format || '').trim(),
decimals: item.decimals != null ? Number(item.decimals) : 2,
dataCategory: String(item.dataCategory || '').trim(),
```

### `visualColumnFormats` — renderizar formato
Adicionar função `measureFormatToColumnFormat` + lookup no `visualColumnFormats`:
```javascript
fields.forEach((field) => {
    if (String(field.type || '').toLowerCase() === 'measure') {
        const measure = measures.find(m => m.name === field.name && m.table === field.table);
        if (measure) { const fmt = measureFormatToColumnFormat(measure); if (fmt) formats[field.name] = fmt; }
    }
});
```

---

## 4. Totais no Rodapé (LIMIT 1000)

### Problema
Tabelas com mais de 1000 linhas mostravam no rodapé a soma apenas das linhas visíveis.

### Solução
Usar `visualTotalsMetadataForRun` no endpoint `/api/visual-query` — **MESMA função do endpoint de execução**:

```javascript
var totalsMeta = {};
if (['table', 'matrix'].includes(vizType)) {
    totalsMeta = await visualTotalsMetadataForRun(visualObj, rows, limit, model, runOpts);
}
return res.json(Object.assign({rows, ...}, totalsMeta));
```

### O que NÃO fazer
- **NÃO** tentar reimplementar a query de totais manualmente com `tryRunSelectFromPostgresCache`
- **NÃO** rodar `sqlForVisualMeasureTotalsRunDetails` separado — use `visualTotalsMetadataForRun` que já faz tudo
- **NÃO** esquecer de usar `Object.assign` para merge dos totais na resposta

---

## 5. NUNCA alterar relações do modelo semântico

- **NUNCA** desativar ou criar relações `Calendario → Metas Empresa` ou qualquer outra
- O sistema de filtros depende das relações exatas do modelo
- Alterar `active: true/false` ou colunas da relação quebra a propagação de filtros

---

## 6. NUNCA chamar `renderReportPageVisuals()` no `saveModel()`

Isso reconstrói todo o HTML da página e destrói estado de filtros/dropdowns.

---

## 7. SEMPRE sincronizar `instalar no servidor`

Após qualquer alteração em `server.js`, `app.js`, ou arquivos de `data/`:
```powershell
Copy-Item ".\server.js" ".\instalar no servidor\server.js" -Force
Copy-Item ".\public\app.js" ".\instalar no servidor\public\app.js" -Force
Copy-Item ".\data\*" ".\instalar no servidor\data\" -Force
Copy-Item ".\data\*" ".\instalar no servidor\dados-iniciais-publicacao\" -Force
```

Caso contrário, o servidor de produção roda código antigo e os bugs persistem.

---

## Resumo das alterações

| Arquivo | O que foi alterado | Propósito |
|---|---|---|
| `server.js` | `compileDaxCondition` | Suporte a `IF(medida, ...)` sem quebrar compilação |
| `server.js` | `normalizeSemanticModel` | Persistir `format`/`decimals`/`dataCategory` das medidas |
| `server.js` | `POST /api/visual-query` | Incluir totais server-side via `visualTotalsMetadataForRun` |
| `app.js` | `visualColumnFormats` + `measureFormatToColumnFormat` | Renderizar formato das medidas nos visuais |
| `data/semantic_model.json` | Medida `Ranking Faturamento` adicionada | Ranking de clientes por faturamento líquido |
