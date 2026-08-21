# REGRA - Reabrir relatório salvo para edição

Ao abrir um relatório salvo no Construtor de relatórios, os visuais já configurados devem aparecer carregados no canvas automaticamente.

Obrigatório:
- Se o visual salvo tem tabela e campos, executar preview automaticamente ao abrir para editar.
- Se o visual salvo tem SQL, executar a consulta salva para preencher o canvas.
- Manter os campos marcados no painel Dados.
- Manter Eixo/Dimensão e Valores nos buckets do visual.
- Não exibir a mensagem "Selecione ou arraste campos" quando o visual salvo já tem campos suficientes.
- Preservar a regra congelada de Tabela/Matriz: campos viram colunas diretas, nunca SUM(texto).

Proibido:
- Limpar selectedFields ao abrir relatório salvo.
- Trocar estrutura de Tabela/Matriz para agregação.
- Gerar SUM(Cliente), SUM(Descrição Comercial), SUM(CFOP) ou qualquer texto.

Implementação protegida:
- public/app.js: hydrateSavedReportVisualsForEditing()
- public/app.js: runSavedVisualPreview()
- public/app.js: visualDirectFieldNames()
- scripts/validate-visual-rules.js deve validar a presença desse fluxo.
