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

const agendaDia = require("../src/services/agenda-dia.service");

// ---------- QA adversarial harness ----------
const PESSOAS = {
  bia: { id: "55", nome: "Bia Lima", email: "bia@exemplo.com", telefone: "+5521987654321", mc: "1001" },
  carla: { id: "66", nome: "Carla Souza", email: "carla@exemplo.com", telefone: "+5511977776666", mc: "1002" },
  duda: { id: "88", nome: "Duda Sem Fone", email: "duda@exemplo.com", telefone: "3333", mc: "1003" },
};
const porMc = Object.fromEntries(Object.entries(PESSOAS).map(([k, p]) => [p.mc, k]));
const porFone = Object.fromEntries(Object.values(PESSOAS).map((p) => [p.telefone, p.mc]));

let mc, avisos, store, google, quadro;

manychat.setFetch(async (url, init) => {
  const caminho = new URL(url).pathname;
  const corpo = init.body ? JSON.parse(init.body) : {};
  mc.push({ caminho, corpo });
  if (caminho.endsWith("createSubscriber")) return ok({ status: "success", data: { id: Number(porFone[corpo.whatsapp_phone] || 9999) } });
  return ok({ status: "success", data: {} });
});
telegram.setFetch(async (url, init) => {
  avisos.push(JSON.parse(init.body).text);
  return ok({ ok: true, result: {} });
});
googleAgenda.setFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return ok({ access_token: "token-google", expires_in: 3600 });
  const partes = u.pathname.split("/events/");
  if (partes[1]) {
    const id = decodeURIComponent(partes[1]);
    const ev = (google.obter || google.eventos).find((e) => e.id === id);
    return ev ? ok(ev) : ok({ error: { message: "Not Found" } }, 404);
  }
  // Simula o filtro do Google: timeMin compara com o FIM, timeMax com o início.
  const de = new Date(u.searchParams.get("timeMin"));
  const ate = new Date(u.searchParams.get("timeMax"));
  const items = google.eventos.filter((e) => {
    const ini = new Date(e.start.dateTime || `${e.start.date}T00:00:00-03:00`);
    const fim = new Date(e.end?.dateTime || (e.end?.date ? `${e.end.date}T00:00:00-03:00` : ini));
    return fim > de && ini < ate;
  });
  return ok({ items });
});
calendly.setFetch(async () => ok({}));

function instalarMonday() {
  monday.setFetch(async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("query Telefones")) {
      const items = quadro.itens.map((i) => ({ id: i.id, name: i.nome, column_values: [{ id: "phonenhzs51c9", phone: i.telefone, text: i.telefone }] }));
      return ok({ data: { boards: [{ items_page: { cursor: null, items } }] } });
    }
    if (query.includes("query PorEmail")) {
      const items = quadro.itens
        .filter((i) => i.email === variables.valores[0])
        .map((i) => ({ id: i.id, name: i.nome, column_values: [{ id: "emailhnvgrjbb", email: i.email, text: i.email }, { id: "phonenhzs51c9", phone: i.telefone, text: i.telefone }] }));
      return ok({ data: { items_page_by_column_values: { items } } });
    }
    if (query.includes("columns")) return ok({ data: { boards: [{ columns: [] }] } });
    if (query.includes("create_update")) return ok({ data: { create_update: { id: "1" } } });
    return ok({ data: {} });
  });
}

