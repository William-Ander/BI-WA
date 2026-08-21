# Regra permanente - listagem de tabelas e views

Esta regra deve ser respeitada em todas as atualizações do BI WA.

## Problema que não pode voltar

A lista de **Tabelas** e **Views** não pode ficar presa indefinidamente em `Carregando...`.

## Regras obrigatórias

1. Toda chamada do frontend para `/api/tables` deve ter timeout visível ao usuário.
2. Se a API falhar, a interface deve mostrar mensagem de erro e botão para tentar novamente.
3. O backend deve consultar tabelas/views com timeout de consulta MySQL.
4. A listagem deve continuar usando múltiplas estratégias:
   - `INFORMATION_SCHEMA.TABLES`;
   - `INFORMATION_SCHEMA.VIEWS`;
   - `SHOW FULL TABLES`;
   - `SHOW TABLES`.
5. O endpoint `/api/tables/debug` deve ser mantido para diagnóstico.
6. Tabelas/views vindas do MySQL externo permanecem somente leitura.
7. Apenas tabelas manuais criadas no BI WA podem ser editadas.

## Como validar antes de gerar ZIP

- Abrir o app com MySQL configurado.
- Confirmar que a lateral sai de `Carregando...`.
- Se houver erro de MySQL, confirmar que aparece a mensagem real.
- Confirmar que o botão **Tentar carregar novamente** aparece quando a listagem falha.
- Confirmar que views aparecem separadas de tabelas quando o usuário MySQL tem permissão.


## Reforço v2.8.9
- Toda chamada de listagem deve ter timeout explícito no backend e no frontend.
- A tela deve usar fallback quando `/api/tables` falhar.
- A tabela nativa `Calendario` deve permanecer visível mesmo quando o MySQL não responder.
- Nunca deixar o texto `Carregando...` permanente sem erro e sem botão de nova tentativa.


## Regra v3.0.9

A listagem deve combinar tabelas MySQL, views, Calendario e consultas transformadas usando uma função auxiliar declarada no frontend. Se uma função auxiliar for removida, renomeada ou movida, a tela deve falhar com fallback e nunca ficar presa em carregando.

Erro corrigido nesta versão: `mergeTransformsIntoResources is not defined`.


## Regra v3.1.0 - Visualização paginada
Na tela Tabelas e Views, a visualização de dados deve carregar páginas pequenas, sem executar COUNT(*) obrigatório e sem timeout curto. Tabelas grandes devem exibir a primeira página rapidamente e usar botões de paginação.
