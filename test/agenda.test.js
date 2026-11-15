const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

// Lembretes das reuniões marcadas direto na agenda do consultor (Google Agenda, só leitura),
// com Google, Monday, ManyChat e Telegram simulados.
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const chaveJson = {
  type: "service_account",
  client_email: "mani-agenda@teste.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
};

process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.CALENDLY_URL = "https://calendly.com/consultor/reuniao";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";
process.env.MANYCHAT_FLOW_REUNIAO_VESPERA = "content20261028000000_000001";
process.env.MANYCHAT_FLOW_REUNIAO_DIA_CONFIRMAR = "content20261028000000_000002";
process.env.MANYCHAT_FLOW_REUNIAO_DIA_CONFIRMADO = "content20261028000000_000003";
process.env.MANYCHAT_FLOW_REUNIAO_REAGENDADA = "content20261028000000_000004";
process.env.MANYCHAT_FLOW_REUNIAO_CANCELADA = "content20261028000000_000005";
process.env.GOOGLE_AGENDA_CHAVE = Buffer.from(JSON.stringify(chaveJson)).toString("base64");

const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const googleAgenda = require("../src/services/google-agenda.service");
const agendamento = require("../src/services/agendamento.service");
const reunioes = require("../src/services/reunioes.service");
const agenda = require("../src/services/reunioes-agenda.service");
const calendly = require("../src/services/calendly.service");

const F = config.manychat.flowReuniao;
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Map() });

// ---------- simulações ----------
let mc;
let mcExistente = false;
let avisos;
let store;
let google;
let quadro;

manychat.setFetch(async (url, init) => {
  const caminho = new URL(url).pathname;
  const corpo = init.body ? JSON.parse(init.body) : {};
  mc.push({ caminho, corpo });
  if (caminho.endsWith("createSubscriber")) {
    if (mcExistente) return ok({ status: "error", message: "Validation error", details: { messages: { wa_id: { message: ["This WhatsApp ID already exists"] } } } }, 400);
    return ok({ status: "success", data: { id: 888 } });
  }
  return ok({ status: "success", data: {} });
});

telegram.setFetch(async (url, init) => {
  avisos.push(JSON.parse(init.body).text);
  return ok({ ok: true, result: {} });
});

googleAgenda.setFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") {
    google.tokens++;
    const assertion = new URLSearchParams(init.body).get("assertion");
    const [cabecalho, corpo, assinatura] = assertion.split(".");
    const valido = crypto.createVerify("RSA-SHA256").update(`${cabecalho}.${corpo}`).verify(privateKey, assinatura, "base64url");
    assert.ok(valido, "JWT assinado com a chave da conta de serviço");
    assert.equal(JSON.parse(Buffer.from(corpo, "base64url")).scope, "https://www.googleapis.com/auth/calendar.readonly");
    return ok({ access_token: "token-google", expires_in: 3600 });
  }
  assert.equal(init.headers.Authorization, "Bearer token-google");
  assert.ok(u.pathname.includes(encodeURIComponent("consultor@example.com")));
  google.leituras++;
  if (google.falhar) return ok({ error: { message: "Not Found" } }, 404);
  const partes = u.pathname.split("/events/");
  if (partes[1]) {
    const ev = google.eventos.find((e) => e.id === decodeURIComponent(partes[1]));
    return ev ? ok(ev) : ok({ error: { message: "Not Found" } }, 404);
  }
  return ok({ items: google.soLista ? google.soLista() : google.eventos });
});

// Calendly: o evento da Daniela (agendado pelo link geral; o aviso do Calendly não registrou).
let cal;
calendly.setFetch(async (url, init) => {
  const u = new URL(url);
  cal.chamadas.push(`${init.method} ${u.pathname}`);
  if (cal.recusar) return ok({ title: "Permission Denied", message: "You are not allowed to view this event" }, 403);
  if (u.pathname.endsWith("/invitees")) return ok({ collection: cal.convidados });
  if (u.pathname.startsWith("/scheduled_events/")) return ok({ resource: cal.evento });
  return ok({});
});

