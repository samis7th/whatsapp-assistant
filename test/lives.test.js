const test = require("node:test");
const assert = require("node:assert/strict");

// Lembretes das lives semanais (quarta à noite, quinta 19h e 20h), com Monday,
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
process.env.LIVE_DATA = "2026-11-05, 2026-11-19";

const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");
const lives = require("../src/services/lives.service");

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
    await lives.rodarLembretesLives(agora);
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

test("semana normal: véspera quarta 19h30, 1 hora quinta 19h e começou 20h, para quem não pediu para parar", async () => {
  // Quarta 04/11 00h até sexta 06/11 00h (Brasília).
  await simular("2026-11-04T03:00:00Z", "2026-11-06T03:00:00Z");

  assert.deepEqual(primeiros(config.manychat.flowLive.vespera), { total: 3, primeiro: "qua., 19:30" });
  assert.deepEqual(primeiros(config.manychat.flowLive.umaHora), { total: 3, primeiro: "qui., 19:00" });
  assert.deepEqual(primeiros(config.manychat.flowLive.comecou), { total: 3, primeiro: "qui., 20:00" });
  assert.equal(envios.length, 9, "Ana, Bia e Duda (uma vez só); Cris fica de fora");
  assert.equal(resumos.length, 3);
  assert.match(resumos[0], /Lembrete da live \(véspera\)/);
  assert.match(resumos[0], /1 não quer receber/);
});

test("quinta fora de LIVE_DATA: nenhum lembrete de live", async () => {
  await simular("2026-11-11T03:00:00Z", "2026-11-13T03:00:00Z");
  assert.equal(envios.length, 0);
});

test("LIVE_DATA vazio desliga todos os lembretes de live", async () => {
  const original = config.lives.datas;
  config.lives.datas = [];
  try {
    await simular("2026-11-04T03:00:00Z", "2026-11-06T03:00:00Z");
    assert.equal(envios.length, 0);
  } finally {
    config.lives.datas = original;
  }
});

test("segunda data da lista também tem lembrete", async () => {
  await simular("2026-11-18T03:00:00Z", "2026-11-20T03:00:00Z");
  assert.equal(envios.length, 9);
});

test("fluxo vazio desliga só aquele lembrete", async () => {
  const original = config.manychat.flowLive.vespera;
  config.manychat.flowLive.vespera = "";
  try {
    await simular("2026-11-04T03:00:00Z", "2026-11-06T03:00:00Z");
    assert.equal(primeiros(original).total, 0);
    assert.equal(envios.length, 6);
  } finally {
    config.manychat.flowLive.vespera = original;
  }
});

test("lembrete atrasado não sai depois do horário (1 hora vence às 20h)", async () => {
  // Fila criada às 19h, mas o processamento só volta às 20h05.
  agora = new Date("2026-11-05T22:00:00Z");
  agendamento.setRelogio(() => agora);
  const fila = await lives.rodarLembretesLives(agora);
  assert.equal(fila.novos, 3, "a fila foi criada");
  agora = new Date("2026-11-05T23:05:00Z");
  await agendamento.processarTarefas();
  assert.equal(primeiros(config.manychat.flowLive.umaHora).total, 0);
});

test("tocou em 'Não quero receber' na véspera: marca a etiqueta e não recebe mais os da quinta", async () => {
  gravadas.length = 0;
  await simular("2026-11-04T22:30:00Z", "2026-11-04T22:40:00Z");
  const ana = envios.find((e) => e.flow === config.manychat.flowLive.vespera).contato;

  assert.deepEqual(await agendamento.pararAvisos({ contatoId: ana }), { resultado: "ok" });
  await agendamento.processarTarefas();
  assert.ok(gravadas.some((g) => g.itemId && JSON.stringify(g.valores).includes("Não quer receber mensagens")), "etiqueta gravada");

  await simular("2026-11-05T22:00:00Z", "2026-11-06T00:10:00Z");
  const quinta = envios.filter((e) => e.flow !== config.manychat.flowLive.vespera);
  assert.equal(quinta.length, 4, "2 lembretes x 2 pessoas (a que pediu ficou de fora)");
  assert.ok(!quinta.some((e) => e.contato === ana));
  inscritos[0][4] = "";
});

test("cada envio termina com um resumo no Telegram (enviados, pulados, falharam) e o log mostra quem recebeu", async () => {
  const linhas = [];
  const logOriginal = console.log;
  console.log = (texto) => linhas.push(String(texto));
  try {
    await simular("2026-11-04T22:30:00Z", "2026-11-04T23:00:00Z");
  } finally {
    console.log = logOriginal;
  }

  assert.equal(concluidos.length, 1, "um resumo só, mesmo rodando várias vezes");
  assert.match(concluidos[0], /Lembrete da live \(véspera\) concluído/);
  assert.match(concluidos[0], /Enviados: 3/);
  assert.match(concluidos[0], /Pulados: 0|Falharam: 0/);
  assert.equal(linhas.filter((l) => /live_lembrete \d+: enviado para/.test(l)).length, 3);
  assert.ok(linhas.some((l) => l.includes("enviado para Ana (+5511912345678)")));
});

test("inscritas pela LP das lives (Mentoria Gratuita, SDR, Presente Novo Seguidor, Chat GPT Ads) também recebem os lembretes das lives", async () => {
  inscritos.push(["6", "Eva", "+5551977776666", "Mentoria Gratuita", "", "2026-11-01T12:00:00Z"]);
  inscritos.push(["7", "Fê", "+5551966665555", "Presente Novo Seguidor", "", "2026-11-01T12:00:00Z"]);
  inscritos.push(["8", "Gabi", "+5551955554444", "Chat GPT Ads", "", "2026-11-01T12:00:00Z"]);
  inscritos.push(["9", "Hana", "+5551944443333", "Indicação", "Não quer receber mensagens", "2026-11-01T12:00:00Z"]);
  try {
    await simular("2026-11-04T22:30:00Z", "2026-11-04T23:00:00Z");
    assert.equal(primeiros(config.manychat.flowLive.vespera).total, 6, "Ana, Bia (SDR), Duda, Eva, Fê e Gabi (ChatGPT); Hana (não quer receber) fica de fora");
  } finally {
    inscritos.splice(-4);
  }
});
