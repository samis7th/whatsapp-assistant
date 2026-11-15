const test = require("node:test");
const assert = require("node:assert/strict");

// E-mails de lembrete da aula pelo Brevo, junto com o WhatsApp, com Monday, ManyChat,
// Brevo e Telegram simulados.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.AULA_DATA = "2026-10-29";
process.env.AULA_INSCRICOES_DESDE = "2026-10-14";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";
process.env.MANYCHAT_FLOW_AULA_3DIAS = "content20261021000000_000003";
process.env.MANYCHAT_FLOW_AULA_AMANHA = "content20261021000000_000004";
process.env.MANYCHAT_FLOW_AULA_HOJE = "content20261021000000_000005";
process.env.MANYCHAT_FLOW_AULA_AOVIVO = "content20261021000000_000006";
process.env.MANYCHAT_FLOW_AULA_1HORA = "content20261021000000_000007";
process.env.MANYCHAT_FLOW_AULA_AMIGA = "content20261021000000_000008";
process.env.AULA_LINK = "https://meet.example.com/aula-2910";
process.env.BREVO_API_KEY = "xkeysib-teste";
process.env.INTERNO_SECRET = "chave-interna-de-teste-com-mais-de-32-caracteres";
process.env.BREVO_MODELO_AULA_3DIAS = "11";
process.env.BREVO_MODELO_AULA_AMANHA = "12";
process.env.BREVO_MODELO_AULA_1HORA = "13";
process.env.BREVO_MODELO_AULA_AOVIVO = "14";

const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");
const aula = require("../src/services/aula.service");
const email = require("../src/services/email.service");
const monitor = require("../src/services/monitor.service");

function respostaJson(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, headers: new Map() };
}

// ---------- Monday simulada: quadro com inscritos de várias turmas ----------
const quadro = { itens: [], chamadas: 0, falhar: false, obs: {}, grupo: {}, etapa: {}, comentarios: [] };

// Etapa do Funil, Data de Cadastro (AAAA-MM-DD) e e-mail.
function item(id, nome, telefone, etapa, cadastro, mail = "", grupo = "") {
  return { id, nome, telefone, etapa, cadastro: (cadastro || "").slice(0, 10), criadoEm: "2026-09-01T12:00:00Z", grupo, email: mail };
}

// Atualizações do cadastro (pedido para não receber avisos) não contam como leitura.
function gravacaoMonday(query, variables) {
  if (query.includes("query Obs")) {
    return respostaJson({ data: { items: [{ column_values: [{ text: "" }] }] } });
  }
  if (query.includes("columns")) {
    const columns = [
      { id: "fat", title: "Faturamento Mensal", type: "status" },
      { id: "etapa", title: "Etapa do Funil", type: "status" },
      { id: "prox", title: "Próximo Contato", type: "date" },
      { id: "ult", title: "Último Contato", type: "date" },
      { id: "cad", title: "Data de Cadastro", type: "date" },
      { id: "grupo", title: "Grupo WhatsApp", type: "status" },
    ];
    return respostaJson({ data: { boards: [{ columns }] } });
  }
  if (query.includes("change_multiple_column_values")) {
    const valores = JSON.parse(variables.valores);
    if (valores.obs) quadro.obs[variables.itemId] = valores.obs.text;
    if ("grupo" in valores) quadro.grupo[variables.itemId] = valores.grupo?.label || "";
    if ("etapa" in valores) quadro.etapa[variables.itemId] = valores.etapa?.label || "";
    return respostaJson({ data: { change_multiple_column_values: { id: variables.itemId } } });
  }
  if (query.includes("create_update")) {
    quadro.comentarios.push({ itemId: variables.itemId, texto: variables.texto });
    return respostaJson({ data: { create_update: { id: "1" } } });
  }
  return null;
}

