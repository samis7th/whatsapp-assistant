const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");

// Casos encontrados na revisão de 21/10: prazo da conversa, corpo do ManyChat com aspas
// e quebras de linha, contato que a API não acha, outros eventos do Calendly, variáveis
// opcionais inválidas e o diagnóstico de contato.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.CALENDLY_URL = "https://calendly.com/consultor/reuniao";
process.env.CALENDLY_WEBHOOK_SECRET = "segredo-do-calendly-com-mais-de-32-caracteres";
process.env.CALENDLY_EVENTO_NOME = "Reunião com a equipe do consultor";
process.env.INTERNO_SECRET = "chave-interna-do-painel-com-32-caracteres-ou-mais";
process.env.AULA_DATA = "2026-10-29";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";
process.env.MANYCHAT_FLOW_CONVITE = "content20261021000000_000002";

const app = require("../src/app");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");

function respostaJson(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, headers: new Map() };
}

// Monday simulada com atraso opcional (respeita o cancelamento por tempo).
const fake = { atrasoMs: 0, gravacoes: [] };

monday.setFetch((url, init) => {
  const { query, variables } = JSON.parse(init.body);

  const responder = () => {
    if (query.includes("query Obs")) return respostaJson({ data: { items: [{ column_values: [{ text: "" }] }] } });
    if (query.includes("items_page")) {
      return respostaJson({
        data: {
          boards: [
            {
              items_page: {
                cursor: null,
                items: [{ id: "101", name: "Ana Souza", column_values: [{ id: "phonenhzs51c9", text: "+5511912345678", phone: "+5511912345678" }] }],
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
    if (query.includes("change_multiple_column_values")) {
      fake.gravacoes.push(JSON.parse(variables.valores));
      return respostaJson({ data: { change_multiple_column_values: { id: "101" } } });
    }
    return respostaJson({ data: { create_update: { id: "1" } } });
  };

  if (!fake.atrasoMs) return Promise.resolve(responder());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(responder()), fake.atrasoMs);
    init.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("abortado"), { name: "TimeoutError" }));
    });
  });
});

const mc = { chamadas: [], existe: false, porCampo: {} };
manychat.setFetch(async (url, init) => {
  const u = new URL(url);
  mc.chamadas.push(u.pathname);
  if (u.pathname === "/fb/subscriber/createSubscriber" && mc.erroOutro) {
    return respostaJson({ status: "error", message: "Validation error", details: { messages: [{ message: "invalid whatsapp phone" }] } }, 400);
  }
  if (u.pathname === "/fb/subscriber/createSubscriber" && mc.existe) {
    return respostaJson({ status: "error", message: "Validation error", details: { messages: [{ message: "whatsapp_phone already exists" }] } }, 400);
  }
  if (u.pathname === "/fb/subscriber/findBySystemField") {
    return respostaJson({ status: "error", message: "Subscriber not found" }, 400);
  }
  if (u.pathname === "/fb/page/getCustomFields") {
    return respostaJson({ status: "success", data: [{ id: 77, name: "whatsapp_numero", type: "text" }] });
  }
  if (u.pathname === "/fb/subscriber/findByName") {
    return respostaJson({ status: "success", data: mc.porNome?.[u.searchParams.get("name")] || [] });
  }
  if (u.pathname === "/fb/subscriber/findByCustomField") {
    // O campo copiado do sistema guarda o número sem "+" (como o wa_id).
    const achado = mc.porCampo[u.searchParams.get("field_value")];
    return respostaJson({ status: "success", data: achado ? [{ id: achado }] : [] });
  }
  return respostaJson({ status: "success", data: { id: 9000 } });
});

const avisos = [];
telegram.setFetch(async (url, init) => {
  avisos.push(JSON.parse(init.body).text);
  return respostaJson({ ok: true, result: {} });
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
  fake.atrasoMs = 0;
  fake.gravacoes = [];
  mc.chamadas.length = 0;
  mc.existe = false;
  mc.porCampo = {};
  avisos.length = 0;
});

