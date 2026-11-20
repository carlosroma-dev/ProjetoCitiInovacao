# Pátio Voz

Demo de atendimento para uma revenda fictícia. Júlia, consultora virtual do Pátio Voz, atende por texto ou áudio, consulta o catálogo, agenda visitas e encaminha conversas à equipe de vendas. O painel reúne Visão geral, Agenda, Estoque e Atendimento. O chat e o painel da mesma rodada compartilham veículos, visitas e encaminhamentos no PostgreSQL.

## Rodar localmente

Use Node.js 22 ou mais recente, npm e PostgreSQL. O ambiente preparado usa o container `patio-voz-phase2` na porta `55435`, com usuário e banco `patio`.

```powershell
npm ci
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

Preencha `DATABASE_URL` em `.env.local` com a conexão do seu banco. Defina `SELLER_DEMO_EMAIL`, `SELLER_DEMO_PASSWORD` e `SELLER_SESSION_SECRET` para entrar no painel. Use um segredo aleatório de pelo menos 32 caracteres. Para dar acesso adicional à banca, configure `SELLER_REVIEW_EMAIL` e `SELLER_REVIEW_PASSWORD`. Cada sessão é vinculada à conta e à rodada. Mantenha as credenciais em `.env.local` ou nas variáveis privadas do host.

Em um banco novo, aplique as migrations `001` a `009`, em ordem. Em um banco existente, aplique apenas as que faltam. A `006` adiciona o histórico e a fila de respostas. A `007` guarda o áudio gerado para reutilizar a mesma gravação quando alguém ouvir a resposta de novo. A `008` vincula os horários e as visitas aos vendedores e registra os encaminhamentos do chat. A `009` abre a agenda diária da demonstração.

Para um banco novo no Docker local, use este comando.

```powershell
Get-ChildItem supabase/migrations/*.sql | Sort-Object Name | ForEach-Object {
  Get-Content -Raw $_.FullName | docker exec -i patio-voz-phase2 psql -U patio -d patio -1 -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "Falha ao aplicar $($_.Name)" }
}
npm run dev
```

A landing abre `/demo/loja`, que usa o mesmo estoque e a mesma agenda do painel em `/vendedor`. Cada navegador inicia sua própria conversa e volta a ela ao reabrir a demonstração. Use `/demo` para testar em uma rodada isolada com o catálogo inicial. Caso a porta 3000 esteja ocupada, use `npm run dev -- --port 3001` e troque a porta nos links. [Demonstração](http://localhost:3000/demo/loja) · [Área do vendedor](http://localhost:3000/vendedor)

## Fotos e atendimento

No Supabase Storage local ou no projeto Free, crie um bucket **público** chamado `catalogo`. Informe a URL da API em `SUPABASE_URL` e a chave secreta de servidor em `SUPABASE_SECRET_KEY`. O Supabase local também aceita a chave `service_role` legada nessa variável. Para outro nome de bucket, use `SUPABASE_CATALOG_BUCKET`. Adicione até três arquivos JPEG, PNG ou WebP de até 1,25 MB cada ao cadastrar ou editar um veículo na aba Estoque. Um chat já aberto na mesma rodada consulta o novo cadastro na mensagem seguinte. [Documentação do Supabase Storage](https://supabase.com/docs/guides/storage/uploads/standard-uploads)

As quatro fotos iniciais funcionam com os arquivos locais. Para servi-las do bucket, copie as quatro imagens WebP de `public/images/` para `images/` no bucket `catalogo` e informe `SUPABASE_CATALOG_URL` como `https://<project-ref>.supabase.co/storage/v1/object/public/catalogo`. Mantenha os créditos e licenças originais. [Créditos e licenças](public/images/ATTRIBUTION.md)

- **OpenAI** usa uma única `OPENAI_API_KEY` para o `gpt-6-luna`, que interpreta o pedido e redige a resposta, e para o `gpt-transcribe`, que transcreve os áudios em português. Adicione a chave do projeto da API em `.env.local` e reinicie o servidor local. Os dois modelos usam o saldo da API. [Chaves da API](https://platform.openai.com/api-keys) · [Preços da API](https://developers.openai.com/api/docs/pricing)
- **ElevenLabs** gera as mensagens de voz a partir de falas próprias. Em `.env.local`, preencha `ELEVENLABS_API_KEY` com uma chave que tenha **Text to Speech → Acesso** e `ELEVENLABS_VOICE_ID` com o ID de uma voz da sua conta em português do Brasil. Por padrão, cerca de 20% das respostas da Júlia incluem áudio. Ela também manda áudio quando o cliente pede e respeita pedidos para conversar só por texto. Toque no player para escutar. A geração usa os créditos do ElevenLabs. [Criar chave](https://elevenlabs.io/app/api/api-keys) · [Copiar ID da voz](https://elevenlabs.io/docs/pt/help-center/technical/how-do-i-find-the-voice-id-of-my-voices-via-the-website-and-api)

## Roteiro da demonstração

1. Abra `/vendedor`, entre na **Área do vendedor** e cadastre um carro em **Estoque** com nome, modelo, preço e fotos. Defina o estado como **Disponível**.
2. Clique em **Abrir chat** no painel. Esse link usa a mesma rodada do estoque. Quando você recarrega ou reabre o mesmo endereço no mesmo navegador, a conversa volta com seu histórico. Use **Nova conversa** para começar um atendimento separado.
3. Pergunte “Quais carros vocês têm?” ou “Tem SUV?”. Júlia lista as opções disponíveis. Pergunte por um carro específico para ver a galeria. Cada carro aparece com uma galeria por conversa. Para ouvir a consultora na demonstração, peça “Me responde em áudio”.
4. Pergunte “Como faço pra dar uma olhada?”. Júlia pergunta se você quer combinar uma visita e, com sua autorização, pede seu melhor dia e horário. Informe que tem um Palio na troca, que seu teto é de R$ 80 mil e qual data e hora prefere. Você pode consultar a disponibilidade de um horário e depois confirmar com “Pode marcar”. Se a vaga já estiver ocupada, Júlia pergunta qual outro horário funciona para você.
5. A **Agenda** oferece vagas todos os dias, das 8h às 18h, a cada 30 minutos, numa janela de 28 dias no horário de Brasília. Ao perguntar “Quais horários vocês têm?”, o cliente recebe opções livres para o dia escolhido. Na confirmação, o chat mostra a data, a hora, o carro e o vendedor responsável. Clique em **Ver no painel** para abrir a visita selecionada na mesma rodada.
6. Depois de confirmar, a consultora pergunta “Ficou alguma dúvida?”. Responda “Não, só isso mesmo” para ver o encaminhamento **Contato de rotina** na aba **Atendimento**. Em outra conversa, peça para falar com um vendedor e confira a prioridade **Quer falar agora**. Abra o encaminhamento para ver o histórico, o carro, a troca, o orçamento e a preferência informada. Envie uma resposta pelo painel e confira a mensagem assinada pelo vendedor no chat do cliente.
7. Altere o preço ou o estado no **Estoque** e consulte o carro novamente em um chat com a consultora para ver a alteração.

## Verificações e hospedagem

`npm run lint` e `npm run typecheck` verificam o código. `npm run verify:db` testa a agenda por vendedor e a concorrência de reservas no PostgreSQL. `npm run verify:voice` testa texto, áudio, reservas e encaminhamentos com respostas simuladas dos provedores. Com PostgreSQL migrado e Storage configurado, `npm run verify:seller` verifica sessão e catálogo e faz upload e download de três fotos reais de teste. Migre o banco antes de rodar esses comandos.

O PostgreSQL e o Supabase podem rodar localmente. Os atendimentos com OpenAI consomem o saldo da API conforme os tokens de texto e a duração do áudio recebido. Para hospedagem pessoal, use Supabase Free e Vercel Hobby dentro dos limites dos planos. A publicação depende de contas, credenciais reais e configuração do host. [Supabase Free](https://supabase.com/pricing) · [Vercel Hobby](https://vercel.com/docs/plans/hobby)

No Supabase hospedado, aplique as migrations no **SQL Editor**, configure o bucket e obtenha a URI de **Connect → Transaction pooler** para `DATABASE_URL`. Para validar o TLS, informe o certificado CA do Supabase em Base64 em `DATABASE_CA_BASE64` e use a URI sem parâmetros SSL. Na Vercel, use `npx vercel login` e `npx vercel link` para vincular a pasta. Configure as variáveis de produção com os nomes do `.env.example` e os valores privados do seu ambiente. Com a configuração pronta, `npx vercel deploy --prod` publica a demo.

Antes de apresentar, teste o microfone e a reprodução no Chrome Android e no Safari iOS com suas contas configuradas. A gravação depende das permissões do dispositivo e dos formatos aceitos pelo navegador.
