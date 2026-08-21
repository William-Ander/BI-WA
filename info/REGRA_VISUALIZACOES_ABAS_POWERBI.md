# REGRA - PAINEL VISUALIZACOES EM ABAS ESTILO POWER BI

Versao: 3.2.61

Esta regra protege o comportamento do painel **Visualizacoes** no editor de relatorios.

## Comportamento obrigatorio

- O painel Visualizacoes deve usar abas/botoes superiores como no Power BI:
  - Criar visual
  - Formatar visual
  - Analise/Filtros
- Cada aba deve mostrar somente as opcoes correspondentes.
- As opcoes de formatacao nao devem ficar empilhadas na rolagem principal do painel.
- O painel nao pode invadir ou sobrepor o painel Dados.
- O conteudo de cada aba pode ter rolagem propria quando necessario.
- Os campos do visual continuam acessiveis na aba Criar visual.

## Regra congelada de Tabela/Matriz

Esta alteracao e somente de layout do painel. Nao pode alterar a regra congelada de Tabela/Matriz:

- Campo em Eixo vira coluna direta.
- Campo em Valores vira coluna direta.
- Campo marcado no painel Dados vira coluna direta.
- Nunca transformar texto em SUM().
- Nunca gerar SUM(Cliente), SUM(Descricao Comercial), SUM(CFOP) etc.
- Filtros podem apenas adicionar WHERE sem mudar a estrutura da tabela.
