# Regra permanente - Linhas de conexões e persistência do Modelo visual

Esta regra deve ser preservada em todas as próximas versões do BI WA.

## Tela Conexões / Modelo visual

- As linhas de relacionamento precisam ligar exatamente o card/coluna de origem ao card/coluna de destino.
- A linha deve mostrar visualmente a cardinalidade nas pontas, como no Power BI: `1`, `*`, `1:*`, `*:1`, etc.
- A linha deve informar claramente o vínculo completo: `TabelaOrigem[ColunaOrigem] -> TabelaDestino[ColunaDestino]`.
- Se o card for arrastado, a linha deve ser redesenhada imediatamente e continuar presa ao card correto.
- Se a coluna relacionada estiver fora da área visível do card por causa do scroll interno, a linha deve prender na borda visível do card e indicar isso sem quebrar o desenho.
- Ao salvar ou mover cards, as posições e os relacionamentos devem ser persistidos em `data/semantic_model.json`.
- Atualizações futuras do app não podem sobrescrever o arquivo real `data/semantic_model.json` do usuário.
- O pacote limpo não deve levar `data/semantic_model.json` real; deve preservar o arquivo existente da instalação.

## Regra congelada da Tabela/Matriz

Esta regra não pode ser alterada por mudanças nas conexões:

- Campo em Eixo vira coluna direta.
- Campo em Valores vira coluna direta.
- Campo marcado no painel Dados vira coluna direta.
- Nunca transformar texto em `SUM()`.
- Filtros podem apenas adicionar `WHERE`, sem mudar a estrutura da tabela.
