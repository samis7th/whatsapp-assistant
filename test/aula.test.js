const test = require("node:test");
const assert = require("node:assert/strict");

// Lembretes da aula no privado (3 dias antes, 1 dia antes e no dia), com Monday,
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
process.env.MANYCHAT_FLOW_AULA_3DIAS = "content20261021000000_000003";
process.env.MANYCHAT_FLOW_AULA_AMANHA = "content20261021000000_000004";
process.env.MANYCHAT_FLOW_AULA_HOJE = "content20261021000000_000005";
process.env.MANYCHAT_FLOW_AULA_AOVIVO = "content20261021000000_000006";
process.env.MANYCHAT_FLOW_AULA_1HORA = "content20261021000000_000007";
process.env.MANYCHAT_FLOW_AULA_AMIGA = "content20261021000000_000008";
process.env.AULA_LINK = "https://meet.example.com/aula-2910";

const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");
const aula = require("../src/services/aula.service");

function respostaJson(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, headers: new Map() };
}

// ---------- Monday simulada: quadro com inscritos de várias turmas ----------
const quadro = { itens: [], chamadas: 0, falhar: false, obs: {}, grupo: {}, etapa: {}, comentarios: [] };

// Etapa do Funil, Data de Cadastro (só registro: não muda quem recebe) e Grupo WhatsApp.
function item(id, nome, telefone, etapa, cadastro, criadoEm = "2026-09-01T12:00:00Z", grupo = "") {
  return { id, nome, telefone, etapa, cadastro: (cadastro || "").slice(0, 10), criadoEm, grupo };
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
    item("1", "Ana Souza", "+5511912345678", "Lead", "2026-10-15"),
    item("2", "Bia Lima", "21 98765-4321", "Cliente Low Ticket", "2026-10-20"),
    item("3", "Aguardando pagamento", "+5531999990000", "Aguardando pagamento", "2026-03-01"),
    item("4", "Ex-cliente", "+5541988887777", "Deixou de ser cliente", "2026-10-16"),
    item("5", "Sem telefone", "", "Lead", "2026-10-17"),
    item("6", "Ana duplicada", "(11) 91234-5678", "A Definir", ""),
  ];
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

test("contagem de dias até a aula", () => {
  assert.equal(aula.diasAte("2026-10-26", "2026-10-29"), 3);
  assert.equal(aula.diasAte("2026-10-28", "2026-10-29"), 1);
  assert.equal(aula.diasAte("2026-10-29", "2026-10-29"), 0);
  assert.equal(aula.diasAte("2026-10-31", "2026-11-01"), 1);
});

test("3 dias antes, às 10h: só os inscritos da turma, um por telefone, com etiqueta e fluxo certos", async () => {
  assert.equal((await rodar(em(26, 12))).status, "cedo", "9h ainda não");
  assert.equal(quadro.chamadas, 0);

  const r = await rodar(em(26));
  assert.deepEqual(r, { status: "enviado", tipo: "3dias", novos: 2, semTelefone: 1 });

  const criados = mc.chamadas.filter((c) => c.caminho === "/fb/subscriber/createSubscriber").map((c) => c.corpo.whatsapp_phone);
  assert.deepEqual(criados.sort(), ["+5511912345678", "+5521987654321"]);
  assert.deepEqual(fluxos(), ["content20261021000000_000003", "content20261021000000_000003"]);
  assert.ok(mc.chamadas.some((c) => c.caminho === "/fb/page/setBotFieldByName" && c.corpo.field_value === "29/10"));
  assert.ok(mc.chamadas.filter((c) => c.caminho === "/fb/subscriber/addTagByName").every((c) => c.corpo.tag_name === "aula_2910"));

  // v2.13.0: sem mensagem no começo; quem ficou de fora vai no resumo "concluído".
  assert.equal(avisos.length, 0);
  assert.equal(concluidos.length, 1);
  assert.match(concluidos[0], /Lembrete da aula \(faltam 3 dias\) concluído/);
  assert.match(concluidos[0], /Enviados: 2/);
  assert.match(concluidos[0], /Turma de 29\/10/);
  assert.match(concluidos[0], /1 sem telefone válido/);
});

