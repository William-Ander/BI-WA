# REGRA PERMANENTE - Tabela/Matriz restaurada na v3.2.59

Esta versão restaura a lógica estável da Tabela/Matriz.

## Regra congelada

- Campo em Eixo/Dimensão vira coluna direta.
- Campo em Valores vira coluna direta.
- Campo marcado no painel Dados vira coluna direta.
- Campo removido sai da visualização.
- Nunca transformar texto em SUM().
- Nunca gerar SUM(Cliente), SUM(Descrição Comercial), SUM(CFOP), Produto, Fornecedor, Nome, etc.
- Filtros podem apenas adicionar WHERE.
- Filtros não podem mudar a estrutura das colunas da tabela.
- A ordem das colunas pode mudar somente por ordem explícita do usuário, sem agregação automática.

## Bloqueio

Alterações em painel lateral, rolagem, recolher/expandir ou navegação do editor não podem alterar:

- visual.table
- visual.dimension
- visual.value
- visual.selectedFields
- visual.columnOrder
- SQL bruto de Tabela/Matriz

sem ação explícita do usuário sobre campos do visual.
