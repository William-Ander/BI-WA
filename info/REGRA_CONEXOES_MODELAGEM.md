# Regra de Conexões e Modelagem

A tela **Conexões** é o local oficial para preparar o modelo de dados do BI WA.

Regras obrigatórias para próximas versões:

1. A tabela nativa **Calendario** deve aparecer sempre em primeiro lugar, mesmo antes de ser materializada no MySQL.
2. A tela deve usar cards de tabelas/views, com as colunas visíveis dentro de cada card, no padrão visual do Power BI.
3. O usuário deve conseguir criar relacionamento arrastando uma coluna de um card para uma coluna de outro card.
4. A tela deve ser compacta, responsiva e com rolagem interna nos cards quando houver muitas colunas.
5. Tabelas/views externas do MySQL continuam somente leitura.
6. O relacionamento salvo em `data/semantic_model.json` deve respeitar origem, destino, coluna, cardinalidade, direção de filtro e tipo de join.

Última atualização desta regra: v2.8.7.
