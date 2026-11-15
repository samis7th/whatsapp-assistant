const test = require("node:test");
const assert = require("node:assert/strict");

// Sorteio semanal das mentorias (checklist da Parte 3 do documento do gestor), com
// Monday, ManyChat, Calendly e Telegram simulados. Rodada de terça 10/11/2026.
process.env.DATA_MEMORY = "true";
process.env.MANYCHAT_SECRET = "chave-de-teste-com-mais-de-32-caracteres-123";
process.env.MONDAY_API_TOKEN = "token-de-teste";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
process.env.TELEGRAM_CHAT_ID = "-100123";
process.env.WORKER_ENABLED = "false";
process.env.MANYCHAT_API_KEY = "chave-api-manychat";
process.env.SORTEIO_INICIO = "2026-11-10";
process.env.INTERNO_SECRET = "segredo-interno-de-teste-com-32-caracteres-ou-mais";
process.env.MANYCHAT_FLOW_SORTEIO_AVISO = "content20261104202113_000001";
process.env.MANYCHAT_FLOW_SORTEIO_SORTEADA = "content20261104202011_000002";
process.env.MANYCHAT_FLOW_SORTEIO_LEMBRETE1 = "content20261104202241_000003";
process.env.MANYCHAT_FLOW_SORTEIO_LEMBRETE2 = "content20261104202517_000004";
process.env.MANYCHAT_FLOW_SORTEIO_PERDEU_VAGA = "content20261104202645_000005";
process.env.MANYCHAT_FLOW_MENTORIA_VESPERA = "content20261104202819_000006";
process.env.MANYCHAT_FLOW_MENTORIA_1HORA = "content20261104203045_000007";

const { config } = require("../src/config/env");
const { createMemoryStore } = require("../src/db/memory-store");
const { setStore, getStore } = require("../src/db");
const monday = require("../src/services/monday.service");
const manychat = require("../src/services/manychat.service");
const telegram = require("../src/services/telegram.service");
const agendamento = require("../src/services/agendamento.service");
const mentoria = require("../src/services/mentoria.service");

const F = config.manychat.flowSorteio;
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Map() });

// ---------- quadro da Monday ----------
let quadro;
let mondayFora = false;
const antigos = new Set();
let leiturasDoQuadro = 0;

function quadroInicial() {
  return [
    { id: "1", nome: "Ana", telefone: "+5511911110001", email: "ana@x.com", etapa: "Lead" },
    { id: "2", nome: "Bia", telefone: "+5511911110002", email: "bia@x.com", etapa: "" },
    { id: "3", nome: "Cris", telefone: "+5511911110003", email: "cris@x.com", etapa: "Quer reunião" },
    { id: "4", nome: "Duda", telefone: "+5511911110004", email: "duda@x.com", etapa: "Reunião agendada" },
    { id: "5", nome: "Eva", telefone: "+5511911110005", email: "eva@x.com", etapa: "Lead" },
    { id: "6", nome: "Fê", telefone: "+5511911110006", email: "fe@x.com", etapa: "Lead" },
    { id: "7", nome: "Gabi", telefone: "+5511911110007", email: "gabi@x.com", etapa: "Lead" },
    // As seis etiquetas que tiram do sorteio.
    { id: "11", nome: "Recusou", telefone: "+5511922220001", email: "r1@x.com", etapa: "Negócio Recusado" },
    { id: "12", nome: "Sumiu", telefone: "+5511922220002", email: "r2@x.com", etapa: "Não Respondeu" },
    { id: "13", nome: "Fora", telefone: "+5511922220003", email: "r3@x.com", etapa: "Fora do Perfil" },
    { id: "14", nome: "Parou", telefone: "+5511922220004", email: "r4@x.com", etapa: "Não quer receber mensagens" },
    { id: "15", nome: "Ex", telefone: "+5511922220005", email: "r5@x.com", etapa: "Deixou de ser cliente" },
    { id: "16", nome: "Carrinho", telefone: "+5511922220006", email: "r6@x.com", etapa: "Aguardando pagamento" },
  ];
}

const escritas = [];
const comentarios = [];

function colunasDo(item) {
  return [
    { id: "phonenhzs51c9", text: item.telefone, phone: item.telefone.replace("+", "") },
    { id: "emailhnvgrjbb", text: item.email, email: item.email },
    { id: "etapa", text: item.etapa, label: item.etapa },
  ];
}

async function mondaySimulada(url, init) {
  const { query, variables } = JSON.parse(init.body);
  if (mondayFora) return ok({ errors: [{ message: "fora do ar" }] }, 500);
  if (query.includes("query PorEmail")) {
    const items = quadro.filter((i) => i.email === variables.valores[0]).map((i) => ({ id: i.id, name: i.nome, column_values: colunasDo(i) }));
    return ok({ data: { items_page_by_column_values: { items } } });
  }
  if (query.includes("columns")) {
    const columns = [
      { id: "fat", title: "Faturamento Mensal", type: "status" },
      { id: "etapa", title: "Etapa do Funil", type: "status" },
      { id: "prox", title: "Próximo Contato", type: "date" },
      { id: "ult", title: "Último Contato", type: "date" },
    ];
    return ok({ data: { boards: [{ columns }] } });
  }
  if (query.includes("query Obs")) {
    const item = quadro.find((i) => i.id === String(variables.itemId[0]));
    return ok({ data: { items: [{ column_values: [{ text: item?.etapa || "" }] }] } });
  }
  if (query.includes("change_multiple_column_values")) {
    const valores = JSON.parse(variables.valores);
    escritas.push({ itemId: variables.itemId, valores });
    const item = quadro.find((i) => i.id === String(variables.itemId));
    if (item && valores.phonenhzs51c9) item.telefone = `+${valores.phonenhzs51c9.phone}`;
    if (item && valores.etapa?.label) item.etapa = valores.etapa.label;
    return ok({ data: { change_multiple_column_values: { id: variables.itemId } } });
  }
  if (query.includes("create_update")) {
    comentarios.push(variables.texto);
    return ok({ data: { create_update: { id: "1" } } });
  }
  // Telefones e inscritos: o quadro inteiro numa página.
  if (query.includes("query Telefones")) leiturasDoQuadro++;
  const items = quadro.map((i) => ({ id: i.id, name: i.nome, created_at: "2026-10-01T12:00:00Z", column_values: colunasDo(i) }));
  return ok({ data: { boards: [{ items_page: { cursor: null, items } }] } });
}

// ---------- ManyChat e Telegram ----------
let envios;
let campos;
let contatos;
let telegrams;

manychat.setFetch(async (url, init) => {
  const corpo = init.body ? JSON.parse(init.body) : {};
  if (url.includes("sendFlow")) envios.push({ flow: corpo.flow_ns, contato: String(corpo.subscriber_id), quando: agora });
  if (url.includes("setCustomFieldByName")) campos.push({ contato: String(corpo.subscriber_id), campo: corpo.field_name, valor: corpo.field_value });
  if (url.includes("createSubscriber")) {
    // Contato antigo do ManyChat que a API não acha (v2.18.1).
    if (antigos.has(corpo.whatsapp_phone)) return ok({ status: "error", message: "Validation error", details: { messages: [{ message: "This WhatsApp ID already exists" }] } }, 400);
    contatos.set(corpo.whatsapp_phone, String(7000 + contatos.size));
    return ok({ status: "success", data: { id: Number(contatos.get(corpo.whatsapp_phone)) } });
  }
  if (url.includes("findBySystemField") || url.includes("findByCustomField")) return ok({ status: "success", data: [] });
  return ok({ status: "success", data: {} });
});

telegram.setFetch(async (url, init) => {
  telegrams.push(JSON.parse(init.body).text);
  return ok({ ok: true, result: {} });
});

let agora;

function relogio(iso) {
  agora = new Date(iso);
  agendamento.setRelogio(() => agora);
  return agora;
}

// Relógio de 5 em 5 minutos, como no servidor.
async function simular(deIso, ateIso) {
  for (let t = Date.parse(deIso); t < Date.parse(ateIso); t += 5 * 60000) {
    relogio(new Date(t).toISOString());
    await mentoria.rodar(agora);
    await agendamento.processarTarefas();
  }
}

const doFluxo = (flow) => envios.filter((e) => e.flow === flow);
const inscrever = (pessoa, extra = {}) =>
  mentoria.inscrever({ nome: pessoa.nome, email: pessoa.email, whatsapp: pessoa.telefone, aceite: true, ...extra }, agora);

test.beforeEach(() => {
  setStore(createMemoryStore());
  // setFetch também limpa a lista de telefones em memória (cada teste tem o seu quadro).
  monday.setFetch(mondaySimulada);
  quadro = quadroInicial();
  mondayFora = false;
  envios = [];
  campos = [];
  contatos = new Map();
  telegrams = [];
  escritas.length = 0;
  comentarios.length = 0;
});