test("o mesmo dia não repete (nem lê a Monday de novo)", async () => {
  await rodar(em(26));
  const leituras = quadro.chamadas;
  assert.equal((await rodar(em(26, 18))).status, "ja_feito");
  assert.equal(quadro.chamadas, leituras);
  assert.equal(fluxos().length, 2);
  assert.equal(avisos.length + concluidos.length, 1);
});

test("cada dia com seu fluxo (3 dias, amiga, amanhã, hoje); o contato é criado uma vez só", async () => {
  await rodar(em(26));
  assert.equal((await rodar(em(27))).tipo, "amiga");
  await rodar(em(28));
  await rodar(em(29));
  assert.equal((await rodar(em(30))).status, "sem_lembrete_hoje");

  assert.deepEqual(fluxos(), [
    "content20261021000000_000003", "content20261021000000_000003",
    "content20261021000000_000008", "content20261021000000_000008",
    "content20261021000000_000004", "content20261021000000_000004",
    "content20261021000000_000005", "content20261021000000_000005",
  ]);
  assert.equal(mc.chamadas.filter((c) => c.caminho === "/fb/subscriber/createSubscriber").length, 2);
  assert.equal(avisos.length, 0);
  assert.equal(concluidos.length, 4);
});

test("quem se inscreveu depois do 1º lembrete recebe os seguintes", async () => {
  await rodar(em(26));
  quadro.itens.push(item("7", "Caio Novo", "+5519999998888", "Lead", "2026-10-27"));
  await rodar(em(28));
  assert.deepEqual(fluxos().slice(2).sort(), ["content20261021000000_000004", "content20261021000000_000004", "content20261021000000_000004"]);
});

test("Monday fora: não marca o dia como feito e tenta de novo depois", async () => {
  quadro.falhar = true;
  await assert.rejects(() => aula.rodarLembretesAula(em(26)));
  quadro.falhar = false;
  assert.equal((await rodar(em(26, 14))).status, "enviado");
  assert.equal(fluxos().length, 2);
});

test("sem o fluxo do dia configurado: não envia nada", async () => {
  const original = config.manychat.flowAula.amanha;
  config.manychat.flowAula.amanha = "";
  try {
    assert.deepEqual(await rodar(em(28)), { status: "sem_fluxo", tipo: "amanha" });
    assert.equal(quadro.chamadas, 0);
    assert.equal(fluxos().length, 0);
  } finally {
    config.manychat.flowAula.amanha = original;
  }
});

test("1 hora antes (19h) e na hora da aula (20h): link da aula no campo do bot e fluxo próprio", async () => {
  await rodar(em(29)); // 10h: lembrete "hoje"
  assert.equal((await rodar(em(29, 21))).status, "ja_feito", "18h: ainda não");

  const umaHora = await rodar(em(29, 22)); // 19h
  assert.deepEqual(umaHora, { status: "enviado", tipo: "1hora", novos: 2, semTelefone: 1 });
  assert.match(concluidos.at(-1), /falta 1 hora\) concluído/);
  assert.equal((await rodar(em(29, 22))).status, "ja_feito", "19h de novo: não repete");

  const r = await rodar(em(29, 23)); // 20h
  assert.deepEqual(r, { status: "enviado", tipo: "aovivo", novos: 2, semTelefone: 1 });
  assert.deepEqual(fluxos(), [
    "content20261021000000_000005", "content20261021000000_000005",
    "content20261021000000_000007", "content20261021000000_000007",
    "content20261021000000_000006", "content20261021000000_000006",
  ]);
  assert.ok(
    mc.chamadas.some(
      (c) => c.caminho === "/fb/page/setBotFieldByName" && c.corpo.field_name === "link_aula" && c.corpo.field_value === "https://meet.example.com/aula-2910"
    )
  );
  assert.match(concluidos.at(-1), /começou agora\) concluído/);

  assert.equal((await rodar(em(29, 23))).status, "ja_feito");
  assert.equal(fluxos().length, 6);
});

