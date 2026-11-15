const test = require("node:test");
const assert = require("node:assert/strict");

// Convite para o grupo pela Mani (lista vinda do painel), com ManyChat e Telegram simulados.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.INTERNO_SECRET = "chave-interna-do-painel-com-32-caracteres-ou-mais";
process.env.AULA_DATA = "2026-10-29";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";
process.env.MANYCHAT_FLOW_CONVITE = "content20261021000000_000002";

const app = require("../src/app");
const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");

const CHAVE = process.env.INTERNO_SECRET;

function respostaJson(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, headers: new Map() };
}

// ---------- ManyChat simulado ----------
const mc = { chamadas: [], existentes: new Map(), proximoId: 9000, falharFluxo: false };

manychat.setFetch(async (url, init) => {
  const u = new URL(url);
  const corpo = init.body ? JSON.parse(init.body) : null;
  mc.chamadas.push({ caminho: u.pathname, corpo, query: Object.fromEntries(u.searchParams) });

  if (u.pathname === "/fb/subscriber/createSubscriber") {
    if (mc.existentes.has(corpo.whatsapp_phone)) {
      return respostaJson({ status: "error", message: "Subscriber already exists" }, 400);
    }
    const id = mc.proximoId++;
    return respostaJson({ status: "success", data: { id } });
  }

  if (u.pathname === "/fb/subscriber/findBySystemField") {
    const id = mc.existentes.get(u.searchParams.get("phone"));
    return id ? respostaJson({ status: "success", data: { id } }) : respostaJson({ status: "error", message: "not found" }, 400);
  }

  if (u.pathname === "/fb/sending/sendFlow" && mc.falharFluxo) {
    return respostaJson({ status: "error", message: "fora do ar" }, 500);
  }

  return respostaJson({ status: "success", data: {} });
});

const avisos = [];
telegram.setFetch(async (url, init) => {
  avisos.push(JSON.parse(init.body).text);
  return respostaJson({ ok: true, result: {} });
});

// ---------- servidor ----------
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
  mc.chamadas.length = 0;
  mc.existentes.clear();
  mc.falharFluxo = false;
  avisos.length = 0;
});

