# Correção 3.2.45 - Timeout no dashboard e visual imediato

Esta versão corrige o caso em que um visual de tabela/matriz com campos de texto em Valores era salvo como agregação SQL, por exemplo `SUM(Cliente)`, causando demora ou `Query inactivity timeout`.

## Ajustes

- Para Tabela e Matriz, campos em Eixo/Dimensão, Valores e campos selecionados são tratados como colunas diretas.
- O dashboard não executa mais o SQL principal antigo quando o relatório possui visuais próprios; ele executa cada visual individualmente.
- Se um visual der timeout, apenas esse visual mostra erro amigável e o restante do dashboard continua funcionando.
- O relatório Vendas foi corrigido para exibir `Descrição Comercial` e `Cliente` diretamente.

## Resultado esperado

Ao arrastar/remover campos no editor, a prévia e o dashboard devem atualizar sem precisar clicar em Atualizar e sem tentar somar campos de texto.