function relogio(iso) {
  const agora = new Date(iso);
  agendamento.setRelogio(() => agora);
  reunioes.setRelogio(() => agora);
  return agora;
}
// Avança o relógio tarefa a tarefa (cada uma roda no seu próprio horário), até `iso`.
async function rodarAte(iso) {
  const alvo = new Date(iso);
  for (let i = 0; i < 200; i++) {
    const pend = (await store.todasTarefas()).filter((t) => t.status === "pendente" && t.proxima && t.proxima <= alvo).sort((a, b) => a.proxima - b.proxima);
    if (!pend.length) break;
    relogio(pend[0].proxima.toISOString());
    await agendamento.processarTarefas();
  }
  relogio(iso);
  await agendamento.processarTarefas();
}
async function ler(iso) {
  relogio(iso);
  const r = await agenda.sincronizarAgenda(new Date(iso));
  await agendamento.processarTarefas();
  return r;
}
// Mensagens enviadas: [{quem, fluxo, hora, data}] (campos definidos logo antes do sendFlow).
function enviados() {
  const out = [];
  let camposAtuais = {};
  for (const c of mc) {
    if (c.caminho.endsWith("setCustomFieldByName")) camposAtuais[c.corpo.field_name] = c.corpo.field_value;
    if (c.caminho.endsWith("sendFlow")) {
      const nome = Object.entries(F).find(([, v]) => v === c.corpo.flow_ns)?.[0];
      out.push({ quem: porMc[String(c.corpo.subscriber_id)] || String(c.corpo.subscriber_id), fluxo: nome, data: camposAtuais.reuniao_data, hora: camposAtuais.reuniao_hora });
      camposAtuais = {};
    }
  }
  return out;
}
const resumo = () => enviados().map((e) => `${e.quem}:${e.fluxo}:${e.hora}`);
const alertas = (re) => avisos.filter((t) => re.test(t));
const ATT = (...emails) => [{ email: "consultor@example.com", self: true, organizer: true }, ...emails.map((email) => ({ email }))];

// Reunião base: quarta 11/11 14h (17Z), com a Bia.
function evento(m = {}) {
  return {
    id: "gev1",
    status: "confirmed",
    summary: "Diagnóstico",
    updated: "2026-11-01T12:00:00.000Z",
    start: { dateTime: "2026-11-11T14:00:00-03:00" },
    end: { dateTime: "2026-11-11T15:00:00-03:00" },
    hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
    attendees: ATT("bia@exemplo.com"),
    ...m,
  };
}
const em = (diaHora, dur = 60) => {
  const ini = new Date(diaHora);
  return { start: { dateTime: diaHora }, end: { dateTime: new Date(ini.getTime() + dur * 60000).toISOString() } };
};
const registroDe = async (id) => store.tarefaPorChave("reuniao:agenda:" + crypto.createHash("sha1").update(id).digest("hex").slice(0, 24));

test.beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
  mc = [];
  avisos = [];
  google = { eventos: [] };
  quadro = { itens: Object.values(PESSOAS).map((p) => ({ ...p })) };
  instalarMonday();
  agenda.reiniciarAlertas();
});

// ===================== CENÁRIOS =====================

test("S01 editado 3 vezes em 10 min: uma 'reagendada' por edição vista, lembretes só do último horário", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento(em("2026-11-11T15:00:00-03:00"))];
  await ler("2026-11-01T12:05:00Z");
  google.eventos = [evento(em("2026-11-11T16:00:00-03:00"))];
  await ler("2026-11-01T12:10:00Z");
  google.eventos = [evento(em("2026-11-11T17:00:00-03:00"))];
  await ler("2026-11-01T12:15:00Z");
  await rodarAte("2026-11-10T16:00:00Z");
  await rodarAte("2026-11-11T11:00:00Z");
  await rodarAte("2026-11-11T23:00:00Z");
  const r = resumo();
  assert.deepEqual(r.filter((x) => /reagendada/.test(x)), ["bia:reagendada:15h", "bia:reagendada:16h", "bia:reagendada:17h"]);
  assert.deepEqual(r.filter((x) => !/reagendada/.test(x)), ["bia:vespera:17h", "bia:diaConfirmar:17h"]);
});

test("S02 A→B→A→B: a pessoa precisa saber do último horário (B)", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento(em("2026-11-12T10:00:00-03:00"))]; // B
  await ler("2026-11-02T12:00:00Z");
  google.eventos = [evento()]; // A
  await ler("2026-11-03T12:00:00Z");
  google.eventos = [evento(em("2026-11-12T10:00:00-03:00"))]; // B de novo
  await ler("2026-11-04T12:00:00Z");
  const reag = enviados().filter((e) => e.fluxo === "reagendada").map((e) => e.data + " " + e.hora);
  assert.equal(reag.length, 3, `reagendadas enviadas: ${JSON.stringify(reag)}`);
  assert.equal(reag.at(-1), "12/11 (quinta-feira) 10h");
});

