const test = require("node:test");
const assert = require("node:assert/strict");

// Vigia cruzada (v2.14.0): a Mani confere a API de inscrições; aviso no Telegram só depois
// de duas falhas seguidas, uma vez só, e outro quando voltar.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";

const telegram = require("../src/services/telegram.service");
const vigia = require("../src/services/vigia.service");
const { config } = require("../src/config/env");

let avisos;
telegram.setFetch(async (url, init) => {
  avisos.push(JSON.parse(init.body).text);
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
});

let resposta;
let urls;
vigia.setFetch(async (url) => {
  urls.push(url);
  if (resposta === "sem_conexao") throw new TypeError("fetch failed");
  return { ok: resposta.status < 400, status: resposta.status, json: async () => resposta.corpo };
});

const NO_AR = { status: 200, corpo: { ok: true, database: "connected" } };
const BANCO_FORA = { status: 503, corpo: { ok: false, database: "unavailable" } };

test.beforeEach(() => {
  vigia.reiniciarEstado();
  avisos = [];
  urls = [];
});

test("confere o /health/db da API por padrão", async () => {
  resposta = NO_AR;
  assert.deepEqual(await vigia.rodar(), { status: "ok" });
  assert.deepEqual(urls, ["https://api.example.com/health/db"]);
  assert.equal(avisos.length, 0);
});

test("uma falha só (reinício rápido): sem aviso; duas seguidas: aviso uma vez; voltou: aviso", async () => {
  resposta = "sem_conexao";
  assert.equal((await vigia.rodar(new Date("2026-11-06T17:00:00Z"))).status, "fora");
  resposta = NO_AR;
  assert.equal((await vigia.rodar()).status, "ok");
  assert.equal(avisos.length, 0, "uma falha isolada não avisa");

  resposta = BANCO_FORA;
  await vigia.rodar(new Date("2026-11-06T17:10:00Z"));
  assert.equal((await vigia.rodar(new Date("2026-11-06T17:15:00Z"))).status, "avisado");
  await vigia.rodar(new Date("2026-11-06T17:20:00Z"));
  assert.equal(avisos.length, 1, "não repete enquanto estiver fora");
  assert.match(avisos[0], /API de inscrições fora do ar/);
  assert.match(avisos[0], /Desde 06\/11, 14:10/);
  assert.match(avisos[0], /banco fora/);

  resposta = NO_AR;
  assert.equal((await vigia.rodar()).status, "voltou");
  assert.equal(avisos.length, 2);
  assert.match(avisos[1], /API de inscrições voltou ao ar/);
  assert.match(avisos[1], /Fora desde 06\/11, 14:10/);
});

test("VIGIA_URL=off: desligada", async () => {
  const antes = config.vigia.url;
  config.vigia.url = "";
  try {
    assert.deepEqual(await vigia.rodar(), { status: "desligado" });
    assert.equal(urls.length, 0);
  } finally {
    config.vigia.url = antes;
  }
});