async function manychatBruto(rota, corpoBruto) {
  const response = await fetch(`${base}/manychat/${rota}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": process.env.MANYCHAT_SECRET },
    body: corpoBruto,
  });
  return response.json();
}

test("ManyChat manda o texto sem escapar (aspas e várias linhas): a conversa segue", async () => {
  const t = await manychatBruto("telefone", '{"contato_id":"c1","whatsapp":"","nome":"Ana "Aninha" Souza","telefone":"(11) 91234-5678"}');
  assert.equal(t.resultado, "seguir");
  const f = await manychatBruto("faturamento", '{"contato_id":"c1","resposta":"uns "20" mil\npor mês"}');
  assert.equal(f.resultado, "qualificada");
  assert.equal((await store.todos())[0].faturamentoTexto, 'uns "20" mil por mês');
});

test("Monday lenta na conversa: responde 'registrado' antes do ManyChat desistir (~10 s)", async () => {
  await manychatBruto("telefone", '{"contato_id":"c2","telefone":"11912345678"}');
  fake.atrasoMs = 5000; // cada chamada demora 5 s: leitura da OBS + gravação = 10 s
  const inicio = Date.now();
  const f = await manychatBruto("faturamento", '{"contato_id":"c2","resposta":"20 mil"}');
  const duracao = Date.now() - inicio;
  assert.equal(f.resultado, "registrado");
  assert.ok(duracao < 9000, `respondeu em ${duracao} ms`);
});

test("contato antigo que a API não acha (já conversou com o número): pulado em silêncio", async () => {
  mc.existe = true;
  const response = await fetch(`${base}/interno/convites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Interno-Key": process.env.INTERNO_SECRET },
    body: JSON.stringify({ pessoas: [{ nome: "Bia", telefone: "21987654321" }] }),
  });
  assert.equal((await response.json()).novos, 1);
  await agendamento.processarTarefas();
  await agendamento.processarTarefas();

  const [tarefa] = (await store.todasTarefas()).filter((t) => t.tipo === "convite");
  assert.equal(tarefa.status, "ignorado");
  assert.equal(tarefa.tentativas, 0);
  assert.match(tarefa.erro, /already exists/);
  // Procurou pelas duas formas do número (com e sem o 9) antes de desistir.
  assert.equal(mc.chamadas.filter((c) => c === "/fb/subscriber/findBySystemField").length, 2);
  assert.equal(avisos.length, 0, "sem alerta no grupo");
  assert.ok(!mc.chamadas.includes("/fb/sending/sendFlow"));
});