monday.setFetch(async (url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (query.includes("query Telefones")) {
    const items = quadro.itens.map((i) => ({ id: i.id, name: i.nome, column_values: [{ id: "phonenhzs51c9", phone: i.telefone, text: i.telefone }] }));
    return ok({ data: { boards: [{ items_page: { cursor: null, items } }] } });
  }
  if (query.includes("query PorEmail")) {
    quadro.buscas++;
    const items = quadro.itens
      .filter((i) => i.email === variables.valores[0])
      .map((i) => ({ id: i.id, name: i.nome, column_values: [{ id: "emailhnvgrjbb", email: i.email, text: i.email }, { id: "phonenhzs51c9", phone: i.telefone, text: i.telefone }] }));
    return ok({ data: { items_page_by_column_values: { items } } });
  }
  if (query.includes("columns")) {
    return ok({ data: { boards: [{ columns: [{ id: "etapa", title: "Etapa do Funil", type: "status" }, { id: "fat", title: "Faturamento Mensal", type: "status" }, { id: "prox", title: "Próximo Contato", type: "date" }, { id: "ult", title: "Último Contato", type: "date" }] }] } });
  }
  if (query.includes("create_update")) {
    quadro.comentarios.push(variables.texto);
    return ok({ data: { create_update: { id: "1" } } });
  }
  return ok({ data: {} });
});

function relogio(iso) {
  const agora = new Date(iso);
  agendamento.setRelogio(() => agora);
  reunioes.setRelogio(() => agora);
  return agora;
}

async function rodarAte(iso) {
  const agora = relogio(iso);
  for (const tarefa of await store.todasTarefas()) {
    if (tarefa.status === "pendente" && tarefa.proxima && tarefa.proxima <= agora) {
      await store.atualizarTarefa(tarefa.id, { proxima: null });
    }
  }
  await agendamento.processarTarefas();
}

async function ler(iso) {
  relogio(iso);
  const r = await agenda.sincronizarAgenda(new Date(iso));
  await agendamento.processarTarefas();
  return r;
}

const fluxos = () => mc.filter((c) => c.caminho.endsWith("sendFlow")).map((c) => c.corpo.flow_ns);
const campos = () => Object.fromEntries(mc.filter((c) => c.caminho.endsWith("setCustomFieldByName")).map((c) => [c.corpo.field_name, c.corpo.field_value]));

// Reunião na segunda 09/11 às 14h (Brasília), marcada direto na agenda, com a Bia como convidada.
function evento(mudancas = {}) {
  return {
    id: "gev1",
    status: "confirmed",
    summary: "Diagnóstico - Bia Lima - Consultor Exemplo",
    updated: "2026-11-01T12:00:00.000Z",
    start: { dateTime: "2026-11-09T14:00:00-03:00" },
    end: { dateTime: "2026-11-09T15:00:00-03:00" },
    hangoutLink: "https://meet.google.com/bia-reun-iao",
    attendees: [{ email: "consultor@example.com", self: true, organizer: true }, { email: "Bia@Exemplo.com" }],
    ...mudancas,
  };
}

test.beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
  mc = [];
  avisos = [];
  google = { eventos: [], tokens: 0, leituras: 0, falhar: false };
  quadro = { buscas: 0, comentarios: [], itens: [{ id: "55", nome: "Bia Lima", email: "bia@exemplo.com", telefone: "+5521987654321" }] };
  cal = { chamadas: [], evento: null, convidados: [] };
  mcExistente = false;
});

test("contato antigo do ManyChat (não achado pelo número): o lembrete é pulado e a equipe é avisada uma vez", async () => {
  mcExistente = true;
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), []);
  const alertas = avisos.filter((t) => /Lembrete de reunião não enviado/.test(t));
  assert.equal(alertas.length, 1, "um aviso só, mesmo com dois lembretes pulados");
  assert.match(alertas[0], /Bia Lima/);
  assert.match(alertas[0], /whatsapp_numero/);
});

test("reunião criada direto na agenda, com convidada cadastrada: véspera 13h e dia 8h, com o link do Meet da agenda", async () => {
  google.eventos = [evento()];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.status, "ok");
  assert.equal(r.registradas, 1);
  assert.match(quadro.comentarios[0], /marcada direto na agenda/);

  await rodarAte("2026-11-08T16:00:00Z"); // domingo 13h
  assert.deepEqual(fluxos(), [F.vespera]);
  assert.equal(campos().reuniao_data, "09/11 (segunda-feira)");
  assert.equal(campos().reuniao_hora, "14h");
  assert.equal(campos().reuniao_link, "https://meet.google.com/bia-reun-iao");
  assert.equal(campos().reuniao_reagendar, "https://calendly.com/consultor/reuniao", "sem Calendly: o link geral para marcar outro horário");

  await rodarAte("2026-11-09T11:00:00Z"); // segunda 8h
  assert.deepEqual(fluxos(), [F.vespera, F.diaConfirmar]);
});

