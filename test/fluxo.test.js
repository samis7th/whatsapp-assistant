const test = require("node:test");
const assert = require("node:assert/strict");

// Fluxo completo pelo HTTP, como o ManyChat chama, com Monday e Telegram simulados.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.MONDAY_BOARD_URL = "https://exemplo.monday.com/boards/1234567890";
process.env.CALENDLY_URL = "https://calendly.com/consultor/reuniao";


const app = require("../src/app");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const telegram = require("../src/services/telegram.service");
const { processarPendentes } = require("../src/services/preatendimento.service");

const CHAVE = process.env.MANYCHAT_SECRET;

// ---------- Monday simulada ----------
const fake = {
  itens: [],
  falhar: null, // null | "tudo" | "gravar" | "limite"
  gravacoes: [],
  comentarios: [],
  obs: {},
  chamadas: 0,
};

function respostaJson(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, headers: new Map() };
}

async function mondaySimulada(url, init) {
  fake.chamadas++;
  const { query, variables } = JSON.parse(init.body);

  if (fake.falhar === "tudo") {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  }

  if (fake.falhar === "limite") {
    return respostaJson({ errors: [{ message: "Daily limit", extensions: { code: "DAILY_LIMIT_EXCEEDED" } }] }, 429);
  }

  if (query.includes("query Obs")) {
    const texto = fake.obs[variables.itemId[0]] || "";
    return respostaJson({ data: { items: [{ column_values: [{ text: texto }] }] } });
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
              { id: "prox", title: "Proximo Contato", type: "date" },
              { id: "ult", title: "ÚLTIMO CONTATO", type: "date" },
              ...(fake.semObs ? [] : [{ id: "obs", title: "OBS", type: "long_text" }]),
            ],
          },
        ],
      },
    });
  }

  if (fake.falhar === "gravar") {
    return respostaJson({ error_message: "Internal error" }, 500);
  }

  if (query.includes("change_multiple_column_values")) {
    const valores = JSON.parse(variables.valores);
    // Último Contato: data e hora de agora (UTC); confere aqui e tira para comparar o resto.
    assert.match(valores.ult?.date || "", /^\d{4}-\d{2}-\d{2}$/);
    assert.match(valores.ult?.time || "", /^\d{2}:\d{2}:\d{2}$/);
    assert.ok(Math.abs(new Date(`${valores.ult.date}T${valores.ult.time}Z`) - Date.now()) < 120000);
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

// ---------- Telegram simulado ----------
const avisos = [];
let telegramFora = false;

telegram.setFetch(async (url, init) => {
  if (telegramFora) {
    throw new Error("offline");
  }
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

// Com TEST_DB_HOST definido, o mesmo fluxo roda no MySQL/MariaDB de verdade.
const mysqlStore = process.env.TEST_DB_HOST
  ? require("../src/db/mysql-store").createMysqlStore({
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT || 3306),
      user: process.env.TEST_DB_USER || "root",
      password: process.env.TEST_DB_PASSWORD || "",
      database: process.env.TEST_DB_NAME || "pa",
    })
  : null;

test.after(async () => {
  servidor.close();
  if (mysqlStore) await mysqlStore.close();
});

test.beforeEach(async () => {
  if (mysqlStore) {
    await mysqlStore.init();
    await mysqlStore.ping();
    store = mysqlStore;
    const { createPool } = require("mysql2/promise");
    const limpar = createPool({
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT || 3306),
      user: process.env.TEST_DB_USER || "root",
      password: process.env.TEST_DB_PASSWORD || "",
      database: process.env.TEST_DB_NAME || "pa",
    });
    await limpar.query("TRUNCATE TABLE preatendimentos");
    await limpar.query("TRUNCATE TABLE preatendimento_tarefas");
    await limpar.query("TRUNCATE TABLE manychat_contatos");
    await limpar.end();
  } else {
    store = createMemoryStore();
  }
  setStore(store);
  monday.setFetch(mondaySimulada); // também limpa o cache de telefones e colunas
  fake.itens = [
    { id: "101", nome: "Ana Souza", telefone: "+5511912345678" },
    { id: "102", nome: "Bia Lima", telefone: "21 98765-4321" },
    { id: "103", nome: "Duplicada 1", telefone: "+5531999990000" },
    { id: "104", nome: "Duplicada 2", telefone: "(31) 99999-0000" },
    { id: "105", nome: "Sem nove", telefone: "+554188887777" },
  ];
  fake.falhar = null;
  fake.gravacoes = [];
  fake.comentarios = [];
  fake.obs = {};
  avisos.length = 0;
  telegramFora = false;
});

async function chamar(rota, body, chave = CHAVE) {
  const response = await fetch(`${base}/manychat/${rota}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(chave ? { "X-Api-Key": chave } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}

function hojeMais(dias) {
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const data = new Date(`${hoje}T12:00:00Z`);
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

// Faz as tentativas agendadas para o futuro rodarem agora.
async function rodarReenvio() {
  for (const linha of await store.todos()) {
    if (linha.sync === "pendente") {
      await store.atualizar(linha.id, { syncProxima: null });
    }
  }
  await processarPendentes();
}

test("sem a chave do ManyChat: 401", async () => {
  const r = await chamar("telefone", { contato_id: "1", telefone: "11912345678" }, null);
  assert.equal(r.status, 401);
  const r2 = await chamar("telefone", { contato_id: "1", telefone: "11912345678" }, "x".repeat(44));
  assert.equal(r2.status, 401);
});

test("qualificada: grava na Monday, comenta, devolve o link do Calendly e não avisa o grupo", async () => {
  const t = await chamar("telefone", { contato_id: "c1", whatsapp: "+5511900001111", nome: "ana", telefone: "(11) 91234-5678" });
  assert.equal(t.resultado, "seguir");
  assert.equal(t.primeiro_nome, "Ana");

  const f = await chamar("faturamento", { contato_id: "c1", resposta: "17 mil" });
  assert.equal(f.resultado, "qualificada");
  assert.deepEqual(fake.gravacoes, [
    {
      itemId: "101",
      valores: {
        fat: { label: "R$ 10 mil a R$ 20 mil" },
        etapa: { label: "Quer reunião" },
        obs: { text: "Aguardando agendamento" },
      },
    },
  ]);

  // Link exclusivo: código do cadastro (utm_content) e nome pré-preenchido.
  const link = new URL(f.link_agendamento);
  const linha = (await store.todos())[0];
  assert.equal(link.origin + link.pathname, "https://calendly.com/consultor/reuniao");
  assert.equal(link.searchParams.get("utm_source"), "mani");
  assert.equal(link.searchParams.get("utm_content"), linha.refAgendamento);
  assert.match(linha.refAgendamento, /^[A-Za-z0-9_-]{12}$/);
  assert.equal(link.searchParams.get("name"), "Ana Souza");
  assert.equal(linha.agendamento, "pendente");

  await rodarReenvio();
  await rodarReenvio();

  assert.equal(fake.gravacoes.length, 1);
  assert.equal(fake.comentarios.length, 1);
  assert.match(fake.comentarios[0].texto, /Faturamento informado: "17 mil" → R\$ 17 mil/);
  assert.match(fake.comentarios[0].texto, /WhatsApp da conversa: \+55 11 90000-1111/);
  assert.match(fake.comentarios[0].texto, /Origem: Pré-atendimento pelo WhatsApp/);
  assert.match(fake.comentarios[0].texto, /link de agendamento enviado/);
  // O grupo só é avisado quando ela agendar (teste em agendamento.test.js).
  assert.equal(avisos.length, 0);
  assert.equal((await store.todos())[0].sync, "ok");
});

test("exatamente 10 mil vai para a reunião", async () => {
  await chamar("telefone", { contato_id: "c2", telefone: "+55 21 98765-4321" });
  const f = await chamar("faturamento", { contato_id: "c2", resposta: "R$ 10.000" });
  assert.equal(f.resultado, "qualificada");
});

test("fora do perfil: grava faixa e resultado, sem prazo e sem aviso", async () => {
  await chamar("telefone", { contato_id: "c3", telefone: "11912345678" });
  const f = await chamar("faturamento", { contato_id: "c3", resposta: "8k" });
  assert.equal(f.resultado, "fora_do_perfil");
  assert.deepEqual(fake.gravacoes[0].valores, {
    fat: { label: "R$ 0 a R$ 10 mil" },
    etapa: { label: "Fora do Perfil" },
    obs: { text: "Perfil não qualificado por renda" },
  });
  await rodarReenvio();
  assert.equal(fake.comentarios.length, 1);
  assert.equal(avisos.length, 0);
});

test("quadro sem a coluna OBS (desde 03/11/2026): grava faixa e etapa, e o status fica só no histórico", async () => {
  fake.semObs = true;
  monday.setFetch(mondaySimulada); // esquece as colunas lidas antes
  try {
    await chamar("telefone", { contato_id: "c30", telefone: "11912345678" });
    const f = await chamar("faturamento", { contato_id: "c30", resposta: "8k" });
    assert.equal(f.resultado, "fora_do_perfil");
    assert.deepEqual(fake.gravacoes[0].valores, {
      fat: { label: "R$ 0 a R$ 10 mil" },
      etapa: { label: "Fora do Perfil" },
    });
    await rodarReenvio();
    assert.equal(fake.comentarios.length, 1);
  } finally {
    fake.semObs = false;
    monday.setFetch(mondaySimulada);
  }
});

test("OBS com anotação da equipe: status entra numa linha nova, sem apagar e sem repetir", async () => {
  fake.obs["101"] = "Indicação da Bia";
  await chamar("telefone", { contato_id: "c16", telefone: "11912345678" });
  await chamar("faturamento", { contato_id: "c16", resposta: "15 mil" });
  assert.equal(fake.gravacoes[0].valores.obs.text, "Indicação da Bia\nAguardando agendamento");

  await chamar("telefone", { contato_id: "c16", telefone: "11912345678" });
  await chamar("faturamento", { contato_id: "c16", resposta: "15 mil" });
  assert.equal(fake.gravacoes[1].valores.obs.text, "Indicação da Bia\nAguardando agendamento");
});

test("cadastro sem o 9 é encontrado", async () => {
  const t = await chamar("telefone", { contato_id: "c4", telefone: "(41) 98888-7777" });
  assert.equal(t.resultado, "seguir");
  assert.equal(t.primeiro_nome, "Sem");
});

test("telefone inválido pede de novo; depois de 4 vezes encaminha", async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await chamar("telefone", { contato_id: "c5", telefone: "123" })).resultado, "telefone_invalido");
  }
  assert.equal((await chamar("telefone", { contato_id: "c5", telefone: "abc" })).resultado, "encaminhado");
  await rodarReenvio();
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /não conseguiu informar um telefone válido/);
});

test("não encontrado: pede para conferir e na segunda encaminha sem criar cadastro", async () => {
  assert.equal((await chamar("telefone", { contato_id: "c6", whatsapp: "5511955554444", telefone: "11977776666" })).resultado, "nao_encontrado");
  assert.equal((await chamar("telefone", { contato_id: "c6", telefone: "11977776665" })).resultado, "encaminhado");
  await rodarReenvio();
  assert.equal(fake.gravacoes.length, 0);
  assert.equal(fake.comentarios.length, 0);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /não encontrado/);
  assert.match(avisos[0], /Responder no WhatsApp: \+55 11 95555-4444/);
});

test("dois cadastros com o mesmo telefone: encaminha sem escolher", async () => {
  assert.equal((await chamar("telefone", { contato_id: "c7", telefone: "31 99999-0000" })).resultado, "encaminhado");
  await rodarReenvio();
  assert.equal(fake.gravacoes.length, 0);
  assert.match(avisos[0], /Mais de um cadastro/);
});

test("faturamento ambíguo: confirma; sim grava, não pede de novo", async () => {
  await chamar("telefone", { contato_id: "c8", telefone: "11912345678" });
  const f = await chamar("faturamento", { contato_id: "c8", resposta: "17" });
  assert.equal(f.resultado, "confirmar_valor");
  assert.equal(f.valor_texto, "R$ 17 mil");
  assert.equal((await chamar("confirmacao", { contato_id: "c8", resposta: "Não" })).resultado, "digitar_novamente");
  assert.equal((await chamar("faturamento", { contato_id: "c8", resposta: "17" })).resultado, "confirmar_valor");
  assert.equal((await chamar("confirmacao", { contato_id: "c8", resposta: "Sim" })).resultado, "qualificada");
});

test("intervalo entre faixas pede valor médio; 3 tentativas sem valor viram A Verificar", async () => {
  await chamar("telefone", { contato_id: "c9", telefone: "11912345678" });
  assert.equal((await chamar("faturamento", { contato_id: "c9", resposta: "de 5 a 15 mil" })).resultado, "pedir_media");
  assert.equal((await chamar("faturamento", { contato_id: "c9", resposta: "não sei" })).resultado, "nao_entendi");
  assert.equal((await chamar("faturamento", { contato_id: "c9", resposta: "{{cuf_123}}" })).resultado, "encaminhado");
  await rodarReenvio();
  assert.deepEqual(fake.gravacoes[0].valores, { fat: { label: "A Verificar" }, obs: { text: "Faturamento a verificar" } });
  assert.equal(fake.comentarios.length, 1);
  assert.match(avisos[0], /não conseguiu informar o faturamento/);
});

test("Monday fora na gravação: resposta genérica, reenvio termina e avisa a equipe", async () => {
  await chamar("telefone", { contato_id: "c10", telefone: "11912345678" });
  fake.falhar = "gravar";
  const f = await chamar("faturamento", { contato_id: "c10", resposta: "25 mil" });
  assert.equal(f.resultado, "registrado");

  await rodarReenvio();
  await rodarReenvio();
  await rodarReenvio();
  let linha = (await store.todos())[0];
  assert.equal(linha.sync, "pendente");
  assert.equal(linha.syncTentativas, 3);
  assert.equal(avisos.length, 1, "alerta de falha depois de 3 tentativas");
  assert.match(avisos[0], /Pré-atendimento com falha/);

  fake.falhar = null;
  await rodarReenvio();
  linha = (await store.todos())[0];
  assert.equal(linha.sync, "ok");
  assert.equal(fake.gravacoes.length, 1);
  assert.equal(fake.comentarios.length, 1);
  assert.equal(avisos.length, 2);
  assert.match(avisos[1], /recebeu só/);
});

test("Monday fora na busca: conversa segue e o reenvio encontra o cadastro depois", async () => {
  fake.falhar = "tudo";
  const t = await chamar("telefone", { contato_id: "c11", nome: "Carla Dias", telefone: "11912345678" });
  assert.equal(t.resultado, "seguir");
  assert.equal(t.primeiro_nome, "Carla");
  assert.equal((await chamar("faturamento", { contato_id: "c11", resposta: "5 mil" })).resultado, "registrado");

  fake.falhar = null;
  await rodarReenvio();
  assert.equal(fake.gravacoes[0].itemId, "101");
  assert.equal(fake.gravacoes[0].valores.etapa.label, "Fora do Perfil");
  assert.match(avisos[0], /Falta responder que a consultoria ainda não é o momento/);
});

test("limite diário da Monday: próxima tentativa só depois da meia-noite UTC", async () => {
  await chamar("telefone", { contato_id: "c12", telefone: "11912345678" });
  fake.falhar = "limite";
  assert.equal((await chamar("faturamento", { contato_id: "c12", resposta: "40 mil" })).resultado, "registrado");
  await rodarReenvio();
  const linha = (await store.todos())[0];
  assert.equal(linha.syncProxima.getUTCHours(), 0);
  assert.equal(linha.syncProxima.getUTCMinutes(), 2);
  assert.ok(linha.syncProxima > new Date());
});

test("Telegram fora: Monday não é regravada, só o aviso é repetido", async () => {
  await chamar("telefone", { contato_id: "c13", telefone: "11912345678" });
  telegramFora = true;
  // 3 respostas sem valor: grava "A Verificar", comenta e avisa o grupo.
  for (const resposta of ["não sei", "não sei", "não sei"]) {
    await chamar("faturamento", { contato_id: "c13", resposta });
  }
  await rodarReenvio();
  telegramFora = false;
  await rodarReenvio();
  assert.equal(fake.gravacoes.length, 1);
  assert.equal(fake.comentarios.length, 1);
  assert.equal(avisos.length, 1);
});

test("chamadas repetidas ao mesmo tempo não duplicam", async () => {
  await chamar("telefone", { contato_id: "c14", telefone: "11912345678" });
  const respostas = await Promise.all([
    chamar("faturamento", { contato_id: "c14", resposta: "20 mil" }),
    chamar("faturamento", { contato_id: "c14", resposta: "20 mil" }),
  ]);
  assert.deepEqual(respostas.map((r) => r.resultado).sort(), ["qualificada", "sem_sessao"]);
  await rodarReenvio();
  assert.equal(fake.gravacoes.length, 1);
  assert.equal(fake.comentarios.length, 1);
  assert.equal((await store.todos()).filter((linha) => linha.refAgendamento).length, 1);
});

test("nova conversa depois de concluída começa do zero", async () => {
  await chamar("telefone", { contato_id: "c15", telefone: "11912345678" });
  await chamar("faturamento", { contato_id: "c15", resposta: "8 mil" });
  assert.equal((await chamar("faturamento", { contato_id: "c15", resposta: "9 mil" })).resultado, "sem_sessao");
  assert.equal((await chamar("telefone", { contato_id: "c15", telefone: "11912345678" })).resultado, "seguir");
  assert.equal((await store.todos()).length, 2);
});
