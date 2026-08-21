# Regra permanente - Tabela nativa Calendário

A tabela `Calendario` é uma tabela nativa do BI WA para modelagem de datas.

Regras obrigatórias:

1. Deve aparecer na tela **Conexões** no grupo **Nativas**.
2. Deve poder se relacionar com qualquer tabela/view que possua coluna de data.
3. Deve ser somente leitura no BI WA.
4. Não deve ser tratada como tabela externa comum nem como tabela manual editável.
5. Deve conter colunas úteis para BI: Data, DataKey, Ano, MesNumero, MesNome, MesNomeCurto, AnoMes, AnoMesNome, Dia, DiaSemanaNumero, DiaSemanaNome, DiaDoAno, SemanaAno, Trimestre, TrimestreNome, Semestre, InicioMes, FimMes, UltimoDiaMes, EhFimSemana e DiaUtil.
6. Em novas versões, preservar o botão **Criar/atualizar Calendário** na tela Conexões.


## Regra crítica v2.9.6

A tabela nativa `Calendario` deve funcionar mesmo quando o usuário MySQL for somente leitura.

- Não tentar criar, apagar ou recriar tabela física `Calendario` no MySQL durante uso normal do app.
- Para filtros e opções de campos do Calendario, usar geração virtual pelo backend do BI WA.
- Qualquer botão de criar/atualizar calendário deve informar que o Calendario é nativo/virtual quando não houver permissão de escrita.
- O erro `CREATE command denied` não pode aparecer para o usuário ao usar filtros do Calendario.

## Regra v3.0.4

A tabela `Calendario` é nativa/virtual. Qualquer rota, visual, filtro, prévia ou tela que usar `Calendario` deve resolver os dados pelo gerador interno do BI WA antes de tentar consultar o MySQL. Nunca gerar `FROM Calendario` direto no MySQL, exceto se no futuro houver configuração explícita de calendário físico com permissão validada.
