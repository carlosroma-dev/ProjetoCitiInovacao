# Atendente de voz para revendas de seminovos

Plano de produto para revisão · Desafio de Inovação do CITi

## Problema e proposta

Responder perguntas sobre preço, disponibilidade e horários toma tempo da equipe e exige consultar estoque e agenda em etapas diferentes. Quando a conversa vira uma visita, o vendedor ainda precisa recuperar o que o cliente já contou sobre o carro, o orçamento e a troca.

O atendente recebe áudios, consulta a revenda fictícia e responde em voz. O cliente consegue tirar dúvidas e sair com dia e hora combinados. O vendedor recebe a visita com contexto suficiente para apresentar o carro e conversar sobre a troca sem pedir que o cliente conte tudo de novo. A demo entrega esse percurso em um link público que a banca pode usar no celular, sem conta nem ajuda da equipe.

## Jornada e telas

| Tela | O que a pessoa vê | O que consegue fazer |
| --- | --- | --- |
| **Landing de venda** | Uma promessa clara para o dono da revenda, os três passos da jornada e o botão **Experimentar demo**. | Iniciar uma rodada da revenda fictícia. As referências visuais entram quando forem adicionadas ao projeto. |
| **Chat do cliente** | Uma conversa inspirada no WhatsApp, com o atendente identificado como virtual, um cartão compacto do HB20 e a dica “Grave um áudio sobre o carro ou peça um horário para visitar a loja”. Os áudios aparecem em balões. A resposta falada vem com texto visível. | Gravar pelo botão de microfone, ouvir antes de enviar ou regravar, enviar e tocar a resposta. Perguntar sobre o estoque, ajustar o orçamento, mencionar a troca e escolher um horário por voz. Após a confirmação, abrir **Ver no painel**. |
| **Painel do vendedor** | Duas seções, **Visitas** e **Estoque**. A visita recém-registrada fica em destaque ao vir do chat. No estoque, cada carro tem foto, modelo, preço e disponibilidade. | Consultar visitas, ler o contexto comercial e editar preço e disponibilidade dos carros da rodada. As próximas consultas do chat refletem as alterações. |

A interação principal cabe em dois áudios. O cliente cita o HB20, a manhã de sábado e o Palio na troca. O atendente consulta o estoque e a agenda. “Tenho sábado, dia [data], às 9h ou às 10h30. Qual horário fica melhor?” O cliente escolhe 10h30. Depois de gravar a visita, o atendente fala “Ficou marcado para sábado, dia [data], às 10h30, para ver o HB20. Já deixei anotado que você tem um Palio na troca.” No painel, o vendedor vê data e hora, HB20 e Palio, com um resumo curto como “Quer conhecer o HB20 e avaliar o Palio como parte do pagamento.”

## Qualidade do frontend

O acabamento visual e a qualidade das interações fazem parte da entrega da primeira versão. Desenhar as três telas para o celular desde o início, com tipografia, cores, espaçamentos e controles consistentes. A direção visual da landing será refinada com as referências que forem adicionadas ao projeto.

- **Landing.** Fazer a proposta e o botão **Experimentar demo** aparecerem na primeira tela do celular. Usar uma imagem de seminovo coerente com o catálogo e manter o foco na passagem para o chat.
- **Chat.** Priorizar o controle de gravação ao alcance do polegar e manter a conversa fácil de acompanhar. Mostrar o tempo de gravação e dar retorno imediato ao gravar, enviar e tocar um áudio. Dar tratamento visual à confirmação da visita, com dia, hora e carro fáceis de localizar e um caminho claro para o painel.
- **Painel.** Destacar a visita recém-criada. Usar cartões no celular para que horário, carro e troca possam ser lidos de relance. No estoque, deixar claras a disponibilidade e a ação de editar, com retorno ao salvar ou em caso de erro.
- **Estados das telas.** Desenhar carregamento, lista vazia, erro e confirmação onde se aplicarem. Usar texto legível, áreas de toque confortáveis e mensagens de estado que possam ser entendidas pela leitura, inclusive quando também forem indicadas por cor ou áudio.

## Escopo da primeira versão

**Teto de custo da primeira versão e da demo: R$ 0.** As tecnologias ficam em aberto para escolha.