test("1 hora antes sem o fluxo configurado (valor provisório): não manda e o resto segue", async () => {
  const original = config.manychat.flowAula.umaHora;
  config.manychat.flowAula.umaHora = "";
  try {
    await rodar(em(29));
    assert.deepEqual(await rodar(em(29, 22)), { status: "sem_fluxo", tipo: "1hora" });
    assert.equal((await rodar(em(29, 23))).status, "enviado");
    assert.equal(fluxos().filter((f) => f === "content20261021000000_000007").length, 0);
  } finally {
    config.manychat.flowAula.umaHora = original;
  }
});

test("depois das 21h não manda mais nada (nem o 'hoje' que não tinha saído)", async () => {
  // 21h30 em Brasília (00h30 UTC do dia 30): ainda é dia 29, mas a aula já começou.
  await rodar(new Date("2026-10-30T00:30:00Z"));
  assert.deepEqual(fluxos(), []);
});

test("começou agora sem AULA_LINK: não manda e avisa o grupo uma vez só", async () => {
  const original = config.aula.link;
  config.aula.link = "";
  try {
    await rodar(em(29)); // hoje
    avisos.length = 0;
    assert.deepEqual(await rodar(em(29, 23)), { status: "sem_link", tipo: "aovivo" });
    await rodar(em(29, 23));
    assert.equal(fluxos().filter((f) => f === "content20261021000000_000006").length, 0);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /AULA_LINK/);
  } finally {
    config.aula.link = original;
  }
});

test("variável de fluxo com valor provisório (não é ID do ManyChat) conta como não configurada", () => {
  const { execFileSync } = require("child_process");
  const saida = execFileSync(
    process.execPath,
    ["-e", "const {config}=require('./src/config/env');console.log(JSON.stringify(config.manychat.flowAula))"],
    {
      cwd: require("path").join(__dirname, ".."),
      env: {
        ...process.env,
        MANYCHAT_FLOW_AULA_3DIAS: "pendente",
        MANYCHAT_FLOW_AULA_AMANHA: "-",
        MANYCHAT_FLOW_AULA_HOJE: "content20261021123456_654321",
        MANYCHAT_FLOW_AULA_AOVIVO: "abc123",
        MANYCHAT_FLOW_AULA_1HORA: "valor-aleatorio",
        MANYCHAT_FLOW_AULA_AMIGA: "pendente",
      },
      stdio: ["ignore", "pipe", "ignore"],
    }
  ).toString();
  assert.deepEqual(JSON.parse(saida), {
    tresDias: "",
    amiga: "",
    amanha: "",
    hoje: "content20261021123456_654321",
    umaHora: "",
    aoVivo: "",
  });
});

test("app derrubado no meio da leitura: a marca abandonada é retomada depois de 10 minutos", async () => {
  // Marca "em andamento" de 11 minutos atrás que nunca foi concluída.
  await store.criarTarefa({
    chave: "aula_varredura:2026-10-29:3dias",
    tipo: "aula_varredura",
    dados: { iniciadoEm: Date.now() - 11 * 60000 },
  });
  const r = await rodar(em(26));
  assert.equal(r.status, "enviado");
  assert.equal(fluxos().length, 2);
  assert.equal((await rodar(em(26, 15))).status, "ja_feito", "depois de concluída não repete");
});

test("marca em andamento recente (outra cópia lendo agora): não lê junto", async () => {
  await store.criarTarefa({
    chave: "aula_varredura:2026-10-29:3dias",
    tipo: "aula_varredura",
    dados: { iniciadoEm: Date.now() - 60000 },
  });
  assert.equal((await rodar(em(26))).status, "ja_feito");
  assert.equal(quadro.chamadas, 0);
});

test("'Não quero receber': não sai mais nenhum aviso da aula; Monday marcada uma vez, sem aviso no Telegram", async () => {
  await rodar(em(26));
  const anaId = await store.contatoManychat("+5511912345678");
  avisos.length = 0;

  assert.deepEqual(await agendamento.pararAvisos({ contatoId: anaId }), { resultado: "ok" });
  assert.deepEqual(await agendamento.pararAvisos({ contatoId: anaId }), { resultado: "ok" }, "tocou duas vezes");
  await agendamento.processarTarefas();

  assert.equal(quadro.etapa["1"], "Não quer receber mensagens");
  assert.equal(quadro.obs["1"], undefined, "sem coluna OBS no quadro");
  assert.equal(quadro.comentarios.length, 1);
  assert.equal(quadro.comentarios[0].itemId, "1");
  assert.equal(avisos.length, 0, "v2.13.0: a Monday já fica marcada, sem aviso no grupo");

  mc.chamadas.length = 0;
  await rodar(em(28));
  await rodar(em(29));
  await rodar(em(29, 23));
  const bia = String(await store.contatoManychat("+5521987654321"));
  const envios = mc.chamadas.filter((c) => c.caminho === "/fb/sending/sendFlow");
  assert.equal(envios.length, 3, "só a Bia recebe amanhã, hoje e começou agora");
  assert.ok(envios.every((c) => String(c.corpo.subscriber_id) === bia));
});

