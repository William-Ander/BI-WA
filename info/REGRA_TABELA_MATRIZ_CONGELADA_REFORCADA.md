# Regra congelada reforcada - Tabela/Matriz

Esta regra e obrigatoria em todas as proximas versoes do BI WA.

## Regra

Para visuais do tipo **Tabela** e **Matriz**:

- Campo em Eixo/Dimensao vira coluna direta.
- Campo em Valores vira coluna direta.
- Campo marcado no painel Dados vira coluna direta.
- Campos de texto podem ficar em Valores e nao podem ser removidos pelo carregamento dos selects.
- Nunca gerar `SUM(Cliente)`, `SUM(Descricao Comercial)`, `SUM(CFOP)` ou qualquer `SUM()` automatico para campo de texto.
- Filtros podem apenas acrescentar `WHERE`.
- Filtros nao podem mudar a estrutura das colunas da Tabela/Matriz.
- Ao reabrir relatorio salvo, os campos ja salvos precisam renderizar imediatamente no canvas.

## Bloqueio tecnico

O script `scripts/validate-visual-rules.js` deve falhar se:

- O bucket Valores de Tabela/Matriz voltar a aceitar somente colunas numericas.
- O editor apagar campos texto salvos por falta de option carregada.
- O bloco bruto de Tabela/Matriz voltar a usar `SUM()`.
