# REGRA PERMANENTE - Tabela/Matriz restaurada da base estável v3.2.45

Esta versão restaura a lógica de Tabela/Matriz da base estável v3.2.45, que foi a versão em que o visual carregava corretamente como tabela.

Regra obrigatória para todas as próximas versões:

- Campo em Eixo/Dimensão vira coluna direta.
- Campo em Valores vira coluna direta.
- Campo marcado no painel Dados vira coluna direta.
- Campo removido sai da visualização.
- Nunca transformar texto em SUM().
- Nunca gerar SUM(Cliente), SUM(Descrição Comercial), SUM(CFOP), Nome, Produto, Fornecedor etc.
- Filtros podem apenas acrescentar WHERE.
- Filtros não podem mudar a estrutura da tabela.
- Alterações visuais nos painéis não podem alterar a montagem da Tabela/Matriz.

Se uma melhoria visual exigir mexer em Eixo, Valores, selectedFields, fields, visualRawFieldNames, canRawPreview ou buildVisualQueryFromRequest, ela deve ser recusada até ser feita sem quebrar esta regra.
