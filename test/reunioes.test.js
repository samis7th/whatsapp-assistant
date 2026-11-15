const test = require("node:test");
const assert = require("node:assert/strict");

// Lembretes da reunião marcada no Calendly (véspera útil, no dia, respostas, reagendar e
// cancelar), com Calendly, ManyChat, Monday e Telegram simulados.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.CALENDLY_TOKEN = "token-calendly";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";
process.env.MANYCHAT_FLOW_CONFIRMACAO = "content20261028000000_000000";
process.env.MANYCHAT_FLOW_REUNIAO_VESPERA = "content20261028000000_000001";
process.env.MANYCHAT_FLOW_REUNIAO_DIA_CONFIRMAR = "content20261028000000_000002";
process.env.MANYCHAT_FLOW_REUNIAO_DIA_CONFIRMADO = "content20261028000000_000003";
process.env.MANYCHAT_FLOW_REUNIAO_REAGENDADA = "content20261028000000_000004";
process.env.MANYCHAT_FLOW_REUNIAO_CANCELADA = "content20261028000000_000005";

const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const calendly = require("../src/services/calendly.service");
const agendamento = require("../src/services/agendamento.service");
const reunioes = require("../src/services/reunioes.service");

const F = config.manychat.flowReuniao;
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Map() });

// ---------- simulações ----------
let mc;
let avisos;
let cal;
let store;

manychat.setFetch(async (url, init) => {
  const caminho = new URL(url).pathname;
  const corpo = init.body ? JSON.parse(init.body) : {};
  mc.push({ caminho, corpo });
  if (caminho.endsWith("createSubscriber")) return ok({ status: "success", data: { id: 777 } });
  return ok({ status: "success", data: {} });
});

telegram.setFetch(async (url, init) => {
  avisos.push(JSON.parse(init.body).text);
  return ok({ ok: true, result: {} });
});

calendly.setFetch(async (url, init) => {
  const caminho = new URL(url).pathname;
  cal.chamadas.push({ metodo: init.method, caminho, corpo: init.body ? JSON.parse(init.body) : null });
  if (caminho.endsWith("/cancellation")) {
    return cal.cancelarFalha ? ok({ message: "Permission denied" }, 403) : ok({ resource: {} }, 201);
  }
  return ok({ resource: { location: { join_url: cal.linkNovo } } });
});

monday.setFetch(async (url, init) => {
  const { query } = JSON.parse(init.body);
  if (query.includes("columns")) {
    return ok({
      data: {
        boards: [
          {
            columns: [
              { id: "fat", title: "Faturamento Mensal", type: "status" },
              { id: "etapa", title: "Etapa do Funil", type: "status" },
              { id: "prox", title: "Próximo Contato", type: "date" },
              { id: "ult", title: "Último Contato", type: "date" },
              { id: "obs", title: "OBS", type: "long_text" },
            ],
          },
        ],
      },
    });
  }
  if (query.includes("query Obs")) return ok({ data: { items: [{ column_values: [{ text: "" }] }] } });
  if (query.includes("items_page")) return ok({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } });
  if (query.includes("change_multiple_column_values")) return ok({ data: { change_multiple_column_values: { id: "1" } } });
  if (query.includes("create_update")) return ok({ data: { create_update: { id: "1" } } });
  throw new Error(`query inesperada: ${query}`);
});

function relogio(iso) {
  const agora = new Date(iso);
  agendamento.setRelogio(() => agora);
  reunioes.setRelogio(() => agora);
  return agora;
}

// Libera as tarefas marcadas até "iso" (no servidor, a fila faz isso sozinha) e processa.
async function rodarAte(iso) {
  const agora = relogio(iso);
  for (const tarefa of await store.todasTarefas()) {
    if (tarefa.status === "pendente" && tarefa.proxima && tarefa.proxima <= agora) {
      await store.atualizarTarefa(tarefa.id, { proxima: null });
    }
  }
  await agendamento.processarTarefas();
}

const fluxos = () => mc.filter((c) => c.caminho.endsWith("sendFlow")).map((c) => c.corpo.flow_ns);
const campos = () => Object.fromEntries(mc.filter((c) => c.caminho.endsWith("setCustomFieldByName")).map((c) => [c.corpo.field_name, c.corpo.field_value]));

