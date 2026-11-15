# whatsapp-assistant

Backend de um assistente de pré-atendimento no WhatsApp. O ManyChat conduz a conversa e chama este sistema por *External Requests*. O sistema responde e cuida de tudo que vem depois:

- qualificar o lead;
- gravar no CRM;
- agendar a reunião;
- mandar lembretes;
- avisar a equipe.

Funciona só com regras determinísticas, sem IA, para que cada resposta seja previsível e testável.

![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white) ![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white) ![Testes](https://img.shields.io/badge/testes-306%20passando-brightgreen) ![Status](https://img.shields.io/badge/status-em%20produção-success)

> **🏢 Usado em produção** por uma empresa de consultoria e educação. Ele atende os leads das landing pages no WhatsApp e manda os lembretes de aulas, reuniões e mentorias. Marca, domínios e dados de pessoas foram trocados por valores genéricos.

## 📈 Impacto

- **Atendimento na hora, 24/7.** O lead responde o faturamento, é qualificado e, se tiver perfil, já recebe o link para agendar com o consultor.
- **Menos reuniões e aulas vazias.** Os lembretes saem no momento certo, e na véspera da reunião a pessoa pode confirmar, reagendar ou cancelar com um toque.
- **Escala sem esforço manual.** Uma única campanha alcançou **412 inscritos** pelo WhatsApp. O sorteio semanal de mentorias roda sozinho: inscrição, sorteio, trocas, mensagens e agendamento.
- **CRM sempre atualizado.** Cada passo da conversa (qualificou, agendou, cancelou, pediu para parar) vira etapa e histórico no Monday.com, sem digitação.
- **Respeito ao cliente.** Opt-out e opt-in de volta com um botão. Clientes ativos ficam fora das campanhas automaticamente.

## 🔌 Integrações

| Serviço | Uso |
|---|---|
| ManyChat (External Requests + API) | Conversa no WhatsApp e Instagram, campos personalizados, disparo de fluxos e modelos |
| Monday.com (GraphQL) | Busca pelo telefone, faixa de faturamento, etapa do funil, histórico, listas de etapas excluídas e protegidas |
| Calendly API v2 | Links com código por lead, webhooks assinados, cancelamento e remarcação |
| Google Calendar API | Leitura da agenda por conta de serviço (reuniões marcadas fora do Calendly) |
| Brevo | E-mails transacionais da aula ao vivo |
| Telegram Bot API | Avisos de reunião, sorteio, ordem de chegada e falhas para a equipe |
| MySQL | Conversas, tarefas agendadas com trava, rodadas do sorteio, contatos |

```
WhatsApp ⇄ ManyChat ⇄ whatsapp-assistant ──► Monday.com (CRM)
                          ▲        │  └──────► Telegram (equipe) · Brevo (e-mail)
            Calendly / Google Agenda      ManyChat API (lembretes agendados)
```

## Funcionalidades

**Qualificação por faturamento**
- Entende respostas livres como "17 mil", "17k", "R$ 17.000", "dezessete mil", "17,5 mil" e intervalos ("entre 15 e 18 mil").
- Pede confirmação quando o valor é ambíguo e enquadra o lead na faixa do CRM.
- Acha o cadastro pelo telefone em qualquer formato, com ou sem o 9 e com validação de DDD. Cadastros duplicados vão para a equipe.

**Agendamento**
- Lead qualificado recebe um link do Calendly com um código próprio, que liga o agendamento ao cadastro certo.
- Webhooks do Calendly com assinatura verificada: agendou, remarcou e cancelou atualizam o CRM e avisam a equipe.
- Também lê a agenda do Google (conta de serviço), para que reuniões marcadas direto na agenda recebam lembretes.
- Lembretes de confirmação na véspera e no dia, com botões para confirmar, reagendar ou cancelar.

**Lembretes e campanhas**
- Até 5 lembretes diários para quem recebeu o link e não agendou.
- Lembretes da aula ao vivo por WhatsApp e por e-mail (Brevo): 3 dias antes, véspera, 1 hora antes e "estamos ao vivo".
- Avisos das lives semanais e disparos únicos para uma lista.
- Opt-out ("não quero mais receber") e opt-in de volta, guardando a etapa anterior do CRM.
- Listas de etapas excluídas e protegidas: clientes ativos não recebem campanhas e não têm a etapa sobrescrita.

**Sorteio semanal de mentorias**
- Inscrições abertas até quarta às 8h e sorteio automático logo depois. Quem não está apto pela etapa do CRM fica de fora, e quem já foi sorteado em outras rodadas é sinalizado.
- A equipe pode trocar, excluir ou preencher vagas pelo painel até o meio-dia. Às 12h35 saem as mensagens para sorteadas e não sorteadas.
- A sorteada agenda pelo Calendly e recebe lembretes da mentoria.

**Confiabilidade**
- Tudo é salvo no banco antes de chamar serviços externos. Cada etapa tem uma chave única, então reenvios não duplicam nada.
- Falhas são repetidas com espera crescente: 1, 2, 5, 10, 30 e depois a cada 60 minutos. Quando o limite diário do CRM acaba, espera ele voltar.
- O agendador usa trava no banco, para não mandar em dobro se a hospedagem subir duas cópias do app.
- Um vigia confere a API de captação. Os avisos de falha e de volta saem no Telegram.
- Rotas internas, protegidas por chave, alimentam o painel administrativo: monitor, reuniões, mentorias e avisos do Telegram.
- Limpeza automática de dados pessoais antigos (LGPD).

## Estrutura

```
src/
  routes/     manychat, calendly, sorteio, interno (painel)
  services/   preatendimento, agendamento, reuniões, agenda Google, aula, lives, mentoria (sorteio),
              disparo, e-mail, monday, manychat, telegram, monitor, vigia, privacidade
  domain/     regras puras: faturamento, telefone, datas
  db/         store MySQL e store em memória (testes e desenvolvimento)
modelos-email/  modelos HTML dos e-mails da aula (Brevo)
test/           306 testes com node --test
```

## Rodando

```bash
npm ci
npm test
cp .env.example .env   # DATA_MEMORY=true roda sem MySQL (só fora de produção)
npm run dev
```


## 🧩 Faz parte de um conjunto de 3 sistemas

Os três rodam juntos em produção, e este assistente atende os leads no WhatsApp:

| Repositório | Papel |
|---|---|
| [lead-capture-api](https://github.com/Samis7th/lead-capture-api) | Capta os leads das landing pages, CRM, Meta Conversions API e Hotmart |
| [whatsapp-assistant](https://github.com/Samis7th/whatsapp-assistant) | Atendimento no WhatsApp, agendamento, lembretes e sorteios |
| [admin-dashboard](https://github.com/Samis7th/admin-dashboard) | Painel da equipe: leads, reuniões, sorteios e saúde das integrações |

## Stack

Node.js 22 · Express 5 · MySQL (`mysql2`) · ManyChat API · Monday.com GraphQL API · Calendly API v2 · Google Calendar API · Brevo · Telegram Bot API.