test("a leitura repetida não duplica nada e não consulta a Monday de novo", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  const buscas = quadro.buscas;
  const r = await ler("2026-11-01T12:05:00Z");
  assert.equal(r.registradas, 0);
  assert.equal(quadro.buscas, buscas);
  assert.ok(google.tokens <= 1, "o token do Google é reaproveitado");
});

test("compromisso pessoal (convidado fora da Monday): nada sai, sem alerta, e a Monday não é consultada de novo", async () => {
  google.eventos = [evento({ id: "pessoal", attendees: [{ email: "consultor@example.com", self: true }, { email: "dentista@clinica.com" }] })];
  let r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.semCadastro, 1);
  const buscas = quadro.buscas;
  r = await ler("2026-11-01T12:05:00Z");
  assert.equal(quadro.buscas, buscas);
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), []);
  assert.deepEqual(avisos, []);
});

test("ficam de fora: dia inteiro, sem convidado e mentoria de quem não é sorteada (sem alerta)", async () => {
  google.eventos = [
    evento({ id: "m1", summary: "Mentoria Sorteada - Bia Lima" }),
    evento({ id: "d1", start: { date: "2026-11-09" }, end: { date: "2026-11-10" } }),
    evento({ id: "s1", attendees: [] }),
  ];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.registradas, 0);
  assert.equal(r.mentorias, 0);
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), []);
  assert.deepEqual(avisos, []);
});

test("reunião que já veio pelo Calendly (mesma pessoa e horário) não entra de novo pela agenda", async () => {
  await store.criarTarefa({ chave: reunioes.marcaCalendly("bia@exemplo.com", "2026-11-09T17:00:00.000Z"), tipo: "reuniao_marca", dados: {} });
  google.eventos = [evento()];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.registradas, 0);
  assert.equal(r.calendly, 1);
});

test("horário mudado na agenda: sai 'reagendada' e os avisos seguem o novo horário (os antigos não saem)", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");

  google.eventos = [evento({ start: { dateTime: "2026-11-11T15:00:00-03:00" }, end: { dateTime: "2026-11-11T16:00:00-03:00" } })];
  const r = await ler("2026-11-02T12:00:00Z");
  assert.equal(r.remarcadas, 1);
  assert.deepEqual(fluxos(), [F.reagendada]);
  assert.equal(campos().reuniao_data, "11/11 (quarta-feira)");

  mc = [];
  await rodarAte("2026-11-08T16:00:00Z"); // véspera do horário antigo: não sai
  assert.deepEqual(fluxos(), []);
  await rodarAte("2026-11-10T16:00:00Z"); // véspera do novo (terça 13h)
  assert.deepEqual(fluxos(), [F.vespera]);
});

test("evento apagado da agenda: os avisos param e sai 'cancelada'", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");

  // O Google devolve o evento apagado com status "cancelled" (a leitura usa showDeleted).
  google.eventos = [evento({ status: "cancelled" })];
  const r = await ler("2026-11-02T12:00:00Z");
  assert.equal(r.canceladas, 1);
  assert.deepEqual(fluxos(), [F.cancelada]);

  mc = [];
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), []);
});

test("'Não posso': link geral do Calendly e aviso para apagar o horário antigo na agenda", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");

  const r = await reunioes.responder({ contatoId: "888", resposta: "Não posso" });
  assert.equal(r.resultado, "reagendar");
  assert.equal(r.reuniao_reagendar, "https://calendly.com/consultor/reuniao");
  await agendamento.processarTarefas();
  assert.ok(avisos.some((t) => /apague o horário antigo na agenda/.test(t)));
});

test("'Não quero reagendar': a equipe cancela na agenda; quando o evento some, sai 'cancelada'", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-08T16:00:00Z");
  await reunioes.responder({ contatoId: "888", resposta: "Não posso" });

  const r = await reunioes.responder({ contatoId: "888", resposta: "Não quero reagendar" });
  assert.equal(r.resultado, "falha");
  assert.ok(avisos.some((t) => /cancele o evento na agenda do consultor/.test(t)));

  mc = [];
  google.eventos = [evento({ status: "cancelled" })];
  await ler("2026-11-08T18:00:00Z");
  assert.deepEqual(fluxos(), [F.cancelada]);
});

