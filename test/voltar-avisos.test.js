const test = require("node:test");
const assert = require("node:assert/strict");

// v3.3.0: botão "Quero voltar a receber" na confirmação do "parar" (POST /manychat/voltar-avisos).
// A Etapa do Funil volta para a de antes do pedido (ou "A Definir"), só se ainda estiver
// "Não quer receber mensagens". Monday, ManyChat e Telegram simulados.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";

const app = require("../src/app");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");

const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Map() });

let quadro;
let comentarios;
let telegrams;
let leituraDaEtapaFalha;

const colunasDo = (item) => [
  { id: "phonenhzs51c9", text: item.telefone, phone: item.telefone.replace("+", "") },
  { id: "etapa", text: item.etapa, label: item.etapa || null },
];

async function mondaySimulada(url, init) {
  const { query, variables } = JSON.parse(init.body);
  if (query.includes("columns")) {
    const columns = [
      { id: "fat", title: "Faturamento Mensal", type: "status" },
      { id: "etapa", title: "Etapa do Funil", type: "status" },
      { id: "prox", title: "Próximo Contato", type: "date" },
      { id: "ult", title: "Último Contato", type: "date" },
    ];
    return ok({ data: { boards: [{ columns }] } });
  }
  if (query.includes("query Obs")) {
    if (leituraDaEtapaFalha) return ok({ errors: [{ message: "fora do ar" }] }, 500);
    const item = quadro.find((i) => i.id === String(variables.itemId[0]));
    return ok({ data: { items: [{ column_values: [{ text: item?.etapa || "" }] }] } });
  }
  if (query.includes("change_multiple_column_values")) {
    const valores = JSON.parse(variables.valores);
    const item = quadro.find((i) => i.id === String(variables.itemId));
    if (item && valores.etapa) item.etapa = valores.etapa.label;
    return ok({ data: { change_multiple_column_values: { id: variables.itemId } } });
  }
  if (query.includes("create_update")) {
    comentarios.push({ itemId: String(variables.itemId), texto: variables.texto });
    return ok({ data: { create_update: { id: "1" } } });
  }
  const items = quadro.map((i) => ({ id: i.id, name: i.nome, created_at: "2026-10-01T12:00:00Z", column_values: colunasDo(i) }));
  return ok({ data: { boards: [{ items_page: { cursor: null, items } }] } });
}

manychat.setFetch(async () => ok({ status: "success", data: {} }));
telegram.setFetch(async (url, init) => {
  telegrams.push(JSON.parse(init.body).text);
  return ok({ ok: true, result: {} });
});

let store;
let base;
let servidor;

