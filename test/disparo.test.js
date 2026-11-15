const test = require("node:test");
const assert = require("node:assert/strict");

// Disparo único (aviso do sorteio das mentorias) na quinta 05/11 às 20h, com Monday,
// ManyChat e Telegram simulados.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.AULA_DATA = "2026-10-29";
process.env.AULA_INSCRICOES_DESDE = "2026-10-14";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";
process.env.MANYCHAT_FLOW_LIVE_VESPERA = "content20261026000000_000001";
process.env.MANYCHAT_FLOW_LIVE_1HORA = "content20261026000000_000002";
process.env.MANYCHAT_FLOW_LIVE_COMECOU = "content20261026000000_000003";
process.env.MANYCHAT_FLOW_DISPARO = "content20261105000000_000009";
process.env.DISPARO_DATA = "2026-11-05";

const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");
const disparo = require("../src/services/disparo.service");

const ok = (body) => ({ ok: true, status: 200, json: async () => body, headers: new Map() });

// Inscritos de turmas diferentes; Cris pediu para não receber e Duda está duplicada.
const inscritos = [
  ["1", "Ana", "+5511912345678", "Aula Gratuita", "", "2026-09-10T12:00:00Z"],
  ["2", "Bia", "+5521987654321", "SDR Mentoria", "Está no grupo", "2026-10-20T12:00:00Z"],
  ["3", "Cris", "+5531999990000", "Aula Gratuita", "Não quer receber mensagens", "2026-10-15T12:00:00Z"],
  ["4", "Duda", "+5541988887777", "Aula Gratuita", "", "2026-08-01T12:00:00Z"],
  ["5", "Duda", "+5541988887777", "Aula Gratuita", "", "2026-10-16T12:00:00Z"],
];

const gravadas = [];

monday.setFetch(async (url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (query.includes("query Obs")) return ok({ data: { items: [{ column_values: [{ text: "" }] }] } });
  if (query.includes("change_multiple_column_values")) {
    const valores = JSON.parse(variables.valores);
    gravadas.push({ itemId: variables.itemId, valores });
    // A etiqueta gravada aparece na próxima leitura do quadro.
    const linha = inscritos.find(([id]) => id === String(variables.itemId));
    if (linha && valores.etapa) linha[4] = valores.etapa.label;
    return ok({ data: { change_multiple_column_values: { id: variables.itemId } } });
  }
  if (query.includes("create_update")) return ok({ data: { create_update: { id: "1" } } });
  if (query.includes("columns")) {
    const columns = [
      { id: "fat", title: "Faturamento Mensal", type: "status" },
      { id: "etapa", title: "Etapa do Funil", type: "status" },
      { id: "prox", title: "Próximo Contato", type: "date" },
      { id: "ult", title: "Último Contato", type: "date" },
      { id: "cad", title: "Data de Cadastro", type: "date" },
      { id: "grupo", title: "Grupo WhatsApp", type: "status" },
    ];
    return ok({ data: { boards: [{ columns }] } });
  }
  const items = inscritos.map(([id, name, tel, funil, grupo, criado]) => ({
    id,
    name,
    created_at: criado,
    column_values: [
      { id: "phonenhzs51c9", text: tel, phone: tel },
      { id: "lead_status", text: funil, label: funil, updated_at: criado },
      // "Não quer receber mensagens" fica na Etapa do Funil desde 03/11/2026.
      { id: "etapa", text: grupo === "Não quer receber mensagens" ? grupo : "Lead", label: grupo === "Não quer receber mensagens" ? grupo : "Lead" },
      { id: "grupo", text: grupo === "Está no grupo" ? grupo : "", label: grupo === "Está no grupo" ? grupo : null },
    ],
  }));
  return ok({ data: { boards: [{ items_page: { cursor: null, items } }] } });
});

let agora;
let envios;
let resumos;
let contatos;

manychat.setFetch(async (url, init) => {
  const corpo = init.body ? JSON.parse(init.body) : {};
  if (url.includes("sendFlow")) envios.push({ quando: agora, flow: corpo.flow_ns, contato: corpo.subscriber_id });
  if (url.includes("createSubscriber")) {
    contatos++;
    return ok({ status: "success", data: { id: 5000 + contatos } });
  }
  return ok({ status: "success", data: {} });
});

let concluidos = [];

telegram.setFetch(async (url, init) => {
  const texto = JSON.parse(init.body).text;
  (/concluído/.test(texto) ? concluidos : resumos).push(texto);
  return ok({ ok: true, result: {} });
});

// Roda o relógio de 5 em 5 minutos, como no servidor.
async function simular(deIso, ateIso) {
  for (let t = Date.parse(deIso); t < Date.parse(ateIso); t += 5 * 60000) {
    agora = new Date(t);
    agendamento.setRelogio(() => agora);
    await disparo.rodarDisparo(agora);
    await agendamento.processarTarefas();
  }
}

const hora = (d) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(d);

function primeiros(flow) {
  const lista = envios.filter((e) => e.flow === flow);
  return { total: lista.length, primeiro: lista[0] && hora(lista[0].quando) };
}

test.beforeEach(() => {
  setStore(createMemoryStore());
  envios = [];
  resumos = [];
  concluidos = [];
  contatos = 0;
});

const FLUXO = "content20261105000000_000009";

test("quinta 05/11 às 20h: uma mensagem para cada inscrito, menos quem não quer receber", async () => {
  // Quarta 04/11 00h até sábado 07/11 00h (Brasília).
  await simular("2026-11-04T03:00:00Z", "2026-11-07T03:00:00Z");
  assert.deepEqual(primeiros(FLUXO), { total: 3, primeiro: "qui., 20:00" });
  assert.equal(envios.length, 3, "Ana, Bia e Duda (uma vez só); Cris fica de fora");
  // v2.13.0: uma mensagem só, no fim, com quem ficou de fora.
  assert.equal(resumos.length, 0);
  assert.equal(concluidos.length, 1);
  assert.match(concluidos[0], /Disparo único/);
  assert.match(concluidos[0], /Enviados: 3/);
  assert.match(concluidos[0], /1 não quer receber/);
});

test("rodar de novo (app reiniciado) não manda duas vezes", async () => {
  await simular("2026-11-05T23:00:00Z", "2026-11-05T23:30:00Z");
  await simular("2026-11-05T23:30:00Z", "2026-11-06T00:30:00Z");
  assert.equal(envios.length, 3);
});

test("sem fluxo ou sem data: não sai nada", async () => {
  const original = config.manychat.flowDisparo;
  config.manychat.flowDisparo = "";
  try {
    await simular("2026-11-05T22:00:00Z", "2026-11-06T03:00:00Z");
    assert.equal(envios.length, 0);
  } finally {
    config.manychat.flowDisparo = original;
  }
  const data = config.disparo.data;
  config.disparo.data = "";
  try {
    await simular("2026-11-05T22:00:00Z", "2026-11-06T03:00:00Z");
    assert.equal(envios.length, 0);
  } finally {
    config.disparo.data = data;
  }
});

test("app ligado depois das 22h não começa o disparo", async () => {
  await simular("2026-11-06T01:05:00Z", "2026-11-06T03:00:00Z");
  assert.equal(envios.length, 0);
});

test("fila que atrasou não sai depois da meia-noite", async () => {
  agora = new Date("2026-11-05T23:00:00Z");
  agendamento.setRelogio(() => agora);
  const fila = await disparo.rodarDisparo(agora);
  assert.equal(fila.novos, 3, "a fila foi criada");
  agora = new Date("2026-11-06T03:05:00Z");
  await agendamento.processarTarefas();
  assert.equal(envios.length, 0);
});