test("S03 convidado trocado Bia→Carla→Bia: Bia consegue confirmar com 'Sim'", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-10T16:00:00Z"); // véspera para a Bia (contato 1001)
  assert.deepEqual(resumo(), ["bia:vespera:14h"]);
  google.eventos = [evento({ attendees: ATT("carla@exemplo.com"), updated: "2026-11-10T17:00:00Z" })];
  await ler("2026-11-10T17:00:00Z");
  google.eventos = [evento({ attendees: ATT("bia@exemplo.com"), updated: "2026-11-10T18:00:00Z" })];
  await ler("2026-11-10T18:00:00Z");
  assert.equal((await registroDe("gev1")).dados.nome, "Bia Lima");
  const r = await reunioes.responder({ contatoId: "1001", resposta: "Sim" });
  assert.equal(r.resultado, "confirmado", "Bia voltou a ser a convidada e deveria poder confirmar");
});

test("S04 mesma pessoa, duas reuniões no mesmo dia: cada uma tem os seus lembretes", async () => {
  google.eventos = [evento({ id: "m10", ...em("2026-11-11T10:00:00-03:00") }), evento({ id: "m16", ...em("2026-11-11T16:00:00-03:00") })];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-10T16:00:00Z");
  await rodarAte("2026-11-11T11:00:00Z");
  assert.deepEqual(resumo().sort(), ["bia:diaConfirmar:10h", "bia:diaConfirmar:16h", "bia:vespera:10h", "bia:vespera:16h"]);
});

test("S05 Consultor cria o horário na agenda ANTES de a pessoa marcar o mesmo horário no Calendly: um lembrete só", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  relogio("2026-11-01T12:30:00Z");
  await reunioes.registrarAgendamento({
    uri: "https://api.calendly.com/scheduled_events/cal1/invitees/i1",
    name: "Bia Lima",
    email: "bia@exemplo.com",
    text_reminder_number: "+5521987654321",
    reschedule_url: "https://calendly.com/reschedulings/i1",
    scheduled_event: { uri: "https://api.calendly.com/scheduled_events/cal1", start_time: "2026-11-11T17:00:00.000Z", end_time: "2026-11-11T18:00:00.000Z", location: { join_url: "https://meet.google.com/cal" } },
  });
  await ler("2026-11-01T12:35:00Z");
  await rodarAte("2026-11-10T16:00:00Z");
  assert.deepEqual(resumo(), ["bia:vespera:14h"], "mesma pessoa, mesmo horário: não pode sair em dobro");
});

test("S06 Calendly primeiro, depois Consultor cria o mesmo horário; Calendly cancela: 'cancelada' uma vez e nada mais", async () => {
  relogio("2026-11-01T12:00:00Z");
  const se = { uri: "https://api.calendly.com/scheduled_events/cal2", start_time: "2026-11-11T17:00:00.000Z", end_time: "2026-11-11T18:00:00.000Z", location: { join_url: "https://meet.google.com/cal" } };
  await reunioes.registrarAgendamento({ uri: `${se.uri}/invitees/i2`, name: "Bia Lima", email: "bia@exemplo.com", text_reminder_number: "+5521987654321", scheduled_event: se });
  google.eventos = [evento({ id: "manual" })];
  const r = await ler("2026-11-01T12:10:00Z");
  assert.equal(r.registradas, 0);
  relogio("2026-11-02T12:00:00Z");
  await reunioes.registrarCancelamento({ scheduled_event: se });
  await agendamento.processarTarefas();
  await ler("2026-11-02T12:05:00Z");
  await rodarAte("2026-11-10T16:00:00Z");
  await rodarAte("2026-11-11T11:00:00Z");
  assert.deepEqual(resumo(), ["bia:cancelada:14h"]);
});

