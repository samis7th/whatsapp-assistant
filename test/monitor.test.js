const test = require("node:test");
const assert = require("node:assert/strict");

// Tela "Sistema" do painel: rota só de leitura com configuração, próximos envios,
// problemas, atividade recente e o log.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.WORKER_ENABLED = "false";
process.env.INTERNO_SECRET = "chave-interna-do-painel-com-32-caracteres-ou-mais";
process.env.MANYCHAT_FLOW_AULA_3DIAS = "content20261021000000_000003";

const registro = require("../src/utils/registro");
registro.instalar();

const app = require("../src/app");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");

let servidor;
let base;
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
});

async function monitor(chave = process.env.INTERNO_SECRET) {
  const response = await fetch(`${base}/interno/monitor`, { headers: { "X-Interno-Key": chave } });
  return { status: response.status, corpo: await response.json() };
}

test("sem a chave interna: recusa", async () => {
  assert.equal((await monitor("errada-errada-errada-errada-errada-errada")).status, 401);
});

test("mostra configuração, próximos envios, problemas, atividade e log, sem expor registros internos", async () => {
  const agora = Date.now();
  await store.criarTarefa({
    chave: "reuniao_aviso:EV1:vespera",
    tipo: "reuniao_aviso",
    dados: { evento: "x", aviso: "vespera" },
    proxima: new Date(agora + 3600000),
  });
  const falhou = await store.criarTarefa({
    chave: "aula:2026-10-29:amanha:+5511912345678",
    tipo: "aula_lembrete",
    dados: { nome: "Ana Souza", telefone: "+5511912345678" },
  });
  await store.atualizarTarefa(falhou.id, { tentativas: 2, erro: "O ManyChat recusou", proxima: new Date(agora - 1000) });
  await store.criarTarefa({ chave: "reuniao:EV1", tipo: "reuniao_registro", dados: { nome: "interno" } });
  console.log("linha de teste do log");

  const { status, corpo } = await monitor();
  assert.equal(status, 200);
  assert.equal(corpo.ok, true);
  assert.ok(corpo.versao);

  const tresDias = corpo.conexoes.find((c) => c.nome === "Faltam 3 dias");
  assert.equal(tresDias.ok, true);
  assert.equal(corpo.conexoes.find((c) => c.nome === "Véspera (dia anterior)").ok, false);

  assert.equal(corpo.proximas.length, 1);
  assert.equal(corpo.proximas[0].rotulo, "lembrete da reunião");
  assert.equal(corpo.proximas[0].detalhe, "vespera");

  assert.equal(corpo.problemas.length, 1);
  assert.equal(corpo.problemas[0].nome, "Ana Souza");
  assert.equal(corpo.problemas[0].detalhe, "2026-10-29 · amanha", "sem o telefone no detalhe");
  assert.equal(corpo.problemas[0].erro, "O ManyChat recusou");

  assert.ok(!corpo.recentes.some((t) => t.tipo === "reuniao_registro"), "registros internos ficam de fora");
  assert.ok(corpo.contagem.linhas.some((l) => l.tipo === "aula_lembrete" && l.status === "pendente"));
  assert.ok(corpo.log.some((l) => l.texto === "linha de teste do log" && l.nivel === "info"));
});
