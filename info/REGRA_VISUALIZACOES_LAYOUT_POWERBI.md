# REGRA - Painel Visualizações no layout Power BI

A partir da v3.2.60, o painel **Visualizações** do editor de relatórios deve permanecer organizado no padrão visual do Power BI:

- Cabeçalho compacto com título e botão de recolher.
- Ícones superiores para Criar visual, Formatar visual e Análise.
- Grade compacta de tipos de visual, sem ocupar espaço excessivo com textos grandes.
- Seções separadas para criar visual, campos do visual, formatação e filtros online.
- Rolagem própria no painel para acessar todas as opções.
- Campos/buckets organizados de forma clara, sem esconder opções.

## Regra de segurança

Este ajuste é apenas de layout. Não pode alterar a regra congelada de Tabela/Matriz:

- Campo em Eixo vira coluna direta.
- Campo em Valores vira coluna direta.
- Campo marcado no painel Dados vira coluna direta.
- Nunca transformar texto em `SUM()`.
- Filtros só podem adicionar `WHERE`, sem mudar a estrutura das colunas da tabela.
