# REGRA - Painéis do editor preservam o visual

A partir da v3.2.58:

- O painel Visualizações deve ter rolagem própria até o fim das opções de formatação.
- O painel Dados deve permitir abrir e recolher a tabela atual pelo cabeçalho da tabela.
- Selecionar/abrir outra tabela no painel Dados é apenas navegação. Não pode apagar campos, buckets, linhas ou preview do visual ativo.
- A origem do visual só muda quando o usuário efetivamente marca, arrasta ou dá duplo clique em um campo da nova tabela.
- A regra congelada de Tabela/Matriz continua intocada: Eixo/Valores/campos marcados viram colunas diretas; texto nunca vira SUM(); filtros só adicionam WHERE.
