# REGRA - Editor de Tabela/Matriz estilo Power BI

Esta regra deve ser preservada nas próximas versões.

## Objetivo

A tabela/matriz do BI WA deve permitir edição parecida com o Power BI:

- mover/reordenar colunas do visual;
- escolher a posição da coluna dentro da tabela/matriz;
- remover coluna do visual sem apagar a coluna/tabela real;
- abrir painel de formatação do visual;
- duplicar visual e trazer visual para frente;
- aplicar formatação de título, borda, cabeçalho, grade, fonte, alinhamento e densidade.

## Regra congelada que não pode ser quebrada

Mesmo com as novas ferramentas de edição, Tabela/Matriz continua obrigatoriamente assim:

- campo em Eixo vira coluna direta;
- campo em Valores vira coluna direta;
- campo marcado no painel Dados vira coluna direta;
- campo removido sai da visualização;
- nunca transformar campo de texto em `SUM()`;
- nunca gerar `SUM(Cliente)`, `SUM(Descrição Comercial)`, `SUM(CFOP)` ou similares;
- filtros podem apenas adicionar `WHERE`;
- filtros não podem mudar a estrutura das colunas da tabela.

## Ordem das colunas

A ordem visual deve ser salva no próprio visual usando `selectedFields` e `columnOrder`.

Ao mover uma coluna, o app deve atualizar o preview imediatamente e gerar o SELECT na mesma ordem.

## Bloqueio de regressão

Antes de gerar ZIP, rodar:

```bash
npm run validate:all
```
