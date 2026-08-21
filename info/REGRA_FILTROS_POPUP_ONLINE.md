# Regra - Popup de filtros online

1. A criação de filtros disponíveis para usuários online deve acontecer no Admin pelo botão **Configurar filtros**.
2. O botão deve abrir um popup responsivo.
3. Somente o visual do tipo **Filtro / Segmentação** pode ser arrastado para esse popup.
4. Os modelos mínimos de filtro são: suspenso, entre, hoje, pesquisa e lista.
5. Na versão online, o botão **Filtros** deve abrir o mesmo popup para o usuário aplicar apenas os filtros liberados pelo administrador.
6. Filtros aplicados pelo usuário online devem ser validados no backend contra a lista de filtros permitidos.
7. Nenhuma atualização futura deve voltar para filtro inline fixo no dashboard.

## Regra adicional v2.9.3
No popup de filtros, o administrador deve conseguir selecionar qualquer fonte disponível no modelo/app: tabelas MySQL, views MySQL e tabelas nativas como Calendario. O campo liberado deve ser carregado com base na fonte escolhida, não apenas na tabela atual do relatório.