test("leitura da agenda falhando: avisa só na 2ª falha seguida, uma vez, e avisa quando volta", async () => {
  agenda.reiniciarAlertas();
  google.falhar = true;
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.status, "falhou");
  assert.match(r.erro, /compartilhada com mani-agenda@teste/);
  assert.equal(avisos.length, 0, "uma falha só (oscilação) não avisa");
  await ler("2026-11-01T12:05:00Z");
  await ler("2026-11-01T12:10:00Z");
  assert.equal(avisos.filter((t) => /Não consegui ler a agenda do consultor/.test(t)).length, 1, "avisa uma vez");

  google.falhar = false;
  await ler("2026-11-01T12:15:00Z");
  assert.ok(avisos.some((t) => /Voltei a ler a agenda do consultor/.test(t)));
  await ler("2026-11-01T12:20:00Z");
  assert.equal(avisos.filter((t) => /Voltei/.test(t)).length, 1, "o 'voltou' sai uma vez");
});

test("uma falha isolada seguida de leitura normal: nenhum aviso", async () => {
  agenda.reiniciarAlertas();
  google.falhar = true;
  await ler("2026-11-01T12:00:00Z");
  google.falhar = false;
  await ler("2026-11-01T12:05:00Z");
  assert.equal(avisos.length, 0);
});

test("ID de evento muito longo (convite vindo de outro calendário): a chave fica curta e a reunião entra", async () => {
  const longo = `${"a1b2c3d4".repeat(40)}_20261109T170000Z`;
  google.eventos = [evento({ id: longo })];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.registradas, 1);
  assert.equal(r.erros, 0);
  const chaves = (await store.todasTarefas()).map((t) => t.chave);
  assert.ok(chaves.every((c) => c.length <= 190), "nenhuma chave passa do tamanho da coluna do banco");

  google.eventos = [];
  assert.equal((await ler("2026-11-02T12:00:00Z")).canceladas, 1, "sumiu da agenda: cancelada pelo ID inteiro");
});

test("qualquer título entra nos lembretes comerciais quando a pessoa está na Monday", async () => {
  google.eventos = [
    evento({ id: "a1", summary: "Reunião com a Bia" }),
    evento({ id: "a2", summary: "Café", attendees: [{ email: "dentista@clinica.com" }] }),
  ];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.registradas, 1);
  assert.equal(r.semCadastro, 1);
});

test("acha a pessoa pelo telefone da descrição mesmo com outro e-mail", async () => {
  google.eventos = [evento({ attendees: [{ email: "outro@gmail.com" }], description: "Seu WhatsApp com DDD: (21) 98765-4321" })];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.registradas, 1);
  await rodarAte("2026-11-08T16:00:00Z");
  assert.deepEqual(fluxos(), [F.vespera]);
});

// Caso de 05/11/2026: agendou pelo link geral do Calendly e o aviso foi ignorado
// (CALENDLY_EVENTO_NOME com o nome antigo do evento). A agenda recupera a reunião.
const URI_DANIELA = "https://api.calendly.com/scheduled_events/00000000-0000-4000-8000-000000000001";

function eventoDoCalendly(mudancas = {}) {
  return evento({
    id: "gcal-daniela",
    summary: "Diagnóstico -Daniela Fontes -Consultor Exemplo",
    attendees: [{ email: "consultor@example.com", self: true, organizer: true }, { email: "daniela@exemplo.com" }],
    description: [
      "Nome do evento",
      "Reunião com o Consultor - Diagnóstico",
      "https://calendly.com/events/00000000-0000-4000-8000-000000000001/google_meet",
      "Seu WhatsApp com DDD: 51999001234",
      "Cancelar: https://calendly.com/cancellations/inv1",
    ].join("\n"),
    ...mudancas,
  });
}

function prepararDaniela() {
  quadro.itens.push({ id: "77", nome: "Daniela Fontes", email: "daniela@exemplo.com", telefone: "+5551999001234" });
  cal.evento = {
    uri: URI_DANIELA,
    name: "Reunião com o Consultor - Diagnóstico",
    status: "active",
    start_time: "2026-11-09T17:00:00.000Z",
    end_time: "2026-11-09T18:00:00.000Z",
    location: { join_url: "https://meet.google.com/vyi-ewyi-ujy" },
  };
  cal.convidados = [
    {
      uri: `${URI_DANIELA}/invitees/inv1`,
      name: "Daniela Fontes",
      email: "daniela@exemplo.com",
      questions_and_answers: [{ question: "Seu WhatsApp com DDD", answer: "51999001234" }],
      reschedule_url: "https://calendly.com/reschedulings/inv1",
      cancel_url: "https://calendly.com/cancellations/inv1",
    },
  ];
}