test("outro erro de dados do ManyChat (não é 'já existe'): para e avisa o grupo", async () => {
  mc.erroOutro = true;
  try {
    await fetch(`${base}/interno/convites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Interno-Key": process.env.INTERNO_SECRET },
      body: JSON.stringify({ pessoas: [{ nome: "Bia", telefone: "21987654321" }] }),
    });
    await agendamento.processarTarefas();
    const [tarefa] = (await store.todasTarefas()).filter((t) => t.tipo === "convite");
    assert.equal(tarefa.status, "falhou");
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /Falha: convite para o grupo/);
  } finally {
    mc.erroOutro = false;
  }
});

test("contato salvo sem o 9 (WhatsApp antigo) é reconhecido no número com 9", async () => {
  await store.criar({ contatoId: "555", whatsapp: "+551191234567" });
  assert.equal(await store.contatoManychat("+5511991234567"), "555");
});

function assinar(corpo) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", process.env.CALENDLY_WEBHOOK_SECRET).update(`${t}.${corpo}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function webhook(payload) {
  const corpo = JSON.stringify({ event: "invitee.created", payload });
  const response = await fetch(`${base}/calendly/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Calendly-Webhook-Signature": assinar(corpo) },
    body: corpo,
  });
  return response.json();
}

function convidado({ nomeEvento, utm }) {
  return {
    uri: "https://api.calendly.com/scheduled_events/EV9/invitees/INV9",
    name: "Cliente",
    email: "cliente@exemplo.com",
    questions_and_answers: [{ question: "WhatsApp", answer: "11 91234-5678" }],
    tracking: { utm_source: utm || null, utm_content: null },
    scheduled_event: { uri: "https://api.calendly.com/scheduled_events/EV9", name: nomeEvento, start_time: "2026-10-23T18:00:00Z" },
  };
}

test("Calendly: reunião de outro evento da conta é ignorada; o evento da Mani passa", async () => {
  assert.equal((await webhook(convidado({ nomeEvento: "Workshop cliente X" }))).ignorado, "outro_evento");
  // A mentoria das sorteadas nunca entra nos lembretes comerciais, nem pelo link da Mani:
  // vai para o sorteio (aqui ninguém foi sorteada, então só sai o alerta para a equipe).
  assert.equal((await webhook(convidado({ nomeEvento: "Reunião com o Consultor - Mentoria", utm: "mani" }))).mentoria, "sem_sorteada");
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /não foi sorteada/);
  avisos.length = 0;

  const r = await webhook(convidado({ nomeEvento: "reuniao com a equipe do consultor" }));
  assert.equal(r.ok, true);
  assert.equal(r.ignorado, undefined);

  // Pelo link da Mani passa sempre, mesmo se o nome do evento mudar.
  const r2 = await webhook({ ...convidado({ nomeEvento: "Outro nome", utm: "mani" }), uri: "https://api.calendly.com/scheduled_events/EV8/invitees/INV8" });
  assert.equal(r2.ignorado, undefined);
});

test("diagnóstico de contato: só leitura, com a chave interna", async () => {
  await store.criar({ contatoId: "777", whatsapp: "+5511912345678" });
  const semChave = await fetch(`${base}/interno/diagnostico/manychat?telefone=11912345678`);
  assert.equal(semChave.status, 401);

  const response = await fetch(`${base}/interno/diagnostico/manychat?telefone=(11)%2091234-5678`, {
    headers: { "X-Interno-Key": process.env.INTERNO_SECRET },
  });
  const corpo = await response.json();
  assert.deepEqual(corpo, {
    ok: true,
    telefone: "+5511912345678",
    contatoNoSistema: "777",
    contatoNoManychatPeloNumero: null,
    contatoNoManychatPeloCampo: null,
  });
  assert.ok(!mc.chamadas.includes("/fb/subscriber/createSubscriber"));

  // Com &nome=: testa a busca pelo nome (contato antigo), sem criar, enviar ou guardar nada.
  mc.porNome = { "Maria Silva": [{ id: "4321", whatsapp_phone: "+5511998887777" }] };
  const comNome = await (
    await fetch(`${base}/interno/diagnostico/manychat?telefone=11998887777&nome=Maria%20Silva`, { headers: { "X-Interno-Key": process.env.INTERNO_SECRET } })
  ).json();
  assert.equal(comNome.contatoNoManychatPeloNome, "4321");
  assert.equal(comNome.contatoNoSistema, null, "não guarda a ligação");
  assert.ok(!mc.chamadas.includes("/fb/subscriber/createSubscriber"));
  assert.ok(!mc.chamadas.includes("/fb/sending/sendFlow"));
  mc.porNome = {};
});

test("diagnóstico dos pulados de um disparo: conta quem a busca pelo nome acharia, sem enviar", async () => {
  const pular = async (telefone, nome) => {
    const t = await store.criarTarefa({ chave: `disparo:2026-11-05:unico:${telefone}`, tipo: "disparo", dados: { nome, telefone } });
    await store.atualizarTarefa(t.id, { status: "ignorado", erro: "Validation error — This WhatsApp ID already exists (contato não encontrado pela API)" });
  };
  await pular("+5511998887777", "Maria Silva");
  await pular("+5511998886666", "Joana Apelido");
  const enviado = await store.criarTarefa({ chave: "disparo:2026-11-05:unico:+5511900001111", tipo: "disparo", dados: { nome: "Ok", telefone: "+5511900001111" } });
  await store.atualizarTarefa(enviado.id, { status: "ok" });

  mc.porNome = { "Maria Silva": [{ id: "4321", whatsapp_phone: "+5511998887777" }] };
  mc.chamadas = [];
  const r = await (await fetch(`${base}/interno/diagnostico/pulados?data=2026-11-05`, { headers: { "X-Interno-Key": process.env.INTERNO_SECRET } })).json();
  assert.deepEqual(r, { ok: true, data: "2026-11-05", pulados: 2, achadosPeloNome: 1, continuariamPulados: ["Joana Apelido"] });

  const comTelefones = await (
    await fetch(`${base}/interno/diagnostico/pulados?data=2026-11-05&telefones=1`, { headers: { "X-Interno-Key": process.env.INTERNO_SECRET } })
  ).json();
  assert.deepEqual(comTelefones.continuariamPulados, [{ nome: "Joana Apelido", telefone: "+5511998886666" }]);
  assert.ok(!mc.chamadas.includes("/fb/subscriber/createSubscriber"));
  assert.ok(!mc.chamadas.includes("/fb/sending/sendFlow"));
  assert.equal(await store.contatoManychat("+5511998887777"), null, "não guarda a ligação");

  // Conferência de todos: um ligado pela etiqueta (guardado aqui), um pelo nome, um faltando.
  await store.salvarContatoManychat("+5511998886666", "5555");
  const t3 = await store.criarTarefa({ chave: "disparo:2026-11-05:unico:+5511998885555", tipo: "disparo", dados: { nome: "Sem Nada", telefone: "+5511998885555" } });
  await store.atualizarTarefa(t3.id, { status: "ignorado", erro: "This WhatsApp ID already exists" });
  mc.chamadas = [];
  const lig = await (await fetch(`${base}/interno/diagnostico/ligados?data=2026-11-05`, { headers: { "X-Interno-Key": process.env.INTERNO_SECRET } })).json();
  assert.deepEqual(lig, {
    ok: true,
    data: "2026-11-05",
    pulados: 3,
    ligadosNoSistema: 1,
    achadosPeloCampo: 0,
    achadosPeloNome: 1,
    prontos: 2,
    faltam: ["Sem Nada"],
  });
  assert.ok(!mc.chamadas.includes("/fb/subscriber/createSubscriber"));
  assert.ok(!mc.chamadas.includes("/fb/sending/sendFlow"));
  mc.porNome = {};
});

test("resumo do envio: contato pulado aparece como 'contato não encontrado'", async () => {
  const fonte = require("node:fs").readFileSync(path.join(__dirname, "../src/services/agendamento.service.js"), "utf8");
  assert.match(fonte, /return "contato não encontrado";/);
});

test("variável opcional com valor provisório não derruba o app", () => {
  const saida = execFileSync(
    process.execPath,
    ["-e", "const {config}=require('./src/config/env');console.log(JSON.stringify({link:config.aula.link,data:config.aula.data,interno:config.internoSecret,tg:config.telegram.chatId}))"],
    {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, AULA_LINK: "pendente", AULA_DATA: "29/10", INTERNO_SECRET: "curta", TELEGRAM_CHAT_ID: "grupo" },
      stdio: ["ignore", "pipe", "ignore"],
    }
  ).toString();
  assert.deepEqual(JSON.parse(saida), { link: "", data: "", interno: "", tg: "" });
});

test("diagnóstico 'criar': mostra o ID devolvido ou o erro do ManyChat, sem enviar mensagem", async () => {
  const headers = { "X-Interno-Key": process.env.INTERNO_SECRET };
  const ok = await (await fetch(`${base}/interno/diagnostico/manychat/criar?telefone=11912345678`, { method: "POST", headers })).json();
  assert.equal(ok.contatoDevolvidoPeloManychat, "9000");

  mc.existe = true;
  const erro = await (await fetch(`${base}/interno/diagnostico/manychat/criar?telefone=11912345678`, { method: "POST", headers })).json();
  assert.equal(erro.ok, false);
  assert.match(erro.erroDoManychat, /already exists/);
  assert.ok(!mc.chamadas.includes("/fb/sending/sendFlow"));
});

test("duas cópias do app ao mesmo tempo: o aviso do agendamento sai uma vez só", async () => {
  // Carrega uma segunda cópia dos módulos (como um segundo processo da Hostinger),
  // usando o mesmo banco.
  const raiz = path.join(__dirname, "..", "src");
  const guardados = {};
  for (const chave of Object.keys(require.cache)) {
    if (chave.startsWith(path.join(raiz, "services")) || chave === path.join(raiz, "db", "index.js")) {
      guardados[chave] = require.cache[chave];
      delete require.cache[chave];
    }
  }
  const dbB = require("../src/db");
  const agendamentoB = require("../src/services/agendamento.service");
  const telegramB = require("../src/services/telegram.service");
  const mondayB = require("../src/services/monday.service");
  Object.assign(require.cache, guardados); // a cópia A continua sendo a usada pelo resto dos testes

  dbB.setStore(store);
  // Telegram um pouco lento nas duas cópias: as duas estariam mandando o aviso ao mesmo tempo.
  const telegramLento = async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    avisos.push(JSON.parse(init.body).text);
    return respostaJson({ ok: true, result: {} });
  };
  telegramB.setFetch(telegramLento);
  telegram.setFetch(telegramLento);
  mondayB.setFetch(() => Promise.resolve(respostaJson({ data: {} })));

  await store.criarTarefa({
    chave: "agendou:teste-duplo",
    tipo: "agendou",
    // Sem telefone e sem cadastro: vai direto para o aviso no grupo.
    dados: { nome: "Cliente", inicio: "2026-10-23T18:00:00Z", evento: "EVX", buscaFeita: true },
  });

  try {
    await Promise.all([agendamento.processarTarefas(), agendamentoB.processarTarefas()]);
  } finally {
    telegram.setFetch(async (url, init) => {
      avisos.push(JSON.parse(init.body).text);
      return respostaJson({ ok: true, result: {} });
    });
  }

  assert.equal(avisos.filter((texto) => /Reunião agendada/.test(texto)).length, 1);
  assert.equal((await store.todasTarefas())[0].status, "ok");
});

test("contato antigo (já existe no ManyChat): achado pelo campo whatsapp_numero, com ou sem o 9", async () => {
  mc.existe = true;
  mc.porCampo["552187654321"] = 4321; // contato antigo, registrado sem o 9
  const response = await fetch(`${base}/interno/convites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Interno-Key": process.env.INTERNO_SECRET },
    body: JSON.stringify({ pessoas: [{ nome: "Bia", telefone: "21987654321" }] }),
  });
  assert.equal((await response.json()).novos, 1);
  await agendamento.processarTarefas();

  const [tarefa] = (await store.todasTarefas()).filter((t) => t.tipo === "convite");
  assert.equal(tarefa.status, "ok");
  assert.equal(tarefa.dados.contatoId, "4321");
  assert.equal(await store.contatoManychat("+5521987654321"), "4321", "fica guardado para os próximos envios");
});

test("diagnóstico 'enviar': manda o fluxo pedido só para contato conhecido", async () => {
  const headers = { "X-Interno-Key": process.env.INTERNO_SECRET };
  const desconhecido = await fetch(`${base}/interno/diagnostico/manychat/enviar?telefone=11912345678&fluxo=convite`, { method: "POST", headers });
  assert.equal(desconhecido.status, 404);

  const fluxoErrado = await fetch(`${base}/interno/diagnostico/manychat/enviar?telefone=11912345678&fluxo=xyz`, { method: "POST", headers });
  assert.equal(fluxoErrado.status, 400);

  await store.criar({ contatoId: "777", whatsapp: "+5511912345678" });
  const ok = await (await fetch(`${base}/interno/diagnostico/manychat/enviar?telefone=11912345678&fluxo=convite`, { method: "POST", headers })).json();
  assert.deepEqual(ok, { ok: true, telefone: "+5511912345678", contatoId: "777", fluxo: "content20261021000000_000002" });
  assert.ok(mc.chamadas.includes("/fb/sending/sendFlow"));
});

test("diagnóstico 'enviar': lembrete da mentoria com campos de teste; contato achado pelo campo whatsapp_numero", async () => {
  const { config } = require("../src/config/env");
  const antes = config.manychat.flowSorteio.vespera;
  config.manychat.flowSorteio.vespera = "content20261106000000_000009";
  mc.porCampo["5511955554444"] = 5544;
  mc.chamadas.length = 0;
  try {
    const r = await (
      await fetch(`${base}/interno/diagnostico/manychat/enviar?telefone=11955554444&fluxo=mentoria_vespera`, {
        method: "POST",
        headers: { "X-Interno-Key": process.env.INTERNO_SECRET },
      })
    ).json();
    assert.deepEqual(r, { ok: true, telefone: "+5511955554444", contatoId: "5544", fluxo: "content20261106000000_000009" });
    assert.equal(mc.chamadas.filter((c) => c === "/fb/subscriber/setCustomFieldByName").length, 3, "mentoria_data, _hora e _link");
    assert.ok(!mc.chamadas.includes("/fb/subscriber/createSubscriber"), "não cria contato");
  } finally {
    config.manychat.flowSorteio.vespera = antes;
    delete mc.porCampo["5511955554444"];
  }
});

test("tarefa esperando a próxima tentativa não é pega por outra cópia antes da hora", async () => {
  const { createMemoryStore } = require("../src/db/memory-store");
  const s = createMemoryStore();
  const t = await s.criarTarefa({ chave: "x", tipo: "agendou" });
  await s.atualizarTarefa(t.id, { proxima: new Date(Date.now() + 60000) });
  assert.equal(await s.travarTarefa(t.id, new Date(Date.now() + 300000)), false);
  await s.atualizarTarefa(t.id, { proxima: new Date(Date.now() - 1000) });
  assert.equal(await s.travarTarefa(t.id, new Date(Date.now() + 300000)), true);
});

test("Telegram: texto longo é cortado numa quebra de linha, sem partir tag HTML", async () => {
  const telegram = require("../src/services/telegram.service");
  let enviado = "";
  telegram.setFetch(async (url, init) => {
    enviado = JSON.parse(init.body).text;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }), headers: new Map() };
  });
  const linhas = Array.from({ length: 200 }, (_, i) => `${i + 1}º <b>Nome &amp; Sobrenome</b>`);
  await telegram.enviarAviso(linhas.join("\n"));
  assert.ok(enviado.length <= 3802);
  assert.ok(enviado.endsWith("</b>\n…"));
});

test("diagnóstico de reuniões de uma pessoa (só leitura)", async () => {
  await store.criarTarefa({
    chave: "reuniao:agenda:abc",
    tipo: "reuniao_registro",
    dados: { origem: "agenda", googleId: "g1", nome: "Ana", telefone: "+5511900004566", inicio: "2026-11-09T17:30:00.000Z", situacao: "ativa", confirmacao: "pendente", enviados: [] },
  });
  const headers = { "X-Interno-Key": process.env.INTERNO_SECRET };
  const r = await (await fetch(`${base}/interno/diagnostico/reunioes?telefone=11900004566`, { headers })).json();
  assert.equal(r.total, 1);
  assert.equal(r.reunioes[0].situacao, "ativa");
  assert.equal(r.reunioes[0].origem, "agenda");
  assert.equal((await fetch(`${base}/interno/diagnostico/reunioes?telefone=11900004566`)).status, 401);
});
