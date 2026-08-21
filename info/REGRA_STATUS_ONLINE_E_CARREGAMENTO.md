# Regra - Status online/offline e carregamento de tabelas/views

A partir da v3.0.8, o BI WA deve seguir estas regras:

1. A listagem de tabelas/views nao pode travar a tela esperando uma consulta lenta ao MySQL.
2. Sempre que possivel, usar cache local/ultima lista carregada enquanto atualiza em segundo plano.
3. Se a atualizacao falhar, manter a ultima lista disponivel e mostrar erro claro com botao de tentar novamente.
4. O dashboard deve exibir status **Online** quando estiver conectado/recebendo atualizacoes.
5. Se perder conexao, exibir **Offline** e a ultima atualizacao de dados recebida.
6. A mensagem de status deve ser visivel na tela inicial do dashboard.