// Terça 10/11 12h30 em Brasília = 15h30 UTC.
const TERCA_1230 = "2026-11-10T15:30:00.000Z";
const QUARTA_1230 = "2026-11-11T15:30:00.000Z";
// O sorteio roda 5 minutos depois do corte.
const QUARTA_1235 = "2026-11-11T15:35:00.000Z";

test("página: fechada antes da primeira terça, aberta de terça 12h30 até quarta 8h (v3.2.2)", () => {
  assert.equal(mentoria.estado(new Date("2026-11-05T12:00:00Z")).aberta, false);
  assert.equal(mentoria.estado(new Date("2026-11-05T12:00:00Z")).proximaAbertura, "2026-11-10T15:30:00.000Z");
  assert.equal(mentoria.estado(new Date("2026-11-10T15:29:00Z")).aberta, false);
  assert.equal(mentoria.estado(new Date(TERCA_1230)).aberta, true);
  assert.equal(mentoria.estado(new Date(TERCA_1230)).encerraEm, "2026-11-11T11:00:00.000Z");
  assert.equal(mentoria.estado(new Date("2026-11-11T10:59:00Z")).aberta, true);
  const depois = mentoria.estado(new Date("2026-11-11T11:00:00Z"));
  assert.equal(depois.aberta, false);
  assert.equal(depois.proximaAbertura, "2026-11-17T15:30:00.000Z", "a próxima é na terça seguinte");
});

test("aviso de terça 12h30: só para quem pode concorrer, uma vez só", async () => {
  await simular("2026-11-10T15:00:00Z", "2026-11-10T17:00:00Z");
  assert.equal(doFluxo(F.aviso).length, 7, "Ana a Gabi; as seis etiquetas ficam de fora");
  assert.equal(doFluxo(F.aviso)[0].quando.toISOString(), TERCA_1230);
  assert.match(telegrams.find((t) => t.includes("aviso de inscrição")), /6 ficaram de fora/);
  await simular("2026-11-10T17:00:00Z", "2026-11-10T18:00:00Z");
  assert.equal(doFluxo(F.aviso).length, 7, "não repete");
});

test("inscrição elegível entra na rodada; repetir não duplica", async () => {
  relogio("2026-11-10T16:00:00Z");
  const ana = quadro[0];
  assert.deepEqual(await inscrever(ana), { resultado: "confirmada", nova: true });
  assert.deepEqual(await inscrever(ana), { resultado: "confirmada", nova: false });
  const lista = await getStore().inscricoesMentoria("2026-11-10");
  assert.equal(lista.length, 1);
  assert.equal(lista[0].mondayItemId, "1");
});

test("cada uma das seis etiquetas de exclusão não entra", async () => {
  relogio("2026-11-10T16:00:00Z");
  for (const pessoa of quadro.filter((i) => Number(i.id) > 10)) {
    assert.equal((await inscrever(pessoa)).resultado, "nao_elegivel", pessoa.etapa);
  }
  assert.equal((await getStore().inscricoesMentoria("2026-11-10")).length, 0);
});

test("mesmo e-mail com outro telefone: a página acha pelo e-mail, atualiza o telefone no CRM e entra", async () => {
  relogio("2026-11-10T16:00:00Z");
  const r = await inscrever({ nome: "Bia", email: "bia@x.com", telefone: "(21) 98888-7777" });
  assert.equal(r.resultado, "confirmada");
  await agendamento.processarTarefas();
  assert.deepEqual(escritas.find((e) => e.valores.phonenhzs51c9).valores.phonenhzs51c9, { phone: "5521988887777", countryShortName: "BR" });
  assert.ok(comentarios.some((c) => /Telefone atualizado pelo sorteio das mentorias \(achado pelo e-mail na página\)/.test(c)));
  assert.equal((await getStore().inscricoesMentoria("2026-11-10"))[0].telefone, "+5521988887777");
});

// Com o modelo "Verificar cadastro" configurado: quem a página não acha nem pelo telefone nem
// pelo e-mail confere o e-mail pelo WhatsApp e recebe de novo o link da página.
async function comVerificacao(fazer) {
  const original = config.manychat.flowSorteio.verificar;
  config.manychat.flowSorteio.verificar = "content20261105000000_000008";
  try {
    await fazer(config.manychat.flowSorteio.verificar);
  } finally {
    config.manychat.flowSorteio.verificar = original;
  }
}

const pedirEmail = (contato, email) => mentoria.receberEmail({ contatoId: contato, email }, agora);

test("e-mail digitado errado na página: a Mani manda o \"Verificar cadastro\", a pessoa confere o e-mail e se inscreve de novo", async () => {
  await comVerificacao(async (fluxo) => {
    relogio("2026-11-10T16:00:00Z");
    const r = await inscrever({ nome: "Bia", email: "bia@errado.com", telefone: "(21) 98888-7777" });
    assert.equal(r.resultado, "verificar_whatsapp");
    await agendamento.processarTarefas();
    assert.equal(doFluxo(fluxo).length, 1);
    assert.equal(telegrams.length, 0, "a equipe só é chamada se nem o WhatsApp resolver");

    const contato = doFluxo(fluxo)[0].contato;
    assert.deepEqual(await pedirEmail(contato, "BIA@x.com"), { resultado: "encontrado", primeiro_nome: "Bia" });
    await agendamento.processarTarefas();
    assert.deepEqual(escritas.find((e) => e.valores.phonenhzs51c9).valores.phonenhzs51c9, { phone: "5521988887777", countryShortName: "BR" });
    assert.ok(comentarios.some((c) => /\(confirmado pelo WhatsApp\)/.test(c)));
    assert.equal((await getStore().inscricoesMentoria("2026-11-10")).length, 0, "a inscrição é feita pela página, com o link");

    // Pela página de novo, agora o telefone acha o cadastro.
    assert.equal((await inscrever({ nome: "Bia", email: "bia@errado.com", telefone: "(21) 98888-7777" })).resultado, "confirmada");
    assert.equal((await getStore().inscricoesMentoria("2026-11-10"))[0].mondayItemId, "2");
  });
});

test("verificação pelo WhatsApp sem achar o e-mail duas vezes: aí sim avisa a equipe", async () => {
  await comVerificacao(async (fluxo) => {
    relogio("2026-11-10T16:00:00Z");
    assert.equal((await inscrever({ nome: "Zoe", email: "zoe@x.com", telefone: "11 93333-0000" })).resultado, "verificar_whatsapp");
    await agendamento.processarTarefas();
    const contato = doFluxo(fluxo)[0].contato;
    assert.equal((await pedirEmail(contato, "zoe")).resultado, "email_invalido");
    assert.equal((await pedirEmail(contato, "zoe@y.com")).resultado, "nao_encontrado");
    assert.equal(telegrams.length, 0);
    assert.equal((await pedirEmail(contato, "zoe@z.com")).resultado, "encaminhado");
    assert.equal(telegrams.length, 1);
    assert.match(telegrams[0], /Inscrição no sorteio sem cadastro/);
    assert.match(telegrams[0], /também não achei o e-mail zoe@z\.com/);
    assert.equal((await pedirEmail(contato, "zoe@w.com")).resultado, "sem_verificacao", "depois de resolvida, não conta mais");
  });
});

test("verificação respondida depois do corte de quarta: inscrições encerradas", async () => {
  await comVerificacao(async (fluxo) => {
    relogio("2026-11-11T10:00:00Z");
    await inscrever({ nome: "Bia", email: "bia@errado.com", telefone: "(21) 98888-7777" });
    await agendamento.processarTarefas();
    relogio("2026-11-11T11:05:00Z");
    assert.equal((await pedirEmail(doFluxo(fluxo)[0].contato, "bia@x.com")).resultado, "encerrada");
  });
});

test("botão tocado sem pedido de verificação (ou de outra semana): sem_verificacao", async () => {
  relogio("2026-11-10T16:00:00Z");
  assert.equal((await pedirEmail("9999", "bia@x.com")).resultado, "sem_verificacao");
});

test("só o telefone bate (outro e-mail): entra sem mexer no CRM", async () => {
  relogio("2026-11-10T16:00:00Z");
  assert.equal((await inscrever({ nome: "Ana", email: "outro@x.com", telefone: "11 91111-0001" })).resultado, "confirmada");
  assert.equal(escritas.length, 0);
});

test("não está no CRM: alerta no Telegram (com a lista do grupo), sem cadastro; uma vez por rodada", async () => {
  await mentoria.guardarListaDoGrupo(["+55 11 93333-0000", "+5511944440000"], "2026-11-09T13:00:00Z");
  relogio("2026-11-10T16:00:00Z");
  const desconhecida = { nome: "Zoe", email: "zoe@x.com", telefone: "11 93333-0000" };
  assert.equal((await inscrever(desconhecida)).resultado, "nao_encontrada");
  assert.equal((await inscrever(desconhecida)).resultado, "nao_encontrada");
  assert.equal(telegrams.length, 1, "um alerta só");
  assert.match(telegrams[0], /Inscrição no sorteio sem cadastro/);
  assert.match(telegrams[0], /zoe@x\.com/);
  assert.match(telegrams[0], /Está no grupo \(lista de 09\/11\): sim/);
  assert.match(telegrams[0], /Essa pessoa tentou se inscrever mas não tem cadastro/);
  assert.equal((await getStore().inscricoesMentoria("2026-11-10")).length, 0);
});

