# REGRA PERMANENTE - Filtros relacionados em tempo real

Esta regra não pode ser removida nas próximas versões.

## Objetivo

Quando um relatório usa uma tabela fato, por exemplo `faturamento2`, e o usuário cria filtros na tabela Calendário/Calendario, esses filtros precisam afetar imediatamente os dados da visualização, igual ao Power BI.

## Regra obrigatória

- Filtros de Calendário devem propagar para tabelas relacionadas.
- Se existir relacionamento salvo no modelo, usar a coluna relacionada.
- Se o relacionamento ainda não estiver salvo, detectar automaticamente uma coluna de data da tabela alvo quando possível.
- O preview do construtor deve respeitar os filtros configurados no popup do administrador.
- Alterar Ano, Mês, Dia, Data ou intervalo deve atualizar o visual automaticamente no canvas.
- A versão online também deve aplicar os mesmos filtros no dashboard publicado.

## Campos de calendário suportados

- Data
- Ano
- Mês / Mes / Nome Mês / MesNome
- Mês Número / MesNumero
- Dia
- Mês/Ano / AnoMes / AnoMesNome
- Trimestre
- Semestre

## Regra técnica

Não deixar o filtro preso somente na tabela Calendario. Ele precisa virar uma expressão sobre a coluna de data da tabela de destino, por exemplo:

```sql
YEAR(`Data Emissão`) = 2026
MONTH(`Data Emissão`) = 1
DAYOFMONTH(`Data Emissão`) BETWEEN 1 AND 31
```

Isso evita o erro em que o usuário aplica Ano/Mês/Dia, mas a tabela de faturamento continua mostrando os mesmos dados.
