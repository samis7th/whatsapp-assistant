const test = require("node:test");
const assert = require("node:assert/strict");

// Ordem de chegada na Mani (link e QR code da aula), por turma.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.INTERNO_SECRET = "chave-interna-do-painel-com-32-caracteres-ou-mais";
process.env.AULA_DATA = "2026-10-29";

const app = require("../src/app");
const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");
const chegadas = require("../src/services/chegadas.service");

const avisos = [];
let telegramFora = false;
telegram.setFetch(async (url, init) => {
  if (telegramFora) return { ok: false, status: 500, json: async () => ({ ok: false }), headers: new Map() };
  avisos.push(JSON.parse(init.body).text);
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }), headers: new Map() };
});

let base;
let servidor;
let store;

test.before(async () => {
  servidor = app.listen(0);
  await new Promise((resolve) => servidor.once("listening", resolve));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => servidor.close());

test.beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
  avisos.length = 0;
  telegramFora = false;
  config.aula.data = "2026-10-29";
});

// 8h em Brasília = 11h UTC.
const em = (dia, horaUtc = 11, minuto = 0) =>
  new Date(`2026-10-${dia}T${String(horaUtc).padStart(2, "0")}:${String(minuto).padStart(2, "0")}:00Z`);

async function chegou(contatoId, nome, whatsapp) {
  const response = await fetch(`${base}/manychat/chegada`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": process.env.MANYCHAT_SECRET },
    body: JSON.stringify({ contato_id: contatoId, nome, whatsapp }),
  });
  return response.json();
}

async function lista(query = "", chave = process.env.INTERNO_SECRET) {
  const response = await fetch(`${base}/interno/chegadas${query}`, { headers: { "X-Interno-Key": chave } });
  return { status: response.status, body: await response.json() };
}

test("cada um na ordem em que mandou a mensagem; quem volta não ganha nova posição", async () => {
  assert.equal((await chegou("111", "Ana Souza", "5511912345678")).resultado, "ok");
  await chegou("222", "Bia Lima", "+55 21 98765-4321");
  await chegou("111", "Ana Souza", "5511912345678"); // mandou de novo
  await chegou("333", "{{full_name}}", "");

  const { body } = await lista();
  assert.equal(body.turma, "2026-10-29");
  assert.equal(body.total, 3);
  assert.deepEqual(
    body.chegadas.map((c) => [c.posicao, c.nomeWhatsapp, c.whatsapp]),
    [
      [1, "Ana Souza", "+5511912345678"],
      [2, "Bia Lima", "+5521987654321"],
      [3, "", ""],
    ]
  );
  await agendamento.processarTarefas();
  assert.equal(avisos.length, 0, "nenhum aviso por pessoa: só o resumo do dia");
});

test("resumo no grupo às 8h, uma vez por dia; sem ninguém novo, não manda", async () => {
  await store.registrarChegada({ turma: "2026-10-29", contatoId: "1", whatsapp: "+5511912345678", nome: "Ana", em: em(21, 23) });
  await store.registrarChegada({ turma: "2026-10-29", contatoId: "2", whatsapp: null, nome: "Bia", em: em(22, 10) });

  assert.equal((await chegadas.rodarResumo(em(22, 10, 59))).status, "cedo", "7h59 ainda não");
  assert.deepEqual(await chegadas.rodarResumo(em(22, 11, 5)), { status: "enviado", total: 2, novas: 2 });
  assert.equal((await chegadas.rodarResumo(em(22, 15))).status, "ja_feito");
  await agendamento.processarTarefas();

  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /Ordem de chegada na Mani · turma 29\/10/);
  assert.match(avisos[0], /2 pessoas até agora \(\+2 desde ontem às 8h\)/);
  assert.match(avisos[0], /1º Ana · \+55 11 91234-5678\n2º Bia$/);

  // Dia seguinte: uma pessoa nova depois das 8h de ontem; a lista vem completa.
  await store.registrarChegada({ turma: "2026-10-29", contatoId: "3", whatsapp: null, nome: "Caio", em: em(22, 20) });
  await chegadas.rodarResumo(em(23, 11, 1));
  await agendamento.processarTarefas();
  assert.match(avisos[1], /3 pessoas até agora \(\+1 desde ontem/);
  assert.match(avisos[1], /3º Caio/);

  // Ninguém novo: o dia fica marcado e nada é enviado.
  assert.equal((await chegadas.rodarResumo(em(24, 11, 1))).status, "sem_novidade");
  assert.equal((await chegadas.rodarResumo(em(24, 12))).status, "ja_feito");
  await agendamento.processarTarefas();
  assert.equal(avisos.length, 2);
});

test("resumo longo: mostra os 20 primeiros e aponta o painel para o resto", async () => {
  for (let i = 1; i <= 53; i++) {
    await store.registrarChegada({ turma: "2026-10-29", contatoId: String(i), whatsapp: null, nome: `Pessoa ${i}`, em: em(22, 10) });
  }
  await chegadas.rodarResumo(em(22, 11, 1));
  await agendamento.processarTarefas();
  assert.match(avisos[0], /20º Pessoa 20/);
  assert.doesNotMatch(avisos[0], /21º/);
  assert.match(avisos[0], /…e mais 33: veja a lista completa no painel/);
});

test("nova turma: a contagem recomeça; a turma anterior continua consultável", async () => {
  await chegou("111", "Ana", "5511912345678");
  config.aula.data = "2026-11-12";
  await chegou("222", "Bia", "5521987654321");
  await chegou("111", "Ana", "5511912345678");

  const atual = (await lista()).body;
  assert.equal(atual.turma, "2026-11-12");
  assert.deepEqual(atual.chegadas.map((c) => [c.posicao, c.nomeWhatsapp]), [[1, "Bia"], [2, "Ana"]]);

  const anterior = (await lista("?turma=2026-10-29")).body;
  assert.deepEqual(anterior.chegadas.map((c) => c.nomeWhatsapp), ["Ana"]);
});

test("a lista mostra o que a Mani descobriu depois (cadastro e resultado)", async () => {
  await chegou("111", "Ana", "5511912345678");
  await store.criar({ contatoId: "111", whatsapp: "+5511912345678" });
  const atendimento = await store.atual("111");
  await store.atualizar(atendimento.id, { mondayNome: "Ana Souza", mondayItemId: "77", resultado: "qualificada" });

  const [ana] = (await lista()).body.chegadas;
  assert.equal(ana.nomeCadastro, "Ana Souza");
  assert.equal(ana.mondayItemId, "77");
  assert.equal(ana.resultado, "qualificada");
});

test("Telegram fora: o resumo do dia é reenviado depois", async () => {
  await store.registrarChegada({ turma: "2026-10-29", contatoId: "1", whatsapp: null, nome: "Ana", em: em(22, 10) });
  telegramFora = true;
  await chegadas.rodarResumo(em(22, 11, 1));
  await agendamento.processarTarefas();
  assert.equal(avisos.length, 0);

  telegramFora = false;
  const [tarefa] = (await store.todasTarefas()).filter((t) => t.tipo === "chegadas_resumo");
  await store.atualizarTarefa(tarefa.id, { proxima: null });
  await agendamento.processarTarefas();
  assert.equal(avisos.length, 1);
});

test("lista só com a chave interna", async () => {
  assert.equal((await lista("", "chave-errada-chave-errada-chave-errada-123")).status, 401);
});
