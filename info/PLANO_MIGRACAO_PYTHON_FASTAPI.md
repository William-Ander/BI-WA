# Migração Python/FastAPI - BI WA v3.2.31

A Fase 5 agora deixou de ser apenas plano: existe uma API Python/FastAPI funcional em `python_backend`.

## Estratégia adotada

O BI WA continua rodando pelo backend Node.js como produção estável, mas o backend Python já consegue ler os mesmos arquivos `data/*.json` e responder rotas compatíveis para testes.

## Rotas Python já criadas

- `/api/health`
- `/api/version`
- `/api/public-config`
- `/api/auth/login`
- `/api/config`
- `/api/settings`
- `/api/reports`
- `/api/reports/{id}/run`
- `/api/sync/ping`
- `/api/sync/reports`
- `/api/mysql/test`

## Próximas migrações recomendadas

1. Comparar resposta Node x Python em relatórios reais.
2. Migrar filtros avançados e modelo semântico completo.
3. Migrar listagem de tabelas/views e colunas.
4. Migrar transformações estilo Power Query.
5. Apontar o frontend para o Python somente após validação.

## Como abrir em modo Python

- Instale dependências: `npm run python:install`
- Abra API Python: `npm run python:start`
- Abra Electron usando Python: `BIWA_SERVER_ENGINE=python npm run app`

O modo Python ainda é experimental e não substitui o Node.js em produção nesta versão.


## v3.2.32 - Instalador unico

Os arquivos `.bat` auxiliares foram removidos. O pacote agora mantem somente `instalar_bi_wa.bat`; os demais fluxos devem usar o atalho criado pelo instalador ou comandos npm.