test("marcado na Monday como 'Não quer receber mensagens': fica de fora dos lembretes", async () => {
  quadro.itens[1].etapa = "Não quer receber mensagens"; // Bia
  const r = await rodar(em(26));
  assert.equal(r.novos, 1);
  assert.deepEqual(
    mc.chamadas.filter((c) => c.caminho === "/fb/subscriber/createSubscriber").map((c) => c.corpo.whatsapp_phone),
    ["+5511912345678"]
  );
  assert.match(concluidos[0], /1 não quer receber mensagens/);
});

test("a etiqueta da Monday manda: a equipe tira 'Não quer receber' e a pessoa volta a receber; tocar de novo marca de novo", async () => {
  await rodar(em(26));
  const anaId = await store.contatoManychat("+5511912345678");
  await agendamento.pararAvisos({ contatoId: anaId });
  await agendamento.processarTarefas();
  assert.equal(quadro.etapa["1"], "Não quer receber mensagens");

  // A equipe tira a etiqueta na Monday: no dia seguinte a Ana recebe de novo.
  quadro.etapa["1"] = "Lead";
  mc.chamadas.length = 0;
  await rodar(em(28));
  assert.equal(fluxos().length, 2, "Ana e Bia recebem o 'amanhã'");

  // Ana toca de novo (mais de um dia depois): etiqueta gravada de novo (sem aviso no grupo).
  const pedido = await store.tarefaPorChave(`sem_avisos:${anaId}`);
  await store.atualizarTarefa(pedido.id, { dados: { ...pedido.dados, em: Date.now() - 2 * 86400000 } });
  avisos.length = 0;
  await agendamento.pararAvisos({ contatoId: anaId });
  await agendamento.processarTarefas();
  assert.equal(quadro.etapa["1"], "Não quer receber mensagens");
  assert.equal(quadro.comentarios.length, 2, "comentário de novo no histórico");
  assert.equal(avisos.length, 0);

  mc.chamadas.length = 0;
  await rodar(em(29));
  assert.equal(fluxos().length, 1, "só a Bia recebe o 'hoje'");
});

test("todos os lembretes vão para todos os inscritos, inclusive quem já está no grupo", async () => {
  quadro.itens[0].grupo = "Está no grupo"; // Ana
  quadro.itens[1].grupo = "Não está no grupo"; // Bia

  assert.equal((await rodar(em(26))).novos, 2, "3 dias: as duas");
  await rodar(em(28));
  assert.deepEqual(fluxos(), [
    "content20261021000000_000003", "content20261021000000_000003",
    "content20261021000000_000004", "content20261021000000_000004",
  ]);
  assert.doesNotMatch(concluidos[0], /no grupo/);
});

test("lembrete que não saiu a tempo (ManyChat fora) não sai atrasado depois do horário", async () => {
  await rodar(em(29)); // hoje, 10h
  // 19h: as tarefas do "falta 1 hora" são criadas, mas o envio só acontece às 21h30.
  await aula.rodarLembretesAula(em(29, 22));
  mc.chamadas.length = 0;
  agendamento.setRelogio(() => new Date("2026-10-30T00:30:00Z"));
  await agendamento.processarTarefas();
  assert.equal(fluxos().filter((f) => f === "content20261021000000_000007").length, 0);
  const ignoradas = (await store.todasTarefas()).filter((t) => t.chave.startsWith("aula:") && t.chave.includes(":1hora:"));
  assert.ok(ignoradas.length && ignoradas.every((t) => t.status === "ignorado"));
});