test.before(async () => {
  servidor = app.listen(0);
  await new Promise((resolve) => servidor.once("listening", resolve));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(() => servidor.close());

test.beforeEach(async () => {
  store = createMemoryStore();
  setStore(store);
  monday.setFetch(mondaySimulada);
  quadro = [
    { id: "1", nome: "Ana", telefone: "+5511911110001", etapa: "Lead" },
    { id: "2", nome: "Bia", telefone: "+5511911110002", etapa: "" },
  ];
  comentarios = [];
  telegrams = [];
  leituraDaEtapaFalha = false;
  await store.salvarContatoManychat("+5511911110001", "501");
  await store.salvarContatoManychat("+5511911110002", "502");
  await store.salvarContatoManychat("+5511999999999", "599");
});

const ana = () => quadro.find((i) => i.id === "1");
const bia = () => quadro.find((i) => i.id === "2");
const parar = async (contatoId) => {
  const r = await agendamento.pararAvisos({ contatoId });
  await agendamento.processarTarefas();
  return r;
};
const voltar = async (contatoId) => {
  const r = await agendamento.voltarAvisos({ contatoId });
  await agendamento.processarTarefas();
  return r;
};

test("parar guarda a Etapa de antes; voltar restaura, comenta no cadastro e não avisa o Telegram", async () => {
  assert.deepEqual(await parar("501"), { resultado: "ok" });
  assert.equal(ana().etapa, "Não quer receber mensagens");
  assert.equal((await store.tarefaPorChave("sem_avisos:501")).dados.etapaAnterior, "Lead");

  assert.deepEqual(await voltar("501"), { resultado: "ok" });
  assert.equal(ana().etapa, "Lead");
  assert.ok(comentarios.some((c) => c.itemId === "1" && c.texto === "🔔 Voltou a receber as mensagens pelo WhatsApp."));
  assert.equal(telegrams.length, 0);
  const voltou = (await store.tarefasComPrefixo("voltou_avisos:501:"))[0];
  assert.equal(voltou.status, "ok");
  assert.equal(voltou.dados.etapaRestaurada, "Lead");

  // Tocou duas vezes: a Etapa já não é "Não quer", nada muda.
  assert.deepEqual(await voltar("501"), { resultado: "ok" });
  assert.equal(ana().etapa, "Lead");
});

test("Etapa de antes desconhecida (vazia ou leitura falhou): volta para \"A Definir\"; a leitura falhando não impede o parar", async () => {
  await parar("502");
  assert.equal(bia().etapa, "Não quer receber mensagens");
  assert.equal((await store.tarefaPorChave("sem_avisos:502")).dados.etapaAnterior, undefined);
  await voltar("502");
  assert.equal(bia().etapa, "A Definir");

  leituraDaEtapaFalha = true;
  setStore((store = createMemoryStore()));
  await store.salvarContatoManychat("+5511911110001", "501");
  await parar("501");
  assert.equal(ana().etapa, "Não quer receber mensagens", "o parar não depende da leitura");
  assert.equal((await store.tarefaPorChave("sem_avisos:501")).status, "ok");
  leituraDaEtapaFalha = false;
  await voltar("501");
  assert.equal(ana().etapa, "A Definir");
});

test("a equipe mudou a Etapa depois do parar: o voltar não sobrescreve", async () => {
  await parar("501");
  ana().etapa = "Quer reunião";
  assert.deepEqual(await voltar("501"), { resultado: "ok" });
  assert.equal(ana().etapa, "Quer reunião");
  const voltou = (await store.tarefasComPrefixo("voltou_avisos:501:"))[0];
  assert.equal(voltou.dados.etapaMantida, "Quer reunião");
  assert.ok(comentarios.some((c) => c.texto.startsWith("🔔 Voltou")));
});

test("parar, voltar e parar de novo no mesmo dia: marca de novo na hora", async () => {
  await parar("501");
  await voltar("501");
  assert.equal(ana().etapa, "Lead");
  assert.deepEqual(await parar("501"), { resultado: "ok" });
  assert.equal(ana().etapa, "Não quer receber mensagens");
  const pedido = await store.tarefaPorChave("sem_avisos:501");
  assert.equal(pedido.dados.voltou, false);
  assert.equal(pedido.dados.etapaAnterior, "Lead");
  await voltar("501");
  assert.equal(ana().etapa, "Lead");
});

test("voltar sem ter parado pela Mani: acha o cadastro pelo telefone; sem cadastro: sem_cadastro", async () => {
  ana().etapa = "Não quer receber mensagens";
  assert.deepEqual(await voltar("501"), { resultado: "ok" });
  assert.equal(ana().etapa, "A Definir");
  assert.deepEqual(await voltar("599"), { resultado: "sem_cadastro" });
  assert.deepEqual(await voltar("12345"), { resultado: "sem_cadastro" }, "contato sem telefone conhecido");
});

test("rota POST /manychat/voltar-avisos: chave do ManyChat e contrato", async () => {
  const chamar = (corpo, chave = process.env.MANYCHAT_SECRET) =>
    fetch(`${base}/manychat/voltar-avisos`, { method: "POST", headers: { "X-Api-Key": chave }, body: JSON.stringify(corpo) }).then(async (r) => ({ status: r.status, corpo: await r.json() }));
  assert.equal((await chamar({ contato_id: "501" }, "errada")).status, 401);
  assert.equal((await chamar({})).corpo.resultado, "erro");
  await parar("501");
  const r = await chamar({ contato_id: "501" });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.resultado, "ok");
  assert.equal((await chamar({ contato_id: "599" })).corpo.resultado, "sem_cadastro");
  await agendamento.processarTarefas();
  assert.equal(ana().etapa, "Lead");
});