monday.setFetch(async (url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const gravacao = gravacaoMonday(query, variables);
  if (gravacao) return gravacao;
  quadro.chamadas++;
  if (quadro.falhar) return respostaJson({ error_message: "fora" }, 500);
  assert.match(query, /DateValue \{ date \}/);
  const items = quadro.itens.map((i) => ({
    id: i.id,
    name: i.nome,
    created_at: i.criadoEm,
    column_values: [
      { id: "phonenhzs51c9", text: i.telefone, phone: i.telefone },
      { id: "emailhnvgrjbb", text: i.email, email: i.email },
      { id: "etapa", text: quadro.etapa[i.id] ?? i.etapa, label: (quadro.etapa[i.id] ?? i.etapa) || null },
      { id: "cad", text: i.cadastro, date: i.cadastro || null },
      { id: "grupo", text: quadro.grupo[i.id] ?? i.grupo, label: (quadro.grupo[i.id] ?? i.grupo) || null },
    ],
  }));
  return respostaJson({ data: { boards: [{ items_page: { cursor: null, items } }] } });
});

const mc = { chamadas: [], proximoId: 100 };
manychat.setFetch(async (url, init) => {
  const u = new URL(url);
  const corpo = init.body ? JSON.parse(init.body) : null;
  mc.chamadas.push({ caminho: u.pathname, corpo });
  if (mc.camposInexistentes?.has(corpo?.field_name)) {
    return respostaJson({ status: "error", message: "Validation error", details: { messages: { field_name: { message: "Field does not exist" } } } }, 400);
  }
  if (mc.semEtiqueta && u.pathname === "/fb/subscriber/addTagByName") {
    return respostaJson({ status: "error", message: "Validation error", details: { messages: { tag_name: { message: "Tag does not exist" } } } }, 400);
  }
  if (u.pathname === "/fb/subscriber/createSubscriber") {
    return respostaJson({ status: "success", data: { id: mc.proximoId++ } });
  }
  return respostaJson({ status: "success", data: {} });
});

// Brevo simulado: guarda cada e-mail enviado.
const brevo = { envios: [], status: 201, headers: [] };
email.setFetch(async (url, init) => {
  assert.equal(url, "https://api.brevo.com/v3/smtp/email");
  brevo.headers.push(init.headers);
  if (brevo.status >= 400) return respostaJson({ code: "invalid_parameter", message: "templateId is not valid" }, brevo.status);
  brevo.envios.push(JSON.parse(init.body));
  return respostaJson({ messageId: "<1@brevo>" }, brevo.status);
});

const avisos = [];
// Resumo de envio concluído vai à parte (os testes contam os avisos de cada leitura).
const concluidos = [];
telegram.setFetch(async (url, init) => {
  const texto = JSON.parse(init.body).text;
  (/concluído/.test(texto) ? concluidos : avisos).push(texto);
  return respostaJson({ ok: true, result: {} });
});

let store;

test.beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
  quadro.itens = [
    item("1", "ANA souza", "+5511912345678", "Lead", "2026-10-15", "Ana@Exemplo.com "),
    item("2", "Bia Lima", "21 98765-4321", "Cliente Low Ticket", "2026-10-20", "bia@exemplo.com"),
    item("3", "Aguardando pagamento", "+5531999990000", "Aguardando pagamento", "2026-03-01", "antiga@exemplo.com"),
    item("4", "Ex-cliente", "+5541988887777", "Deixou de ser cliente", "2026-10-16", "lead@exemplo.com"),
    item("5", "Carla sem telefone", "", "Lead", "2026-10-17", "carla@exemplo.com"),
    item("6", "Ana duplicada", "(11) 91234-5678", "A Definir", "", "ana@exemplo.com"),
    item("7", "Dani e-mail errado", "+5511955554444", "Lead", "2026-10-18", "dani@"),
  ];
  brevo.envios.length = 0;
  brevo.status = 201;
  quadro.chamadas = 0;
  quadro.falhar = false;
  quadro.obs = {};
  quadro.grupo = {};
  quadro.etapa = {};
  quadro.comentarios = [];
  mc.chamadas.length = 0;
  avisos.length = 0;
  concluidos.length = 0;
});

