# Regra - Propagação de filtros por relacionamento

Quando o administrador criar um relacionamento na tela **Conexões**, os filtros liberados no popup online devem respeitar esse relacionamento.

## Exemplo obrigatório

Se existir o relacionamento:

```text
Calendario[Data] -> faturamento[Data Venda]
```

Então, ao usuário online aplicar:

```text
Calendario[Data] = hoje
```

Os visuais baseados na tabela `faturamento` devem retornar somente os registros cuja coluna relacionada `Data Venda` seja igual à data de hoje.

## Regras permanentes

- A tabela nativa `Calendario` pode ser usada como tabela de filtro.
- Filtros de `Calendario` devem ser convertidos para a coluna de data da tabela relacionada.
- O app deve suportar pelo menos: `Data`, `DataKey`, `Ano`, `MesNumero`, `AnoMes`, `Dia`, `SemanaAno`, `Trimestre`, `Semestre`, `InicioMes`, `FimMes`, `EhFimSemana` e `DiaUtil`.
- A propagação deve funcionar nos relatórios salvos e na versão online.
- O filtro deve ser aplicado antes do agrupamento do SQL do visual, para funcionar mesmo quando a coluna de data não aparece no resultado final do gráfico.
- Nunca tentar criar tabela física no MySQL para o Calendario quando o usuário for somente leitura.
