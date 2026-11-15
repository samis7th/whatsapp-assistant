const test = require("node:test");
const assert = require("node:assert/strict");

// POST /manychat/vincular: contato antigo do ManyChat (a API não acha pelo número). A Mani
// lê o número pelo ID do contato e guarda a ligação; os envios seguintes acham o contato.
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
const manychat = require("../src/services/manychat.service");

const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Map() });
let info;
let chamadas;
let porNome = {};
let porId = {};
manychat.setFetch(async (url, init) => {
  const u = new URL(url);
  chamadas.push({ caminho: u.pathname, corpo: init.body ? JSON.parse(init.body) : null, query: u.search });
  if (u.pathname.endsWith("createSubscriber")) {
    return ok({ status: "error", message: "Validation error", details: { messages: [{ message: "This WhatsApp ID already exists" }] } }, 400);
  }
  if (u.pathname.endsWith("findByName")) return ok({ status: "success", data: porNome[u.searchParams.get("name")] || [] });
  if (u.pathname.endsWith("getInfo")) {
    const id = u.searchParams.get("subscriber_id");
    return ok({ status: "success", data: porId[id] || info });
  }
  return ok({ status: "success", data: {} });
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
  chamadas = [];
});

const vincular = (corpo, chave = process.env.MANYCHAT_SECRET) =>
  fetch(`${base}/manychat/vincular`, { method: "POST", headers: { "X-Api-Key": chave }, body: JSON.stringify(corpo) }).then(async (r) => ({ status: r.status, corpo: await r.json() }));

test("guarda a ligação telefone -> contato e preenche whatsapp_numero", async () => {
  info = { id: "123456", name: "Beatriz", whatsapp_phone: "+5511900004566" };
  const r = await vincular({ contato_id: "123456" });
  assert.equal(r.corpo.resultado, "ok");
  assert.equal(await store.contatoManychat("+5511900004566"), "123456");
  const campo = chamadas.find((c) => c.caminho.endsWith("setCustomFieldByName"));
  assert.deepEqual([campo.corpo.field_name, campo.corpo.field_value], ["whatsapp_numero", "5511900004566"]);
  assert.match(chamadas[0].query, /subscriber_id=123456/);
});

test("número sem '+' (wa_id) também serve", async () => {
  info = { id: "77", wa_id: "5551999001234" };
  const r = await vincular({ contato_id: "77" });
  assert.equal(r.corpo.resultado, "ok");
  assert.equal(await store.contatoManychat("+5551999001234"), "77");
});

test("sem número no contato: sem_telefone, com os nomes dos campos (sem valores)", async () => {
  info = { id: "9", name: "Fulana", email: "fulana@exemplo.com" };
  const r = await vincular({ contato_id: "9" });
  assert.equal(r.corpo.resultado, "sem_telefone");
  assert.equal(r.corpo.motivo, "id,name,email");
  assert.ok(!r.corpo.motivo.includes("fulana@"));
});

test("contato do Instagram com telefone: não liga o número (canal errado)", async () => {
  info = { id: "555", name: "Usuario", ig_username: "usuario", phone: "+5511900004566" };
  const r = await vincular({ contato_id: "555" });
  assert.equal(r.corpo.resultado, "sem_telefone");
  assert.equal(await store.contatoManychat("+5511900004566"), null);
});

test("contato de WhatsApp que só traz 'phone' (sem Instagram): continua ligando", async () => {
  info = { id: "556", name: "Bia", phone: "+5521987654321" };
  const r = await vincular({ contato_id: "556" });
  assert.equal(r.corpo.resultado, "ok");
  assert.equal(r.corpo.motivo, "phone");
  assert.equal(await store.contatoManychat("+5521987654321"), "556");
});

test("contato com WhatsApp e Instagram: vale o número do WhatsApp", async () => {
  info = { id: "557", ig_username: "bia", phone: "+5511900000001", whatsapp_phone: "+5521987654321" };
  const r = await vincular({ contato_id: "557" });
  assert.equal(r.corpo.motivo, "whatsapp_phone");
  assert.equal(await store.contatoManychat("+5521987654321"), "557");
  assert.equal(await store.contatoManychat("+5511900000001"), null);
});

// ---------- contato antigo achado pelo nome (garantirContato) ----------

test("contato antigo: acha pelo nome e só aceita quem tem o mesmo WhatsApp", async () => {
  porNome = {
    "Beatriz Souza de Oliveira Lima": [
      { id: "902", name: "Beatriz Souza", whatsapp_phone: "+5511900000000" },
      { id: "901", name: "Beatriz Souza", whatsapp_phone: "5511900004566" },
    ],
  };
  const id = await manychat.garantirContato({ telefoneE164: "+5511900004566", nome: "Beatriz Souza de Oliveira Lima" });
  assert.equal(id, "901");
});

test("contato antigo: busca sem o WhatsApp no resultado lê o contato; nome curto também tenta", async () => {
  porNome = { Beatriz: [{ id: "903" }] };
  porId = { 903: { id: "903", whatsapp_phone: "+551100004566" } }; // sem o 9: mesmo número
  const id = await manychat.garantirContato({ telefoneE164: "+5511900004566", nome: "Beatriz Souza de Oliveira Lima" });
  assert.equal(id, "903");
  porId = {};
});

test("contato antigo cadastrado com título e anotação: procura também sem 'Dra.' e sem parênteses", async () => {
  porNome = {
    "Juliana Alves": [{ id: "905", whatsapp_phone: "+5511900004566" }],
    Everton: [{ id: "906", whatsapp_phone: "+5511977776666" }],
  };
  assert.equal(await manychat.garantirContato({ telefoneE164: "+5511900004566", nome: "Dra. Juliana Alves" }), "905");
  assert.equal(await manychat.garantirContato({ telefoneE164: "+5511977776666", nome: "Everton (Marido da Dra. Marcella)" }), "906");
  const buscas = chamadas.filter((c) => c.caminho.endsWith("findByName")).map((c) => new URLSearchParams(c.query).get("name"));
  assert.ok(!buscas.includes("Dra.") && !buscas.includes("Dra"), "nunca procura só pelo título");
});

test("contato antigo com nome diferente no ManyChat: continua pulado (contato antigo)", async () => {
  porNome = { "Bia Lima": [{ id: "904", whatsapp_phone: "+5521900000000" }] };
  await assert.rejects(
    manychat.garantirContato({ telefoneE164: "+5511900004566", nome: "Bia Lima" }),
    (erro) => erro.contatoExistente === true
  );
});

test("sem a chave X-Api-Key: recusado", async () => {
  const r = await vincular({ contato_id: "9" }, "errada");
  assert.equal(r.status, 401);
});
