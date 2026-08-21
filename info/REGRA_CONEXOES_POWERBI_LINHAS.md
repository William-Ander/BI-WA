# Regra - Conexões estilo Power BI com linhas

A tela Conexões deve funcionar como área de modelagem visual.

Regras obrigatórias:

- Tabelas, views, consultas transformadas e fontes nativas devem aparecer como cards com colunas internas.
- O usuário deve poder arrastar uma tabela/view para a área do modelo.
- O usuário deve poder criar relacionamento arrastando uma coluna até outra coluna.
- Após criar ou salvar um relacionamento, uma linha visual deve aparecer entre as duas colunas relacionadas.
- Relações salvas em `data/semantic_model.json` devem ser redesenhadas automaticamente ao abrir a tela.
- A área de modelagem deve ter rolagem própria, sem quebrar o layout principal.
- Cards com muitas colunas devem ter rolagem interna.
- Nenhum relacionamento deve alterar o MySQL; ele apenas orienta relatórios, filtros e dashboards.

Esta regra deve ser preservada em futuras atualizações.
## Atualização v3.1.1

- A tela Conexões deve persistir `model.tables` e `model.tablePositions` no arquivo `data/semantic_model.json`.
- Ao salvar conexões, os cards já posicionados não podem sumir ao sair e voltar da tela.
- As linhas de relacionamento devem ser desenhadas entre as colunas reais dos cards, usando as bordas corretas de origem/destino.
- A área visual deve ter rolagem própria, mantendo os cards dentro do modelo visual.
- Os painéis laterais `Tabelas e views` e `Criar relacionamento` devem ter opção de recolher/expandir para liberar espaço.



## v3.1.2

- Os painéis **Tabelas e views** e **Criar relacionamento** devem ficar no lado direito/final da página.
- Ao recolher um painel, ele deve permanecer como trilho visível para expandir novamente.
- Cards salvos no modelo visual devem persistir ao sair e voltar da tela.
