# REGRA - Remover cards do Modelo visual

Esta regra e permanente para a tela **Conexoes > Modelo visual**.

## Comportamento obrigatorio

- O botao **x** de cada card deve remover o card imediatamente do Modelo visual.
- Remover card nao apaga tabela/view real do MySQL.
- Remover card remove apenas a tabela do modelo visual e os relacionamentos ligados a ela.
- `tablePositions` serve somente para guardar coordenadas; nunca pode recriar/ressuscitar card removido.
- Ao remover card, ele tambem deve sair da selecao de origem/destino de relacionamento.
- A remocao deve funcionar tanto na tela normal quanto em **Tela cheia do modelo**.
- Apos remover, o usuario deve clicar em **Salvar conexoes** para gravar no modelo semantico.

## Regra congelada preservada

Esta alteracao nao pode mexer na regra congelada de Tabela/Matriz:

- campo em Eixo vira coluna direta;
- campo em Valores vira coluna direta;
- campo marcado no painel Dados vira coluna direta;
- nunca gerar SUM em campo de texto;
- filtros so podem adicionar WHERE, sem mudar a estrutura da tabela.