test("depois do corte de quarta 12h30 não entra; dados inválidos ou sem aceite são recusados", async () => {
  relogio(QUARTA_1230);
  assert.equal((await inscrever(quadro[0])).resultado, "encerrada");
  relogio("2026-11-10T16:00:00Z");
  assert.equal((await inscrever(quadro[0], { aceite: false })).resultado, "invalido");
  assert.equal((await inscrever(quadro[0], { email: "sem-arroba" })).resultado, "invalido");
  assert.equal((await inscrever(quadro[0], { whatsapp: "123" })).resultado, "invalido");
});

test("menos de 4 inscritas: todas são sorteadas, com registro auditável, e recebem o link às 12h35", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await inscrever(quadro[1]);
  await simular("2026-11-11T15:00:00Z", "2026-11-11T16:00:00Z");

  const lista = await getStore().inscricoesMentoria("2026-11-10");
  assert.ok(lista.every((i) => i.sorteada && i.agendamento === "pendente"));
  const registro = await getStore().tarefaPorChave("mentoria_rodada:2026-11-10");
  assert.equal(registro.dados.concorrentes.length, 2);
  assert.deepEqual(registro.dados.sorteadas.sort(), lista.map((i) => i.id).sort());
  assert.ok(registro.dados.sorteadoEm && registro.dados.execucao);
  assert.equal(doFluxo(F.sorteada).length, 2);
  assert.equal(doFluxo(F.sorteada)[0].quando.toISOString(), QUARTA_1235);
  // v3.2.0: o resultado vai para o Telegram com os nomes (aqui o app só rodou a partir das
  // 12h, então o sorteio saiu atrasado, sem tempo para trocas).
  const resultado = telegrams.find((t) => /Sorteio das mentorias feito/.test(t));
  assert.match(resultado, /📝 Inscritas: 2 · 🎲 Concorreram: 2 · 🚫 Fora pela Etapa: 0/);
  assert.match(resultado, /🎉 Sorteadas \(2\):/);
  assert.match(resultado, /saiu atrasado.*saem às 12h35\./, "às 12h ainda não é a hora dos avisos");
  assert.ok(resultado.includes("Ana") && resultado.includes("Bia"));
});

test("mais de 4 inscritas: sorteia exatamente 4; rodar de novo não sorteia outra vez", async () => {
  relogio("2026-11-10T16:00:00Z");
  for (const pessoa of quadro.slice(0, 7)) await inscrever(pessoa);
  await simular("2026-11-11T15:30:00Z", "2026-11-11T16:00:00Z");
  const primeira = (await getStore().inscricoesMentoria("2026-11-10")).filter((i) => i.sorteada).map((i) => i.id);
  assert.equal(primeira.length, 4);
  await simular("2026-11-11T16:00:00Z", "2026-11-11T18:00:00Z");
  const depois = (await getStore().inscricoesMentoria("2026-11-10")).filter((i) => i.sorteada).map((i) => i.id);
  assert.deepEqual(depois, primeira);
  assert.equal(doFluxo(F.sorteada).length, 4);
});

test("quem passou a ter etiqueta de exclusão depois de se inscrever não concorre", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await inscrever(quadro[1]);
  quadro[1].etapa = "Não quer receber mensagens";
  await simular("2026-11-11T15:30:00Z", "2026-11-11T15:40:00Z");
  const registro = await getStore().tarefaPorChave("mentoria_rodada:2026-11-10");
  assert.equal(registro.dados.concorrentes.length, 1);
  assert.equal(registro.dados.excluidas[0].motivo, "Não quer receber mensagens");
});

test("falha no sorteio: alerta no Telegram, ninguém é avisada; tenta de novo e avisa depois", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  mondayFora = true;
  await simular("2026-11-11T15:30:00Z", "2026-11-11T18:05:00Z");
  assert.equal(doFluxo(F.sorteada).length, 0, "não avisa rodada incompleta");
  // Um alerta por hora (12h, 13h, 14h e 15h), não um a cada 5 minutos.
  assert.equal(telegrams.filter((t) => t.includes("O sorteio das mentorias falhou")).length, 4);
  assert.equal(await getStore().tarefaPorChave("mentoria_rodada:2026-11-10"), null);
  mondayFora = false;
  await simular("2026-11-11T18:05:00Z", "2026-11-11T18:15:00Z");
  assert.equal(doFluxo(F.sorteada).length, 1);
});

function convidado({ email, telefone, inicio, evento = "https://api.calendly.com/scheduled_events/MEN1", tipo = "invitee.created", rescheduled = false }) {
  return {
    event: tipo,
    payload: {
      uri: `${evento}/invitees/I1`,
      email,
      name: "Convidada",
      rescheduled,
      questions_and_answers: telefone ? [{ question: "WhatsApp", answer: telefone }] : [],
      scheduled_event: {
        uri: evento,
        name: "Reunião com o Consultor - Mentoria",
        start_time: inicio,
        location: { type: "google_conference", join_url: "https://meet.google.com/abc-defg-hij" },
      },
    },
  };
}

test("régua: lembretes quarta 19h e quinta 12h só para quem não agendou; para assim que agenda", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await inscrever(quadro[1]);
  await simular("2026-11-11T15:30:00Z", "2026-11-11T22:30:00Z");
  assert.equal(doFluxo(F.lembrete1).length, 2, "quarta 19h para as duas");
  assert.equal(doFluxo(F.lembrete1)[0].quando.toISOString(), "2026-11-11T22:00:00.000Z");

  // Ana agenda na quinta de manhã, pelo e-mail; a régua dela para.
  relogio("2026-11-12T12:00:00Z");
  const r = await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-13T18:00:00Z" }));
  assert.equal(r.mentoria, "agendada");
  assert.ok(telegrams.some((t) => t.includes("Mentoria agendada:") && t.includes("Ana")));

  await simular("2026-11-12T14:30:00Z", "2026-11-12T16:00:00Z");
  assert.equal(doFluxo(F.lembrete2).length, 1, "quinta 12h só para a Bia");
});

test("prazo de sexta 12h: quem não agendou perde a vaga e recebe o aviso às 15h", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await inscrever(quadro[1]);
  await simular("2026-11-11T15:30:00Z", "2026-11-11T15:40:00Z");
  relogio("2026-11-11T20:00:00Z");
  await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-16T18:00:00Z" }));

  await simular("2026-11-13T14:55:00Z", "2026-11-13T18:30:00Z");
  const lista = await getStore().inscricoesMentoria("2026-11-10");
  assert.equal(lista.find((i) => i.mondayItemId === "2").agendamento, "perdeu");
  assert.equal(lista.find((i) => i.mondayItemId === "1").agendamento, "agendada");
  assert.equal(doFluxo(F.perdeu).length, 1);
  assert.equal(doFluxo(F.perdeu)[0].quando.toISOString(), "2026-11-13T18:00:00.000Z");
  // v2.13.0: fechamento da semana, com quem agendou e quem perdeu a vaga.
  const fechamento = telegrams.find((t) => /Fechamento do sorteio das mentorias/.test(t));
  assert.ok(fechamento);
  assert.match(fechamento, /2 inscritas · 2 sorteadas/);
  assert.match(fechamento, /✅ Agendaram \(1\):\n• Ana[^\n]*seg\. 16\/11 às 15:00/);
  assert.match(fechamento, /⏳ Perderam a vaga \(1\):\n• Bia/);
  assert.equal(telegrams.filter((t) => /Fechamento/.test(t)).length, 1, "uma vez só");
  assert.ok(comentarios.some((c) => /perdeu a vaga/.test(c)));
});

test("mentoria agendada: lembretes 1 dia antes e 1 hora antes, com dia, hora e link do Meet", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await simular("2026-11-11T15:30:00Z", "2026-11-11T15:40:00Z");
  // Telefone do Calendly (com outro e-mail) também liga à sorteada.
  relogio("2026-11-11T20:00:00Z");
  await agendamento.receberWebhook(convidado({ email: "outro@x.com", telefone: "11 91111-0001", inicio: "2026-11-13T18:30:00Z" }));

  await simular("2026-11-12T18:00:00Z", "2026-11-13T18:40:00Z");
  assert.equal(doFluxo(F.vespera).length, 1);
  assert.equal(doFluxo(F.vespera)[0].quando.toISOString(), "2026-11-12T18:30:00.000Z");
  assert.equal(doFluxo(F.umaHora).length, 1);
  assert.equal(doFluxo(F.umaHora)[0].quando.toISOString(), "2026-11-13T17:30:00.000Z");
  const valores = Object.fromEntries(campos.map((c) => [c.campo, c.valor]));
  assert.deepEqual(valores, { mentoria_data: "13/11", mentoria_hora: "15h30", mentoria_link: "https://meet.google.com/abc-defg-hij" });
  assert.equal(doFluxo(F.lembrete2).length, 0, "agendou antes da quinta: régua parou");
});