function convidado({ evento = "EV1", invitee = "INV1", inicio = "2026-11-09T17:00:00Z", link = "https://meet.google.com/abc-defg-hij", oldInvitee, rescheduled = false } = {}) {
  return {
    uri: `https://api.calendly.com/scheduled_events/${evento}/invitees/${invitee}`,
    name: "Ana Souza",
    email: "ana@exemplo.com",
    text_reminder_number: null,
    rescheduled,
    old_invitee: oldInvitee || null,
    reschedule_url: `https://calendly.com/reschedulings/${invitee}`,
    cancel_url: `https://calendly.com/cancellations/${invitee}`,
    questions_and_answers: [{ question: "WhatsApp", answer: "(11) 91234-5678" }],
    tracking: {},
    scheduled_event: {
      uri: `https://api.calendly.com/scheduled_events/${evento}`,
      start_time: inicio,
      end_time: inicio,
      location: { type: "google_conference", join_url: link },
    },
  };
}

async function agendar(dados, quando) {
  relogio(quando);
  await agendamento.receberWebhook({ event: "invitee.created", payload: convidado(dados) });
}

async function cancelarNoCalendly(dados, quando) {
  relogio(quando);
  await agendamento.receberWebhook({ event: "invitee.canceled", payload: { ...convidado(dados), cancellation: { reason: "Imprevisto" } } });
}

async function registro(evento = "EV1") {
  return (await store.tarefaPorChave(`reuniao:${evento}`)).dados;
}

test.beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
  mc = [];
  avisos = [];
  cal = { chamadas: [], cancelarFalha: false, linkNovo: "https://meet.google.com/novo-link-xyz" };
});

// ---------- calendário ----------

const brt = (d) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);

test("véspera é o dia anterior às 13h, sem exceção para fim de semana nem feriado; no dia às 8h (Brasília)", () => {
  const agendado = new Date("2026-11-01T12:00:00Z");
  // Segunda 09/11 14h -> domingo 08/11 13h e segunda 8h.
  let p = reunioes.planejarAvisos(new Date("2026-11-09T17:00:00Z"), agendado);
  assert.equal(brt(p.vespera), "dom., 08/11, 13:00");
  assert.equal(brt(p.dia), "seg., 09/11, 08:00");

  // Terça 03/11 (segunda 02/11 é Finados): a véspera é o feriado mesmo.
  p = reunioes.planejarAvisos(new Date("2026-11-03T17:00:00Z"), new Date("2026-10-20T12:00:00Z"));
  assert.equal(brt(p.vespera), "seg., 02/11, 13:00");

  // Sábado 26/12 -> sexta 25/12 (Natal), 13h.
  p = reunioes.planejarAvisos(new Date("2026-12-26T13:00:00Z"), agendado);
  assert.equal(brt(p.vespera), "sex., 25/12, 13:00");

  // Virada de mês: domingo 01/11 -> sábado 31/10.
  p = reunioes.planejarAvisos(new Date("2026-11-01T17:00:00Z"), new Date("2026-10-20T12:00:00Z"));
  assert.equal(brt(p.vespera), "sáb., 31/10, 13:00");
});

test("reunião cedo: o lembrete do dia sai antes (antecedência), nunca depois do início", () => {
  const p = reunioes.planejarAvisos(new Date("2026-11-09T10:30:00Z"), new Date("2026-11-01T12:00:00Z")); // 7h30
  assert.equal(brt(p.dia), "seg., 09/11, 05:30");
});

test("agendamento de última hora: sem avisos retroativos; se der tempo, um pedido só", () => {
  // Marcou às 9h para as 14h do mesmo dia: só um pedido, às 10h.
  let p = reunioes.planejarAvisos(new Date("2026-11-09T17:00:00Z"), new Date("2026-11-09T12:00:00Z"));
  assert.equal(p.vespera, null);
  assert.equal(brt(p.dia), "seg., 09/11, 10:00");

  // Marcou às 13h para as 14h: nada (já tem a confirmação do agendamento).
  p = reunioes.planejarAvisos(new Date("2026-11-09T17:00:00Z"), new Date("2026-11-09T16:00:00Z"));
  assert.deepEqual(p, { vespera: null, dia: null });

  // Marcou domingo 12h30 para segunda: véspera (domingo 13h) muito perto -> só o do dia.
  p = reunioes.planejarAvisos(new Date("2026-11-09T17:00:00Z"), new Date("2026-11-08T15:30:00Z"));
  assert.equal(p.vespera, null);
  assert.equal(brt(p.dia), "seg., 09/11, 08:00");
});