// 10h em Brasília = 13h UTC.
const em = (dia, horaUtc = 13) => new Date(`2026-10-${dia}T${String(horaUtc).padStart(2, "0")}:00:00Z`);
const fluxos = () => mc.chamadas.filter((c) => c.caminho === "/fb/sending/sendFlow").map((c) => c.corpo.flow_ns);

async function rodar(agora) {
  agendamento.setRelogio(() => agora);
  const r = await aula.rodarLembretesAula(agora);
  await agendamento.processarTarefas();
  return r;
}

const enviadosPara = () => brevo.envios.map((e) => e.to[0].email).sort();

test("3 dias antes: e-mail com o modelo do dia para cada endereço da turma, junto com o WhatsApp", async () => {
  const r = await rodar(em(26));
  assert.deepEqual(r, { status: "enviado", tipo: "3dias", novos: 3, semTelefone: 1, emails: 3 });

  // Endereço repetido (Ana, com maiúscula e espaço) sai uma vez só; quem não tem telefone
  // (Carla) recebe o e-mail; e-mail inválido, ex-cliente e quem não pagou ficam de fora.
  assert.deepEqual(enviadosPara(), ["ana@exemplo.com", "bia@exemplo.com", "carla@exemplo.com"]);
  const ana = brevo.envios.find((e) => e.to[0].email === "ana@exemplo.com");
  assert.deepEqual(ana, {
    templateId: 11,
    to: [{ email: "ana@exemplo.com", name: "ANA souza" }],
    params: { NOME: "Ana", DATA_AULA: "29/10", HORA_AULA: "20h", LINK_AULA: "https://meet.example.com/aula-2910" },
  });
  assert.equal(brevo.headers[0]["api-key"], "xkeysib-teste");
  assert.equal(fluxos().length, 3, "o WhatsApp sai normalmente");
  assert.equal(avisos.length, 0, "v2.13.0: sem mensagem no começo do envio");
  assert.ok(concluidos.some((t) => /E-mail da aula \(faltam 3 dias\) concluído/.test(t) && /Enviados: 3/.test(t)));
  // Quem ficou de fora vai só no resumo do WhatsApp (não repete no dos e-mails).
  assert.ok(concluidos.some((t) => /Lembrete da aula \(faltam 3 dias\) concluído/.test(t) && /Turma de 29\/10/.test(t)));
  assert.ok(!concluidos.some((t) => /E-mail da aula/.test(t) && /Turma de/.test(t)));

  // Mesmo dia de novo: não repete.
  assert.equal((await rodar(em(26, 18))).status, "ja_feito");
  assert.equal(brevo.envios.length, 3);
});

test("cada lembrete com seu modelo; o convite para amiga e o 'hoje' não têm e-mail", async () => {
  await rodar(em(26));
  await rodar(em(27)); // amiga: só WhatsApp
  await rodar(em(28));
  await rodar(em(29)); // hoje: só WhatsApp
  await rodar(em(29, 22)); // 19h
  await rodar(em(29, 23)); // 20h
  const porModelo = {};
  for (const envio of brevo.envios) porModelo[envio.templateId] = (porModelo[envio.templateId] || 0) + 1;
  assert.deepEqual(porModelo, { 11: 3, 12: 3, 13: 3, 14: 3 });
});

test("'Não quer receber mensagens' na Monday: sem e-mail também", async () => {
  quadro.itens[1].etapa = "Não quer receber mensagens"; // Bia
  await rodar(em(26));
  assert.deepEqual(enviadosPara(), ["ana@exemplo.com", "carla@exemplo.com"]);
});