test("mentoria cancelada antes do prazo: lembretes não saem e a régua volta", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await simular("2026-11-11T15:30:00Z", "2026-11-11T15:40:00Z");
  relogio("2026-11-11T20:00:00Z");
  await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-13T18:00:00Z" }));
  relogio("2026-11-12T10:00:00Z");
  await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-13T18:00:00Z", tipo: "invitee.canceled" }));
  assert.equal((await getStore().inscricoesMentoria("2026-11-10"))[0].agendamento, "pendente");
  assert.ok(telegrams.some((t) => t.includes("Mentoria cancelada")));

  await simular("2026-11-12T14:55:00Z", "2026-11-13T19:00:00Z");
  assert.equal(doFluxo(F.vespera).length, 0);
  assert.equal(doFluxo(F.umaHora).length, 0);
  assert.equal(doFluxo(F.lembrete2).length, 1, "voltou para a régua");
});

test("agendou sem ter sido sorteada: só alerta a equipe", async () => {
  relogio("2026-11-11T20:00:00Z");
  const r = await agendamento.receberWebhook(convidado({ email: "zoe@x.com", inicio: "2026-11-13T18:00:00Z" }));
  assert.equal(r.mentoria, "sem_sorteada");
  assert.ok(telegrams.some((t) => t.includes("não foi sorteada")));
});

test("antes de SORTEIO_INICIO e sem a variável, nada roda", async () => {
  await simular("2026-11-03T15:00:00Z", "2026-11-03T17:00:00Z");
  assert.equal(envios.length, 0);
  const inicio = config.sorteio.inicio;
  config.sorteio.inicio = "";
  try {
    await simular("2026-11-10T15:00:00Z", "2026-11-10T16:00:00Z");
    assert.equal(envios.length, 0);
    assert.equal(mentoria.estado(new Date(TERCA_1230)).aberta, false);
  } finally {
    config.sorteio.inicio = inicio;
  }
});

test("pediu para parar (botão do aviso): os avisos seguintes do sorteio não saem", async () => {
  await simular("2026-11-10T15:25:00Z", "2026-11-10T15:40:00Z");
  const ana = doFluxo(F.aviso)[0].contato;
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  assert.deepEqual(await agendamento.pararAvisos({ contatoId: ana }), { resultado: "ok" });
  await agendamento.processarTarefas();
  await simular("2026-11-11T15:30:00Z", "2026-11-11T15:40:00Z");
  assert.equal(doFluxo(F.sorteada).filter((e) => e.contato === ana).length, 0);
});

test("rotas da página: só o site da Acme pode chamar; estado e inscrição respondem em JSON", async () => {
  const app = require("../src/app");
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const pre = await fetch(`${base}/sorteio/inscricao`, {
      method: "OPTIONS",
      headers: { Origin: "https://www.example.com", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://www.example.com");

    const estranho = await fetch(`${base}/sorteio/estado`, { headers: { Origin: "https://site-qualquer.com" } });
    assert.equal(estranho.headers.get("access-control-allow-origin"), null);
    const estado = await estranho.json();
    assert.equal(estado.ok, true);
    assert.equal(typeof estado.aberta, "boolean");

    const ruim = await fetch(`${base}/sorteio/inscricao`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://www.example.com" },
      body: JSON.stringify({ nome: "Ana", email: "x", whatsapp: "1", aceite: true }),
    });
    assert.equal(ruim.status, 400);
    assert.equal((await ruim.json()).resultado, "invalido");
  } finally {
    servidor.close();
  }
});

test("cada passo deixa um comentário no cadastro da Monday, uma vez só", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await inscrever(quadro[0]);
  await simular("2026-11-11T15:30:00Z", "2026-11-11T15:40:00Z");
  relogio("2026-11-11T20:00:00Z");
  await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-13T18:00:00Z" }));
  relogio("2026-11-12T10:00:00Z");
  await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-13T18:00:00Z", tipo: "invitee.canceled" }));
  await agendamento.processarTarefas();

  assert.equal(comentarios.filter((c) => c.includes("Inscreveu-se no sorteio")).length, 1, "a segunda inscrição não repete");
  assert.equal(comentarios.filter((c) => c.includes("Sorteada para a mentoria")).length, 1);
  assert.equal(comentarios.filter((c) => c.includes("Agendou a mentoria")).length, 1);
  assert.equal(comentarios.filter((c) => c.includes("Cancelou a mentoria")).length, 1);
});

test("carga: 300 inscrições ao mesmo tempo (com cliques repetidos) e duas cópias do app sorteando juntas", async () => {
  for (let n = 0; n < 300; n++) {
    quadro.push({ id: String(1000 + n), nome: `Pessoa ${n}`, telefone: `+55119${String(50000000 + n).padStart(8, "0")}`, email: `p${n}@x.com`, etapa: "Lead" });
  }
  const multidao = quadro.filter((i) => Number(i.id) >= 1000);
  leiturasDoQuadro = 0;
  relogio("2026-11-10T15:31:00Z");

  // Cada pessoa clica duas vezes; tudo chega junto.
  const respostas = await Promise.all([...multidao, ...multidao].map((pessoa) => inscrever(pessoa)));
  const porResultado = respostas.reduce((m, r) => ({ ...m, [r.resultado]: (m[r.resultado] || 0) + 1 }), {});
  assert.deepEqual(porResultado, { confirmada: 600 });
  assert.equal(respostas.filter((r) => r.nova).length, 300, "uma inscrição por pessoa");
  assert.equal((await getStore().inscricoesMentoria("2026-11-10")).length, 300);
  assert.ok(leiturasDoQuadro <= 2, `o quadro foi lido ${leiturasDoQuadro} vezes (deveria ser uma leitura compartilhada)`);

  // Duas cópias do app na quarta 12h35, ao mesmo tempo: um sorteio só.
  relogio(QUARTA_1235);
  await Promise.all([mentoria.rodar(agora), mentoria.rodar(agora)]);
  await agendamento.processarTarefas();
  const sorteadas = (await getStore().inscricoesMentoria("2026-11-10")).filter((i) => i.sorteada);
  assert.equal(sorteadas.length, 4);
  assert.equal(doFluxo(F.sorteada).length, 4);
  assert.equal(new Set(doFluxo(F.sorteada).map((e) => e.contato)).size, 4, "quatro pessoas diferentes");
  const registro = await getStore().tarefaPorChave("mentoria_rodada:2026-11-10");
  assert.equal(registro.dados.concorrentes.length, 300);
});

test("o sorteio não favorece ninguém: em 2.000 rodadas com 7 pessoas, cada uma sai perto de 4 em 7 vezes", async () => {
  const contagem = new Map();
  for (let rodada = 0; rodada < 2000; rodada++) {
    setStore(createMemoryStore());
    relogio("2026-11-10T16:00:00Z");
    for (const pessoa of quadro.slice(0, 7)) await getStore().inscreverMentoria({ rodada: "2026-11-10", mondayItemId: pessoa.id, nome: pessoa.nome, telefone: pessoa.telefone, email: pessoa.email });
    await getStore().inscreverMentoria({ rodada: "2026-11-10", mondayItemId: "1", nome: "Ana", telefone: "+5511911110001", email: "ana@x.com" });
    relogio(QUARTA_1235);
    await mentoria.rodar(agora);
    for (const i of (await getStore().inscricoesMentoria("2026-11-10")).filter((x) => x.sorteada)) {
      contagem.set(i.mondayItemId, (contagem.get(i.mondayItemId) || 0) + 1);
    }
  }
  // 7 pessoas distintas (Ana repetida conta uma vez só): 4 de 7 = 57% cada.
  assert.equal(contagem.size, 7);
  for (const [id, vezes] of contagem) assert.ok(vezes > 1000 && vezes < 1300, `pessoa ${id} saiu ${vezes} vezes`);
});

test("inscrição enviada às 7h59 que termina de gravar depois das 8h ainda concorre; às 12h29 está encerrada", async () => {
  relogio("2026-11-11T10:59:58Z");
  await inscrever(quadro[0]);
  relogio("2026-11-11T15:29:58Z");
  assert.equal((await inscrever(quadro[1])).resultado, "encerrada");
  await simular("2026-11-11T11:00:00Z", "2026-11-11T11:10:00Z");
  const registro = await getStore().tarefaPorChave("mentoria_rodada:2026-11-10");
  assert.equal(registro.dados.concorrentes.length, 1);
  assert.equal((await getStore().inscricoesMentoria("2026-11-17")).length, 0);
});

