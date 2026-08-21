# REGRA PERMANENTE - CONEXOES / MODELO ESTILO POWER BI

Esta regra vale para todas as proximas versoes do BI WA.

## Objetivo

A tela **Conexoes** deve funcionar como a exibicao de modelo do Power BI:

- permitir abrir o modelo em tela cheia;
- mostrar todos os cards/tabelas no canvas com rolagem ampla;
- desenhar linhas visuais entre colunas relacionadas;
- mostrar cardinalidade nas pontas da linha, como `*` e `1`;
- permitir arrastar coluna de um card ate outra coluna para criar relacionamento;
- permitir clicar em dois cards para preencher origem/destino do relacionamento;
- permitir remover um card do modelo sem apagar tabela real do MySQL;
- ao remover card, remover apenas relacionamentos ligados a esse card;
- salvar os relacionamentos no modelo semantico;
- nao alterar dados reais do banco.

## Protecao da regra de Tabela/Matriz

Esta regra **nao pode mexer** na regra congelada de Tabela/Matriz.

Filtros e relacionamentos podem adicionar condicoes `WHERE`, mas nao podem mudar a estrutura da tabela/matriz:

- campo em Eixo vira coluna direta;
- campo em Valores vira coluna direta;
- campo marcado no painel Dados vira coluna direta;
- nunca transformar texto em `SUM()`;
- nunca gerar `SUM(Cliente)`, `SUM(Descricao Comercial)`, `SUM(CFOP)`, etc.