test("evento do Calendly que o aviso não registrou: a agenda recupera, com os links do Calendly, e avisa a equipe", async () => {
  prepararDaniela();
  google.eventos = [eventoDoCalendly()];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.recuperadas, 1);
  assert.ok(avisos.some((t) => /Reunião recuperada pela agenda/.test(t) && /Daniela/.test(t)));

  const registro = await store.tarefaPorChave(reunioes.chaveRegistro(URI_DANIELA));
  assert.ok(registro, "registrada com a mesma chave do aviso do Calendly");
  assert.equal(registro.dados.reagendar, "https://calendly.com/reschedulings/inv1");
  assert.equal(registro.dados.telefone, "+5551999001234");

  // Leitura seguinte: não chama o Calendly de novo nem duplica.
  const chamadas = cal.chamadas.length;
  const r2 = await ler("2026-11-01T12:05:00Z");
  assert.equal(r2.recuperadas, 0);
  assert.equal(cal.chamadas.length, chamadas);

  // O aviso do Calendly chegando depois não cria outra reunião.
  const dup = await reunioes.registrarAgendamento({ ...cal.convidados[0], scheduled_event: cal.evento });
  assert.equal(dup.duplicado, true);

  mc = [];
  await rodarAte("2026-11-08T16:00:00Z");
  assert.deepEqual(fluxos(), [F.vespera]);
  assert.equal(campos().reuniao_reagendar, "https://calendly.com/reschedulings/inv1");
});

test("evento do Calendly recém-criado: espera 10 minutos pelo aviso antes de recuperar", async () => {
  prepararDaniela();
  google.eventos = [eventoDoCalendly({ created: "2026-11-01T11:55:00.000Z" })];
  let r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.recuperadas, 0);
  assert.deepEqual(cal.chamadas, []);
  assert.deepEqual(avisos, []);

  r = await ler("2026-11-01T12:06:00Z");
  assert.equal(r.recuperadas, 1, "11 minutos depois, sem aviso do Calendly: recupera");
});

test("evento do Calendly já registrado pelo aviso: a agenda nem consulta o Calendly", async () => {
  prepararDaniela();
  await reunioes.registrarAgendamento({ ...cal.convidados[0], scheduled_event: cal.evento });
  google.eventos = [eventoDoCalendly()];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.recuperadas, 0);
  assert.equal(r.calendly, 1);
  assert.deepEqual(cal.chamadas, []);
});

test("evento do Calendly de quem não está na Monday: nada sai, sem alerta, e não consulta de novo", async () => {
  prepararDaniela();
  quadro.itens = quadro.itens.filter((i) => i.id !== "77");
  google.eventos = [eventoDoCalendly()];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.semCadastro, 1);
  assert.deepEqual(avisos, []);
  const chamadas = cal.chamadas.length;
  await ler("2026-11-01T12:05:00Z");
  assert.equal(cal.chamadas.length, chamadas);
});

test("mentoria na agenda de uma sorteada que não agendou: liga à sorteada, fora dos lembretes comerciais", async () => {
  const insc = await store.inscreverMentoria({ rodada: "2026-10-27", mondayItemId: "55", nome: "Bia Lima", telefone: "+5521987654321", email: "bia@exemplo.com" });
  await store.atualizarInscricaoMentoria(insc.id, { sorteada: true, agendamento: "pendente" });
  google.eventos = [evento({ id: "m2", summary: "Mentoria Sorteada - Bia Lima" })];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.mentorias, 1);
  assert.equal(r.registradas, 0);
  const atual = await store.inscricaoMentoria(insc.id);
  assert.equal(atual.agendamento, "agendada");
  assert.equal(new Date(atual.mentoriaEm).toISOString(), "2026-11-09T17:00:00.000Z");
});