test("sem o fluxo do lembrete da mentoria, o lembrete não entra na fila (e não cai em outro fluxo)", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await simular("2026-11-11T15:35:00Z", "2026-11-11T15:40:00Z");
  const original = config.manychat.flowSorteio.vespera;
  config.manychat.flowSorteio.vespera = "";
  try {
    relogio("2026-11-11T20:00:00Z");
    await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-13T18:00:00Z" }));
    await simular("2026-11-12T17:55:00Z", "2026-11-13T18:00:00Z");
    assert.equal(envios.filter((e) => !Object.values(F).includes(e.flow)).length, 0, "nenhum envio fora dos fluxos do sorteio");
    assert.equal(doFluxo(F.umaHora).length, 1);
  } finally {
    config.manychat.flowSorteio.vespera = original;
  }
});

test("o Calendly manda o mesmo aviso duas vezes: nada se repete", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await simular("2026-11-11T15:35:00Z", "2026-11-11T15:40:00Z");
  relogio("2026-11-11T20:00:00Z");
  const aviso = convidado({ email: "ana@x.com", inicio: "2026-11-13T18:00:00Z" });
  await agendamento.receberWebhook(aviso);
  assert.equal((await agendamento.receberWebhook(aviso)).mentoria, "ja_registrada");
  assert.equal(telegrams.filter((t) => t.includes("Mentoria agendada:")).length, 1);
});

test("quem já fez a mentoria e agenda outra: alerta, sem mexer na mentoria antiga", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await simular("2026-11-11T15:35:00Z", "2026-11-11T15:40:00Z");
  relogio("2026-11-11T20:00:00Z");
  await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-12T18:00:00Z" }));
  relogio("2026-11-14T12:00:00Z");
  const r = await agendamento.receberWebhook(convidado({ email: "ana@x.com", inicio: "2026-11-20T18:00:00Z", evento: "https://api.calendly.com/scheduled_events/MEN2" }));
  assert.equal(r.mentoria, "sem_sorteada");
  assert.ok(telegrams.some((t) => t.includes("Mentoria agendada depois do prazo")));
  const ana = (await getStore().inscricoesMentoria("2026-11-10"))[0];
  assert.equal(ana.eventoCalendly, "https://api.calendly.com/scheduled_events/MEN1");
});

test("app fora do ar na sexta das 12h às 15h: o prazo encerra assim que ele volta", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await simular("2026-11-11T15:35:00Z", "2026-11-11T15:40:00Z");
  await simular("2026-11-13T19:00:00Z", "2026-11-13T19:10:00Z");
  assert.equal((await getStore().inscricoesMentoria("2026-11-10"))[0].agendamento, "perdeu");
});

test("confirmou pelo WhatsApp e voltou na hora para a página (troca do telefone ainda na fila): entra", async () => {
  await comVerificacao(async (fluxo) => {
    relogio("2026-11-10T16:00:00Z");
    await inscrever({ nome: "Bia", email: "bia@errado.com", telefone: "(21) 98888-7777" });
    await agendamento.processarTarefas();
    assert.equal((await pedirEmail(doFluxo(fluxo)[0].contato, "bia@x.com")).resultado, "encontrado");
    // Sem processar a fila: a Monday ainda tem o telefone antigo, e ela digitou o e-mail errado de novo.
    assert.equal((await inscrever({ nome: "Bia", email: "bia@errado.com", telefone: "(21) 98888-7777" })).resultado, "confirmada");
    await agendamento.processarTarefas();
    assert.equal(escritas.filter((e) => e.valores.phonenhzs51c9).length, 1, "o telefone muda uma vez só");
  });
});

test("depois de uma verificação sem sucesso, a página não promete outra mensagem", async () => {
  await comVerificacao(async (fluxo) => {
    relogio("2026-11-10T16:00:00Z");
    await inscrever({ nome: "Zoe", email: "zoe@x.com", telefone: "11 93333-0000" });
    await agendamento.processarTarefas();
    const contato = doFluxo(fluxo)[0].contato;
    await pedirEmail(contato, "zoe@y.com");
    await pedirEmail(contato, "zoe@z.com");
    assert.equal((await inscrever({ nome: "Zoe", email: "zoe@x.com", telefone: "11 93333-0000" })).resultado, "nao_encontrada");
    await agendamento.processarTarefas();
    assert.equal(doFluxo(fluxo).length, 1, "nenhuma mensagem nova");
  });
});

test("recebeu o \"Verificar cadastro\" e não respondeu: alerta para a equipe na quarta 12h30, uma vez", async () => {
  await comVerificacao(async () => {
    relogio("2026-11-10T16:00:00Z");
    await inscrever({ nome: "Zoe", email: "zoe@x.com", telefone: "11 93333-0000" });
    await inscrever({ nome: "Bia", email: "bia@errado.com", telefone: "(21) 98888-7777" });
    await agendamento.processarTarefas();
    const bia = doFluxo(config.manychat.flowSorteio.verificar)[1].contato;
    await pedirEmail(bia, "bia@x.com");
    assert.equal(telegrams.length, 0);

    await simular("2026-11-11T15:00:00Z", "2026-11-11T16:30:00Z");
    const alertas = telegrams.filter((t) => t.includes("não respondeu até o fim das inscrições"));
    assert.equal(alertas.length, 1, "só a Zoe (a Bia respondeu)");
    assert.match(alertas[0], /zoe@x\.com/);
  });
});

test("teto de verificações por rodada: depois do teto, número novo não recebe a mensagem paga; equipe avisada uma vez", async () => {
  await comVerificacao(async (fluxo) => {
    const teto = config.sorteio.tetoVerificar;
    config.sorteio.tetoVerificar = 2;
    try {
      relogio("2026-11-10T16:00:00Z");
      const r = [];
      for (const final of ["0001", "0002", "0003", "0004"]) {
        r.push((await inscrever({ nome: "Estranha", email: `x${final}@y.com`, telefone: `11 94444-${final}` })).resultado);
      }
      assert.deepEqual(r, ["verificar_whatsapp", "verificar_whatsapp", "nao_encontrada", "nao_encontrada"]);
      // O mesmo número de antes do teto continua valendo (sem mensagem nova).
      assert.equal((await inscrever({ nome: "Estranha", email: "x0001@y.com", telefone: "11 94444-0001" })).resultado, "verificar_whatsapp");
      await agendamento.processarTarefas();
      assert.equal(doFluxo(fluxo).length, 2, "só as duas antes do teto");
      const avisos = telegrams.filter((t) => /teto de verificações/.test(t));
      assert.equal(avisos.length, 1, "um aviso só por rodada");
      assert.match(avisos[0], /Já saíram 2 mensagens/);
      // Quem está na Monday continua entrando direto, sem contar no teto.
      assert.equal((await inscrever(quadro[0])).resultado, "confirmada");
    } finally {
      config.sorteio.tetoVerificar = teto;
    }
  });
});

test("página do sorteio: no máximo 10 tentativas a cada 10 minutos pelo mesmo endereço", async () => {
  const app = require("../src/app");
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const tentar = () =>
      fetch(`${base}/sorteio/inscricao`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://www.example.com", "X-Forwarded-For": "203.0.113.77" },
        body: JSON.stringify({ nome: "Ana", email: "x", whatsapp: "1", aceite: true }),
      });
    const status = [];
    for (let i = 0; i < 11; i++) status.push((await tentar()).status);
    assert.deepEqual(status.slice(0, 10), Array(10).fill(400), "as 10 primeiras passam (dados inválidos: 400)");
    assert.equal(status[10], 429, "a 11ª é barrada");
  } finally {
    servidor.close();
  }
});


test("sorteada com contato antigo do ManyChat (a API não acha): a equipe recebe o nome, uma vez", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  antigos.add(require("../src/domain/telefone").normalizarTelefone(quadro[0].telefone));
  try {
    await simular("2026-11-11T15:30:00Z", "2026-11-11T16:00:00Z");
    const avisos = telegrams.filter((t) => /Mensagem do sorteio não enviada/.test(t));
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], new RegExp(quadro[0].nome));
    assert.match(avisos[0], /aviso de sorteada/);
  } finally {
    antigos.clear();
  }
});

test("aviso de terça falhando: alerta uma vez por hora; janela perdida (app fora do ar): alerta uma vez", async () => {
  mondayFora = true;
  await simular("2026-11-10T15:25:00Z", "2026-11-10T16:00:00Z");
  mondayFora = false;
  assert.equal(telegrams.filter((t) => /O aviso do sorteio das mentorias falhou/.test(t)).length, 1);
  await simular("2026-11-10T16:00:00Z", "2026-11-10T16:10:00Z");
  assert.ok(telegrams.some((t) => /aviso de inscrição/.test(t)), "tentou de novo e saiu");
});

test("app fora do ar a janela toda de terça: depois das 14h30, um alerta de aviso não enviado", async () => {
  await simular("2026-11-10T17:35:00Z", "2026-11-10T18:30:00Z");
  assert.equal(telegrams.filter((t) => /aviso de terça do sorteio não saiu/.test(t)).length, 1);
});