- **Estoque e agenda fictícios.** Um catálogo pequeno com fotos, HB20 disponível, opções em faixas de preço diferentes e um carro indisponível. Cada rodada começa com dois horários livres na manhã de um sábado futuro e pelo menos uma vaga em outro período. O chat consulta os dados da rodada e oferece alternativas que respeitem o orçamento informado.
- **Conversa por áudio gravado.** Gravação, envio, transcrição e resposta falada. O chat mostra quando está gravando, enviando ou preparando a resposta. O cliente decide quando ouvir. O atendente recupera o carro, o orçamento e o usado mencionado nos turnos anteriores e atualiza esses dados quando o cliente corrige algo.
- **Agendamento e continuidade.** Oferecer até dois horários, reconhecer a escolha por voz, revalidar carro e horário e confirmar somente depois de salvar. A visita fica disponível no painel da mesma rodada e continua lá após recarregar a página. O resumo inclui o que ajuda o vendedor a conduzir a visita, como o orçamento e o interesse na troca.
- **Administração mínima do estoque.** Editar preço e disponibilidade para demonstrar que chat e painel trabalham com o mesmo estoque. Uma visita já registrada continua visível se a disponibilidade do carro mudar depois.

| Para depois | Motivo |
| --- | --- |
| WhatsApp e ligações | Cada canal adiciona um fluxo de entrada e operação. O link já permite testar a conversa de ponta a ponta. |
| Cadastro de clientes, CRM e lembretes | Ganham valor quando a loja precisa retomar contato depois da conversa. A visita com contexto cobre a passagem para o vendedor na demo. |
| Cadastro completo de carros, upload de fotos e gestão da agenda | O catálogo e os horários preparados cobrem os cenários de teste. Preço e disponibilidade já permitem demonstrar administração do estoque. |
| Avaliação do usado, financiamento e negociação | Dependem de dados e regras comerciais da loja. Na primeira versão, o vendedor recebe a informação sobre a troca e conduz a avaliação. |
| Múltiplas lojas e permissões de acesso | Fazem sentido com dados e equipes reais. A demo funciona com uma revenda fictícia por rodada. |

## Decisões para revisão

| Decisão | Opções e escolha proposta |
| --- | --- |
| Estoque e agenda | **Uma cópia por rodada** ou uma revenda compartilhada entre todos os testes públicos. Escolho a cópia por rodada para que a banca sempre comece com a mesma disponibilidade. Abrir o link do chat da rodada em uma janela anônima inicia outra conversa com a mesma revenda, o que permite testar a disputa de horário. |
| Identificação | **Agendar sem cadastro** ou pedir nome e contato antes de salvar. Escolho agendar sem cadastro para manter os dois áudios do roteiro. O painel recebe os dados comerciais que a pessoa informou. |
| Escolha do horário | **Escolher por voz** ou tocar em um dos horários exibidos. Escolho a voz para que a banca teste a continuidade da conversa até a confirmação. O texto da resposta deixa os horários à vista. |

## Como a conversa deve soar

- Responder primeiro ao que a pessoa perguntou, em duas ou três frases curtas. Fazer uma pergunta por vez, sobre o detalhe que destrava o próximo passo.
- Usar o que a pessoa já contou. Se ela disser “até R$ 60 mil agora”, filtrar pelo novo teto e retomar a conversa sobre o Palio quando fizer sentido. Se trocar de carro depois de ver horários, validar o novo interesse antes de registrar a visita.
- Confirmar o que importa com nomes, dia, data e hora. Usar os preços e horários consultados. Ao falar do Palio, registrar a intenção de troca e deixar a avaliação com o vendedor.