test("link do Calendly de outra conta (403): não é reunião nossa; marca como conferido e não tenta de novo", async () => {
  google.eventos = [eventoDoCalendly({ id: "gcal-outra-conta" })];
  cal.recusar = true;
  try {
    const r = await ler("2026-11-01T12:00:00Z");
    assert.equal(r.erros, 0);
    assert.equal(r.calendly, 1);
    const chamadas = cal.chamadas.length;
    const r2 = await ler("2026-11-01T12:05:00Z");
    assert.equal(r2.erros, 0);
    assert.equal(cal.chamadas.length, chamadas, "na leitura seguinte, não chama o Calendly de novo");
    assert.equal(avisos.length, 0, "sem aviso para a equipe");
  } finally {
    cal.recusar = false;
  }
});

test("reunião que some sem ser apagada (404): cancela sem mensagem para a pessoa e avisa a equipe", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");

  google.eventos = []; // não aparece mais nem como apagado
  const r = await ler("2026-11-02T12:00:00Z");
  assert.equal(r.canceladas, 1);
  await agendamento.processarTarefas();
  assert.deepEqual(fluxos(), [], "sem 'cancelada' para a pessoa");
  assert.ok(avisos.some((t) => /Reunião saiu da agenda do consultor/.test(t) && /Bia Lima/.test(t)));

  mc = [];
  await rodarAte("2026-11-09T11:00:00Z");
  assert.deepEqual(fluxos(), [], "os lembretes não saem");
});

test("sessão que se repete (ex.: Consultoria toda segunda): ocorrência cancelada pela mudança da série não manda 'cancelada'", async () => {
  const ocorrencia = { id: "serie1_20261109T170000Z", recurringEventId: "serie1", summary: "Consultoria - Bia" };
  google.eventos = [evento(ocorrencia)];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ ...ocorrencia, status: "cancelled" })];
  await ler("2026-11-02T12:00:00Z");
  await agendamento.processarTarefas();
  assert.deepEqual(fluxos(), []);
  assert.ok(avisos.some((t) => /Reunião saiu da agenda do consultor/.test(t)));
});

test("reunião ativa fora do índice (perdido no deploy) também é conferida", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  const indice = await store.tarefaPorChave("reuniao_agenda_indice");
  await store.atualizarTarefa(indice.id, { dados: { eventos: [] } }); // índice perdeu a reunião
  google.eventos = [];
  const r = await ler("2026-11-02T12:00:00Z");
  assert.equal(r.canceladas, 1, "achou pela lista de reuniões ativas");
});

test("caso Beatriz (09/11): código antigo aponta para a sessão de outro dia, que já tem registro próprio — sai em silêncio, sem 'reagendada' nem lembrete em dobro", async () => {
  // Registrada pelo código antigo, para 09/11.
  google.eventos = [evento({ id: "antigo" })];
  await ler("2026-11-01T12:00:00Z");
  // A série mudou: a leitura traz a sessão de 13/11 com OUTRO código; o código antigo,
  // aberto direto, também aponta para 13/11.
  const sessao13 = { start: { dateTime: "2026-11-13T14:30:00-03:00" }, end: { dateTime: "2026-11-13T15:00:00-03:00" }, recurringEventId: "serie" };
  google.eventos = [evento({ id: "serie_20261113T173000Z", ...sessao13 })];
  const obter = google.eventos[0];
  google.eventos.push({ ...obter, id: "antigo" }); // só para o obterEvento achar
  const listar = () => [obter];
  const original = google.eventos;
  // A leitura (lista) não traz o "antigo"; o obterEvento traz.
  google.eventos = original;
  google.soLista = listar;
  const r = await ler("2026-11-09T12:00:00Z");
  delete google.soLista;
  await agendamento.processarTarefas();
  assert.equal(r.remarcadas, 0);
  assert.ok(!mc.some((c) => c.corpo?.flow_ns === F.reagendada), "sem 'reagendada'");
  const antigo = await store.tarefaPorChave(`reuniao:agenda:${require("crypto").createHash("sha1").update("antigo").digest("hex").slice(0, 24)}`);
  assert.equal(antigo.dados.situacao, "cancelada");
  assert.ok(avisos.some((t) => /Reunião saiu da agenda do consultor/.test(t)));
});