test("sem o WhatsApp do dia configurado, o e-mail sai sozinho", async () => {
  const original = config.manychat.flowAula.tresDias;
  config.manychat.flowAula.tresDias = "";
  try {
    const r = await rodar(em(26));
    assert.equal(r.emails, 3);
    assert.equal(fluxos().length, 0);
    // Sem WhatsApp, quem ficou de fora vai no resumo dos e-mails.
    assert.ok(concluidos.some((t) => /E-mail da aula \(faltam 3 dias\) concluído/.test(t) && /Turma de 29\/10/.test(t)));
  } finally {
    config.manychat.flowAula.tresDias = original;
  }
});

test("sem modelo do Brevo para o dia: só o WhatsApp", async () => {
  const original = config.brevo.modelosAula["3dias"];
  config.brevo.modelosAula["3dias"] = null;
  try {
    const r = await rodar(em(26));
    assert.equal(r.emails, undefined);
    assert.equal(brevo.envios.length, 0);
    assert.equal(fluxos().length, 3);
  } finally {
    config.brevo.modelosAula["3dias"] = original;
  }
});

test("Brevo recusa (modelo inválido): não repete, marca como falha e avisa o grupo", async () => {
  brevo.status = 400;
  await rodar(em(26));
  const tarefa = await store.tarefaPorChave("aula_email:2026-10-29:3dias:bia@exemplo.com");
  assert.equal(tarefa.status, "falhou");
  assert.match(tarefa.erro, /O Brevo recusou o e-mail \(400\)/);
  assert.ok(avisos.some((t) => /Falha: e-mail da aula/.test(t)));
});

test("e-mail que não saiu a tempo não sai atrasado", async () => {
  agendamento.setRelogio(() => em(26));
  await aula.rodarLembretesAula(em(26));
  agendamento.setRelogio(() => em(27));
  await agendamento.processarTarefas();
  assert.equal(brevo.envios.length, 0);
  const tarefa = await store.tarefaPorChave("aula_email:2026-10-29:3dias:ana@exemplo.com");
  assert.equal(tarefa.status, "ignorado");
});

test("tela Sistema: Brevo e modelos aparecem nas conexões, sem o e-mail no detalhe", async () => {
  await rodar(em(26));
  const r = await monitor.retrato(em(26, 14));
  const nomes = JSON.stringify(r);
  assert.match(nomes, /Brevo \(e-mails da aula\)/);
  assert.match(nomes, /E-mail: faltam 3 dias/);
  assert.doesNotMatch(nomes, /bia@exemplo\.com/);
});

test("validação de e-mail", () => {
  assert.equal(email.emailValido("ana@exemplo.com"), true);
  assert.equal(email.emailValido("ana@exemplo"), false);
  assert.equal(email.emailValido("dani@"), false);
  assert.equal(email.emailValido("a b@c.com"), false);
  assert.equal(email.emailValido(""), false);
});

test("diagnóstico: manda um e-mail de teste com o modelo e os dados da turma", async () => {
  const express = require("express");
  const app = express();
  app.use("/interno", require("../src/routes/interno.routes"));
  const servidor = app.listen(0);
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/interno/diagnostico/email/enviar`;
    const headers = { "x-interno-key": process.env.INTERNO_SECRET };
    const ok = await fetch(`${base}?email=Maria@Exemplo.com&modelo=1hora&nome=maria%20t`, { method: "POST", headers });
    assert.equal(ok.status, 200);
    assert.deepEqual(brevo.envios.at(-1), {
      templateId: 13,
      to: [{ email: "maria@exemplo.com", name: "maria t" }],
      params: { NOME: "Maria", DATA_AULA: "29/10", LINK_AULA: "https://meet.example.com/aula-2910" },
    });
    assert.equal((await fetch(`${base}?email=x&modelo=1hora`, { method: "POST", headers })).status, 400);
    assert.equal((await fetch(`${base}?email=a@b.com&modelo=amiga`, { method: "POST", headers })).status, 400);
    brevo.status = 401;
    const recusado = await (await fetch(`${base}?email=a@b.com&modelo=3dias`, { method: "POST", headers })).json();
    assert.match(recusado.erro, /O Brevo recusou o e-mail \(401\)/);
  } finally {
    servidor.close();
  }
});