// ---------- v3.2.0: sorteio às 8h, trocas até 12h, avisos às 12h35 ----------

// Quarta 11/11 em Brasília (UTC-3).
const QUARTA_0800 = "2026-11-11T11:00:00.000Z";
const QUARTA_1200 = "2026-11-11T15:00:00.000Z";
const registroDa = async (rodada = "2026-11-10") => (await getStore().tarefaPorChave(`mentoria_rodada:${rodada}`))?.dados;
const trocar = (corpo) => mentoria.trocar(corpo, agora);
const resultadosDoSorteio = () => telegrams.filter((t) => /Sorteio das mentorias feito/.test(t));
const refeitos = () => telegrams.filter((t) => /Sorteio refeito por/.test(t));

async function setePessoasSorteadasAs8h() {
  relogio("2026-11-10T16:00:00Z");
  for (const pessoa of quadro.slice(0, 7)) await inscrever(pessoa);
  await simular("2026-11-11T10:55:00Z", "2026-11-11T11:10:00Z");
  return registroDa();
}

test("v3.2.0: sorteio às 8h só entre as inscritas até as 8h; ninguém é avisada antes das 12h35; Telegram com contagens e nomes", async () => {
  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await inscrever(quadro[1]);
  relogio("2026-11-11T10:58:00Z");
  await inscrever(quadro[2]);
  quadro[2].etapa = "Não Respondeu";

  relogio("2026-11-11T11:01:00Z");
  assert.equal(mentoria.estado(agora).aberta, false, "v3.2.2: a página fecha às 8h");
  assert.equal(mentoria.estado(agora).depoisDoSorteioVaiPara, null);
  assert.equal(mentoria.estado(new Date("2026-11-11T10:59:00Z")).sorteioEm, QUARTA_0800);
  assert.equal((await inscrever(quadro[4])).resultado, "encerrada");

  await simular("2026-11-11T10:55:00Z", "2026-11-11T11:10:00Z");
  const registro = await registroDa();
  assert.ok(registro, "o sorteio saiu às 8h");
  assert.deepEqual(registro.concorrentes.map((c) => c.mondayItemId).sort(), ["1", "2"]);
  assert.equal(registro.inscritas, 3);
  assert.equal(registro.excluidas.length, 1);
  assert.equal((await getStore().inscricoesMentoria("2026-11-17")).length, 0, "a Eva (8h01) não entra em rodada nenhuma");
  assert.equal(doFluxo(F.sorteada).length, 0, "ninguém é avisada às 8h");
  assert.ok((await getStore().inscricoesMentoria("2026-11-10")).every((i) => !i.sorteada));

  assert.equal(resultadosDoSorteio().length, 1);
  const texto = resultadosDoSorteio()[0];
  assert.match(texto, /rodada de 10\/11/);
  assert.match(texto, /📝 Inscritas: 3 · 🎲 Concorreram: 2 · 🚫 Fora pela Etapa: 1/);
  assert.match(texto, /🎉 Sorteadas \(2\):/);
  assert.match(texto, /• Ana · \+55 11 91111-0001/);
  assert.match(texto, /• Bia/);
  assert.ok(!texto.includes("já sorteada"));
  assert.match(texto, /Para trocar alguém, use o painel › Mentorias até 12h\. As mensagens para as sorteadas saem às 12h35\./);

  // Às 12h35 saem os avisos; o resultado não se repete no Telegram.
  await simular("2026-11-11T11:10:00Z", "2026-11-11T15:45:00Z");
  assert.equal(doFluxo(F.sorteada).length, 2);
  assert.equal(doFluxo(F.sorteada)[0].quando.toISOString(), QUARTA_1235);
  assert.equal(resultadosDoSorteio().length, 1);
});

test("v3.2.2: verificação pedida às 7h55: respondida às 7h58 vale; respondida às 8h05 está encerrada", async () => {
  await comVerificacao(async (fluxo) => {
    relogio("2026-11-11T10:55:00Z");
    assert.equal((await inscrever({ nome: "Bia", email: "bia@errado.com", telefone: "(21) 98888-7777" })).resultado, "verificar_whatsapp");
    assert.equal((await inscrever({ nome: "Zoe", email: "zoe@x.com", telefone: "11 93333-0000" })).resultado, "verificar_whatsapp");
    await agendamento.processarTarefas();
    relogio("2026-11-11T10:58:00Z");
    assert.deepEqual(await pedirEmail(doFluxo(fluxo)[0].contato, "bia@x.com"), { resultado: "encontrado", primeiro_nome: "Bia" });
    assert.equal((await inscrever({ nome: "Bia", email: "bia@errado.com", telefone: "(21) 98888-7777" })).resultado, "confirmada");
    assert.equal((await getStore().inscricoesMentoria("2026-11-10"))[0].mondayItemId, "2");
    relogio("2026-11-11T11:05:00Z");
    assert.equal((await pedirEmail(doFluxo(fluxo)[1].contato, "zoe@x.com")).resultado, "encerrada");
  });
});

test("v3.2.0: quem já foi sorteada antes (pelo cadastro ou pelo telefone) vem com ⚠️ no Telegram e no painel", async () => {
  const store = getStore();
  // Rodada anterior (03/11): Ana (mesmo cadastro) fez a mentoria; outro cadastro com o
  // telefone da Bia perdeu a vaga.
  const ana = await store.inscreverMentoria({ rodada: "2026-11-03", mondayItemId: "1", nome: "Ana", telefone: "+5511911110001", email: "ana@x.com" });
  await store.atualizarInscricaoMentoria(ana.id, { sorteada: true, agendamento: "agendada", mentoriaEm: new Date("2026-11-06T18:00:00Z") });
  const outra = await store.inscreverMentoria({ rodada: "2026-11-03", mondayItemId: "999", nome: "Bia (cadastro antigo)", telefone: "+5511911110002", email: "velho@x.com" });
  await store.atualizarInscricaoMentoria(outra.id, { sorteada: true, agendamento: "perdeu" });

  relogio("2026-11-10T16:00:00Z");
  await inscrever(quadro[0]);
  await inscrever(quadro[1]);
  await inscrever(quadro[2]);
  await simular("2026-11-11T11:00:00Z", "2026-11-11T11:10:00Z");

  const texto = resultadosDoSorteio()[0];
  assert.match(texto, /• Ana · [^\n]*\n {3}⚠️ já sorteada em 03\/11 \(realizada\)/);
  assert.match(texto, /• Bia · [^\n]*\n {3}⚠️ já sorteada em 03\/11 \(não agendou\/perdeu a vaga\)/);
  assert.ok(!/• Cris[^\n]*\n {3}⚠️/.test(texto), "a Cris nunca foi sorteada");

  const { rodadas } = await mentoria.resumo({ agora });
  const atual = rodadas.find((r) => r.rodada === "2026-11-10");
  const idDe = (mondayItemId) => atual.sorteio && (registroDaRodada.concorrentes.find((c) => c.mondayItemId === mondayItemId) || {}).id;
  const registroDaRodada = await registroDa();
  assert.ok(atual.inscricoes.every((i) => Number.isInteger(i.id)));
  assert.deepEqual(Object.keys(atual.sorteio.anteriores).map(Number).sort(), [idDe("1"), idDe("2")].sort());
  assert.deepEqual(atual.sorteio.anteriores[idDe("1")], [{ rodada: "2026-11-03", agendamento: "agendada" }]);
  assert.deepEqual(atual.sorteio.anteriores[idDe("2")], [{ rodada: "2026-11-03", agendamento: "perdeu" }]);
});