test("registro antigo (chave longa, de antes de 03/11) também é conferido e sai em silêncio", async () => {
  await store.criarTarefa({
    chave: "reuniao:agenda:_codigo_longo_antigo",
    tipo: "reuniao_registro",
    dados: { origem: "agenda", googleId: "_codigo_longo_antigo", evento: "agenda:_codigo_longo_antigo", nome: "Beatriz", telefone: "+5511900004566", inicio: "2026-11-09T17:30:00.000Z", situacao: "ativa", confirmacao: "pendente", enviados: [] },
  });
  // O código antigo, aberto direto, aponta para a sessão de 13/11 (que tem registro próprio).
  google.eventos = [evento({ id: "_codigo_longo_antigo", start: { dateTime: "2026-11-13T14:30:00-03:00" }, recurringEventId: "serie" })];
  google.soLista = () => [];
  const r = await ler("2026-11-09T12:00:00Z");
  delete google.soLista;
  await agendamento.processarTarefas();
  assert.equal(r.canceladas, 1);
  assert.equal(r.remarcadas, 0);
  assert.equal((await store.tarefaPorChave("reuniao:agenda:_codigo_longo_antigo")).dados.situacao, "cancelada");
  assert.ok(!mc.some((c) => c.corpo?.flow_ns === F.reagendada));
  assert.ok(avisos.some((t) => /Reunião saiu da agenda do consultor/.test(t) && /Beatriz/.test(t)));
});

// ---------- v2.17.0: convidado trocado e reunião sem lembrete ----------

test("Consultor reaproveita o evento para outra pessoa: os lembretes passam para a pessoa nova e a equipe é avisada", async () => {
  quadro.itens.push({ id: "66", nome: "Carla Souza", email: "carla@exemplo.com", telefone: "+5511977776666" });
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");

  google.eventos = [evento({ summary: "Diagnóstico - Carla", updated: "2026-11-02T12:00:00.000Z", attendees: [{ email: "consultor@example.com", self: true, organizer: true }, { email: "carla@exemplo.com" }] })];
  const r = await ler("2026-11-02T12:00:00Z");
  assert.equal(r.trocadas, 1);
  const registro = await store.tarefaPorChave("reuniao:agenda:" + require("crypto").createHash("sha1").update("gev1").digest("hex").slice(0, 24));
  assert.equal(registro.dados.nome, "Carla Souza");
  assert.equal(registro.dados.telefone, "+5511977776666");
  assert.ok(avisos.some((t) => /Convidado trocado/.test(t) && /Era: Bia Lima/.test(t) && /Agora: Carla Souza/.test(t)));

  mc = [];
  await rodarAte("2026-11-08T16:00:00Z"); // véspera 13h
  assert.deepEqual(fluxos(), [F.vespera], "um lembrete só, para a pessoa nova");
  const criados = mc.filter((c) => c.caminho.endsWith("createSubscriber")).map((c) => c.corpo.whatsapp_phone);
  assert.ok(!criados.includes("+5521987654321"), "nada para a Bia");

  // Ler de novo não troca outra vez nem repete o aviso.
  const r2 = await ler("2026-11-08T17:00:00Z");
  assert.ok(!r2.trocadas);
  assert.equal(avisos.filter((t) => /Convidado trocado/.test(t)).length, 1);
});

test("convidado trocado por alguém que não está na Monday: o registro sai em silêncio", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ updated: "2026-11-02T12:00:00.000Z", attendees: [{ email: "consultor@example.com", self: true, organizer: true }, { email: "amigo@pessoal.com" }] })];
  const r = await ler("2026-11-02T12:00:00Z");
  assert.equal(r.canceladas, 1);
  assert.deepEqual(fluxos(), [], "sem 'cancelada' para a Bia");
  assert.ok(avisos.some((t) => /Reunião saiu da agenda do consultor/.test(t)));
});

test("reunião marcada em cima da hora (sem tempo para lembrete): a equipe é avisada, uma vez", async () => {
  // Segunda 09/11, 13h (Brasília) marca para as 14h do mesmo dia.
  google.eventos = [evento()];
  const r = await ler("2026-11-09T16:00:00Z");
  assert.equal(r.registradas, 1);
  assert.equal(avisos.filter((t) => /Reunião sem lembrete/.test(t) && /Bia Lima/.test(t)).length, 1);
  await ler("2026-11-09T16:05:00Z");
  assert.equal(avisos.filter((t) => /Reunião sem lembrete/.test(t)).length, 1);
});

test("reunião marcada com tempo para o lembrete: sem aviso de 'sem lembrete'", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  assert.ok(!avisos.some((t) => /Reunião sem lembrete/.test(t)));
});