test("S07 reunião às 00h30 e às 23h30: nenhum aviso depois do início, no máximo 2 por reunião", async () => {
  google.eventos = [evento({ id: "cedo", ...em("2026-11-11T00:30:00-03:00") }), evento({ id: "tarde", ...em("2026-11-11T23:30:00-03:00") })];
  await ler("2026-11-01T12:00:00Z");
  const tarefas = (await store.todasTarefas()).filter((t) => t.tipo === "reuniao_aviso");
  for (const t of tarefas) assert.ok(t.proxima.getTime() <= new Date(t.dados.inicio).getTime() - 2 * 3600000, `aviso ${t.chave} < 2h antes`);
  await rodarAte("2026-11-12T12:00:00Z");
  const r = resumo();
  assert.equal(r.filter((x) => x.endsWith(":0h30")).length, 2, r.join());
  assert.equal(r.filter((x) => x.endsWith(":23h30")).length, 2, r.join());
});

test("S08 movida de amanhã para hoje depois das 8h: 'reagendada' + um lembrete do dia, nada do horário antigo", async () => {
  google.eventos = [evento()]; // qua 14h
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento(em("2026-11-10T16:00:00-03:00"))]; // ter 16h, mudado ter 9h
  await ler("2026-11-10T12:00:00Z");
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), ["bia:reagendada:16h", "bia:diaConfirmar:16h"]);
});

test("S09 véspera já enviada e reunião antecipada para cedo no dia seguinte", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-10T16:00:00Z");
  google.eventos = [evento(em("2026-11-11T09:00:00-03:00"))];
  await ler("2026-11-10T18:00:00Z");
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), ["bia:vespera:14h", "bia:reagendada:9h", "bia:diaConfirmar:9h"]);
});

test("S10 movida para mais de 30 dias e de volta", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento(em("2026-12-20T14:00:00-03:00"))];
  const r1 = await ler("2026-11-02T12:00:00Z");
  assert.equal(r1.remarcadas, 1);
  google.eventos = [evento()];
  const r2 = await ler("2026-11-03T12:00:00Z");
  assert.equal(r2.remarcadas, 1);
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), ["bia:reagendada:14h", "bia:reagendada:14h", "bia:vespera:14h", "bia:diaConfirmar:14h"]);
  assert.equal(enviados()[0].data, "20/12 (domingo)");
});

test("S11 série editada 'esta e as seguintes': ocorrência antiga sai em silêncio, nova entra, sem duplicar", async () => {
  const o1 = evento({ id: "serie1_20261111T170000Z", recurringEventId: "serie1" });
  const o2 = evento({ id: "serie1_20261118T170000Z", recurringEventId: "serie1", ...em("2026-11-18T14:00:00-03:00") });
  google.eventos = [o1, o2];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-12T00:00:00Z");
  mc = [];
  // 12/11: "esta e as seguintes" a partir de 18/11 -> 15h, nova série.
  const n2 = evento({ id: "serie2_20261118T180000Z", recurringEventId: "serie2", ...em("2026-11-18T15:00:00-03:00") });
  google.eventos = [n2];
  google.obter = [n2]; // o2 dá 404
  await ler("2026-11-12T12:00:00Z");
  delete google.obter;
  await rodarAte("2026-11-19T00:00:00Z");
  assert.deepEqual(resumo(), ["bia:vespera:15h", "bia:diaConfirmar:15h"]);
  assert.equal(alertas(/Reunião saiu da agenda/).length, 1);
});

test("S12 'Não posso' e depois o consultor muda o horário: 'reagendada' e lembretes voltam", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-10T16:00:00Z");
  await reunioes.responder({ contatoId: "1001", resposta: "Não posso" });
  google.eventos = [evento(em("2026-11-13T14:00:00-03:00"))];
  await ler("2026-11-10T20:00:00Z");
  await rodarAte("2026-11-14T00:00:00Z");
  assert.deepEqual(resumo(), ["bia:vespera:14h", "bia:reagendada:14h", "bia:vespera:14h", "bia:diaConfirmar:14h"]);
});