async function enviar(pessoas, chave = CHAVE) {
  const response = await fetch(`${base}/interno/convites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(chave ? { "X-Interno-Key": chave } : {}) },
    body: JSON.stringify({ pessoas }),
  });
  const corpo = await response.json();
  await agendamento.processarTarefas();
  return { status: response.status, ...corpo };
}

const chamadasDe = (caminho) => mc.chamadas.filter((c) => c.caminho === caminho);

const LISTA = [
  { nome: "Ana Souza", telefone: "5511912345678", mondayItemId: "101" },
  { nome: "Bia Lima", telefone: "21987654321", mondayItemId: "102" },
  { nome: "Sem telefone", telefone: "", mondayItemId: "103" },
  { nome: "Ana de novo", telefone: "(11) 91234-5678", mondayItemId: "101" },
];

// ---------- testes ----------

test("sem a chave interna: 401", async () => {
  assert.equal((await enviar(LISTA, null)).status, 401);
  assert.equal((await enviar(LISTA, "x".repeat(49))).status, 401);
  assert.equal(mc.chamadas.length, 0);
});

test("convite: cria o contato, etiqueta da turma, dispara o fluxo e grava a data no campo do bot", async () => {
  const r = await enviar(LISTA);
  assert.equal(r.status, 200);
  assert.deepEqual({ novos: r.novos, jaEnviados: r.jaEnviados, invalidos: r.invalidos, turma: r.turma }, {
    novos: 2,
    jaEnviados: 0,
    invalidos: 1,
    turma: "29/10",
  });

  assert.deepEqual(chamadasDe("/fb/page/setBotFieldByName")[0].corpo, { field_name: "data_aula", field_value: "29/10" });

  const criados = chamadasDe("/fb/subscriber/createSubscriber").map((c) => c.corpo);
  assert.deepEqual(
    criados.map((c) => [c.whatsapp_phone, c.first_name, c.last_name]),
    [
      ["+5511912345678", "Ana", "Souza"],
      ["+5521987654321", "Bia", "Lima"],
    ]
  );
  assert.deepEqual(
    chamadasDe("/fb/subscriber/addTagByName").map((c) => c.corpo),
    [
      { subscriber_id: 9000, tag_name: "aula_2910" },
      { subscriber_id: 9001, tag_name: "aula_2910" },
    ]
  );
  assert.deepEqual(
    chamadasDe("/fb/sending/sendFlow").map((c) => c.corpo),
    [
      { subscriber_id: 9000, flow_ns: "content20261021000000_000002" },
      { subscriber_id: 9001, flow_ns: "content20261021000000_000002" },
    ]
  );
});

test("mesma lista de novo: ninguém recebe o convite duas vezes na mesma turma", async () => {
  await enviar(LISTA);
  mc.chamadas.length = 0;
  const r = await enviar(LISTA);
  assert.equal(r.novos, 0);
  assert.equal(r.jaEnviados, 2);
  assert.equal(chamadasDe("/fb/sending/sendFlow").length, 0);
  assert.equal(chamadasDe("/fb/subscriber/createSubscriber").length, 0);
});

test("quem já conversou com a Mani usa o contato que existe (não cria outro)", async () => {
  await store.criar({ contatoId: "777", whatsapp: "+5511912345678" });
  await enviar([LISTA[0]]);
  assert.equal(chamadasDe("/fb/subscriber/createSubscriber").length, 0);
  assert.equal(chamadasDe("/fb/sending/sendFlow")[0].corpo.subscriber_id, 777);
});

test("contato que já existe no ManyChat: acha pelo telefone e segue", async () => {
  mc.existentes.set("+5511912345678", 555);
  await enviar([LISTA[0]]);
  assert.equal(chamadasDe("/fb/subscriber/findBySystemField")[0].query.phone, "+5511912345678");
  assert.equal(chamadasDe("/fb/sending/sendFlow")[0].corpo.subscriber_id, 555);

  // Da próxima vez nem pergunta: o ID ficou guardado.
  mc.chamadas.length = 0;
  process.env.AULA_DATA = "2026-11-05";
  await store.criarTarefa({
    chave: "convite:2026-11-05:+5511912345678",
    tipo: "convite",
    dados: { nome: "Ana", telefone: "+5511912345678", etiqueta: "aula_0511" },
  });
  await agendamento.processarTarefas();
  assert.equal(chamadasDe("/fb/subscriber/createSubscriber").length, 0);
  assert.equal(chamadasDe("/fb/subscriber/findBySystemField").length, 0);
});

test("ManyChat fora no envio: tenta de novo sem recriar contato, e o grupo recebe um aviso só", async () => {
  mc.falharFluxo = true;
  const pessoas = Array.from({ length: 5 }, (_, i) => ({ nome: `Pessoa ${i}`, telefone: `1191234500${i}` }));
  await enviar(pessoas);

  for (let rodada = 0; rodada < 3; rodada++) {
    for (const tarefa of await store.todasTarefas()) await store.atualizarTarefa(tarefa.id, { proxima: null });
    await agendamento.processarTarefas();
  }

  assert.equal(chamadasDe("/fb/subscriber/createSubscriber").length, 5, "cada contato criado uma vez só");
  assert.equal(avisos.length, 1, "um aviso para o lote, não um por pessoa");
  assert.match(avisos[0], /Falha: convite para o grupo/);

  mc.falharFluxo = false;
  for (const tarefa of await store.todasTarefas()) await store.atualizarTarefa(tarefa.id, { proxima: null });
  await agendamento.processarTarefas();
  assert.equal((await store.todasTarefas()).filter((t) => t.status === "ok").length, 5);
});

test("sem o fluxo de convite configurado: 503 com a variável que falta", async () => {
  const original = config.manychat.flowConvite;
  config.manychat.flowConvite = "";
  try {
    const r = await enviar(LISTA);
    assert.equal(r.status, 503);
    assert.match(r.erro, /MANYCHAT_FLOW_CONVITE/);
    assert.equal(mc.chamadas.length, 0);
  } finally {
    config.manychat.flowConvite = original;
  }
});
