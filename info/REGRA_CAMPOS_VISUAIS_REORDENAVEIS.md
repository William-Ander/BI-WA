# Regra - Campos visuais reordenáveis

A tela Relatórios/Dashboards deve permitir reordenar os campos dentro de **Campos do visual** para definir a ordem das colunas da Tabela/Matriz, no padrão do Power BI.

Regras obrigatórias:

- Os buckets Eixo/Dimensão e Valores podem ser arrastados entre si quando possuem campo.
- Os botões ↑ e ↓ também devem mover a coluna na ordem do visual.
- A ordem gravada deve atualizar `selectedFields` e `columnOrder`.
- O preview deve atualizar automaticamente após mover campo.
- Esta regra não pode alterar a regra congelada de Tabela/Matriz.
- Campo em Eixo continua coluna direta.
- Campo em Valores continua coluna direta.
- Campo marcado no painel Dados continua coluna direta.
- Nunca gerar SUM() automático para texto.
- Filtros podem apenas adicionar WHERE e não podem mudar a estrutura das colunas.