test("S13 convidado trocado por alguém fora da Monday e depois uma pessoa da Monday adicionada", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ attendees: ATT("amigo@pessoal.com"), updated: "2026-11-02T12:00:00Z" })];
  await ler("2026-11-02T12:00:00Z");
  google.eventos = [evento({ attendees: ATT("amigo@pessoal.com", "carla@exemplo.com"), updated: "2026-11-03T12:00:00Z" })];
  await ler("2026-11-03T12:00:00Z");
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), ["carla:vespera:14h", "carla:diaConfirmar:14h"], "Carla está na Monday e no evento");
});

test("S14 evento apagado logo depois de a reunião acontecer: nada para a pessoa", async () => {
  google.eventos = [evento({ ...em("2026-11-10T14:00:00-03:00") })];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-10T11:00:00Z");
  mc = [];
  google.eventos = [evento({ ...em("2026-11-10T14:00:00-03:00"), status: "cancelled" })];
  await ler("2026-11-10T18:30:00Z"); // 15h30, reunião acabou às 15h
  assert.deepEqual(resumo(), [], "nada depois do início da reunião");
});

test("S15 duas leituras ao mesmo tempo: uma roda, nada em dobro", async () => {
  google.eventos = [evento()];
  relogio("2026-11-01T12:00:00Z");
  const [a, b] = await Promise.all([agenda.sincronizarAgenda(new Date("2026-11-01T12:00:00Z")), agenda.sincronizarAgenda(new Date("2026-11-01T12:00:00Z"))]);
  assert.deepEqual([a.status, b.status].sort(), ["ja_rodando", "ok"]);
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), ["bia:vespera:14h", "bia:diaConfirmar:14h"]);
});

test("S16 reinício do app (banco mantido, memória perdida) com tarefa reservada no meio", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  const vesp = (await store.todasTarefas()).find((t) => t.chave.includes(":vespera"));
  await store.atualizarTarefa(vesp.id, { proxima: null });
  // A cópia antiga reservou a tarefa e caiu.
  await store.travarTarefa(vesp.id, new Date("2026-11-10T16:05:00Z"), new Date("2026-11-10T16:00:00Z"));
  for (const k of Object.keys(require.cache)) if (/services[\\/](agendamento|reunioes|reunioes-agenda)\.service/.test(k)) delete require.cache[k];
  const ag2 = require("../src/services/agendamento.service");
  const re2 = require("../src/services/reunioes.service");
  try {
    const t1 = new Date("2026-11-10T16:01:00Z");
    ag2.setRelogio(() => t1);
    re2.setRelogio(() => t1);
    await ag2.processarTarefas();
    assert.deepEqual(resumo(), [], "reservada pela cópia que caiu");
    const t2 = new Date("2026-11-10T16:06:00Z");
    ag2.setRelogio(() => t2);
    re2.setRelogio(() => t2);
    await ag2.processarTarefas();
    await ag2.processarTarefas();
    assert.deepEqual(resumo(), ["bia:vespera:14h"]);
  } finally {
    // As outras cenas usam os módulos originais.
  }
});

test("S17 fuso diferente no evento: mesmo instante não é 'reagendada'; horário mostrado em Brasília", async () => {
  google.eventos = [evento({ start: { dateTime: "2026-11-11T12:00:00-05:00", timeZone: "America/New_York" }, end: { dateTime: "2026-11-11T13:00:00-05:00" } })];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ start: { dateTime: "2026-11-11T18:00:00+01:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-11T19:00:00+01:00" } })];
  const r = await ler("2026-11-02T12:00:00Z");
  assert.equal(r.remarcadas, 0);
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), ["bia:vespera:14h", "bia:diaConfirmar:14h"]);
});

test("S18 reunião transformada em evento de dia inteiro: lembretes do horário antigo não deveriam sair", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ start: { date: "2026-11-11" }, end: { date: "2026-11-12" } })];
  await ler("2026-11-02T12:00:00Z");
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), [], `saiu: ${resumo()}`);
});

