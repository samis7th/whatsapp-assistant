const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

// Agendamento pelo Calendly + lembretes, com Monday, Telegram e ManyChat simulados.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.CALENDLY_URL = "https://calendly.com/consultor/reuniao";
process.env.CALENDLY_WEBHOOK_SECRET = "segredo-do-calendly-com-mais-de-32-caracteres";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";
process.env.MANYCHAT_FLOW_LEMBRETE = "content20261020000000_000001";

const app = require("../src/app");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const telegram = require("../src/services/telegram.service");
const manychat = require("../src/services/manychat.service");
const agendamento = require("../src/services/agendamento.service");
const { processarPendentes } = require("../src/services/preatendimento.service");

const CHAVE = process.env.MANYCHAT_SECRET;
const SEGREDO = process.env.CALENDLY_WEBHOOK_SECRET;

// ---------- simulações ----------
const fake = { itens: [], gravacoes: [], comentarios: [], obs: {}, falharMonday: false };
const avisos = [];
const manychatChamadas = [];
let manychatFora = false;

function respostaJson(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, headers: new Map() };
}

async function mondaySimulada(url, init) {
  const { query, variables } = JSON.parse(init.body);

  if (query.includes("query Obs")) {
    const itemId = variables.itemId[0];
    if (variables.coluna[0] === "etapa") {
      const ultima = [...fake.gravacoes].reverse().find((g) => g.itemId === itemId && g.valores.etapa);
      return respostaJson({ data: { items: [{ column_values: [{ text: fake.etapaAtual ?? ultima?.valores.etapa.label ?? "" }] }] } });
    }
    return respostaJson({ data: { items: [{ column_values: [{ text: fake.obs[itemId] || "" }] }] } });
  }

  if (query.includes("items_page")) {
    return respostaJson({
      data: {
        boards: [
          {
            items_page: {
              cursor: null,
              items: fake.itens.map((item) => ({
                id: item.id,
                name: item.nome,
                column_values: [{ id: "phonenhzs51c9", text: item.telefone, phone: item.telefone }],
              })),
            },
          },
        ],
      },
    });
  }

  if (query.includes("columns")) {
    return respostaJson({
      data: {
        boards: [
          {
            columns: [
              { id: "fat", title: "Faturamento Mensal", type: "status" },
              { id: "etapa", title: "Etapa do Funil", type: "status" },
              { id: "prox", title: "Próximo Contato", type: "date" },
              { id: "ult", title: "Último Contato", type: "date" },
              { id: "obs", title: "OBS", type: "long_text" },
            ],
          },
        ],
      },
    });
  }

  if (fake.falharMonday) {
    return respostaJson({ error_message: "Internal error" }, 500);
  }

  if (fake.inativo && (query.includes("change_multiple_column_values") || query.includes("create_update"))) {
    return respostaJson({ errors: [{ message: "Cannot change column value for inactive items" }] });
  }

  if (query.includes("change_multiple_column_values")) {
    const valores = JSON.parse(variables.valores);
    delete valores.ult;
    if (valores.obs) fake.obs[variables.itemId] = valores.obs.text;
    fake.gravacoes.push({ itemId: variables.itemId, valores });
    return respostaJson({ data: { change_multiple_column_values: { id: variables.itemId } } });
  }

  if (query.includes("create_update")) {
    fake.comentarios.push({ itemId: variables.itemId, texto: variables.texto });
    return respostaJson({ data: { create_update: { id: "1" } } });
  }

  throw new Error(`query inesperada: ${query}`);
}

telegram.setFetch(async (url, init) => {
  avisos.push(JSON.parse(init.body).text);
  return respostaJson({ ok: true, result: {} });
});

