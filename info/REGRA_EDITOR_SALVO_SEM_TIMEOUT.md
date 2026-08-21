# REGRA - Editor ao reabrir relatório salvo sem timeout

Esta regra protege o comportamento do editor de relatórios do BI WA.

## Obrigatório

- Ao abrir um relatório salvo para edição, os visuais salvos devem renderizar automaticamente no canvas.
- Para Tabela/Matriz, os campos de Eixo, Valores e campos marcados continuam sendo colunas diretas.
- O carregamento inicial do editor não deve aplicar valores antigos de filtros online/dashboard automaticamente.
- A configuração dos filtros online continua salva no relatório, mas os valores ativos não podem travar a abertura do editor.
- O endpoint `/api/visual-query` deve ter timeout controlado no backend, evitando abort genérico no frontend.

## Regra congelada preservada

Tabela/Matriz nunca devem transformar texto em agregação automática.

- Nunca gerar `SUM(Cliente)`.
- Nunca gerar `SUM(Descrição Comercial)`.
- Nunca gerar `SUM(CFOP)`.
- Filtros podem apenas adicionar `WHERE`, sem mudar as colunas da tabela.