| Situação | Comportamento esperado |
| --- | --- |
| Pedido ambíguo | Se a pessoa disser “qual o preço daquele branco?” e houver dois carros possíveis, perguntar qual modelo. Se responder “de manhã” a dois horários matutinos, repetir as opções em uma pergunta curta. Salvar a visita só quando a escolha estiver clara. |
| Carro indisponível | Informar a situação e sugerir até duas alternativas disponíveis compatíveis com o orçamento conhecido. Se o carro ficar indisponível depois da oferta de horários, avisar ao tentar marcar e pedir que o cliente indique outro carro. |
| Áudio difícil de entender | Pedir só o trecho que faltou. “Entendi que você quer vir sábado. Qual é o modelo do seu usado?” Manter o restante do contexto e permitir gravar outro áudio. Se a permissão do microfone falhar, mostrar como habilitá-la e permitir nova tentativa. |
| Duas pessoas escolhem a mesma vaga | A oferta do horário é uma consulta. No momento de salvar, a agenda aceita uma única visita por horário. Quem conseguir a vaga recebe a confirmação. A outra pessoa ouve que a vaga acabou de ser ocupada e recebe outro horário livre, ou a opção de consultar outro período. |
| Falha ao salvar ou repetir o envio | Conferir se a escolha já gerou uma visita antes de tentar de novo. Se já existir, recuperar a confirmação. Se o agendamento ainda não tiver sido salvo, dizer que a visita está pendente e oferecer nova tentativa. Se só o áudio da resposta falhar depois de salvar, mostrar a confirmação em texto e permitir tentar ouvir novamente. |

## Ordem de entrega

1. **Desenhar a jornada no celular e fechar os dados da rodada.** Esboçar as três telas e os estados de gravação, espera, erro e confirmação. Preparar carros, fotos, preços e horários que cubram os casos do plano.
2. **Fechar agenda e painel.** Oferecer uma vaga, registrar a escolha e verificar a visita após recarregar. Aplicar o layout do painel com os dados da rodada e validar a disputa da vaga, a repetição do envio e a mudança de disponibilidade no estoque.
3. **Fechar a conversa por voz no celular.** Integrar gravação, transcrição e resposta falada ao chat desenhado. Exercitar mudança de orçamento, troca, ambiguidades e recuperação de erros. Ajustar os controles, a clareza e o tempo de resposta com áudios reais.
4. **Publicar a landing e ensaiar pelo link.** Testar como visitante novo, desde a entrada na landing e a primeira permissão de microfone até a leitura da visita no painel. Verificar o acabamento das três telas junto com os critérios funcionais.

## Roteiro ao vivo

1. No celular, abrir o link, tocar em **Experimentar demo** e permitir o microfone.
2. Gravar “Curti o HB20. Consigo passar sábado de manhã? Tenho um Palio pra dar na troca.” Ouvir as duas opções.
3. Gravar “Pode ser às dez e meia.” Ouvir a confirmação com a data, o horário e o HB20.
4. Tocar em **Ver no painel**. Conferir a nova visita, o Palio e o resumo. Recarregar e conferir que ela continua visível.

## Critérios de pronto

- O percurso completo funciona a partir do link público, sem login ou intervenção, em Safari no iPhone e Chrome no Android. Fazer três rodadas independentes em cada navegador. A meta de ensaio é disponibilizar cada resposta em até 10 segundos após o envio, em conexão estável.
- Em uma tela de 360 px de largura, **Experimentar demo** aparece antes de rolar, gravar e reproduzir áudio são ações identificáveis no chat e a nova visita pode ser lida no painel sem zoom, corte de texto ou rolagem horizontal. Conferir as três telas também no desktop.
- No celular, dá para distinguir se o chat está gravando, enviando, esperando resposta, pronto para reproduzir ou em erro. A confirmação mostra o dia, a hora e o carro, com acesso visível ao painel. Ao editar o estoque, o painel informa se a alteração foi salva.
- Na rodada inicial, o primeiro áudio gera duas opções livres e o segundo gera exatamente uma visita. A confirmação falada e o painel mostram a mesma data, hora e carro. O painel registra o Palio e um resumo fiel. Recarregar preserva a visita e abrir uma nova rodada repõe os dois horários de teste.
- Ao editar preço ou disponibilidade no painel, a próxima consulta do chat usa o novo valor. Ao mudar o orçamento, as sugestões passam a respeitar o novo teto e a troca permanece no contexto.
- Pedido ambíguo e áudio difícil de entender geram uma pergunta específica. Carro indisponível e falha ao salvar produzem uma orientação para seguir. Nenhum desses casos gera confirmação sem visita registrada.
- Em duas conversas da mesma rodada que escolhem a mesma vaga, aparece uma única visita e o segundo cliente recebe uma alternativa válida. Repetir o envio da escolha também resulta em uma única visita.