test("link da aula: gravado no campo do bot e no campo do contato; campo que não existe no ManyChat não trava o envio", async () => {
  mc.camposInexistentes = new Set(["link_aula"]);
  try {
    await rodar(em(29));
    const r = await rodar(em(29, 23)); // 20h: começou agora
    assert.equal(r.status, "enviado");
    assert.equal(fluxos().filter((f) => f === "content20261021000000_000006").length, 2);
  } finally {
    mc.camposInexistentes = null;
  }

  mc.chamadas.length = 0;
  store = createMemoryStore();
  setStore(store);
  await rodar(em(29, 23));
  const doContato = mc.chamadas.filter((c) => c.caminho === "/fb/subscriber/setCustomFieldByName" && c.corpo.field_name === "link_aula");
  assert.equal(doContato.length, 2);
  assert.ok(doContato.every((c) => c.corpo.field_value === "https://meet.example.com/aula-2910"));
});

test("etiqueta da turma que não existe no ManyChat não trava o lembrete", async () => {
  mc.chamadas.length = 0;
  store = createMemoryStore();
  setStore(store);
  mc.semEtiqueta = true;
  try {
    const r = await rodar(em(26));
    assert.equal(r.status, "enviado");
    assert.deepEqual(fluxos(), ["content20261021000000_000003", "content20261021000000_000003"]);
  } finally {
    mc.semEtiqueta = false;
  }
});

test("público: todo o quadro, qualquer Funil e qualquer data, menos as etapas sem avisos", async () => {
  quadro.itens.push(item("8", "Dani SDR", "+5511977776666", "Quer reunião", "2026-10-22"));
  quadro.itens.push(item("9", "Eva aguardando", "+5551977776666", "Aguardando pagamento", ""));
  quadro.itens.push(item("10", "Fê cadastro antigo", "+5511966665555", "Lead", "2025-01-10"));
  quadro.itens.push(item("11", "Gabi sem data", "+5511955554444", "Lead", "", "2024-06-01T12:00:00Z"));
  const r = await rodar(em(26));
  // Ana, Bia, Dani, Fê e Gabi: sem ciclo, a data não tira ninguém.
  assert.equal(r.novos, 5);
  for (const tel of ["+5511977776666", "+5511966665555", "+5511955554444"]) {
    assert.ok(mc.chamadas.some((c) => c.corpo?.whatsapp_phone === tel), tel);
  }
  for (const tel of ["+5551977776666", "+5531999990000", "+5541988887777"]) {
    assert.ok(!mc.chamadas.some((c) => c.corpo?.whatsapp_phone === tel), tel);
  }
  assert.match(concluidos[0], /fora pela Etapa do Funil/);
});

test("convite para amiga (2 dias antes, 10h): para todos, inclusive quem está no grupo; uma vez só", async () => {
  quadro.itens[0].grupo = "Está no grupo";
  quadro.itens[1].etapa = "Não quer receber mensagens";
  assert.equal((await rodar(em(27, 12))).status, "cedo", "9h ainda não");
  const r = await rodar(em(27));
  assert.deepEqual(r, { status: "enviado", tipo: "amiga", novos: 1, semTelefone: 1 });
  assert.deepEqual(fluxos(), ["content20261021000000_000008"], "a Ana (no grupo) recebe; a Bia (não quer) não");
  assert.equal((await rodar(em(27, 18))).status, "ja_feito");
  assert.equal(fluxos().length, 1);
});

test("AULA_PULAR_NO_GRUPO=3dias,amanha: quem está no grupo não recebe esses dois; os outros vão para todos", async () => {
  config.aula.pularNoGrupo = new Set(["3dias", "amanha"]);
  try {
    quadro.itens[0].grupo = "Está no grupo"; // Ana (a duplicada fica em branco: vale pelo telefone)
    quadro.itens[1].grupo = "Não está no grupo"; // Bia

    const r = await rodar(em(26));
    assert.equal(r.novos, 1);
    assert.match(concluidos[0], /1 já está no grupo \(recebem por lá\)/);
    await rodar(em(28));
    assert.deepEqual(fluxos(), ["content20261021000000_000003", "content20261021000000_000004"], "só a Bia");

    mc.chamadas.length = 0;
    await rodar(em(29, 23));
    assert.equal(fluxos().filter((f) => f === "content20261021000000_000006").length, 2, "começou agora: as duas");
  } finally {
    config.aula.pularNoGrupo = new Set();
  }
});

