# Regra de preservacao de dados nas atualizacoes

Nas proximas versoes do BI WA, o ZIP final nao deve incluir arquivos locais de usuario dentro da pasta `data/`, como:

- `data/settings.json`
- `data/reports.json`
- `data/semantic_model.json`
- `data/transform_queries.json`
- `data/manual_tables.json`

Esses arquivos pertencem a instalacao local do usuario e devem ser criados pelo app somente quando nao existirem.

O instalador unico `instalar_bi_wa.bat` deve sempre preservar o `.env` existente e criar backup da pasta `data/` antes de instalar dependencias ou iniciar o app.

Nunca sobrescrever configuracoes reais de MySQL, usuarios, permissoes, relatorios ou publicacao online em uma atualizacao.