// ---------- fluxo completo ----------

test("agendou -> véspera pede confirmação -> 'Sim, confirmo' -> no dia sai o de 'já confirmou'", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await agendamento.processarTarefas();
  mc = [];

  await rodarAte("2026-11-08T16:00:00Z"); // domingo 13h
  assert.deepEqual(fluxos(), [F.vespera]);
  assert.deepEqual(campos(), {
    reuniao_data: "09/11 (segunda-feira)",
    reuniao_hora: "14h",
    reuniao_link: "https://meet.google.com/abc-defg-hij",
    reuniao_reagendar: "https://calendly.com/reschedulings/INV1",
  });

  const r = await reunioes.responder({ contatoId: "777", resposta: "Sim, confirmo" });
  assert.equal(r.resultado, "confirmado");
  assert.equal(r.reuniao_data, "09/11 (segunda-feira)");
  assert.equal((await registro()).confirmacao, "confirmada");

  // Resposta repetida (com espaços e minúsculas) não muda nada.
  assert.equal((await reunioes.responder({ contatoId: "777", resposta: "  sim  " })).resultado, "confirmado");

  mc = [];
  await rodarAte("2026-11-09T11:00:00Z"); // segunda 8h
  assert.deepEqual(fluxos(), [F.diaConfirmado]);
});

test("sem resposta: no dia sai o de 'confirmar' com o link", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");
  mc = [];
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), [F.diaConfirmar]);
  assert.equal(campos().reuniao_link, "https://meet.google.com/abc-defg-hij");
});

test("'Não posso': manda o link de reagendar, suspende os lembretes e avisa a pendência no dia; não cancela", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");

  const r = await reunioes.responder({ contatoId: "777", resposta: "Não posso" });
  assert.equal(r.resultado, "reagendar");
  assert.equal(r.reuniao_reagendar, "https://calendly.com/reschedulings/INV1");
  await agendamento.processarTarefas();
  assert.ok(avisos.some((a) => /Pediu para reagendar/.test(a)));

  // Um "não" isolado depois do link não cancela.
  assert.equal((await reunioes.responder({ contatoId: "777", resposta: "não" })).resultado, "reagendar");
  assert.equal(cal.chamadas.filter((c) => c.caminho.endsWith("/cancellation")).length, 0);

  mc = [];
  avisos = [];
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), [], "o lembrete do dia não sai");
  assert.ok(avisos.some((a) => /Reunião com pendência/.test(a)));
  assert.equal((await registro()).situacao, "ativa", "silêncio não cancela");
});

test("reagendou no Calendly: avisos antigos não saem, novos são marcados e sai 'reagendada' uma vez", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await agendamento.processarTarefas();

  relogio("2026-11-02T12:00:00Z");
  await agendamento.receberWebhook({ event: "invitee.canceled", payload: convidado({ rescheduled: true }) });
  mc = [];
  await agendar(
    { evento: "EV2", invitee: "INV2", inicio: "2026-11-11T13:00:00Z", oldInvitee: "https://api.calendly.com/scheduled_events/EV1/invitees/INV1" },
    "2026-11-02T12:05:00Z"
  );
  await agendamento.processarTarefas();

  assert.equal((await registro("EV1")).situacao, "substituida");
  assert.deepEqual(fluxos(), [F.reagendada]);
  assert.equal(campos().reuniao_data, "11/11 (quarta-feira)");
  assert.ok(!fluxos().includes(process.env.MANYCHAT_FLOW_CONFIRMACAO), "sem a confirmação comum duplicada");

  mc = [];
  await rodarAte("2026-11-08T16:00:00Z"); // véspera da reunião antiga: não sai
  assert.deepEqual(fluxos(), []);
  await rodarAte("2026-11-10T16:00:00Z"); // véspera da nova (terça 13h)
  assert.deepEqual(fluxos(), [F.vespera]);
});

