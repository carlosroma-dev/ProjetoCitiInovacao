# Pátio Voz

Histórico de desenvolvimento e material de apoio para o pitch e o relatório do Desafio de Inovação do CITi. Registro de 19 de novembro de 2026.

[Landing pública](https://patio-voz-citi.vercel.app/) · [Chat da loja](https://patio-voz-citi.vercel.app/demo/loja) · [Painel do vendedor](https://patio-voz-citi.vercel.app/vendedor)

## O problema e a proposta

Em uma revenda, perguntas sobre preço, disponibilidade e visita passam por três tarefas. A equipe precisa consultar o estoque, conferir a agenda e recuperar o contexto da conversa quando outro vendedor assume. Um cliente que já informou qual carro quer ver, quanto pode pagar e qual usado tem na troca pode ter de repetir esses dados.

O Pátio Voz concentra essa jornada em um chat. Júlia, a consultora virtual, recebe texto e áudio, consulta o catálogo e ajuda o cliente a marcar uma visita. O vendedor recebe o carro de interesse, o dia e horário, o orçamento e o usado na troca quando informados, além do histórico e do resumo do atendimento. Ele pode responder pelo painel e a mensagem volta ao mesmo chat do cliente.

O objetivo da primeira versão foi demonstrar esse percurso em uma revenda fictícia, com um link que a banca consegue abrir no celular. A entrada no chat é pública. O painel tem um acesso separado para a equipe.

## Como o escopo evoluiu

| Etapa | Decisão e motivo | Resultado |
| --- | --- | --- |
| Planejamento da jornada | Fazer a visita com contexto ser o resultado do MVP. A conversa inicial foi desenhada em torno de dois áudios, com interesse no HB20, manhã de sábado e Palio na troca. | O plano definiu três telas, casos de teste para concorrência e ambiguidades, e critérios de legibilidade no celular. [Plano inicial](PLANO-PRODUTO.md) |
| Estoque e agenda | Tratar catálogo e reservas como dados da aplicação. A IA interpreta a intenção, e o backend verifica o carro, o orçamento e a vaga antes de confirmar. | Visita persistente e vinculada à conversa, ao carro e ao vendedor. A vaga pertence a um vendedor, de modo que dois vendedores livres podem atender no mesmo horário. Uma vaga individual só aceita uma reserva. [Lógica de estoque e agenda](lib/demo.ts) |
| Conversa multimodal | Acrescentar texto ao fluxo por voz e aceitar mensagens curtas em sequência. Dar ao cliente controle sobre a gravação e a reprodução. | O chat agrupa mensagens de texto após oito segundos de inatividade. O cliente pode gravar, ouvir e regravar. A resposta escrita aparece no chat e o áudio usa uma fala própria. [Histórico e processamento](lib/chat-history.ts) · [Interface do chat](app/demo/%5BroundId%5D/voice-chat.tsx) |
| Continuidade humana | Fazer o painel receber a conversa quando a visita é concluída ou quando o cliente pede um vendedor. | A agenda identifica o responsável. A área **Atendimento** diferencia **Contato de rotina** de **Quer falar agora**. O vendedor vê o histórico e responde no mesmo chat. [Agenda por vendedor e encaminhamentos](supabase/migrations/202611170008_seller_agenda_handoffs.sql) |
| Administração do estoque | O plano inicial previa edição de preço e disponibilidade. Na implementação, cadastrar carros e enviar fotos passou a fazer parte da demo para mostrar a conexão ao vivo. | O vendedor pode cadastrar e editar carros e enviar até três imagens por carro. As próximas consultas consultam o estoque salvo. Foram cadastrados Evoque, Sportage e Tracker com dados de demonstração e sete fotos fornecidas para o projeto. [Guia do catálogo](README.md#fotos-e-atendimento) |
| Ambiente da banca | Manter uma entrada pública que usa o estoque e a agenda do painel. Manter uma entrada independente para testes descartáveis. | A landing e **Abrir chat** no painel levam à mesma loja em `/demo/loja`. A rota `/demo` cria uma rodada isolada. Dentro da loja compartilhada, cada navegador mantém seu histórico. A banca ganhou acesso adicional ao painel. [Rotas da demo](app/demo) · [Sessão do painel](lib/seller-session.ts) |
| Publicação e acabamento | Publicar a experiência integral e destacar a passagem da landing para a demo. Aplicar a referência do hero animado à identidade do projeto. | Landing com título alternado, pausa, suporte a movimento reduzido e imagens do painel e do chat. O botão **Experimentar chat** abre a loja. [Hero da landing](app/animated-hero.tsx) |

## As decisões técnicas

- **Next.js, React e TypeScript** no frontend e nas rotas de servidor. A landing, o chat e o painel fazem parte da mesma aplicação publicada na Vercel. [Dependências](package.json) · [Configuração de deploy](vercel.json)
- **PostgreSQL no Supabase** para carros, horários, conversas, reservas e encaminhamentos. O Storage guarda as fotos cadastradas. O backend vincula operações à rodada, protege o painel e revalida a disponibilidade ao confirmar. Reenvios da mesma reserva reaproveitam a confirmação quando ela já foi registrada. [Migrações](supabase/migrations) · [Implementação do catálogo](lib/demo.ts)
- **OpenAI** para interpretar o pedido e redigir a resposta com `gpt-6-luna`, e para transcrever em português com `gpt-transcribe`. A resposta usa preços e disponibilidades consultados pela aplicação. O modelo ajuda a entender a conversa, enquanto a confirmação depende de a reserva ter sido gravada. [Implementação da conversa](lib/voice.ts)
- **ElevenLabs** para sintetizar mensagens de voz. A fala pode complementar a resposta escrita com uma formulação própria. O áudio gerado é armazenado para reaproveitamento quando o cliente toca novamente. [Cache de áudio](supabase/migrations/202611170007_reply_audio.sql) · [Controle de consumo](lib/quotas.ts)
- **Custo**. O plano inicial propôs teto de R$ 0 para a primeira versão e a demo. A hospedagem foi planejada com Supabase Free e Vercel Hobby dentro dos limites dos planos. Uso de OpenAI consome saldo da API, e síntese de voz consome créditos do ElevenLabs. Nenhum custo total ou volume suportado foi medido para o relatório. [Notas de hospedagem](README.md#verificações-e-hospedagem)

## Como foi construída e validada

O trabalho partiu de um plano de produto e avançou por partes que podiam ser testadas isoladamente. Estoque e agenda foram ligados ao banco. A conversa e a reprodução de áudio foram integradas. O painel recebeu sessões, cadastro e encaminhamentos. O fluxo completo foi exercitado em ambiente local e depois no domínio público. Agentes executaram frentes em paralelo quando solicitado, com integração e verificação no código compartilhado. Feedback de uso gerou ajustes na landing, na leitura de pedidos e na agenda.

| Evidência | O que foi verificado |
| --- | --- |
| Verificações de código | ESLint e TypeScript passaram nas entregas publicadas e nas alterações de acesso para a banca. |
| Testes de banco e atendimento | O projeto tem verificações de reserva concorrente, contexto, sessão, catálogo, upload e leitura de fotos. As verificações de voz usam respostas simuladas dos provedores. [Scripts de verificação](scripts) |
| Produção e catálogo | A landing pública, o login, o estoque compartilhado, a galeria da Sportage e a geração do áudio da Júlia foram exercitados no endereço de produção. Foi conferido que as imagens de prévia publicadas na landing correspondiam aos arquivos locais. |
| Produção e passagem ao vendedor | Em uma rodada isolada, uma visita ao HB20 com intenção de entregar um Palio na troca foi registrada. O responsável apareceu na agenda, o contato chegou à área de Atendimento e uma resposta do vendedor voltou ao chat. |
| Interface | O hero foi conferido em larguras de 320, 390 e 1.440 px, incluindo animação, pausa, movimento reduzido e abertura da loja. O login da banca também foi conferido pelo formulário com acesso ao estoque e sessão persistida. |

A validação de voz em produção confirma a geração do áudio da resposta. A gravação pelo microfone e a reprodução em celulares físicos, especialmente Safari iOS e Chrome Android, ainda precisam de um ensaio. A meta inicial de resposta em até dez segundos era um critério de teste, sem medição concluída para o relatório.

## Último feedback e ajustes publicados

O feedback mais recente entrou na versão publicada da demo. O teste em produção confirmou a lista do estoque, o filtro de SUVs, uma resposta sem áudio e uma visita às 15h de sexta registrada no painel em uma rodada isolada.

| Feedback | Ajuste publicado |
| --- | --- |
| Um pedido como “quais carros vocês têm?” devolvia uma nova pergunta genérica. Um pedido de SUV podia seguir o mesmo caminho. | Apresentar os carros disponíveis e seus preços diretamente. Filtrar a listagem quando o cliente procurar uma categoria reconhecida ou informar um orçamento. |
| Áudio aparecia com frequência maior que a desejada. | Selecionar cerca de 20% das respostas para áudio espontâneo. Preparar áudio quando o cliente solicitar expressamente. |
| A agenda anterior era preparada para sábados específicos e podia recusar sexta às 15h. Perguntas sobre horários precisavam de alternativas concretas. | Abrir a agenda da demo todos os dias das 8h às 18h, em intervalos de 30 minutos, no horário de Brasília, em janela móvel de 28 dias. Consultar as vagas quando o cliente pedir opções. O painel indica os horários reservados por vendedor. [Migração da agenda diária](supabase/migrations/202611170009_daily_demo_agenda.sql) |

O escopo é de uma revenda fictícia. WhatsApp, telefonia, CRM, lembretes, avaliação de usados, financiamento, negociação e operação com lojas reais ficam para etapas futuras. O projeto registra intenção de troca e encaminha a conversa para a pessoa que conduz a negociação. O benefício esperado é reduzir a repetição de perguntas e facilitar a passagem ao vendedor. Qualquer ganho de conversão ou tempo poupado precisaria ser medido com uma revenda real.

## Roteiro de gravação

1. **Abra com o problema.** “Quando alguém pergunta por um seminovo, o vendedor alterna entre conversa, estoque e agenda. Quando outro vendedor assume, parte do contexto se perde.”
2. **Mostre a entrada.** Abra a landing no celular, toque em **Experimentar chat** e faça uma pergunta concreta como “Vocês têm Sportage?”. Mostre o preço e as fotos. Se quiser demonstrar áudio em um momento previsível, peça “Pode explicar em áudio?”.
3. **Leve a conversa até a visita.** Use um carro e um horário livres que tenha conferido antes de gravar. Diga “Quero ver o HB20. Tenho um Palio pra dar na troca”. Indique um dia e horário disponíveis quando a Júlia perguntar e confirme. O card da visita deve mostrar os dados gravados.
4. **Troque para o ponto de vista do vendedor.** Na agenda, mostre a mesma reserva e o responsável. Encerre a conversa dizendo “Não, só isso mesmo”. Abra **Atendimento**, mostre o Palio e o histórico, responda como vendedor e volte ao chat para ver a mensagem.
5. **Feche com o resultado que a demo prova.** “O atendimento começa com uma pergunta sobre um carro e termina com uma visita registrada, pronta para a equipe continuar.”

## Briefing para colar no outro chat

> Estou preparando o pitch e o relatório do Pátio Voz para o Desafio de Inovação do CITi. É uma demo web publicada para uma revenda fictícia. A Júlia atende por texto e voz, consulta o estoque, agenda visitas e passa o contexto para um vendedor, que pode responder pelo mesmo chat. A demonstração pode destacar o HB20 com um Palio na troca e a continuidade no painel. Use este histórico para justificar as decisões, separar proposta de evidência e explicar a evolução do escopo. Inclua os ajustes publicados de lista do estoque, agenda diária e áudio espontâneo em cerca de 20% das respostas. Baseie o relato em funcionalidades demonstradas e testes documentados.
