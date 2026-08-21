# Regra - Filtros do usuário online

A criação de relatórios deve permitir que o administrador escolha quais campos podem virar filtros para o usuário final na versão online.

Regras obrigatórias:
- O usuário online só pode filtrar campos liberados pelo administrador no relatório.
- O botão **Filtros** só aparece no dashboard online quando houver filtros configurados.
- O backend deve validar os filtros recebidos antes de aplicar SQL.
- Filtros não podem permitir escrita, alteração de SQL livre ou edição de dados.
- Ao publicar relatórios, a configuração de filtros online deve ser enviada junto com o relatório.