test("cancelada pela pessoa (Não quero reagendar) com o evento ainda na agenda: não volta a valer", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  const k = "reuniao:agenda:" + require("crypto").createHash("sha1").update("gev1").digest("hex").slice(0, 24);
  const r0 = await store.tarefaPorChave(k);
  await store.atualizarTarefa(r0.id, { dados: { ...r0.dados, situacao: "cancelada", mensagemCancelamento: true } });
  avisos.length = 0;
  await ler("2026-11-02T12:00:00Z");
  assert.equal((await store.tarefaPorChave(k)).dados.situacao, "cancelada");
  assert.ok(!avisos.some((t) => /de volta à agenda/.test(t)));
  mc = [];
  await rodarAte("2026-11-08T16:00:00Z");
  assert.deepEqual(fluxos(), []);
});

// ---------- v2.18.0: revisão final ----------

test("telefone da descrição: formatos antigos e novos; o texto do Google Meet não conta", () => {
  const ler = (description) => agenda.telefonesDaDescricao({ description });
  for (const f of ["51-9-9900-1234", "51 99 900 1234", "(51) 9.9900.1234", "51 999 001 234", "51 9 99 00 12 34"]) {
    assert.deepEqual(ler(`WhatsApp: ${f}`), ["+5551999001234"], f);
  }
  assert.deepEqual(ler("<b>WhatsApp:</b> 21 98765-4321"), ["+5521987654321"]);
  assert.deepEqual(ler("Telefone:\n(21) 98765-4321"), ["+5521987654321"]);
  assert.deepEqual(ler('Contato: <a href="tel:+5521987654321">ligar</a>'), ["+5521987654321"]);
  assert.deepEqual(ler("WhatsApp: 21 98765-4321 (depois das 18:30)"), ["+5521987654321"]);
  const meet = "Entrar com o Google Meet\nmeet.google.com/dme-asix-xun\nParticipar por telefone\n(BR) +55 21 4560-7276 PIN: 535 534 572#\nMais números de telefone: https://tel.meet/dme-asix-xun?pin=5355345720";
  assert.deepEqual(ler(meet), []);
  assert.deepEqual(ler(`${meet}\nWhatsApp: 21 98765-4321`), ["+5521987654321"]);
});

test("mesma pessoa achada de outro jeito (telefone tirado da descrição): sem troca, sem lembrete repetido, sem aviso", async () => {
  google.eventos = [evento({ description: "WhatsApp: 21 98765-4321" })];
  await ler("2026-11-01T12:00:00Z");
  mc = [];
  await rodarAte("2026-11-09T11:00:00Z"); // véspera e dia saem para a Bia
  const enviados = fluxos().length;
  google.eventos = [evento({ description: "", updated: "2026-11-09T11:30:00.000Z" })]; // continua convidada por e-mail
  const r = await ler("2026-11-09T11:30:00Z");
  assert.ok(!r.trocadas);
  mc = [];
  await rodarAte("2026-11-09T16:00:00Z");
  assert.deepEqual(fluxos(), [], "nada repetido");
  assert.ok(!avisos.some((t) => /Convidado trocado/.test(t)));
  assert.ok(enviados >= 1);
});

test("apagada, desfeita e apagada de novo: o 'cancelada' sai de novo", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ status: "cancelled" })];
  await ler("2026-11-02T12:00:00Z");
  google.eventos = [evento({ updated: "2026-11-03T12:00:00.000Z" })];
  await ler("2026-11-03T12:00:00Z");
  assert.ok(avisos.some((t) => /de volta à agenda/.test(t) && /avise que a reunião continua/.test(t)));
  google.eventos = [evento({ status: "cancelled", updated: "2026-11-04T12:00:00.000Z" })];
  await ler("2026-11-04T12:00:00Z");
  assert.deepEqual(fluxos().filter((f) => f === F.cancelada).length, 2);
});

test("movida para o passado e de volta para o futuro: volta a valer", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ start: { dateTime: "2026-11-01T08:00:00-03:00" }, end: { dateTime: "2026-11-01T09:00:00-03:00" }, updated: "2026-11-01T13:00:00.000Z" })];
  await ler("2026-11-01T13:00:00Z");
  google.eventos = [evento({ updated: "2026-11-01T14:00:00.000Z" })];
  await ler("2026-11-01T14:00:00Z");
  assert.ok(avisos.some((t) => /de volta à agenda/.test(t) && !/avise que a reunião continua/.test(t)));
  mc = [];
  await rodarAte("2026-11-08T16:00:00Z");
  assert.deepEqual(fluxos(), [F.vespera]);
});
