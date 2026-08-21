---
name: bi-wa-qa
description: Planeja e executa validação do BI WA usando os scripts reais do repositório, distinguindo checks estáticos, runtime, banco, mutações temporárias e empacotamento. Use para QA, regressão e gates; não use para implementar a correção.
---

# BI WA — QA

Selecione o menor conjunto de validações que cobre o risco real sem tocar produção ou estado local desnecessariamente.

## Preparação

Leia [a matriz de validação](references/validation-matrix.md) antes de executar testes além de npm run check.

## Estratégia

1. Liste os arquivos/símbolos alterados e os contratos afetados.
2. Rode npm run check para qualquer mudança em JavaScript principal.
3. Selecione validadores estáticos por domínio.
4. Só rode validadores runtime após confirmar servidor local, autenticação, PostgreSQL e dados de teste.
5. Para scripts que iniciam backend ou escrevem em data/, use cópia isolada e confira hashes.
6. Não rode pacote, publish, deploy ou sync como parte implícita de QA.

## Regras

- package.json é a fonte dos aliases npm. Documentação histórica contém comandos inexistentes.
- Um POST /api/visual-query pode ser semanticamente read-only, mas ainda depende do ambiente e pode ser caro.
- Nunca configure BIWA_TEST_BASE_URL para produção.
- Não aceite teste que passa apenas por procurar texto quando há um contrato observável disponível; combine check estático com runtime proporcional ao risco.
- Preserve e compare data/reports.json, data/semantic_model.json, data/transform_queries.json e data/imported_tables.json em testes runtime.
- Se um teste falhar por ambiente ausente, reporte-o como não executado/bloqueado, não como regressão funcional.
- Não corrija o aplicativo durante uma tarefa apenas de diagnóstico/QA sem autorização.

## Saída esperada

Informe:

- comandos executados e resultado;
- ambiente usado e dependências externas;
- testes não executados e motivo;
- arquivos de estado verificados por hash;
- risco residual por fluxo afetado.