test("v3.2.0: troca antes das 12h tira só quem foi escolhida, grava no registro, avisa no Telegram; quem saiu não volta", async () => {
  const inicial = await setePessoasSorteadasAs8h();
  assert.equal(inicial.sorteadas.length, 4);

  relogio("2026-11-11T13:00:00Z");
  const [tirar, ...ficam] = inicial.sorteadas;
  const r1 = await trocar({ rodada: "2026-11-10", remover: [tirar], por: "Consultor" });
  assert.equal(r1.status, 200);
  assert.equal(r1.ok, true);
  assert.equal(r1.faltaram, 0);
  assert.equal(r1.novas.length, 1);
  assert.deepEqual(r1.removidas.map((p) => p.id), [tirar]);
  assert.equal(r1.sorteadas.length, 4);
  for (const id of ficam) assert.ok(r1.sorteadas.some((p) => p.id === id), "as outras continuam");
  assert.ok(!r1.sorteadas.some((p) => p.id === tirar));
  assert.ok(r1.sorteadas.every((p) => p.nome && p.telefone));

  const registro = await registroDa();
  assert.deepEqual(registro.sorteadas, r1.sorteadas.map((p) => p.id));
  assert.equal(registro.removidas.length, 1);
  assert.equal(registro.removidas[0].id, tirar);
  assert.equal(registro.removidas[0].por, "Consultor");
  assert.equal(registro.trocas.length, 1);
  assert.deepEqual(registro.trocas[0].novas, r1.novas.map((p) => p.id));

  await agendamento.processarTarefas();
  assert.equal(refeitos().length, 1);
  assert.match(refeitos()[0], /🔁 <b>Sorteio refeito por Consultor<\/b> \(rodada de 10\/11\)/);
  assert.match(refeitos()[0], /📝 Inscritas: 7 · 🎲 Concorreram: 7 · 🚫 Fora pela Etapa: 0/);
  assert.ok(refeitos()[0].includes(`➖ Saíram: ${r1.removidas[0].nome}`));
  assert.ok(refeitos()[0].includes(`➕ Entraram: ${r1.novas[0].nome}`));
  assert.match(refeitos()[0], /🎉 Sorteadas \(4\):/);
  assert.match(refeitos()[0], /até 12h\. As mensagens para as sorteadas saem às 12h35\./);

  // Mais trocas, até acabarem as concorrentes: quem saiu nunca volta.
  const removidas = [tirar];
  let ultima;
  for (let i = 0; i < 3; i++) {
    const alvo = (await registroDa()).sorteadas[0];
    ultima = await trocar({ rodada: "2026-11-10", remover: [alvo], por: "Equipe" });
    removidas.push(alvo);
    assert.equal(ultima.status, 200);
    for (const id of removidas) assert.ok(!ultima.sorteadas.some((p) => p.id === id) && !ultima.novas.some((p) => p.id === id));
  }
  assert.equal(ultima.faltaram, 1, "7 concorrentes, 4 removidas: a 4ª troca não tem quem pôr");
  assert.equal(ultima.novas.length, 0);
  assert.equal(ultima.sorteadas.length, 3);
  assert.equal((await registroDa()).trocas.length, 4);
  await agendamento.processarTarefas();
  assert.equal(refeitos().length, 4);
  assert.match(refeitos()[3], /➕ Entraram: ninguém/);
  assert.match(refeitos()[3], /⚠️ Faltaram 1/);

  // 12h35: avisos só para a lista final; ninguém removida recebe. Régua (quarta 19h) também.
  await simular("2026-11-11T15:30:00Z", "2026-11-11T22:30:00Z");
  const final = (await registroDa()).sorteadas;
  const inscricoes = await getStore().inscricoesMentoria("2026-11-10");
  assert.deepEqual(inscricoes.filter((i) => i.sorteada).map((i) => i.id).sort(), [...final].sort());
  assert.ok(removidas.every((id) => !inscricoes.find((i) => i.id === id).sorteada));
  assert.equal(doFluxo(F.sorteada).length, 3);
  assert.equal(doFluxo(F.lembrete1).length, 3);
  const contatosDe = (lista) => new Set(lista.map((e) => e.contato));
  assert.deepEqual(contatosDe(doFluxo(F.lembrete1)), contatosDe(doFluxo(F.sorteada)));
  assert.equal(comentarios.filter((c) => c.includes("Sorteada para a mentoria")).length, 3);
});

test("v3.2.0: troca recusada depois das 12h, antes do sorteio, depois do envio e com dados inválidos", async () => {
  relogio("2026-11-11T12:00:00Z");
  assert.deepEqual(await trocar({ rodada: "2026-11-10", remover: [1], por: "Consultor" }), { status: 409, ok: false, erro: "O sorteio desta rodada ainda não foi feito." });

  const registro = await setePessoasSorteadasAs8h();
  relogio(QUARTA_1200);
  const tarde = await trocar({ rodada: "2026-11-10", remover: [registro.sorteadas[0]], por: "Consultor" });
  assert.equal(tarde.status, 409);
  assert.match(tarde.erro, /horário das trocas/);

  relogio("2026-11-11T14:00:00Z");
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [9999], por: "Consultor" })).status, 409, "id que não está entre as sorteadas");
  assert.equal((await trocar({ rodada: "2026-11-11", remover: [registro.sorteadas[0]], por: "Consultor" })).status, 400, "rodada que não é terça");
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [], por: "Consultor" })).status, 400);
  assert.equal((await trocar({ rodada: "2026-11-10", remover: ["abc"], por: "Consultor" })).status, 400);
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [registro.sorteadas[0]], por: "  " })).status, 400);
  assert.equal((await registroDa()).trocas.length, 0, "nada mudou");

  // Depois do envio (mesmo que o relógio volte), não troca mais.
  await simular("2026-11-11T15:35:00Z", "2026-11-11T15:40:00Z");
  relogio("2026-11-11T14:00:00Z");
  const depois = await trocar({ rodada: "2026-11-10", remover: [registro.sorteadas[0]], por: "Consultor" });
  assert.equal(depois.status, 409);
  assert.match(depois.erro, /já saíram/);
});

