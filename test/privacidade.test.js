const test = require("node:test");
const assert = require("node:assert/strict");

// LGPD (v2.16.0): o que não é usado há mais de 12 meses é apagado; o que está na fila, não.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";

const { createMemoryStore } = require("../src/db/memory-store");
const { setStore } = require("../src/db");
const privacidade = require("../src/services/privacidade.service");

const VELHO = new Date("2025-09-01T12:00:00Z");
const AGORA = new Date("2026-11-07T12:00:00Z");

test("chegadas e inscrições do sorteio: apaga só as de mais de 12 meses", async () => {
  const store = createMemoryStore();
  await store.registrarChegada({ turma: "2025-09-04", contatoId: "1", whatsapp: "+5511900000001", nome: "Ana", em: VELHO });
  await store.registrarChegada({ turma: "2026-11-19", contatoId: "2", whatsapp: "+5511900000002", nome: "Cris", em: AGORA });
  await store.inscreverMentoria({ rodada: "2025-09-02", mondayItemId: "1", nome: "Ana", telefone: "+5511900000001", email: "a@x.com", em: VELHO });
  await store.inscreverMentoria({ rodada: "2026-11-10", mondayItemId: "2", nome: "Cris", telefone: "+5511900000002", email: "c@x.com", em: AGORA });

  const r = await store.limparDadosAntigos(privacidade.limite(AGORA));
  assert.equal(r.chegadas, 1);
  assert.equal(r.inscricoes, 1);
  assert.equal((await store.chegadas("2025-09-04")).length, 0);
  assert.equal((await store.chegadas("2026-11-19")).length, 1);
  assert.equal((await store.inscricoesMentoria("2025-09-02")).length, 0);
  assert.equal((await store.inscricoesMentoria("2026-11-10")).length, 1);
});

test("tarefas e pré-atendimentos: a fila e o que espera a Monday nunca são apagados; a ligação com o ManyChat fica", async () => {
  const store = createMemoryStore();
  const feita = await store.criarTarefa({ chave: "aula:2025-09-04:3dias:+5511900000001", tipo: "aula_lembrete", dados: { nome: "Ana" } });
  await store.atualizarTarefa(feita.id, { status: "ok" });
  await store.criarTarefa({ chave: "reuniao_aviso:x:dia", tipo: "reuniao_aviso", dados: { nome: "Bia" } }); // pendente
  const concluido = await store.criar({ contatoId: "10", whatsapp: "+5511900000003" });
  await store.atualizar(concluido.id, { sync: "ok" });
  const esperando = await store.criar({ contatoId: "11", whatsapp: "+5511900000004" });
  await store.atualizar(esperando.id, { sync: "pendente" });
  await store.salvarContatoManychat("+5511900000001", "777");

  // Limite no futuro: tudo é "antigo"; só o que não está em andamento sai.
  const r = await store.limparDadosAntigos(new Date(Date.now() + 60000));
  assert.equal(r.tarefas, 1);
  assert.equal(r.atendimentos, 1);
  assert.equal(await store.tarefaPorChave("aula:2025-09-04:3dias:+5511900000001"), null);
  assert.ok(await store.tarefaPorChave("reuniao_aviso:x:dia"), "tarefa na fila nunca é apagada");
  assert.equal((await store.porId(esperando.id)).sync, "pendente", "pré-atendimento esperando a Monday fica");
  assert.equal(await store.porId(concluido.id), null);
  assert.equal(await store.contatoManychat("+5511900000001"), "777", "a ligação com o ManyChat fica");

  // O pré-atendimento apagado deixa a ligação telefone -> contato (para mandar mensagens depois).
  assert.equal(await store.contatoManychat("+5511900000003"), "10", "ligação de quem só conversou com a Mani fica");
  assert.equal(await store.telefoneDoContato("10"), "+5511900000003");

  // Limite de verdade (12 meses): nada recente sai.
  const nada = await store.limparDadosAntigos(privacidade.limite(new Date()));
  assert.deepEqual(nada, { tarefas: 0, atendimentos: 0, chegadas: 0, inscricoes: 0 });
});

test("o pedido de parar as mensagens (sem_avisos) nunca é apagado", async () => {
  const store = createMemoryStore();
  const pedido = await store.criarTarefa({ chave: "sem_avisos:777", tipo: "sem_avisos", dados: { contatoId: "777" } });
  await store.atualizarTarefa(pedido.id, { status: "sem_cadastro" });
  const r = await store.limparDadosAntigos(new Date(Date.now() + 60000));
  assert.equal(r.tarefas, 0);
  assert.ok(await store.tarefaPorChave("sem_avisos:777"));
});

test("limite: 12 meses antes por padrão; roda uma vez por dia", async () => {
  setStore(createMemoryStore());
  privacidade.reiniciar();
  assert.equal(privacidade.limite(AGORA).toISOString().slice(0, 10), "2025-11-07");
  assert.equal((await privacidade.limpar(AGORA)).status, "ok");
  assert.equal((await privacidade.limpar(AGORA)).status, "ja_feito");
});
