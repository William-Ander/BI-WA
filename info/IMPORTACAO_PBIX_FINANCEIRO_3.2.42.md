# Importação do PBIX FINANCEIRO para o BI WA v3.2.42

Gerado em: 2026-06-01T21:30:03Z

## Páginas importadas

- DASHBOARD: 7 visuais suportados importados
- CONTAS A PAGAR: 20 visuais suportados importados
- CONTAS A RECEBER: 20 visuais suportados importados
- DESPESAS COMPETENCIA: 24 visuais suportados importados
- DESPESAS FLUXO: 24 visuais suportados importados
- COMPRAS FLUXO: 24 visuais suportados importados
- CAIXA: 19 visuais suportados importados
- DRE: 41 visuais suportados importados
- EBITDA: 8 visuais suportados importados
- Entradas e Saídas: 21 visuais suportados importados
- fluxo de caixa: 72 visuais suportados importados

## Tipos de visuais encontrados no PBIX

- actionButton: 120
- shape: 80
- slicer: 73
- None: 51
- tableEx: 50
- card: 42
- cardVisual: 38
- multiRowCard: 32
- textbox: 29
- BBED0A4D4D8D44CE93CF2DAFADEE466C: 26
- image: 25
- pivotTable: 9
- clusteredColumnChart: 2
- donutChart: 2
- pieChart: 2
- stackedAreaChart: 2
- areaChart: 1
- funnel: 1

## Tabelas/entidades encontradas

- Atualização: 1 colunas, 0 medidas
- CP: 8 colunas, 0 medidas
- CP & CR: 2 colunas, 0 medidas
- CP Fluxo: 3 colunas, 0 medidas
- CR: 6 colunas, 0 medidas
- CR Fluxo: 4 colunas, 0 medidas
- Calendário: 5 colunas, 0 medidas
- Cliente: 2 colunas, 0 medidas
- Cliente & Fornecedor: 1 colunas, 0 medidas
- Contas a Pagar: 9 colunas, 0 medidas
- Contas a Pagar 2: 8 colunas, 0 medidas
- Contas a Receber: 6 colunas, 0 medidas
- Faturamento: 1 colunas, 0 medidas
- Fornecedor: 1 colunas, 0 medidas
- Inventário: 1 colunas, 0 medidas
- Medidas Loja: 0 colunas, 65 medidas
- Plano de Contas: 1 colunas, 0 medidas
- Plano de Contas CR: 1 colunas, 0 medidas
- Recebimento: 2 colunas, 0 medidas

## Observações importantes

- O relatório FINANCEIRO foi adicionado em `data/reports.json` com as 11 páginas do PBIX.
- Os visuais de dados e filtros foram importados com layout aproximado de 1280x720.
- Objetos decorativos do Power BI como shapes, imagens e botões foram inventariados, mas nem todos viram visuais editáveis porque o app ainda não tem motor nativo de canvas para esses objetos.
- As fórmulas DAX e os dados internos do modelo não foram extraídos porque o `DataModel` do PBIX está comprimido em XPress9.
- Os SQLs dos visuais foram mantidos como placeholders seguros; para bater os números em tempo real, é necessário mapear cada medida DAX para SQL/MySQL.