test("S19 dois convidados da Monday; depois a primeira é removida", async () => {
  google.eventos = [evento({ attendees: ATT("bia@exemplo.com", "carla@exemplo.com") })];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-10T16:00:00Z");
  assert.deepEqual(resumo(), ["bia:vespera:14h"]);
  google.eventos = [evento({ attendees: ATT("carla@exemplo.com"), updated: "2026-11-10T17:00:00Z" })];
  await ler("2026-11-10T17:00:00Z");
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), ["bia:vespera:14h", "carla:diaConfirmar:14h"]);
});

for (const [rotulo, descricao] of [
  ["+55 com parênteses", "WhatsApp: +55 (21) 98765-4321"],
  ["link wa.me", "WhatsApp: https://wa.me/5521987654321"],
  ["hora depois do número", "Celular: 21 98765-4321 (ligar após 18:30)"],
  ["número na linha de baixo", "WhatsApp\n21 98765-4321"],
  ["HTML do Google", '<b>Telefone</b>: <a href="tel:+5521987654321">(21) 98765-4321</a>'],
  ["dois números na mesma linha", "Telefone: 21 98765-4321 / 21 3333-4444"],
]) {
  test(`S20 telefone na descrição (${rotulo})`, async () => {
    google.eventos = [evento({ attendees: ATT("outro@gmail.com"), description: descricao })];
    const r = await ler("2026-11-01T12:00:00Z");
    assert.equal(r.registradas, 1, `não achou pelo telefone: ${JSON.stringify(descricao)}`);
  });
}

test("S21 Consultor troca o WhatsApp da descrição (convidado-e-mail fora da Monday continua): lembretes não podem ir para a pessoa antiga", async () => {
  google.eventos = [evento({ attendees: ATT("assistente@empresa.com"), description: "WhatsApp: 21987654321" })];
  await ler("2026-11-01T12:00:00Z");
  assert.equal((await registroDe("gev1")).dados.nome, "Bia Lima");
  google.eventos = [evento({ attendees: ATT("assistente@empresa.com"), description: "WhatsApp: 11977776666", updated: "2026-11-02T12:00:00Z" })];
  await ler("2026-11-02T12:00:00Z");
  await rodarAte("2026-11-12T00:00:00Z");
  assert.ok(!resumo().some((x) => x.startsWith("bia:")), `foi para a Bia: ${resumo()}`);
});

test("S22 convidado trocado no próprio dia, depois do lembrete das 8h: pessoa nova recebe algo ou a equipe é avisada", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-11T11:00:00Z"); // véspera + dia para a Bia
  mc = [];
  google.eventos = [evento({ attendees: ATT("carla@exemplo.com"), updated: "2026-11-11T12:00:00Z" })];
  await ler("2026-11-11T12:00:00Z"); // 9h, reunião às 14h
  await rodarAte("2026-11-11T16:59:00Z");
  const carlaRecebeu = resumo().some((x) => x.startsWith("carla:"));
  const equipeAvisadaSemLembrete = alertas(/Reunião sem lembrete/).length > 0;
  assert.ok(carlaRecebeu || equipeAvisadaSemLembrete, `Carla não recebeu nada; a equipe só ouviu: ${alertas(/Convidado trocado/).map((t) => t.split("\n").pop())}`);
});

test("S23 pessoa da Monday sem telefone válido: a equipe precisa saber que o lembrete não sai", async () => {
  google.eventos = [evento({ attendees: ATT("duda@exemplo.com") })];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.registradas, 1);
  await rodarAte("2026-11-12T00:00:00Z");
  assert.deepEqual(resumo(), []);
  assert.ok(avisos.some((t) => /Duda/.test(t) && /lembrete/i.test(t)), `nenhum alerta sobre a Duda: ${JSON.stringify(avisos)}`);
});