manychat.setFetch(async (url, init) => {
  if (manychatFora) {
    return respostaJson({ status: "error", message: "fora do ar" }, 500);
  }
  const caminho = new URL(url).pathname;
  manychatChamadas.push({ caminho, corpo: JSON.parse(init.body), auth: init.headers.Authorization });
  return respostaJson({ status: "success", data: caminho.endsWith("createSubscriber") ? { id: 4242 } : {} });
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

// Com TEST_DB_HOST definido, roda no MySQL/MariaDB de verdade.
const dbTeste = process.env.TEST_DB_HOST
  ? {
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT || 3306),
      user: process.env.TEST_DB_USER || "root",
      password: process.env.TEST_DB_PASSWORD || "",
      database: process.env.TEST_DB_NAME || "pa",
    }
  : null;
const mysqlStore = dbTeste ? require("../src/db/mysql-store").createMysqlStore(dbTeste) : null;

test.after(async () => {
  servidor.close();
  if (mysqlStore) await mysqlStore.close();
});

test.beforeEach(async () => {
  if (mysqlStore) {
    await mysqlStore.init();
    const limpar = require("mysql2/promise").createPool(dbTeste);
    await limpar.query("TRUNCATE TABLE preatendimentos");
    await limpar.query("TRUNCATE TABLE preatendimento_tarefas");
    await limpar.query("TRUNCATE TABLE manychat_contatos");
    await limpar.end();
    store = mysqlStore;
  } else {
    store = createMemoryStore();
  }
  setStore(store);
  monday.setFetch(mondaySimulada);
  fake.itens = [
    { id: "101", nome: "Ana Souza", telefone: "+5511912345678" },
    { id: "102", nome: "Bia Lima", telefone: "+5521987654321" },
  ];
  fake.gravacoes = [];
  fake.comentarios = [];
  fake.obs = {};
  fake.falharMonday = false;
  avisos.length = 0;
  manychatChamadas.length = 0;
  manychatFora = false;
});

async function chamar(rota, body) {
  const response = await fetch(`${base}/manychat/${rota}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": CHAVE },
    body: JSON.stringify(body),
  });
  return response.json();
}

// Lead que passou pela Mani e foi qualificada (recebeu o link).
async function qualificar(contatoId = "c1", telefone = "11912345678") {
  await chamar("telefone", { contato_id: contatoId, whatsapp: "+5511900001111", nome: "Ana", telefone });
  const f = await chamar("faturamento", { contato_id: contatoId, resposta: "20 mil" });
  assert.equal(f.resultado, "qualificada");
  await processarPendentes();
  fake.gravacoes = [];
  fake.comentarios = [];
  return (await store.todos()).find((linha) => linha.contatoId === contatoId);
}

function convidado({ ref, evento = "EV1", invitee = "INV1", inicio = "2026-10-23T18:00:00.000000Z", telefone, oldInvitee, rescheduled = false, motivo }) {
  return {
    uri: `https://api.calendly.com/scheduled_events/${evento}/invitees/${invitee}`,
    name: "Ana S.",
    email: "ana@exemplo.com",
    text_reminder_number: null,
    rescheduled,
    old_invitee: oldInvitee || null,
    questions_and_answers: telefone ? [{ question: "WhatsApp", answer: telefone }] : [],
    tracking: { utm_source: ref ? "mani" : null, utm_content: ref || null },
    scheduled_event: { uri: `https://api.calendly.com/scheduled_events/${evento}`, start_time: inicio },
    cancellation: motivo ? { reason: motivo, canceled_by: "Ana S." } : null,
  };
}

async function webhook(event, payload, { assinatura, t = Math.floor(Date.now() / 1000) } = {}) {
  const corpo = JSON.stringify({ event, payload });
  const v1 = crypto.createHmac("sha256", SEGREDO).update(`${t}.${corpo}`).digest("hex");
  const response = await fetch(`${base}/calendly/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Calendly-Webhook-Signature": assinatura ?? `t=${t},v1=${v1}`,
    },
    body: corpo,
  });
  await agendamento.processarTarefas();
  return { status: response.status, ...(await response.json()) };
}

// ---------- testes ----------

test("webhook sem assinatura, com assinatura errada ou antiga: recusado", async () => {
  assert.equal((await webhook("invitee.created", convidado({}), { assinatura: "" })).status, 401);
  assert.equal((await webhook("invitee.created", convidado({}), { assinatura: "t=1,v1=abc" })).status, 401);
  const antigo = Math.floor(Date.now() / 1000) - 600;
  assert.equal((await webhook("invitee.created", convidado({}), { t: antigo })).status, 401);
  assert.equal(avisos.length, 0);
});

test("agendou pelo link da Mani: Reunião Marcada, data no Próximo Contato, OBS e aviso no grupo", async () => {
  const lead = await qualificar();
  assert.equal(fake.obs["101"], "Aguardando agendamento");

  const r = await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  assert.equal(r.status, 200);
  assert.equal(r.vinculado, true);

  assert.deepEqual(fake.gravacoes, [
    {
      itemId: "101",
      valores: {
        etapa: { label: "Reunião Marcada" },
        prox: { date: "2026-10-23", time: "18:00:00" },
        obs: { text: "Reunião marcada 23/10 às 15:00" },
      },
    },
  ]);
  assert.equal(fake.obs["101"], "Reunião marcada 23/10 às 15:00", "substitui o 'Aguardando agendamento'");
  assert.match(fake.comentarios[0].texto, /Reunião agendada pelo Calendly/);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /📅 <b>Reunião agendada<\/b>/);
  assert.match(avisos[0], /👤 Ana Souza/);
  assert.match(avisos[0], /23\/10 às 15:00/);
  assert.match(avisos[0], /WhatsApp: \+55 11 90000-1111/);
  assert.doesNotMatch(avisos[0], /R\$|\bmil\b|Faixa|faturamento/i, "o faturamento não vai para o grupo");

  const linha = await store.porId(lead.id);
  assert.equal(linha.agendamento, "agendado");

  // O Calendly pode reenviar o mesmo aviso: nada se repete.
  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  assert.equal(fake.gravacoes.length, 1);
  assert.equal(avisos.length, 1);
});

test("remarcou: atualiza a data e avisa 'remarcada', mesmo sem o código no novo agendamento", async () => {
  const lead = await qualificar();
  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  const antigo = convidado({ ref: lead.refAgendamento }).uri;

  const cancelamento = await webhook("invitee.canceled", convidado({ ref: lead.refAgendamento, rescheduled: true }));
  assert.equal(cancelamento.ignorado, "remarcacao");

  await webhook(
    "invitee.created",
    convidado({ evento: "EV2", invitee: "INV2", inicio: "2026-10-24T13:30:00Z", oldInvitee: antigo })
  );

  assert.equal(fake.gravacoes.length, 2);
  assert.deepEqual(fake.gravacoes[1].valores.prox, { date: "2026-10-24", time: "13:30:00" });
  assert.deepEqual(fake.gravacoes[1].valores.etapa, { label: "Reunião Marcada" });
  assert.equal(fake.obs["101"], "Reunião reagendada 24/10 às 10:30");
  assert.equal(avisos.length, 2);
  assert.match(avisos[1], /🔁 <b>Reunião remarcada<\/b>/);
  assert.match(avisos[1], /Nova data: .*24\/10 às 10:30/);
});

test("cancelou: Etapa vira 'Reunião cancelada', avisa o grupo e não volta aos lembretes", async () => {
  const lead = await qualificar();
  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  fake.gravacoes = [];
  fake.etapaAtual = "Reunião Marcada";

  await webhook("invitee.canceled", convidado({ ref: lead.refAgendamento, motivo: "Imprevisto" }));
  fake.etapaAtual = undefined;
  assert.equal(fake.gravacoes.length, 1);
  assert.deepEqual(fake.gravacoes[0].valores.etapa, { label: "Reunião cancelada" });
  assert.equal(avisos.length, 2);
  assert.match(avisos[1], /❌ <b>Reunião cancelada<\/b>/);
  assert.match(avisos[1], /Era em: .*23\/10 às 15:00/);
  assert.match(avisos[1], /Motivo: Imprevisto/);
  assert.equal((await store.porId(lead.id)).agendamento, "cancelado");

  await store.atualizar(lead.id, { concluidoEm: new Date("2026-10-01T15:00:00Z") });
  await agendamento.rodarLembretes(new Date("2026-10-30T14:00:00Z"));
  await agendamento.processarTarefas();
  assert.equal(manychatChamadas.length, 0);
});

test("agendou sem o código, mas com o WhatsApp no formulário: encontra a lead da Mani", async () => {
  const lead = await qualificar();
  await webhook("invitee.created", convidado({ telefone: "(11) 90000-1111" }));
  assert.equal((await store.porId(lead.id)).agendamento, "agendado");
  assert.equal(fake.gravacoes[0].itemId, "101");
});

test("agendou sem passar pela Mani: acha o cadastro na Monday pelo telefone", async () => {
  await webhook("invitee.created", convidado({ telefone: "21 98765-4321" }));
  assert.equal(fake.gravacoes[0].itemId, "102");
  assert.equal(fake.gravacoes[0].valores.etapa.label, "Reunião Marcada");
  assert.match(avisos[0], /Reunião agendada/);
  assert.match(avisos[0], /pulses\/102|👤/);
});

test("agendou e ninguém foi encontrado: avisa o grupo para conferir, sem mexer na Monday", async () => {
  await webhook("invitee.created", convidado({ telefone: "31 99999-1234" }));
  assert.equal(fake.gravacoes.length, 0);
  assert.match(avisos[0], /Não encontrei o cadastro na Monday/);
  assert.match(avisos[0], /ana@exemplo.com/);
});

test("'Não quero marcar a reunião': Etapa vira 'Não agendou', OBS muda, sem aviso e sem lembretes", async () => {
  const lead = await qualificar();
  assert.deepEqual(await chamar("recusa", { contato_id: "c1" }), {
    primeiro_nome: "",
    valor_texto: "",
    motivo: "",
    link_agendamento: "",
    resultado: "ok",
  });
  await agendamento.processarTarefas();

  assert.deepEqual(fake.gravacoes, [
    { itemId: "101", valores: { etapa: { label: "Não agendou" }, obs: { text: "Não quis agendar reunião" } } },
  ]);
  assert.match(fake.comentarios[0].texto, /não quer agendar/);
  assert.equal(avisos.length, 0);

  await store.atualizar(lead.id, { concluidoEm: new Date("2026-10-01T15:00:00Z") });
  await agendamento.rodarLembretes(new Date("2026-10-30T14:00:00Z"));
  await agendamento.processarTarefas();
  assert.equal(manychatChamadas.length, 0);

  // Clicar de novo não repete nada.
  await chamar("recusa", { contato_id: "c1" });
  await agendamento.processarTarefas();
  assert.equal(fake.gravacoes.length, 1);
});

test("cadastro arquivado/apagado na Monday: a recusa termina sem ficar tentando", async () => {
  await qualificar();
  fake.inativo = true;
  try {
    await chamar("recusa", { contato_id: "c1" });
    await agendamento.processarTarefas();
    const tarefa = (await store.todasTarefas()).find((t) => t.tipo === "recusou");
    assert.equal(tarefa.status, "ok");
    assert.equal(tarefa.tentativas, 0);
    assert.equal(fake.gravacoes.length, 0);
    assert.equal(avisos.length, 0, "sem alerta de falha");
  } finally {
    fake.inativo = false;
  }
});

test("'Não quero marcar' depois de já ter agendado: responde ja_agendado", async () => {
  const lead = await qualificar();
  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  assert.equal((await chamar("recusa", { contato_id: "c1" })).resultado, "ja_agendado");
});

test("lembretes: 1 por dia a partir das 10h, 5 no máximo, depois 'não agendou'", async () => {
  const lead = await qualificar();
  // Recebeu o link em 20/10 às 12h (Brasília).
  await store.atualizar(lead.id, { concluidoEm: new Date("2026-10-20T15:00:00Z") });

  const dia = (d, horaUtc) => new Date(`2026-10-${d}T${horaUtc}:00:00Z`);
  const rodar = async (agora) => {
    await agendamento.rodarLembretes(agora);
    await agendamento.processarTarefas();
  };

  await rodar(dia(20, 18)); // mesmo dia do link: nada
  await rodar(dia(21, 12)); // 9h em Brasília: ainda não
  assert.equal(manychatChamadas.length, 0);

  await rodar(dia(21, 13)); // 10h: 1º lembrete
  assert.deepEqual(
    manychatChamadas.map((c) => c.caminho),
    ["/fb/subscriber/setCustomFieldByName", "/fb/sending/sendFlow"]
  );
  assert.equal(manychatChamadas[0].auth, "Bearer chave-api-manychat");
  assert.equal(manychatChamadas[0].corpo.field_name, "link_agendamento");
  assert.match(manychatChamadas[0].corpo.field_value, new RegExp(`utm_content=${lead.refAgendamento}`));
  assert.equal(manychatChamadas[1].corpo.flow_ns, "content20261020000000_000001");

  await rodar(dia(21, 20)); // mesmo dia de novo: nada
  assert.equal(manychatChamadas.filter((c) => c.caminho.endsWith("sendFlow")).length, 1);

  for (const d of [22, 23, 24, 25]) await rodar(dia(d, 13));
  assert.equal(manychatChamadas.filter((c) => c.caminho.endsWith("sendFlow")).length, 5);
  assert.equal((await store.porId(lead.id)).lembretes, 5);

  await rodar(dia(26, 13)); // dia seguinte ao 5º: não agendou
  assert.equal(manychatChamadas.filter((c) => c.caminho.endsWith("sendFlow")).length, 5);
  assert.equal((await store.porId(lead.id)).agendamento, "nao_agendou");
  assert.deepEqual(fake.gravacoes, [
    { itemId: "101", valores: { etapa: { label: "Não respondeu" }, obs: { text: "Não respondeu aos 5 lembretes" } } },
  ]);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /⏳ <b>Não respondeu aos lembretes<\/b>/);
  assert.match(avisos[0], /5 lembretes/);

  await rodar(dia(27, 13));
  assert.equal(avisos.length, 1);
});

test("lembretes param quando a pessoa agenda", async () => {
  const lead = await qualificar();
  await store.atualizar(lead.id, { concluidoEm: new Date("2026-10-20T15:00:00Z") });
  await agendamento.rodarLembretes(new Date("2026-10-21T13:00:00Z"));
  await agendamento.processarTarefas();
  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  await agendamento.rodarLembretes(new Date("2026-10-22T13:00:00Z"));
  await agendamento.processarTarefas();
  assert.equal(manychatChamadas.filter((c) => c.caminho.endsWith("sendFlow")).length, 1);
});

test("ManyChat fora: o lembrete do dia é reenviado depois, uma vez só", async () => {
  const lead = await qualificar();
  await store.atualizar(lead.id, { concluidoEm: new Date("2026-10-20T15:00:00Z") });
  manychatFora = true;
  await agendamento.rodarLembretes(new Date("2026-10-21T13:00:00Z"));
  await agendamento.processarTarefas();
  assert.equal(manychatChamadas.length, 0);

  manychatFora = false;
  for (const tarefa of await store.todasTarefas()) await store.atualizarTarefa(tarefa.id, { proxima: null });
  await agendamento.processarTarefas();
  await agendamento.processarTarefas();
  assert.equal(manychatChamadas.filter((c) => c.caminho.endsWith("sendFlow")).length, 1);
});

test("Monday fora no agendamento: grupo avisado uma vez e Monday gravada no reenvio", async () => {
  const lead = await qualificar();
  fake.falharMonday = true;
  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  assert.equal(avisos.length, 0, "aviso só depois da Monday, na ordem");

  fake.falharMonday = false;
  for (const tarefa of await store.todasTarefas()) await store.atualizarTarefa(tarefa.id, { proxima: null });
  await agendamento.processarTarefas();
  assert.equal(fake.gravacoes.length, 1);
  assert.equal(avisos.length, 1);
});

test("lembrete puxado pelo ManyChat (sem API): enviar 1x por dia, 5 no máximo, depois nao_agendou", async () => {
  const lead = await qualificar();
  await store.atualizar(lead.id, { concluidoEm: new Date("2026-10-20T15:00:00Z") });
  const pedir = (d) => agendamento.proximoLembrete({ contatoId: "c1", agora: new Date(`2026-10-${d}T14:00:00Z`) });

  assert.deepEqual(await pedir(20), { resultado: "aguardar" }, "mesmo dia do link");

  const primeiro = await pedir(21);
  assert.equal(primeiro.resultado, "enviar");
  assert.match(primeiro.link_agendamento, new RegExp(`utm_content=${lead.refAgendamento}`));
  assert.deepEqual(await pedir(21), { resultado: "aguardar" }, "repetido no mesmo dia não manda de novo");

  for (const d of [22, 23, 24, 25]) assert.equal((await pedir(d)).resultado, "enviar");
  assert.equal((await pedir(26)).resultado, "nao_agendou");
  await agendamento.processarTarefas();
  assert.equal(fake.obs["101"], "Não respondeu aos 5 lembretes");
  assert.match(avisos[0], /Não respondeu aos lembretes/);
  assert.equal((await pedir(27)).resultado, "parar");
  assert.equal(manychatChamadas.length, 0, "não usa a API do ManyChat");
});

test("lembrete puxado: para quando agendou ou recusou; pela rota HTTP também", async () => {
  const lead = await qualificar();
  await store.atualizar(lead.id, { concluidoEm: new Date("2026-10-01T15:00:00Z") });
  assert.equal((await chamar("lembrete", { contato_id: "c1" })).resultado, "enviar");
  assert.equal((await chamar("lembrete", { contato_id: "c1" })).resultado, "aguardar");

  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  assert.equal((await agendamento.proximoLembrete({ contatoId: "c1", agora: new Date("2026-12-01T14:00:00Z") })).resultado, "parar");

  assert.equal((await chamar("lembrete", { contato_id: "desconhecido" })).resultado, "parar");
});

test("registro do webhook: organização recusada cai para o usuário; já existente não recria", async () => {
  process.env.CALENDLY_TOKEN = "";
  const calendly = require("../src/services/calendly.service");
  const { config } = require("../src/config/env");
  const chamadas = [];
  let existentes = [];
  let recusarOrganizacao = true;

  // config é congelado: o token vem por um objeto de teste sobre o original.
  Object.defineProperty(config.calendly, "token", { value: "tok", configurable: true, writable: true });

  calendly.setFetch(async (url, init) => {
    const u = new URL(url);
    chamadas.push(`${init.method} ${u.pathname} ${u.searchParams.get("scope") || (init.body ? JSON.parse(init.body).scope : "")}`);
    if (u.pathname === "/users/me") {
      return respostaJson({ resource: { uri: "https://api.calendly.com/users/U1", current_organization: "https://api.calendly.com/organizations/O1" } });
    }
    if (init.method === "GET") {
      return respostaJson({ collection: existentes });
    }
    const corpo = JSON.parse(init.body);
    if (corpo.scope === "organization" && recusarOrganizacao) {
      return respostaJson({ title: "Invalid Argument", message: "The supplied parameters are invalid.", details: [{ parameter: "scope", message: "não permitido" }] }, 400);
    }
    assert.equal(corpo.signing_key, process.env.CALENDLY_WEBHOOK_SECRET);
    assert.deepEqual(corpo.events, ["invitee.created", "invitee.canceled"]);
    return respostaJson({ resource: {} }, 201);
  });

  try {
    assert.deepEqual(await calendly.garantirWebhook(), { status: "criado (usuário)" });
    assert.ok(chamadas.includes("POST /webhook_subscriptions organization"));
    assert.ok(chamadas.includes("POST /webhook_subscriptions user"));

    existentes = [{ callback_url: calendly.urlWebhook(), state: "active" }];
    chamadas.length = 0;
    assert.deepEqual(await calendly.garantirWebhook(), { status: "ativo" });
    assert.ok(!chamadas.some((c) => c.startsWith("POST")));

    existentes = [];
    recusarOrganizacao = false;
    assert.deepEqual(await calendly.garantirWebhook(), { status: "criado (organização)" });
  } finally {
    config.calendly.token = "";
  }
});

test("confirmação pelo WhatsApp: ao agendar e ao remarcar, com a data por extenso", async () => {
  const { config } = require("../src/config/env");
  config.manychat.flowConfirmacao = "flow_confirmacao";

  try {
    const lead = await qualificar();
    await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));

    const campo = manychatChamadas.find((c) => c.caminho === "/fb/subscriber/setCustomFieldByName");
    assert.deepEqual(
      { campo: campo.corpo.field_name, valor: campo.corpo.field_value },
      { campo: "reuniao_texto", valor: "sexta-feira, 23/10, às 15h" }
    );
    assert.deepEqual(
      manychatChamadas.filter((c) => c.caminho === "/fb/sending/sendFlow").map((c) => c.corpo.flow_ns),
      ["flow_confirmacao"]
    );
    assert.equal(avisos.length, 1, "o grupo continua recebendo o 📅");

    // Remarcou: nova confirmação com a nova data.
    const antigo = convidado({ ref: lead.refAgendamento }).uri;
    await webhook("invitee.canceled", convidado({ ref: lead.refAgendamento, rescheduled: true }));
    await webhook("invitee.created", convidado({ evento: "EV2", invitee: "INV2", inicio: "2026-10-24T13:30:00Z", oldInvitee: antigo }));
    const campos = manychatChamadas.filter((c) => c.caminho === "/fb/subscriber/setCustomFieldByName");
    assert.equal(campos.at(-1).corpo.field_value, "sábado, 24/10, às 10h30");

    // Mesmo aviso do Calendly de novo: não confirma duas vezes.
    await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
    assert.equal(manychatChamadas.filter((c) => c.caminho === "/fb/sending/sendFlow").length, 2);
  } finally {
    config.manychat.flowConfirmacao = "";
  }
});

test("confirmação: agendou sem passar pela Mani, cria o contato pelo WhatsApp do Calendly", async () => {
  const { config } = require("../src/config/env");
  config.manychat.flowConfirmacao = "flow_confirmacao";

  try {
    await webhook("invitee.created", convidado({ telefone: "21 98765-4321" }));
    const criado = manychatChamadas.find((c) => c.caminho === "/fb/subscriber/createSubscriber");
    assert.equal(criado.corpo.whatsapp_phone, "+5521987654321");
    assert.equal(manychatChamadas.filter((c) => c.caminho === "/fb/sending/sendFlow").length, 1);
  } finally {
    config.manychat.flowConfirmacao = "";
  }
});

test("cancelou com a pessoa já numa etapa mais adiante (ex.: Negócio fechado): a Etapa não volta", async () => {
  const lead = await qualificar();
  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  fake.gravacoes = [];
  fake.etapaAtual = "Negócio fechado";
  try {
    await webhook("invitee.canceled", convidado({ ref: lead.refAgendamento, motivo: "Fechou" }));
    assert.equal(fake.gravacoes.filter((g) => g.valores.etapa).length, 0);
  } finally {
    fake.etapaAtual = undefined;
  }
});

// ---------- origem do link no aviso do grupo (v3.5.0) ----------

function convidadoDaPagina(tracking, evento = "EV9") {
  return { ...convidado({ evento, invitee: "INV9", telefone: "21 98765-4321" }), tracking };
}

test("agendou pela página /reuniao-consultor: aviso com a origem e origemLink no registro da reunião", async () => {
  const tracking = { utm_source: "reuniao-consultor", utm_medium: "pagina", utm_campaign: "reuniao-consultor", utm_content: null, utm_term: null };
  await webhook("invitee.created", convidadoDaPagina(tracking));

  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /📅 <b>Reunião agendada<\/b>/);
  assert.match(avisos[0], /📍 Origem: página reunião-consultor/);
  assert.equal(fake.gravacoes[0].itemId, "102", "cadastro achado pelo telefone, como antes");

  const reunioesSvc = require("../src/services/reunioes.service");
  const registro = await store.tarefaPorChave(reunioesSvc.chaveRegistro("https://api.calendly.com/scheduled_events/EV9"));
  assert.equal(registro.dados.origemLink, "reuniao-consultor");
  assert.equal(registro.dados.situacao, "ativa", "lembretes da reunião seguem iguais");
});

test("agendou com outra origem: mostra o utm_source como veio (sem HTML); sem origem: sem a linha", async () => {
  await webhook("invitee.created", convidadoDaPagina({ utm_source: "insta<b>gram</b>" }, "EV10"));
  assert.doesNotMatch(avisos[0], /📍 Origem/, "só a página reuniao-consultor aparece");

  for (const [i, tracking] of [null, {}, { utm_source: null }, { utm_source: "  " }, { utm_source: { x: 1 } }].entries()) {
    avisos.length = 0;
    await webhook("invitee.created", convidadoDaPagina(tracking, `EV2${i}`));
    assert.equal(avisos.length, 1);
    assert.doesNotMatch(avisos[0], /Origem/, JSON.stringify(tracking));
  }
});

test("agendou pelo link da Mani: origem 'mani'; cancelamento não mostra a origem", async () => {
  const lead = await qualificar();
  await webhook("invitee.created", convidado({ ref: lead.refAgendamento }));
  assert.doesNotMatch(avisos[0], /📍 Origem/, "links da Mani não mostram origem");
  await webhook("invitee.canceled", convidado({ ref: lead.refAgendamento, motivo: "Imprevisto" }));
  assert.match(avisos[1], /Reunião cancelada/);
  assert.doesNotMatch(avisos[1], /Origem/);
});

test("origemDoLink: lê payload.tracking.utm_source com cuidado", () => {
  const { origemDoLink } = require("../src/services/reunioes.service");
  assert.equal(origemDoLink({ tracking: { utm_source: "reuniao-consultor" } }), "reuniao-consultor");
  assert.equal(origemDoLink({ tracking: { utm_source: " a\nb " } }), "ab");
  assert.equal(origemDoLink({ tracking: { utm_source: "x".repeat(100) } }).length, 60);
  assert.equal(origemDoLink({}), null);
  assert.equal(origemDoLink(null), null);
  assert.equal(origemDoLink({ tracking: null }), null);
  assert.equal(origemDoLink({ tracking: { utm_source: ["a"] } }), null);
});
