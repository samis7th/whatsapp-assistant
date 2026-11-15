const test = require("node:test");
const assert = require("node:assert/strict");

// Reuniões do dia (v2.13.0): às 8h, a lista de hoje no Telegram (reuniões comerciais e
// mentorias), uma vez só; sem reunião no dia, nada.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";

const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");
const agendaDia = require("../src/services/agenda-dia.service");

let enviados;
telegram.setFetch(async (url, init) => {
  enviados.push(JSON.parse(init.body).text);
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
});

let store;
test.beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
  enviados = [];
});

const reuniao = (id, dados) =>
  store.criarTarefa({ chave: `reuniao:${id}`, tipo: "reuniao_registro", dados: { situacao: "ativa", confirmacao: "pendente", ...dados } });

// Sexta 06/11/2026; 8h em Brasília = 11h UTC.
const em = (iso) => {
  const agora = new Date(iso);
  agendamento.setRelogio(() => agora);
  return agora;
};

test("às 8h: reuniões e mentorias de hoje, em ordem, com a situação; uma vez só", async () => {
  await reuniao("a", { nome: "Carla Lima", telefone: "+5511912345678", inicio: "2026-11-06T17:00:00Z", confirmacao: "confirmada" });
  await reuniao("b", { nome: "Duda Reis", telefone: "", inicio: "2026-11-06T13:30:00Z" });
  await reuniao("c", { nome: "Ontem", inicio: "2026-11-05T17:00:00Z" });
  await reuniao("d", { nome: "Cancelada", inicio: "2026-11-06T15:00:00Z", situacao: "cancelada" });
  await reuniao("e", { nome: "Pediu reagendar", inicio: "2026-11-06T19:00:00Z", confirmacao: "reagendar_pendente" });
  const m = await store.inscreverMentoria({ rodada: "2026-11-03", mondayItemId: "9", nome: "Ana Souza", telefone: "+5511911110001", email: "ana@x.com" });
  await store.atualizarInscricaoMentoria(m.id, { sorteada: true, agendamento: "agendada", mentoriaEm: new Date("2026-11-06T18:00:00Z") });

  assert.equal((await agendaDia.rodar(em("2026-11-06T10:55:00Z"))).status, "cedo");
  assert.deepEqual(await agendaDia.rodar(em("2026-11-06T11:00:00Z")), { status: "enviado", total: 4 });
  await agendamento.processarTarefas();

  assert.equal(enviados.length, 1);
  const t = enviados[0];
  assert.match(t, /Reuniões de hoje<\/b> · sexta-feira, 06\/11/);
  const ordem = ["Duda Reis", "Carla Lima", "Ana Souza", "Pediu reagendar"].map((n) => t.indexOf(n));
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, "em ordem de horário");
  assert.match(t, /<b>10h30<\/b> · Duda Reis\nReunião comercial · ⏳ ainda não confirmou/);
  assert.match(t, /<b>14h<\/b> · Carla Lima · [^\n]+\nReunião comercial · ✅ confirmou/);
  assert.match(t, /<b>15h<\/b> · Ana Souza · [^\n]+\nMentoria \(sorteada\)/);
  assert.match(t, /🔁 pediu para reagendar/);
  assert.doesNotMatch(t, /Ontem|Cancelada/);
  assert.match(t, /Total: 4 reuniões/);

  assert.equal((await agendaDia.rodar(em("2026-11-06T14:00:00Z"))).status, "ja_feito");
  await agendamento.processarTarefas();
  assert.equal(enviados.length, 1);
});

test("dia sem reunião: não manda nada", async () => {
  await reuniao("x", { nome: "Amanhã", inicio: "2026-11-07T17:00:00Z" });
  assert.deepEqual(await agendaDia.rodar(em("2026-11-06T11:00:00Z")), { status: "sem_reunioes", total: 0 });
  await agendamento.processarTarefas();
  assert.equal(enviados.length, 0);
  assert.equal((await agendaDia.rodar(em("2026-11-06T12:00:00Z"))).status, "ja_feito");
});

// Painel (v3.1.0): reuniões de 7 dias atrás a 30 à frente, com a situação; e os avisos do
// Telegram guardados na memória.
test("painel: reuniões e mentorias na janela, em ordem, sem o que está fora dela", async () => {
  await reuniao("p1", { nome: "Carla Lima", telefone: "+5511912345678", inicio: "2026-11-12T17:00:00Z", confirmacao: "confirmada", enviados: ["vespera"], origem: "agenda", recorrente: true });
  await reuniao("p2", { nome: "Semana passada", inicio: "2026-11-05T17:00:00Z", situacao: "realizada" });
  await reuniao("p3", { nome: "Muito antiga", inicio: "2026-10-01T17:00:00Z" });
  await reuniao("p4", { nome: "Muito longe", inicio: "2027-01-20T17:00:00Z" });
  const m = await store.inscreverMentoria({ rodada: "2026-11-10", mondayItemId: "9", nome: "Ana Souza", telefone: "+5511911110001", email: "ana@x.com" });
  await store.atualizarInscricaoMentoria(m.id, { sorteada: true, agendamento: "agendada", mentoriaEm: new Date("2026-11-13T18:00:00Z") });

  const r = await agendaDia.paraPainel({ agora: new Date("2026-11-10T12:00:00Z") });
  assert.deepEqual(r.reunioes.map((x) => x.nome), ["Semana passada", "Carla Lima", "Ana Souza"]);
  const carla = r.reunioes[1];
  assert.equal(carla.origem, "agenda");
  assert.equal(carla.confirmacaoTexto, "confirmou");
  assert.equal(carla.recorrente, true);
  assert.deepEqual(carla.lembretes, ["vespera"]);
  assert.equal(carla.telefone, "+55 11 91234-5678");
  assert.equal(r.reunioes[0].situacao, "realizada");
  assert.equal(r.reunioes[2].tipo, "mentoria");
});

test("painel: avisos do Telegram ficam guardados (mais recente primeiro, sem as tags)", async () => {
  await telegram.enviarAviso("<b>Primeiro</b> aviso &amp; teste");
  await telegram.enviarAviso("Segundo");
  const avisos = telegram.ultimosAvisos(2);
  assert.equal(avisos[0].texto, "Segundo");
  assert.equal(avisos[1].texto, "Primeiro aviso & teste");
  assert.equal(avisos[0].ok, true);
});