test("S24 reunião antecipada para um horário que já passou (aconteceu mais cedo): lembrete do horário antigo não sai", async () => {
  google.eventos = [evento()]; // qua 14h
  await ler("2026-11-01T12:00:00Z");
  await rodarAte("2026-11-10T16:00:00Z");
  mc = [];
  google.eventos = [evento(em("2026-11-11T07:00:00-03:00"))]; // registrou que aconteceu às 7h
  await ler("2026-11-11T10:35:00Z"); // 7h35
  await rodarAte("2026-11-11T11:00:00Z"); // 8h
  await ler("2026-11-11T13:05:00Z"); // 10h05: já fora da janela de leitura
  await agendamento.processarTarefas();
  assert.deepEqual(resumo(), [], `saiu: ${resumo()}`);
  assert.equal(alertas(/Reunião sem lembrete/).length, 0, "alerta enganoso de 'sem lembrete' para reunião já feita");
});

test("S25 lista 'Reuniões de hoje' depois de remarcação e de troca de convidado", async () => {
  google.eventos = [evento({ id: "x1" }), evento({ id: "x2", ...em("2026-11-11T16:00:00-03:00"), attendees: ATT("carla@exemplo.com") })];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ id: "x1", ...em("2026-11-12T14:00:00-03:00") }), evento({ id: "x2", ...em("2026-11-11T16:00:00-03:00"), attendees: ATT("bia@exemplo.com"), updated: "2026-11-02T11:00:00Z" })];
  await ler("2026-11-02T12:00:00Z");
  avisos = [];
  relogio("2026-11-11T11:00:00Z");
  await agendaDia.rodar(new Date("2026-11-11T11:00:00Z"));
  await agendamento.processarTarefas();
  const lista = avisos.find((t) => /Reuniões de hoje/.test(t));
  assert.ok(lista);
  assert.match(lista, /16h<\/b> · Bia Lima/);
  assert.doesNotMatch(lista, /14h<\/b>/);
  assert.match(lista, /Total: 1 reunião/);
});

test("S26 evento apagado e restaurado (desfazer) no Google: a reunião volta a ter lembretes (ou a equipe é avisada)", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento({ status: "cancelled" })];
  await ler("2026-11-02T12:00:00Z");
  google.eventos = [evento({ updated: "2026-11-02T12:06:00Z" })];
  await ler("2026-11-02T12:10:00Z");
  await rodarAte("2026-11-12T00:00:00Z");
  const r = resumo();
  assert.ok(r.includes("bia:vespera:14h") || alertas(/restaurad|voltou|sem lembrete/i).length, `após 'cancelada', a reunião restaurada ficou sem nada: ${r}; alertas: ${avisos.length}`);
});

test("S27 movida e devolvida ao horário original (desfazer) dentro da janela: cada lembrete sai uma vez", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento(em("2026-11-12T10:00:00-03:00"))];
  await ler("2026-11-02T12:00:00Z");
  google.eventos = [evento()];
  await ler("2026-11-02T12:05:00Z");
  await rodarAte("2026-11-11T16:59:00Z");
  assert.deepEqual(resumo(), ["bia:reagendada:10h", "bia:reagendada:14h", "bia:vespera:14h", "bia:diaConfirmar:14h"]);
});

test("S28 telefone com rótulo em negrito no editor do Google (<b>WhatsApp:</b> número)", async () => {
  google.eventos = [evento({ attendees: ATT("outro@gmail.com"), description: "<b>WhatsApp:</b> 21 98765-4321<br>Empresa: X" })];
  const r = await ler("2026-11-01T12:00:00Z");
  assert.equal(r.registradas, 1);
});

test("S29 (diagnóstico S24) alertas depois de mover para o passado", async () => {
  google.eventos = [evento()];
  await ler("2026-11-01T12:00:00Z");
  google.eventos = [evento(em("2026-11-11T07:00:00-03:00"))];
  await ler("2026-11-11T10:35:00Z");
  await ler("2026-11-11T13:05:00Z");
  await agendamento.processarTarefas();
  const reg = await registroDe("gev1");
  assert.equal(alertas(/Reunião sem lembrete/).length, 0, `alertas: ${avisos.map((t) => t.split("\n")[0])}; registro: ${reg.dados.situacao} ${reg.dados.inicio}`);
});
