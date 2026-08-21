# Regras do projeto BI WA

Estas regras devem ser respeitadas em toda alteracao futura do app.

1. Nao incluir `.env` real, senhas, tokens, usuarios ou configuracoes reais de banco no ZIP final.
2. Manter apenas `.env.example` como modelo de configuracao.
3. Nao incluir `node_modules` no ZIP final; usar `npm install` ou `npm ci` no computador/servidor de destino.
4. Nao incluir logs, perfis locais de navegador ou arquivos temporarios no ZIP final.
5. Antes de entregar uma nova versao, executar `npm run check`.
6. Verificar se a versao em `package.json`, `info/VERSION.json` e `info/marcadores/` foi atualizada.
7. Preservar a separacao entre modo desktop/admin e modo online/viewer.
8. O modo online deve continuar bloqueando edicao, escrita em tabela, alteracao de schema e publicacao.
9. Toda melhoria de frontend deve preservar a compatibilidade com relatorios ja salvos em `data/reports.json`.
10. Alteracoes no tempo real devem evitar consultas desnecessarias ao MySQL, principalmente com aba oculta ou dashboard pausado.

## Regra v3.2.2 - Performance e tempo real

- Não remover o cache de consultas sem substituir por solução equivalente de proteção ao MySQL.
- Toda escrita em tabela manual, alteração de estrutura, transformação ou relatório deve invalidar o cache.
- O modo online deve continuar somente visualização.
- O ZIP final nunca deve incluir `.env`, `node_modules`, logs ou perfis locais.

## Regra v3.2.93 - Arquitetura PostgreSQL primário

- PostgreSQL é o banco operacional do app. Todas as telas consultam PG primeiro.
- MySQL é EXCLUSIVAMENTE para sincronizar/atualizar os dados do cache PG.
- Se MySQL estiver offline, o app deve continuar 100% funcional com dados em cache PG/SQLite.
- NUNCA usar `noCache: true` em `runSelect()` — bloqueia PG cache.
- NUNCA inverter a ordem PG → MySQL em `findDatabaseResourceByName()`.
- `autoImportUnimportedTables()` deve ser chamada no startup e não pode depender de MySQL.
- Detalhes completos: `info/REGRA_ARQUITETURA_POSTGRES_PRIMARIO.md`
