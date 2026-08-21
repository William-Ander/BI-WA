# Regra travada - Tabela/Matriz v3.2.62

Esta versão restaura a lógica da Tabela/Matriz para a base estável da v3.2.59.

## Bloqueio obrigatório

Nenhuma melhoria visual, painel, aba ou formatação pode alterar a regra da Tabela/Matriz.

- Campo em Eixo/Dimensão vira coluna direta.
- Campo em Valores vira coluna direta.
- Campo marcado no painel Dados vira coluna direta.
- Campo removido sai da visualização.
- Texto nunca vira agregação automática.
- Nunca gerar SUM(Cliente).
- Nunca gerar SUM(Descrição Comercial).
- Nunca gerar SUM(CFOP).
- Filtros podem apenas adicionar WHERE.
- Filtros não podem mudar a estrutura das colunas.
- Abrir, recolher, trocar painel ou formatar visual não pode limpar Eixo, Valores, Campos ou SELECT da Tabela/Matriz.

## Decisão técnica

Quando uma alteração de interface conflitar com esta regra, a alteração de interface deve ser descartada.
A Tabela/Matriz tem prioridade absoluta.