test("horário de cada lembrete configurável: 3 dias às 12h, amiga às 19h, amanhã às 20h", async () => {
  const original = { ...config.aula.horas };
  Object.assign(config.aula.horas, { "3dias": 12, amiga: 19, amanha: 20 });
  try {
    assert.equal((await rodar(em(26))).status, "cedo", "10h: 3 dias ainda não");
    assert.equal((await rodar(em(26, 15))).status, "enviado", "12h: sai");
    assert.equal((await rodar(em(27, 21))).status, "cedo", "18h: amiga ainda não");
    assert.equal((await rodar(em(27, 22))).tipo, "amiga", "19h: sai");
    assert.equal((await rodar(em(28, 22))).status, "cedo", "19h: amanhã ainda não");
    assert.equal((await rodar(em(28, 23))).tipo, "amanha", "20h: sai");
  } finally {
    Object.assign(config.aula.horas, original);
  }
});

test("horário com minutos: AULA_HORA_3DIAS=19:30 sai a partir de 19h30", async () => {
  const original = { ...config.aula.horas };
  config.aula.horas["3dias"] = 19.5;
  try {
    assert.equal((await rodar(new Date("2026-10-26T22:25:00Z"))).status, "cedo", "19h25 ainda não");
    assert.equal((await rodar(new Date("2026-10-26T22:30:00Z"))).status, "enviado", "19h30 sai");
  } finally {
    Object.assign(config.aula.horas, original);
  }
});

test("Data de Cadastro (qualquer formato ou vazia) não muda quem recebe", async () => {
  quadro.itens = [
    item("1", "Ana BR", "+5511912345678", "Lead", "26/04/2026"),
    item("2", "Bia BR", "21 98765-4321", "Lead", "27/04/2026"),
    item("3", "Cris vazia", "+5531977776666", "Lead", ""),
  ];
  const r = await rodar(em(26));
  assert.equal(r.novos, 3);
});

test("AULA_HORA=19:30: 'falta 1 hora' às 18h30 e 'começou' às 19h30, com hora_aula '19h30' no campo do bot", async () => {
  const original = config.aula.horaAula;
  config.aula.horaAula = 19.5;
  try {
    // 18h em Brasília (21h UTC): ainda não.
    assert.notEqual((await rodar(new Date("2026-10-29T21:00:00Z"))).tipo, "1hora");
    const umaHora = await rodar(new Date("2026-10-29T21:30:00Z")); // 18h30
    assert.equal(umaHora.tipo, "1hora");
    assert.ok(mc.chamadas.some((c) => c.corpo?.field_name === "hora_aula" && c.corpo?.field_value === "19h30"));
    const comecou = await rodar(new Date("2026-10-29T22:30:00Z")); // 19h30
    assert.equal(comecou.tipo, "aovivo");
  } finally {
    config.aula.horaAula = original;
  }
});

test("todas as mensagens saíram antes da lista ficar pronta: o resumo sai mesmo assim, uma vez só", async () => {
  // As tarefas já terminaram (status ok), mas a lista só agora foi marcada como pronta.
  for (const tel of ["+5511900000001", "+5511900000002"]) {
    const t = await store.criarTarefa({ chave: `aula:2026-10-29:amanha:${tel}`, tipo: "aula_lembrete", dados: {} });
    await store.atualizarTarefa(t.id, { status: "ok" });
  }
  await store.criarTarefa({ chave: "aula_varredura:2026-10-29:amanha", tipo: "aula_varredura", dados: { concluido: true, resumo: ["👥 Turma de 29/10"] } });

  await agendamento.fecharLoteDe("aula_lembrete", "aula", "2026-10-29", "amanha");
  await agendamento.fecharLoteDe("aula_lembrete", "aula", "2026-10-29", "amanha");
  assert.equal(concluidos.length, 1);
  assert.match(concluidos[0], /Lembrete da aula \(é amanhã\) concluído/);
  assert.match(concluidos[0], /Enviados: 2/);
  assert.match(concluidos[0], /Turma de 29\/10/);
});