test("'Não quero reagendar': cancela no Calendly, responde 'cancelado' e o aviso do Calendly não manda outra mensagem", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");
  await reunioes.responder({ contatoId: "777", resposta: "Não posso" });

  const r = await reunioes.responder({ contatoId: "777", resposta: "Não quero reagendar" });
  assert.equal(r.resultado, "cancelado");
  assert.ok(cal.chamadas.some((c) => c.metodo === "POST" && c.caminho === "/scheduled_events/EV1/cancellation"));

  mc = [];
  await cancelarNoCalendly({}, "2026-11-06T21:05:00Z");
  await agendamento.processarTarefas();
  assert.deepEqual(fluxos(), [], "a mensagem de cancelada já saiu na conversa");

  mc = [];
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), [], "nenhum lembrete depois de cancelada");
});

test("falha ao cancelar no Calendly: não confirma, suspende os lembretes e avisa a equipe", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");
  cal.cancelarFalha = true;
  const r = await reunioes.responder({ contatoId: "777", resposta: "pode cancelar" });
  assert.equal(r.resultado, "falha");
  assert.equal((await registro()).situacao, "ativa");
  assert.equal((await registro()).confirmacao, "cancelamento_pendente");
  assert.ok(avisos.some((a) => /Cancelamento de reunião não concluído/.test(a)));

  mc = [];
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), []);
});

test("cancelou direto no Calendly: sai 'cancelada' uma vez (aviso repetido não duplica)", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");
  mc = [];
  await cancelarNoCalendly({}, "2026-11-07T12:00:00Z");
  await cancelarNoCalendly({}, "2026-11-07T12:01:00Z");
  await agendamento.processarTarefas();
  assert.deepEqual(fluxos(), [F.cancelada]);
  assert.equal(campos().reuniao_hora, "14h");
});

test("link do Meet ainda não gerado: busca no Calendly; sem link, não manda com o campo vazio", async () => {
  await agendar({ link: "" }, "2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z"); // véspera não precisa do link
  mc = [];
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), [F.diaConfirmar]);
  assert.equal(campos().reuniao_link, "https://meet.google.com/novo-link-xyz");

  // Outra reunião, sem link nem no Calendly: não sai.
  cal.linkNovo = "";
  await agendar({ evento: "EV3", invitee: "INV3", link: "", inicio: "2026-11-10T17:00:00Z" }, "2026-11-01T12:00:00Z");
  mc = [];
  await rodarAte("2026-11-10T11:00:00Z");
  assert.deepEqual(fluxos().filter((f) => f === F.diaConfirmar), []);
  const tarefa = (await store.todasTarefas()).find((t) => t.chave === "reuniao_aviso:EV3:dia");
  assert.equal(tarefa.status, "pendente");
  assert.match(tarefa.erro, /link do Meet/);
});

test("resposta que não dá para entender vai para a equipe; quem não tem reunião recebe sem_reuniao", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");
  const r = await reunioes.responder({ contatoId: "777", resposta: "posso mudar o horário pra mais tarde?" });
  assert.equal(r.resultado, "humano");
  assert.ok(avisos.some((a) => /Resposta sobre reunião para conferir/.test(a)));
  assert.equal((await registro()).confirmacao, "pendente");

  assert.equal((await reunioes.responder({ contatoId: "999", resposta: "sim" })).resultado, "sem_reuniao");
});

test("aviso repetido do Calendly não duplica os lembretes", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await agendar({}, "2026-11-01T12:00:10Z");
  const avisosMarcados = (await store.todasTarefas()).filter((t) => t.tipo === "reuniao_aviso");
  assert.equal(avisosMarcados.length, 2);
});

test("quem pediu para não receber os avisos da aula recebe os lembretes da reunião que marcou", async () => {
  await agendar({}, "2026-11-01T12:00:00Z");
  await agendamento.processarTarefas();
  await store.criarTarefa({ chave: "sem_avisos:777", tipo: "sem_avisos", dados: { contatoId: "777" } });
  await store.atualizarTarefa((await store.tarefaPorChave("sem_avisos:777")).id, { status: "ok" });
  mc = [];
  await rodarAte("2026-11-08T16:00:00Z");
  assert.deepEqual(fluxos(), [F.vespera]);
});
