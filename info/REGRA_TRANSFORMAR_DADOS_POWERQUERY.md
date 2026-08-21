# Regra - Transformar Dados estilo Power Query

A partir da v2.9.8, o BI WA possui a tela **Transformar Dados**.

Regras permanentes:

- Tabelas/views originais do MySQL continuam somente leitura.
- Transformações nunca podem alterar a base MySQL original.
- Toda transformação deve ser salva como consulta do BI WA em `data/transform_queries.json`.
- Consultas transformadas devem aparecer como fonte de dados para relatórios/dashboards.
- A tela deve manter lista de **Etapas aplicadas**, semelhante ao Power Query.
- Nenhuma atualização futura deve remover essa camada sem substituir por equivalente melhor.

Funções iniciais obrigatórias:

- Selecionar colunas.
- Remover colunas.
- Renomear colunas.
- Alterar tipo.
- Filtrar linhas.
- Ordenar.
- Substituir valores.
- Remover duplicados.


## v2.9.9 - Etapas aplicadas e prévia

- A lista de etapas deve mostrar a etapa **Fonte** e todas as etapas aplicadas.
- O usuário deve conseguir clicar em uma etapa para ver a prévia até aquela etapa.
- O usuário deve conseguir reorganizar etapas com mover para cima/baixo.
- A prévia deve recalcular automaticamente após adicionar, editar, remover ou mover etapas.
- Nenhum erro de prévia deve travar a tela; mostrar mensagem clara e manter a lista de etapas visível.


## Mesclar e acrescentar consultas

- O módulo Transformar Dados deve permitir **Mesclar consultas**, equivalente a combinar dados por colunas correspondentes.
- O módulo Transformar Dados deve permitir **Acrescentar consultas**, equivalente a empilhar linhas de duas consultas/tabelas/views.
- Essas etapas devem aparecer em **Etapas aplicadas**, com possibilidade de editar, mover, remover e clicar para prévia até a etapa.
- A prévia deve recalcular automaticamente após qualquer alteração.
- Nenhuma etapa pode alterar o MySQL original.


## v3.0.1 - Colunas personalizadas e condicionais

O módulo **Transformar Dados** deve manter as etapas:

- **Coluna personalizada**: cria uma nova coluna por expressão calculada sem alterar o MySQL original. Deve aceitar referências a colunas usando `[Nome da Coluna]`.
- **Coluna condicional**: cria nova coluna no padrão IF/THEN/ELSE, com operador, valor verdadeiro e valor falso.
- A prévia deve recalcular automaticamente a cada alteração de etapa.
- As novas colunas devem ficar disponíveis para etapas seguintes, relatórios e dashboards.
- Qualquer atualização futura deve preservar suporte a nomes de colunas reais do MySQL, com espaços e acentos.
## v3.0.2 - Uso das consultas transformadas nos relatórios

- Toda consulta transformada salva em `data/transform_queries.json` deve aparecer como fonte em Relatórios / Dashboards.
- Consultas transformadas devem funcionar em eixo, valores, filtros, popup de filtros e prévia do visual.
- A API `/api/tables` e `/api/tables/lite` deve retornar também recursos com `source: "transform"`.
- O backend deve executar relatórios de consulta transformada via subquery segura, sem alterar o MySQL original.
- A regra de somente leitura permanece: transformações são camada de consulta, não edição da base.