test("v3.2.0: duas trocas ao mesmo tempo não se atropelam", async () => {
  const registro = await setePessoasSorteadasAs8h();
  relogio("2026-11-11T13:00:00Z");
  const [a, b] = registro.sorteadas;
  const [r1, r2] = await Promise.all([
    trocar({ rodada: "2026-11-10", remover: [a], por: "Consultor" }),
    trocar({ rodada: "2026-11-10", remover: [b], por: "Equipe" }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const final = await registroDa();
  assert.equal(final.trocas.length, 2);
  assert.equal(final.sorteadas.length, 4);
  assert.equal(new Set(final.sorteadas).size, 4, "sem repetidas");
  assert.ok(!final.sorteadas.includes(a) && !final.sorteadas.includes(b));
  assert.deepEqual(final.removidas.map((x) => x.id).sort(), [a, b].sort());
  assert.notEqual(r1.novas[0].id, r2.novas[0].id);

  // A mesma pessoa removida duas vezes ao mesmo tempo: uma passa, a outra é recusada.
  const c = final.sorteadas[0];
  const duas = await Promise.all([1, 2].map(() => trocar({ rodada: "2026-11-10", remover: [c], por: "Consultor" })));
  assert.deepEqual(duas.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await registroDa()).sorteadas.length, 4);
});

test("v3.2.0: Mani fora do ar às 8h: às 12h35 sorteia, avisa a equipe e manda os avisos", async () => {
  relogio("2026-11-10T16:00:00Z");
  for (const pessoa of quadro.slice(0, 7)) await inscrever(pessoa);
  await simular("2026-11-11T15:35:00Z", "2026-11-11T23:30:00Z");
  const registro = await registroDa();
  assert.equal(registro.sorteadoEm, QUARTA_1235);
  assert.equal(resultadosDoSorteio().length, 1);
  assert.match(resultadosDoSorteio()[0], /saiu atrasado.*saem agora\./);
  assert.match(resultadosDoSorteio()[0], /📝 Inscritas: 7 · 🎲 Concorreram: 7 · 🚫 Fora pela Etapa: 0/);
  assert.equal(doFluxo(F.sorteada).length, 4);
  assert.equal(doFluxo(F.lembrete1).length, 4);
});

test("v3.2.0: rodada já em andamento (inscrições de terça), o dia todo de 5 em 5 minutos: um sorteio, um resultado, quatro avisos", async () => {
  relogio("2026-11-10T15:31:00Z");
  for (const pessoa of quadro.slice(0, 7)) await inscrever(pessoa);
  await simular("2026-11-10T15:30:00Z", "2026-11-12T00:00:00Z");
  const registro = await registroDa();
  assert.equal(registro.sorteadoEm, "2026-11-11T11:05:00.000Z", "às 8h05 (o primeiro passo depois das 8h01)");
  assert.equal(registro.concorrentes.length, 7);
  assert.ok(registro.enviadoEm);
  assert.equal(resultadosDoSorteio().length, 1);
  assert.equal(doFluxo(F.sorteada).length, 4);
  assert.equal(new Set(doFluxo(F.sorteada).map((e) => e.contato)).size, 4);
  assert.equal(comentarios.filter((c) => c.includes("Sorteada para a mentoria")).length, 4);
  assert.equal((await getStore().inscricoesMentoria("2026-11-10")).filter((i) => i.sorteada).length, 4);
  assert.equal(doFluxo(F.lembrete1).length, 4);
});

test("v3.2.0: painel (GET /interno/mentorias) mostra o sorteio e as trocas", async () => {
  const registro = await setePessoasSorteadasAs8h();
  relogio("2026-11-11T12:00:00Z");
  await trocar({ rodada: "2026-11-10", remover: [registro.sorteadas[0]], por: "Consultor" });

  const r = await mentoria.resumo({ agora });
  // Página fechada (v3.2.2): sorteioEm já é o da próxima rodada.
  assert.equal(r.estado.aberta, false);
  assert.equal(r.estado.sorteioEm, "2026-11-18T11:00:00.000Z");
  assert.equal(r.estado.depoisDoSorteioVaiPara, null);
  const atual = r.rodadas[0];
  assert.equal(atual.rodada, "2026-11-10");
  assert.equal(atual.sorteio.sorteadoEm, "2026-11-11T11:05:00.000Z");
  assert.equal(atual.sorteio.sorteadas.length, 4);
  assert.equal(atual.sorteio.removidas.length, 1);
  assert.equal(atual.sorteio.trocas.length, 1);
  assert.equal(atual.sorteio.trocaAte, QUARTA_1200);
  assert.equal(atual.sorteio.envioEm, QUARTA_1235);
  assert.equal(atual.sorteio.enviado, false);
  assert.deepEqual(atual.sorteio.anteriores, {});
  assert.ok(atual.inscricoes.every((i) => typeof i.id === "number"));
});

test("v3.2.0: rota POST /interno/mentorias/trocar: chave interna, 400 e 409", async () => {
  const app = require("../src/app");
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const post = (corpo, chave = config.internoSecret) =>
    fetch(`${base}/interno/mentorias/trocar`, { method: "POST", headers: { "Content-Type": "application/json", "X-Interno-Key": chave }, body: JSON.stringify(corpo) });
  try {
    assert.equal((await post({}, "errada-errada-errada-errada-errada-errada-1")).status, 401);
    const ruim = await post({ rodada: "ontem", remover: [1], por: "Consultor" });
    assert.equal(ruim.status, 400);
    assert.equal((await ruim.json()).ok, false);
    const semSorteio = await post({ rodada: "2026-11-03", remover: [1], por: "Consultor" });
    assert.equal(semSorteio.status, 409);
    assert.deepEqual(await semSorteio.json(), { ok: false, erro: "O sorteio desta rodada ainda não foi feito." });
  } finally {
    servidor.close();
  }
});

test("v3.2.2: inscrições fecham na quarta às 8h: 7h59 entra nesta rodada; 8h e 10h encerrada, com a próxima abertura", async () => {
  relogio("2026-11-11T10:59:00Z");
  assert.deepEqual(await inscrever(quadro[0]), { resultado: "confirmada", nova: true });
  assert.equal(mentoria.estado(new Date(QUARTA_0800)).aberta, false);
  for (const hora of [QUARTA_0800, "2026-11-11T13:00:00.000Z"]) {
    relogio(hora);
    assert.deepEqual(await inscrever(quadro[1]), { resultado: "encerrada", proximaAbertura: "2026-11-17T15:30:00.000Z" });
  }
  assert.deepEqual((await getStore().inscricoesMentoria("2026-11-10")).map((i) => i.mondayItemId), ["1"]);
  assert.equal((await getStore().inscricoesMentoria("2026-11-17")).length, 0);
});

// ---------- v3.2.1: excluir sorteada sem substituta e sortear vagas vazias ----------

const excluidasMsg = () => telegrams.filter((t) => /excluída(s)? por/.test(t));
const preenchidasMsg = () => telegrams.filter((t) => /Vagas vazias sorteadas por/.test(t));

test("v3.2.1: excluir sem substituta: a vaga fica vazia, registro, Telegram e às 12h35 só 3 avisos", async () => {
  const inicial = await setePessoasSorteadasAs8h();
  relogio("2026-11-11T13:00:00Z");
  const [tirar, ...ficam] = inicial.sorteadas;
  const r = await trocar({ rodada: "2026-11-10", remover: [tirar], por: "Consultor", substituir: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.novas, []);
  assert.equal(r.faltaram, 0);
  assert.deepEqual(r.removidas.map((p) => p.id), [tirar]);
  assert.deepEqual(r.sorteadas.map((p) => p.id), ficam);

  const registro = await registroDa();
  assert.deepEqual(registro.sorteadas, ficam);
  assert.equal(registro.removidas[0].id, tirar);
  assert.deepEqual(registro.trocas, [{ em: agora.toISOString(), por: "Consultor", removidas: [tirar], novas: [], semSubstituta: true }]);

  await agendamento.processarTarefas();
  assert.equal(excluidasMsg().length, 1);
  const texto = excluidasMsg()[0];
  assert.match(texto, /➖ <b>Sorteada excluída por Consultor<\/b> \(vaga fica vazia\) \(rodada de 10\/11\)/);
  assert.match(texto, /📝 Inscritas: 7 · 🎲 Concorreram: 7 · 🚫 Fora pela Etapa: 0/);
  assert.ok(texto.includes(`➖ Saíram: ${r.removidas[0].nome}`));
  assert.ok(!texto.includes("Entraram"));
  assert.match(texto, /🎉 Sorteadas \(3\):/);
  assert.match(texto, /Vagas vazias: 1/);
  assert.match(texto, /sortear as vagas vazias, use o painel › Mentorias até 12h/);

  const painel = (await mentoria.resumo({ agora })).rodadas.find((x) => x.rodada === "2026-11-10").sorteio;
  assert.equal(painel.vagas, 4);
  assert.equal(painel.vagasVazias, 1);
  assert.equal(painel.trocas[0].semSubstituta, true);

  await simular("2026-11-11T15:30:00Z", "2026-11-11T22:30:00Z");
  assert.equal(doFluxo(F.sorteada).length, 3);
  assert.equal(doFluxo(F.lembrete1).length, 3);
  const inscricoes = await getStore().inscricoesMentoria("2026-11-10");
  assert.deepEqual(inscricoes.filter((i) => i.sorteada).map((i) => i.id).sort(), [...ficam].sort());
});

test("v3.2.1: excluir e depois sortear a vaga vazia: preenche só as vazias e nunca devolve quem saiu", async () => {
  const inicial = await setePessoasSorteadasAs8h();
  relogio("2026-11-11T13:00:00Z");
  const [a, b] = inicial.sorteadas;
  await trocar({ rodada: "2026-11-10", remover: [a, b], por: "Consultor", substituir: false });
  assert.equal((await registroDa()).sorteadas.length, 2);

  const r = await trocar({ rodada: "2026-11-10", remover: [], preencher: true, por: "Equipe" });
  assert.equal(r.status, 200);
  assert.equal(r.novas.length, 2);
  assert.deepEqual(r.removidas, []);
  assert.equal(r.faltaram, 0);
  assert.equal(r.sorteadas.length, 4);
  assert.ok(r.novas.every((p) => p.id !== a && p.id !== b));
  const registro = await registroDa();
  assert.equal(registro.trocas.length, 2);
  assert.equal(registro.trocas[1].preencher, true);
  assert.deepEqual(registro.trocas[1].removidas, []);
  assert.deepEqual(registro.removidas.map((x) => x.id).sort(), [a, b].sort());

  // Sem vaga vazia: 409.
  const cheia = await trocar({ rodada: "2026-11-10", remover: [], preencher: true, por: "Equipe" });
  assert.deepEqual(cheia, { status: 409, ok: false, erro: "Não há vaga vazia para sortear." });

  await agendamento.processarTarefas();
  assert.equal(preenchidasMsg().length, 1);
  assert.match(preenchidasMsg()[0], /➕ <b>Vagas vazias sorteadas por Equipe<\/b> \(rodada de 10\/11\)/);
  assert.ok(preenchidasMsg()[0].includes(`➕ Entraram: ${r.novas[0].nome}`));
  assert.match(preenchidasMsg()[0], /🎉 Sorteadas \(4\):/);
  assert.ok(!/Vagas vazias: /.test(preenchidasMsg()[0]));

  // Só 1 concorrente sobrando: tira 2 sem substituta e preenche: entra 1, falta 1.
  await trocar({ rodada: "2026-11-10", remover: (await registroDa()).sorteadas.slice(0, 2), por: "Consultor", substituir: false });
  const ultima = await trocar({ rodada: "2026-11-10", remover: [], preencher: true, por: "Equipe" });
  assert.equal(ultima.novas.length, 1);
  assert.equal(ultima.faltaram, 1);
  const semNinguem = await trocar({ rodada: "2026-11-10", remover: [], preencher: true, por: "Equipe" });
  assert.equal(semNinguem.status, 409);
  const final = await registroDa();
  assert.ok(final.removidas.every((x) => !final.sorteadas.includes(x.id)));
});

test("v3.2.1: regras de entrada e horário da exclusão e do preenchimento", async () => {
  const inicial = await setePessoasSorteadasAs8h();
  relogio("2026-11-11T13:00:00Z");
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [], por: "Consultor" })).status, 400, "remover vazio sem preencher");
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [], por: "Consultor", substituir: false })).status, 400);
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [inicial.sorteadas[0]], preencher: true, por: "Consultor" })).status, 400);
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [inicial.sorteadas[0]], substituir: "não", por: "Consultor" })).status, 400);
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [9999], substituir: false, por: "Consultor" })).status, 409);
  assert.equal((await registroDa()).trocas.length, 0);

  relogio(QUARTA_1200);
  const tarde = await trocar({ rodada: "2026-11-10", remover: [inicial.sorteadas[0]], substituir: false, por: "Consultor" });
  assert.equal(tarde.status, 409);
  assert.match(tarde.erro, /horário das trocas/);
  assert.equal((await trocar({ rodada: "2026-11-10", remover: [], preencher: true, por: "Consultor" })).status, 409);
});
