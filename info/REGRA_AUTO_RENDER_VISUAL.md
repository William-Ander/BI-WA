# Regra - Atualização automática do visual

A tela Relatórios / Dashboards deve funcionar como no Power BI: ao selecionar, marcar ou arrastar um campo para o visual, a prévia deve atualizar automaticamente.

Regras obrigatórias:

- Não depender de botão "Atualizar visual" para renderizar a prévia.
- Alterações em tabela/view, eixo, valores, agregação, ordenação, filtro, limite e tipo de visual devem disparar atualização automática com debounce.
- Enquanto atualiza, mostrar status no visual ou no metadado.
- Se o visual ainda não tiver campos suficientes, mostrar orientação dentro do canvas, não erro genérico.
- Se a consulta falhar, mostrar erro claro dentro do visual e toast opcional.
- A publicação online deve manter o visual salvo exatamente como foi renderizado no desktop.
