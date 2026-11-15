const crypto = require("crypto");

const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataPorExtenso, dataSP, diaHoraCurto, diaSemanaHora, horaMinutoSP, horaSP } = require("../domain/datas");
const { formatarTelefone, normalizarTelefone } = require("../domain/telefone");
const { emFila, proximaTentativa } = require("../utils/fila");
const manychat = require("./manychat.service");
const monday = require("./monday.service");
const convites = require("./convites.service");
const email = require("./email.service");
const reunioes = require("./reunioes.service");
const telegram = require("./telegram.service");

const ALERTAR_APOS = 3;
const DESISTIR_APOS = 60;

// Campo do ManyChat que recebe o link usado no lembrete.
const CAMPO_LINK = "link_agendamento";
// Campo do ManyChat com a data da reunião, usado no modelo confirmacao_reuniao.
const CAMPO_REUNIAO = "reuniao_texto";

const OBS = {
  aguardando: "Aguardando agendamento",
  recusou: "Não quis agendar reunião",
  naoAgendou: () => `Não respondeu aos ${config.lembretes.maximo} lembretes`,
  marcada: (inicio) => `Reunião marcada ${diaHoraCurto(inicio)}`,
  reagendada: (inicio) => `Reunião reagendada ${diaHoraCurto(inicio)}`,
  cancelada: "Reunião cancelada",
};

// ---------- link de agendamento ----------

// Código que vai no link do Calendly (utm_content) e volta no aviso do agendamento:
// é ele que liga o agendamento ao cadastro certo, mesmo com outro e-mail.
function novaRef() {
  return crypto.randomBytes(9).toString("base64url");
}

function linkAgendamento(atendimento) {
  if (!config.calendly.url || !atendimento?.refAgendamento) {
    return "";
  }

  const url = new URL(config.calendly.url);
  url.searchParams.set("utm_source", "mani");
  url.searchParams.set("utm_content", atendimento.refAgendamento);

  const nome = atendimento.mondayNome || atendimento.nomeWhatsapp;

  if (nome) {
    url.searchParams.set("name", nome);
  }

  const telefone = atendimento.whatsapp || atendimento.telefone;

  if (config.calendly.campoTelefone && telefone) {
    url.searchParams.set(config.calendly.campoTelefone, formatarTelefone(telefone));
  }

  return url.toString();
}

// ---------- avisos do Calendly ----------

function eventoDoConvidado(inviteeUri) {
  // ".../scheduled_events/<EVENTO>/invitees/<ID>" -> ".../scheduled_events/<EVENTO>"
  return String(inviteeUri || "").split("/invitees/")[0] || null;
}

function telefonesDoConvidado(p) {
  const candidatos = [p.text_reminder_number, ...(p.questions_and_answers || []).map((qa) => qa.answer)];
  const telefones = candidatos.map((valor) => normalizarTelefone(valor)).filter(Boolean);
  return [...new Set(telefones)];
}

async function localizar(p) {
  const store = getStore();
  const ref = p.tracking?.utm_content;

  if (ref) {
    const porRef = await store.porRef(String(ref).slice(0, 32));
    if (porRef) return porRef;
  }

  if (p.old_invitee) {
    const anterior = await store.porEvento(eventoDoConvidado(p.old_invitee));
    if (anterior) return anterior;
  }

  for (const telefone of telefonesDoConvidado(p)) {
    const qualificadas = await store.qualificadasPorTelefone(telefone);
    const escolhida = qualificadas.find((item) => item.agendamento === "pendente") || qualificadas[0];
    if (escolhida) return escolhida;
  }

  return null;
}

function dadosDoConvidado(p) {
  return {
    nome: p.name || "",
    email: p.email || "",
    telefone: telefonesDoConvidado(p)[0] || "",
    inicio: p.scheduled_event?.start_time || null,
    evento: p.scheduled_event?.uri || null,
    motivo: p.cancellation?.reason || "",
    canceladoPor: p.cancellation?.canceled_by || "",
    // utm_source do link do Calendly (ex.: "reuniao-consultor" da página, "mani"), v3.5.0.
    origemLink: reunioes.origemDoLink(p),
  };
}

// Linha da origem no aviso do grupo: só para quem veio da página de pré-reunião (v3.5.0).
function linhaOrigem(origemLink) {
  return origemLink === "reuniao-consultor" ? "📍 Origem: página reunião-consultor" : null;
}

function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function eventoIgnorado(p) {
  const nome = semAcento(p.scheduled_event?.name);
  return config.agenda.ignorar.some((palavra) => nome.includes(semAcento(palavra)));
}

function semAcento(texto) {
  return String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function outroEvento(p) {
  if (!config.calendly.eventoNome || p.tracking?.utm_source === "mani") {
    return false;
  }

  return normalizar(p.scheduled_event?.name) !== normalizar(config.calendly.eventoNome);
}

async function receberWebhook(corpo) {
  const p = corpo?.payload || {};

  if (!p.uri || !p.scheduled_event?.uri) {
    return { ignorado: "sem_dados" };
  }

  // Mentoria das sorteadas (evento "Reunião com o Consultor - Mentoria" no Calendly): tem os
  // lembretes próprios, nunca os da reunião comercial (GOOGLE_AGENDA_IGNORAR, padrão "Mentoria").
  // A mentoria tem a própria lógica (sorteio): liga à sorteada e marca os lembretes dela.
  if (eventoIgnorado(p)) {
    return require("./mentoria.service").receberCalendly(corpo, relogio());
  }

  // O aviso vale para a conta inteira do Calendly: reuniões de outros eventos (que não
  // vieram pelo link da Mani) não são do pré-atendimento.
  if (outroEvento(p)) {
    return { ignorado: "outro_evento" };
  }

  if (corpo.event === "invitee.created") {
    return agendou(p);
  }

  if (corpo.event === "invitee.canceled") {
    // Remarcação chega como cancelamento + novo agendamento: só o novo interessa.
    if (p.rescheduled) {
      return { ignorado: "remarcacao" };
    }

    return cancelou(p);
  }

  return { ignorado: corpo.event || "evento" };
}

async function agendou(p) {
  const store = getStore();
  const atendimento = await localizar(p);
  const dados = dadosDoConvidado(p);
  const remarcou = Boolean(p.old_invitee);

  if (atendimento) {
    await emFila(atendimento.contatoId, () =>
      store.atualizar(atendimento.id, {
        agendamento: "agendado",
        reuniaoEm: new Date(dados.inicio),
        eventoCalendly: dados.evento,
      })
    );
  }

  await store.criarTarefa({
    chave: `agendou:${p.uri}`,
    tipo: remarcou ? "remarcou" : "agendou",
    atendimentoId: atendimento?.id || null,
    dados,
  });

  // Lembretes da reunião (véspera útil e no dia) e respostas pelo WhatsApp.
  await reunioes.registrarAgendamento(p, { atendimento });

  agendarProcessamento();
  return { ok: true, vinculado: Boolean(atendimento) };
}

async function cancelou(p) {
  const store = getStore();
  const dados = dadosDoConvidado(p);
  const atendimento = (await store.porEvento(dados.evento)) || (await localizar(p));

  if (atendimento && atendimento.eventoCalendly === dados.evento) {
    await emFila(atendimento.contatoId, () => store.atualizar(atendimento.id, { agendamento: "cancelado" }));
  }

  // Cancelamento de uma reunião antiga (a pessoa já tem outra marcada) não muda a Monday.
  dados.atual = !atendimento || !atendimento.eventoCalendly || atendimento.eventoCalendly === dados.evento;

  await store.criarTarefa({
    chave: `cancelou:${p.uri}`,
    tipo: "cancelou",
    atendimentoId: atendimento?.id || null,
    dados,
  });

  await reunioes.registrarCancelamento(p);

  agendarProcessamento();
  return { ok: true };
}

// ---------- "Não quero marcar a reunião" (botão do lembrete) ----------

async function recusar({ contatoId }) {
  return emFila(contatoId, async () => {
    const store = getStore();
    const atendimento = await store.atual(contatoId);

    if (!atendimento || atendimento.resultado !== "qualificada") {
      return { resultado: "sem_agendamento" };
    }

    if (atendimento.agendamento === "agendado") {
      return { resultado: "ja_agendado" };
    }

    if (atendimento.agendamento !== "recusou") {
      await store.atualizar(atendimento.id, { agendamento: "recusou" });
      await store.criarTarefa({ chave: `recusou:${atendimento.id}`, tipo: "recusou", atendimentoId: atendimento.id });
      agendarProcessamento();
    }

    return { resultado: "ok" };
  });
}

// ---------- "Não quero receber" (avisos da aula) ----------

// Quem confirma ("Sim, quero parar") ganha a etiqueta "Não quer receber mensagens" na Etapa
// do Funil da Monday, e é essa etiqueta que decide: com ela, nenhum aviso da aula
// (lembretes e convite do grupo); se a equipe tirar a etiqueta, a pessoa volta a
// receber. Os lembretes da reunião não mudam: eles têm o botão "Não quero agendar".
const UM_DIA_MS = 86400000;
const AVISOS_DA_AULA = new Set(["convite", "aula_lembrete", "live_lembrete", "disparo", "mentoria_msg"]);

function chaveSemAvisos(contatoId) {
  return `sem_avisos:${contatoId}`;
}

// Tarefa de aviso da turma atual (ou das lives) para o telefone: traz o nome e o
// cadastro na Monday.
async function avisoDaTurma(telefone) {
  if (!telefone) return null;
  const store = getStore();
  const chaves = [];

  if (config.aula.data) {
    chaves.push(...["3dias", "amiga", "amanha", "hoje", "1hora", "aovivo"].map((tipo) => `aula:${config.aula.data}:${tipo}:${telefone}`));
    chaves.push(`convite:${config.aula.data}:${telefone}`);
  }

  for (const live of config.lives.datas) {
    chaves.push(...["vespera", "1hora", "comecou"].map((tipo) => `live:${live}:${tipo}:${telefone}`));
  }

  for (const chave of chaves) {
    const tarefa = await store.tarefaPorChave(chave);
    if (tarefa) return tarefa;
  }

  return null;
}

// Bloqueio pelo pedido, até a etiqueta estar gravada na Monday. Depois disso, quem
// decide é a etiqueta (os avisos novos já saem da lista filtrada pela Monday); só os
// avisos preparados antes do pedido continuam bloqueados.
async function pediuSemAvisos(tarefa) {
  const pedido = await getStore().tarefaPorChave(chaveSemAvisos(tarefa.dados.contatoId));
  // v3.3.0: tocou em "Quero voltar a receber" depois do pedido: não bloqueia mais.
  return Boolean(pedido) && !pedido.dados?.voltou && (pedido.status !== "ok" || tarefa.id < pedido.id);
}

async function pararAvisos({ contatoId }) {
  return emFila(contatoId, async () => {
    const store = getStore();
    const chave = chaveSemAvisos(contatoId);

    const existente = await store.tarefaPorChave(chave);

    if (existente) {
      // Tocou de novo depois de um dia (a equipe pode ter tirado a etiqueta): marca de
      // novo. Dois toques seguidos não avisam o grupo duas vezes.
      if (Date.now() - (existente.dados.em || 0) > UM_DIA_MS) {
        await store.atualizarTarefa(existente.id, {
          status: "pendente",
          etapas: [],
          tentativas: 0,
          erro: null,
          proxima: null,
          alertaFalha: false,
          dados: { ...existente.dados, em: Date.now(), voltou: false },
        });
        agendarProcessamento();
      }

      return { resultado: "ok" };
    }

    const atendimento = await store.atual(contatoId);
    const telefone = normalizarTelefone((await store.telefoneDoContato(contatoId)) || atendimento?.whatsapp);
    const aviso = await avisoDaTurma(telefone);

    await store.criarTarefa({
      chave,
      tipo: "sem_avisos",
      atendimentoId: atendimento?.id || null,
      dados: {
        contatoId,
        telefone,
        nome: aviso?.dados.nome || "",
        itemId: aviso?.dados.mondayItemId || null,
        em: Date.now(),
      },
    });
    agendarProcessamento();
    return { resultado: "ok" };
  });
}

// Botão "Quero voltar a receber" (v3.3.0), na mensagem de confirmação do "parar": a Etapa
// do Funil volta para a de antes do pedido (ou MONDAY_LABEL_VOLTOU), só se ainda estiver
// "Não quer receber mensagens", com comentário no cadastro e sem aviso no Telegram.
// Resultados: ok, sem_cadastro (não achei o cadastro na Monday).
let toquesVoltar = 0;

async function voltarAvisos({ contatoId }) {
  return emFila(contatoId, async () => {
    const store = getStore();
    const pedido = await store.tarefaPorChave(chaveSemAvisos(contatoId));

    // Um "Parar" depois disso marca de novo na hora (sem esperar um dia).
    if (pedido) await store.atualizarTarefa(pedido.id, { dados: { ...pedido.dados, em: 0, voltou: true } });

    const atendimento = await store.atual(contatoId);
    const telefone = normalizarTelefone(pedido?.dados.telefone || (await store.telefoneDoContato(contatoId)) || atendimento?.whatsapp);
    let itemId = pedido?.dados.itemId || atendimento?.mondayItemId || (await itemDoAvisoDaTurma(telefone));
    if (!itemId && telefone) {
      const encontrados = await monday.buscarPorTelefone(telefone);
      itemId = encontrados.length === 1 ? encontrados[0].id : null;
    }
    if (!itemId) return { resultado: "sem_cadastro" };

    await store.criarTarefa({
      chave: `voltou_avisos:${contatoId}:${Date.now()}:${++toquesVoltar}`,
      tipo: "voltou_avisos",
      atendimentoId: atendimento?.id || null,
      dados: { contatoId, telefone, nome: pedido?.dados.nome || "", itemId: String(itemId), em: Date.now() },
    });
    agendarProcessamento();
    return { resultado: "ok" };
  });
}

async function itemDoAvisoDaTurma(telefone) {
  return (await avisoDaTurma(telefone))?.dados.mondayItemId || null;
}

// Grava a Etapa de antes do "parar", para o "voltar" restaurar (se a leitura falhar, segue).
async function guardarEtapaAnterior(tarefa, itemId) {
  try {
    const atual = await monday.lerEtapa(itemId);
    if (atual && atual.toLowerCase() !== config.monday.labels.naoQuerMensagens.toLowerCase()) tarefa.dados.etapaAnterior = atual;
  } catch (error) {
    console.warn(`Etapa antes do pedido para parar não lida (${itemId}): ${error.message}`);
  }
}

// "Voltar": só mexe se a Etapa ainda é "Não quer receber mensagens" (a equipe pode ter mudado).
async function restaurarEtapa(tarefa, itemId) {
  const atual = await monday.lerEtapa(itemId);
  if (atual.toLowerCase() !== config.monday.labels.naoQuerMensagens.toLowerCase()) {
    tarefa.dados.etapaMantida = atual;
    return;
  }
  const pedido = await getStore().tarefaPorChave(chaveSemAvisos(tarefa.dados.contatoId));
  const etapa = pedido?.dados?.etapaAnterior || config.monday.labels.voltou;
  await monday.atualizarCadastro(itemId, { resultadoLabel: etapa });
  tarefa.dados.etapaRestaurada = etapa;
}

// ---------- lembretes diários ----------

// Lembrete puxado pelo ManyChat (sem precisar da API dele): o fluxo espera 1 dia e
// pergunta aqui se manda o lembrete. Resultado:
//  enviar (+ link_agendamento)  manda o modelo de lembrete e espera mais 1 dia
//  aguardar                     já houve lembrete hoje: só espera mais 1 dia
//  parar                        agendou, recusou, cancelou ou não é qualificada
//  nao_agendou                  passou dos 5 lembretes (Monday e grupo já cuidados)
async function proximoLembrete({ contatoId, agora = new Date() }) {
  return emFila(contatoId, async () => {
    const store = getStore();
    const atendimento = await store.atual(contatoId);

    if (!atendimento || atendimento.resultado !== "qualificada" || atendimento.agendamento !== "pendente") {
      return { resultado: "parar" };
    }

    const hoje = dataSP(agora);

    if (atendimento.ultimoLembrete === hoje || dataSP(new Date(atendimento.concluidoEm)) >= hoje) {
      return { resultado: "aguardar" };
    }

    if (atendimento.lembretes >= config.lembretes.maximo) {
      await store.atualizar(atendimento.id, { agendamento: "nao_agendou" });
      await store.criarTarefa({ chave: `nao_agendou:${atendimento.id}`, tipo: "nao_agendou", atendimentoId: atendimento.id });
      agendarProcessamento();
      return { resultado: "nao_agendou" };
    }

    await store.atualizar(atendimento.id, { lembretes: atendimento.lembretes + 1, ultimoLembrete: hoje });
    return { resultado: "enviar", link_agendamento: linkAgendamento(atendimento) };
  });
}

// Roda várias vezes por dia; a partir das 10h (Brasília) manda o lembrete do dia para
// quem recebeu o link e ainda não agendou nem recusou. Cada pessoa recebe no máximo
// um por dia e até 5 no total; no dia seguinte ao 5º, vira "não agendou".
async function rodarLembretes(agora = new Date()) {
  if (!manychat.isConfigured() || horaSP(agora) < config.lembretes.hora) {
    return { enviados: 0 };
  }

  const store = getStore();
  const hoje = dataSP(agora);
  let enviados = 0;

  for (const item of await store.aguardandoAgendamento()) {
    await emFila(item.contatoId, async () => {
      const atendimento = await store.porId(item.id);

      if (
        atendimento.agendamento !== "pendente" ||
        !atendimento.concluidoEm ||
        dataSP(new Date(atendimento.concluidoEm)) >= hoje || // recebeu o link hoje
        atendimento.ultimoLembrete === hoje
      ) {
        return;
      }

      if (atendimento.lembretes >= config.lembretes.maximo) {
        await store.atualizar(atendimento.id, { agendamento: "nao_agendou" });
        await store.criarTarefa({ chave: `nao_agendou:${atendimento.id}`, tipo: "nao_agendou", atendimentoId: atendimento.id });
        return;
      }

      const numero = atendimento.lembretes + 1;
      await store.atualizar(atendimento.id, { lembretes: numero, ultimoLembrete: hoje });
      await store.criarTarefa({
        chave: `lembrete:${atendimento.id}:${numero}`,
        tipo: "lembrete",
        atendimentoId: atendimento.id,
        dados: { numero },
      });
      enviados++;
    });
  }

  agendarProcessamento();
  return { enviados };
}

// ---------- execução das tarefas (Monday, Telegram, ManyChat) ----------

function nomeDe(atendimento, dados) {
  return atendimento?.mondayNome || dados?.nome || atendimento?.nomeWhatsapp || "Sem nome";
}

function whatsappDe(atendimento, dados) {
  const numero = atendimento?.whatsapp || atendimento?.telefone || dados?.telefone;
  return numero ? formatarTelefone(numero) : "";
}

function textoTelegram(tipo, atendimento, dados, itemId) {
  const e = telegram.escapeHtml;
  const inicio = dados.inicio ? new Date(dados.inicio) : null;
  const linhas = [];

  if (tipo === "agendou" || tipo === "remarcou") {
    linhas.push(tipo === "agendou" ? "📅 <b>Reunião agendada</b>" : "🔁 <b>Reunião remarcada</b>");
    if (!atendimento && !itemId) linhas.push("⚠️ Não encontrei o cadastro na Monday: confira e atualize manualmente.");
  } else if (tipo === "cancelou") {
    linhas.push("❌ <b>Reunião cancelada</b>");
  } else if (tipo === "nao_agendou") {
    linhas.push("⏳ <b>Não respondeu aos lembretes</b>");
  } else if (tipo === "sem_avisos") {
    linhas.push("🔕 <b>Não quer receber os avisos da aula</b>");
  }

  linhas.push(`👤 ${e(nomeDe(atendimento, dados))}`);

  if (inicio && tipo !== "nao_agendou") {
    linhas.push(`🗓 ${tipo === "cancelou" ? "Era em: " : tipo === "remarcou" ? "Nova data: " : ""}${diaSemanaHora(inicio)}`);
  }

  const whatsapp = whatsappDe(atendimento, dados);
  if (whatsapp) linhas.push(`📲 WhatsApp: ${whatsapp}`);
  if (dados.email && !atendimento) linhas.push(`✉️ ${e(dados.email)}`);
  if (tipo === "agendou" || tipo === "remarcou") {
    const origem = linhaOrigem(dados.origemLink);
    if (origem) linhas.push(origem);
  }
  if (tipo === "cancelou" && dados.motivo) linhas.push(`Motivo: ${e(dados.motivo)}`);
  if (tipo === "nao_agendou") linhas.push(`Recebeu o link e ${config.lembretes.maximo} lembretes sem agendar.`);
  if (tipo === "sem_avisos") linhas.push("Não recebe mais lembretes nem convite da aula.");
  if (dados.cadastroInativo) {
    linhas.push("⚠️ O cadastro na Monday está arquivado ou foi apagado: a Monday não foi atualizada.");
  } else if (tipo === "sem_avisos" && !itemId) {
    linhas.push("⚠️ Não achei o cadastro na Monday: marque \"Não quer receber mensagens\" na Etapa do Funil manualmente.");
  }

  const link = monday.linkDoCadastro(itemId);
  if (link) linhas.push(`🔗 ${e(link)}`);

  return linhas.join("\n");
}

function comentarioTarefa(tipo, dados) {
  const inicio = dados.inicio ? new Date(dados.inicio) : null;

  if (tipo === "agendou" || tipo === "remarcou") {
    return [
      `<b>📅 ${tipo === "agendou" ? "Reunião agendada" : "Reunião reagendada"} pelo Calendly</b>`,
      inicio ? `Data: ${diaSemanaHora(inicio)}` : null,
      dados.email ? `E-mail informado: ${telegram.escapeHtml(dados.email)}` : null,
    ]
      .filter(Boolean)
      .join("<br>");
  }

  if (tipo === "recusou") {
    return "<b>📲 Pré-atendimento:</b> respondeu que não quer agendar a reunião.";
  }

  if (tipo === "cancelou") {
    return [
      "<b>❌ Reunião cancelada</b> no Calendly",
      inicio ? `Era em: ${diaSemanaHora(inicio)}` : null,
      dados.motivo ? `Motivo: ${telegram.escapeHtml(dados.motivo)}` : null,
    ]
      .filter(Boolean)
      .join("<br>");
  }

  if (tipo === "reuniao_nota") {
    return `<b>📲 Reunião:</b> ${telegram.escapeHtml(dados.texto || "")}`;
  }

  if (tipo === "sem_avisos") {
    return "<b>🔕 Avisos da aula:</b> pediu para não receber mais os avisos da aula pelo WhatsApp.";
  }

  if (tipo === "voltou_avisos") {
    return "🔔 Voltou a receber as mensagens pelo WhatsApp.";
  }

  return `<b>⏳ Pré-atendimento:</b> não agendou a reunião depois de ${config.lembretes.maximo} lembretes.`;
}

// Etapas de cada tipo, na ordem. Cada etapa concluída fica gravada e não se repete.
function etapasDo(tipo, dados) {
  switch (tipo) {
    case "lembrete":
      return ["campo", "fluxo"];
    case "agendou":
      // A confirmação pelo WhatsApp vem por último: se o ManyChat falhar, a Monday e o
      // grupo já foram atualizados.
      return ["monday", "comentario", "telegram", "confirmacao"];
    case "remarcou":
      // Com o modelo "reunião reagendada", a mensagem sai pelos lembretes da reunião.
      return config.manychat.flowReuniao.reagendada
        ? ["monday", "comentario", "telegram"]
        : ["monday", "comentario", "telegram", "confirmacao"];
    case "cancelou":
      return ["monday", "comentario", "telegram"];
    case "reuniao_aviso":
    case "reuniao_msg":
      return ["envio"];
    case "reuniao_nota":
      return dados?.telegram ? ["comentario", "telegram"] : ["comentario"];
    case "chegadas_resumo":
    case "telegram_resumo":
      return dados?.texto ? ["telegram"] : [];
    case "recusou":
      return ["monday", "comentario"];
    case "nao_agendou":
      return ["monday", "comentario", "telegram"];
    // Pediu para parar os avisos da aula: a Monday já fica marcada, sem aviso no Telegram (v2.13.0).
    case "sem_avisos":
    case "voltou_avisos":
      return ["monday", "comentario"];
    case "convite":
      return convites.ETAPAS;
    case "aula_lembrete":
      return ["contato", "etiqueta", "link", "fluxo"];
    case "live_lembrete":
    case "disparo":
      return ["contato", "fluxo"];
    case "aula_email":
      return ["email"];
    case "mentoria_msg":
    case "mentoria_nota":
      return require("./mentoria.service").etapasDa({ tipo, dados });
    default:
      return [];
  }
}

async function executarEtapa(etapa, tarefa, atendimento, itemId) {
  const { tipo, dados } = tarefa;

  if (tipo === "convite" || tipo === "aula_lembrete" || tipo === "live_lembrete" || tipo === "disparo") {
    await convites.executarEtapa(etapa, tarefa);
    return;
  }

  if (tipo === "reuniao_aviso" || tipo === "reuniao_msg") {
    await reunioes.executarEtapa(etapa, tarefa);
    return;
  }

  if (tipo === "aula_email") {
    await email.executarEtapa(etapa, tarefa);
    return;
  }

  if (tipo === "mentoria_msg" || tipo === "mentoria_nota") {
    await require("./mentoria.service").executarEtapa(etapa, tarefa);
    return;
  }

  if (etapa === "campo") {
    await manychat.definirCampo(atendimento.contatoId, CAMPO_LINK, linkAgendamento(atendimento));
  } else if (etapa === "fluxo") {
    await manychat.enviarFluxo(atendimento.contatoId, config.manychat.flowLembrete);
  } else if (etapa === "monday" && itemId) {
    if (tipo === "agendou") {
      await monday.atualizarCadastro(itemId, {
        resultadoLabel: config.monday.labels.reuniaoMarcada,
        proximoContato: new Date(dados.inicio),
        obs: OBS.marcada(new Date(dados.inicio)),
      });
    } else if (tipo === "remarcou") {
      const etapaLivre = await podeMudarEtapa(itemId);
      await monday.atualizarCadastro(itemId, {
        resultadoLabel: etapaLivre ? config.monday.labels.reuniaoMarcada : null,
        proximoContato: new Date(dados.inicio),
        obs: OBS.reagendada(new Date(dados.inicio)),
      });
    } else if (tipo === "cancelou") {
      if (dados.atual !== false && (await podeMudarEtapa(itemId))) {
        await monday.atualizarCadastro(itemId, { resultadoLabel: config.monday.labels.reuniaoCancelada, obs: OBS.cancelada });
      }
    } else if (tipo === "sem_avisos") {
      await guardarEtapaAnterior(tarefa, itemId);
      await monday.atualizarCadastro(itemId, { resultadoLabel: config.monday.labels.naoQuerMensagens });
    } else if (tipo === "voltou_avisos") {
      await restaurarEtapa(tarefa, itemId);
    } else if (tipo === "recusou") {
      await monday.atualizarCadastro(itemId, { resultadoLabel: config.monday.labels.naoQuisAgendar, obs: OBS.recusou });
    } else {
      await monday.atualizarCadastro(itemId, { resultadoLabel: config.monday.labels.naoAgendou, obs: OBS.naoAgendou() });
    }
  } else if (etapa === "comentario" && itemId) {
    await monday.comentar(itemId, comentarioTarefa(tipo, dados));
  } else if (etapa === "telegram") {
    const texto =
      tipo === "chegadas_resumo" || tipo === "telegram_resumo" ? dados.texto : tipo === "reuniao_nota" ? dados.telegram : textoTelegram(tipo, atendimento, dados, itemId);
    await telegram.enviarAviso(texto);
  } else if (etapa === "confirmacao") {
    await confirmarPeloWhatsapp(tarefa, atendimento);
  }
}

// A reunião só muda a Etapa do Funil enquanto a pessoa está nas etapas de antes da
// reunião: uma etapa mais adiante (proposta, negócio fechado...) não volta para trás.
async function podeMudarEtapa(itemId) {
  const l = config.monday.labels;
  // Inclui as etiquetas antigas ("Qualificado", "Não quis agendar reunião", "Reunião reagendada")
  // de quem já as tinha.
  const antes = [
    l.qualificada, l.reuniaoMarcada, l.reuniaoCancelada, l.naoQuisAgendar, l.naoAgendou,
    "A Definir", "Lead", "Não respondeu", "Qualificado", "Não quis agendar reunião", "Reunião reagendada", "",
  ];
  const atual = await monday.lerEtapa(itemId);
  return antes.some((etapa) => etapa.toLowerCase() === atual.toLowerCase());
}

// "Sua reunião está confirmada para quinta-feira, 23/10, às 15h" no WhatsApp da pessoa.
// Só com a API do ManyChat e o fluxo da confirmação configurados; sem eles, pula.
async function confirmarPeloWhatsapp(tarefa, atendimento) {
  const { dados } = tarefa;

  if (!config.manychat.apiKey || !config.manychat.flowConfirmacao || !dados.inicio) {
    return;
  }

  let contatoId = atendimento?.contatoId || dados.contatoId || null;

  // Agendou sem passar pela Mani: usa o WhatsApp respondido no Calendly.
  if (!contatoId && dados.telefone) {
    contatoId =
      (await getStore().contatoManychat(dados.telefone)) ||
      (await manychat.garantirContato({ telefoneE164: dados.telefone, nome: dados.nome }));
    await getStore().salvarContatoManychat(dados.telefone, contatoId);
    dados.contatoId = String(contatoId);
  }

  if (!contatoId) {
    return; // sem WhatsApp conhecido: a confirmação fica só no e-mail do Calendly
  }

  await manychat.definirCampo(contatoId, CAMPO_REUNIAO, dataPorExtenso(new Date(dados.inicio)));
  await manychat.enviarFluxo(contatoId, config.manychat.flowConfirmacao);
}

// Lembrete da aula que não saiu a tempo (ex.: ManyChat fora do ar) não sai atrasado:
// "faltam 3 dias" só no próprio dia, "hoje" e "falta 1 hora" até a aula começar e
// "começou agora" até 1 hora depois do início.
const PRAZO_AULA = { "3dias": [3, 24], amiga: [2, 24], amanha: [1, 24], hoje: [0, 0], "1hora": [0, 0], aovivo: [0, 1] };

// Relógio trocável nos testes (os lembretes da aula dependem da data e da hora).
let relogio = () => new Date();

function setRelogio(fn) {
  relogio = fn;
}

// Lembrete da live: a véspera só no próprio dia; "1 hora" até as 20h e "começou agora"
// até as 21h do dia da live.
const PRAZO_LIVE = { vespera: [1, 24], "1hora": [0, 20], comecou: [0, 21] };

function avisoLiveVencido(tarefa, agora = relogio()) {
  const [, live, tipo] = String(tarefa.chave).split(":");
  const prazo = PRAZO_LIVE[tipo];
  if (!prazo || !/^\d{4}-\d{2}-\d{2}$/.test(live || "")) return false;

  const [dias, horaLimite] = prazo;
  const dia = new Date(Date.parse(`${live}T12:00:00Z`) - dias * 86400000).toISOString().slice(0, 10);
  const hoje = dataSP(agora);
  return hoje > dia || (hoje === dia && horaSP(agora) >= horaLimite);
}

// Disparo único: o que ficou na fila não sai depois do dia, nem 4 horas depois da hora marcada.
function disparoVencido(tarefa, agora = relogio()) {
  const [, data] = String(tarefa.chave).split(":");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data || "")) return false;
  const hoje = dataSP(agora);
  return hoje > data || (hoje === data && horaMinutoSP(agora) >= config.disparo.hora + 4);
}

function avisoAulaVencido(tarefa, agora = relogio()) {
  const [, data, tipo] = String(tarefa.chave).split(":");
  const prazo = PRAZO_AULA[tipo];
  if (!prazo || !/^\d{4}-\d{2}-\d{2}$/.test(data || "")) return false;

  const [dias, horas] = prazo;
  const dia = new Date(Date.parse(`${data}T12:00:00Z`) - dias * 86400000).toISOString().slice(0, 10);
  const horaLimite = dias ? horas : config.aula.horaAula + horas;
  const hoje = dataSP(agora);
  return hoje > dia || (hoje === dia && horaMinutoSP(agora) >= horaLimite);
}

async function executar(tarefa) {
  const store = getStore();
  const atendimento = tarefa.atendimentoId ? await store.porId(tarefa.atendimentoId) : null;

  const vencido =
    ((tarefa.tipo === "aula_lembrete" || tarefa.tipo === "aula_email") && avisoAulaVencido(tarefa)) ||
    (tarefa.tipo === "live_lembrete" && avisoLiveVencido(tarefa)) ||
    (tarefa.tipo === "disparo" && disparoVencido(tarefa)) ||
    (tarefa.tipo === "mentoria_msg" && Boolean(tarefa.dados.ate) && relogio() >= new Date(tarefa.dados.ate));

  if (vencido) {
    await store.atualizarTarefa(tarefa.id, { status: "ignorado", erro: "Passou do horário do lembrete.", proxima: null, bloqueio: null });
    return;
  }

  // Lembrete que perdeu o sentido (agendou ou recusou depois): não envia.
  if (tarefa.tipo === "lembrete" && atendimento?.agendamento !== "pendente") {
    await store.atualizarTarefa(tarefa.id, { status: "ok", bloqueio: null });
    return;
  }

  let itemId = atendimento?.mondayItemId || tarefa.dados.itemId || null;

  // Agendou sem passar pela Mani (ou sem cadastro vinculado), ou pediu para não receber
  // avisos sem ter recebido nenhum (cadastro desconhecido): procura pelo telefone.
  const procurar =
    (["agendou", "remarcou", "cancelou"].includes(tarefa.tipo) && !atendimento) ||
    tarefa.tipo === "sem_avisos" ||
    tarefa.tipo === "reuniao_nota";
  if (!itemId && procurar && tarefa.dados.telefone && tarefa.dados.buscaFeita !== true) {
    const encontrados = await monday.buscarPorTelefone(tarefa.dados.telefone);
    const dados = { ...tarefa.dados, buscaFeita: true, itemId: encontrados.length === 1 ? encontrados[0].id : null };
    tarefa = await store.atualizarTarefa(tarefa.id, { dados });
    itemId = dados.itemId;
  }

  const feitas = new Set(tarefa.etapas);

  for (const etapa of etapasDo(tarefa.tipo, tarefa.dados)) {
    if (feitas.has(etapa)) continue;

    // Pediu para não receber os avisos da aula: o contato já é conhecido, mas não envia.
    if (etapa === "fluxo" && AVISOS_DA_AULA.has(tarefa.tipo) && (await pediuSemAvisos(tarefa))) {
      await store.atualizarTarefa(tarefa.id, { status: "ignorado", erro: "Não quer receber avisos da aula.", proxima: null, bloqueio: null });
      return;
    }

    try {
      await executarEtapa(etapa, tarefa, atendimento, itemId);
    } catch (error) {
      // Cadastro arquivado ou apagado na Monday: tentar de novo não resolve. Segue sem
      // a Monday e avisa no Telegram (quando a tarefa avisa).
      if (!cadastroInativo(etapa, error)) throw error;
      console.warn(`Tarefa ${tarefa.tipo} ${tarefa.id}: cadastro ${itemId} arquivado ou apagado na Monday; segue sem atualizar a Monday.`);
      tarefa.dados.cadastroInativo = String(itemId);
      itemId = null;
    }

    feitas.add(etapa);
    // A etapa pode ter completado os dados (ex.: ID do contato criado no ManyChat).
    tarefa = await store.atualizarTarefa(tarefa.id, { etapas: [...feitas], dados: tarefa.dados });
  }

  // Pedido sem cadastro achado na Monday: a etiqueta não foi gravada, então o pedido
  // continua bloqueando os avisos por aqui (pediuSemAvisos) e a equipe marca à mão.
  // Lembrete de reunião que perdeu o sentido (cancelada, reagendada, já começou...).
  if (tarefa.dados.pulado) {
    await store.atualizarTarefa(tarefa.id, { status: "ignorado", erro: tarefa.dados.pulado, proxima: null, bloqueio: null, dados: tarefa.dados });
    return;
  }

  const status = tarefa.tipo === "sem_avisos" && !itemId ? "sem_cadastro" : "ok";
  await store.atualizarTarefa(tarefa.id, { status, erro: null, proxima: null, bloqueio: null });

  if (AVISOS_DA_AULA.has(tarefa.tipo) || tarefa.tipo === "reuniao_aviso" || tarefa.tipo === "reuniao_msg") {
    console.log(`Tarefa ${tarefa.tipo} ${tarefa.id}: enviado para ${tarefa.dados.nome || "(sem nome)"} (${tarefa.dados.telefone}).`);
  } else if (tarefa.tipo === "aula_email") {
    console.log(`Tarefa aula_email ${tarefa.id}: e-mail enviado para ${tarefa.dados.nome || "(sem nome)"}.`);
  }
}

// ---------- resumo de cada envio em massa ----------

// Quando o último lembrete de um envio (ex.: "faltam 3 dias" da turma de 29/10)
// termina, manda no Telegram quantos foram, quantos pularam e quantos falharam.
const LOTES = {
  aula_lembrete: {
    varredura: "aula_varredura",
    titulo: "Lembrete da aula",
    rotulos: {
      "3dias": "faltam 3 dias",
      amiga: "convite para amiga",
      amanha: "é amanhã",
      hoje: "é hoje",
      "1hora": "falta 1 hora",
      aovivo: "começou agora",
    },
  },
  // E-mails da aula: o mesmo envio (e a mesma leitura) dos lembretes no WhatsApp.
  aula_email: {
    varredura: "aula_varredura",
    titulo: "E-mail da aula",
    rotulos: { "3dias": "faltam 3 dias", amanha: "é amanhã", "1hora": "falta 1 hora", aovivo: "começou agora" },
  },
  live_lembrete: {
    varredura: "live_varredura",
    titulo: "Lembrete da live",
    rotulos: { vespera: "véspera", "1hora": "começa em 1 hora", comecou: "começou agora" },
  },
  mentoria_msg: {
    varredura: "mentoria_varredura",
    titulo: "Sorteio das mentorias",
    rotulos: {
      aviso: "aviso de inscrição",
      sorteada: "aviso de sorteada",
      lembrete1: "lembrete de quarta",
      lembrete2: "lembrete de quinta",
      perdeu: "perdeu a vaga",
    },
  },
  disparo: {
    varredura: "disparo_varredura",
    titulo: "Disparo único",
    rotulos: { unico: "aviso para todos os inscritos" },
  },
};

function motivoPulado(erro) {
  if (/horário/i.test(erro || "")) return "passou do horário";
  if (/não quer/i.test(erro || "")) return "pediram para não receber";
  return "contato não encontrado";
}

// Chamado pela varredura logo depois de marcar a lista como pronta: se todas as mensagens
// já saíram enquanto a lista era montada, o resumo "concluído" sai agora (v2.14.0; antes
// só a última tarefa da fila tentava fechar o envio e o resumo podia se perder).
async function fecharLoteDe(tipoTarefa, prefixo, data, tipo) {
  try {
    await fecharLote({ tipo: tipoTarefa, chave: `${prefixo}:${data}:${tipo}:` });
  } catch (error) {
    console.error("Resumo do envio falhou:", error.message);
  }
}

async function fecharLote(tarefa) {
  const lote = LOTES[tarefa.tipo];
  if (!lote) return;

  const [, data, tipo] = String(tarefa.chave).split(":");
  const prefixo = `${tarefa.chave.split(":")[0]}:${data}:${tipo}:`;
  const store = getStore();

  // Ainda montando a lista, ou ainda tem gente na fila: o resumo fica para depois.
  const varredura = await store.tarefaPorChave(`${lote.varredura}:${data}:${tipo}`);
  if (!varredura?.dados?.concluido) return;

  const linhas = await store.resumoTarefas(prefixo);
  if (!linhas.length || linhas.some((linha) => linha.status === "pendente")) return;

  // Um resumo só por envio, mesmo com duas cópias do app.
  const marca = await store.criarTarefa({ chave: `resumo_lote:${prefixo}`, tipo: "resumo_lote" });
  if (!marca.criada) return;
  await store.atualizarTarefa(marca.id, { status: "ok" });

  let enviados = 0;
  let falharam = 0;
  const pulados = new Map();

  for (const linha of linhas) {
    if (linha.status === "ok") enviados += linha.total;
    else if (linha.status === "ignorado") {
      const motivo = motivoPulado(linha.erro);
      pulados.set(motivo, (pulados.get(motivo) || 0) + linha.total);
    } else falharam += linha.total;
  }

  const [, mes, dia] = data.split("-");
  const linhasPulados = [...pulados].map(([motivo, total]) => `⏭️ Pulados: ${total} (${motivo})`);

  console.log(`Envio concluído (${prefixo}): ${enviados} enviados, ${[...pulados.values()].reduce((a, b) => a + b, 0)} pulados, ${falharam} falharam.`);

  await telegram.enviarAviso(
    [
      `✅ <b>${lote.titulo} (${lote.rotulos[tipo] || tipo}) concluído</b> · ${dia}/${mes}`,
      `📨 Enviados: ${enviados}`,
      ...linhasPulados,
      falharam ? `🔴 Falharam: ${falharam} (confira no log)` : "🔴 Falharam: 0",
      // Quem ficou de fora da lista (antes ia numa mensagem separada, no começo do envio).
      ...((varredura.dados.resumoEm || tarefa.tipo) === tarefa.tipo ? varredura.dados.resumo || [] : []),
    ].join("\n")
  );
}

function cadastroInativo(etapa, error) {
  return (etapa === "monday" || etapa === "comentario") && /inactive items/i.test(String(error?.message));
}

// Tempo de reserva de uma tarefa: se o processo cair no meio, outro pega depois disso.
const RESERVA_MS = 5 * 60000;

async function processarTarefa(tarefa) {
  const store = getStore();

  // A Hostinger pode rodar duas cópias do app (ex.: durante um reinício): só quem
  // conseguir reservar a tarefa no banco executa, para nada sair em dobro.
  const agoraTarefa = relogio();
  if (!(await store.travarTarefa(tarefa.id, new Date(agoraTarefa.getTime() + RESERVA_MS), agoraTarefa))) {
    return;
  }

  // A lista foi lida antes: outra cópia pode ter feito etapas desde então. Segue com o
  // estado atual do banco, para não repetir etapas nem voltar a contagem de tentativas.
  tarefa = (await store.tarefaPorChave(tarefa.chave)) || tarefa;

  try {
    await processarComFila(tarefa);
  } finally {
    try {
      await fecharLote(tarefa);
    } catch (error) {
      console.error("Resumo do envio falhou:", error.message);
    }
  }
}

async function processarComFila(tarefa) {
  const store = getStore();

  try {
    await executar(tarefa);
  } catch (error) {
    // Quem já conversou com o número antes (o ManyChat não diz o ID): pula sem alerta.
    if (error.contatoExistente) {
      console.log(`Tarefa ${tarefa.tipo} ${tarefa.id}: pulada (contato antigo do ManyChat, sem ID pela API).`);
      await store.atualizarTarefa(tarefa.id, { status: "ignorado", erro: error.message, proxima: null, bloqueio: null });
      // Lembrete de reunião não pode sumir em silêncio: a equipe é avisada (uma vez por reunião).
      if (tarefa.tipo === "reuniao_aviso" || tarefa.tipo === "reuniao_msg") {
        await reunioes.avisarSemContato(tarefa.dados.evento);
      }
      // Mensagens do sorteio que a pessoa precisa receber (v2.18.1).
      if (tarefa.tipo === "mentoria_msg") {
        await require("./mentoria.service").avisarSemContato(tarefa).catch((e) => console.error("Aviso de mensagem do sorteio não enviada falhou:", e.message));
      }
      return;
    }

    const tentativas = tarefa.tentativas + 1;
    // Erro que não se resolve tentando de novo (ex.: contato que a API não acha) para já.
    const desistir = tentativas >= DESISTIR_APOS || error.naoRepetir === true;
    const campos = {
      tentativas,
      erro: error.message,
      proxima: proximaTentativa(error, tentativas),
      status: desistir ? "falhou" : "pendente",
      bloqueio: null,
    };

    console.error(`Tarefa ${tarefa.tipo} ${tarefa.id}: tentativa ${tentativas} falhou:`, error.code || error.message);

    if ((tentativas >= ALERTAR_APOS || desistir) && !tarefa.alertaFalha) {
      try {
        // Um envio em massa que falha inteiro (ex.: ManyChat fora) não vira um aviso por
        // pessoa: no máximo um aviso por tipo a cada 30 minutos.
        const ultimo = ultimoAlerta.get(tarefa.tipo) || 0;

        if (Date.now() - ultimo >= ALERTA_INTERVALO_MS) {
          ultimoAlerta.set(tarefa.tipo, Date.now());
          await telegram.enviarAviso(
            [
              `🔴 <b>Falha: ${ROTULOS[tarefa.tipo] || tarefa.tipo}</b>`,
              `Não consegui concluir depois de ${tentativas} tentativas (${telegram.escapeHtml(error.message)}).`,
              tarefa.dados?.nome ? `👤 ${telegram.escapeHtml(tarefa.dados.nome)}` : null,
              desistir
                ? "Parei de tentar: confira manualmente."
                : "Vou continuar tentando. Falhas iguais na próxima meia hora não geram novo aviso.",
            ]
              .filter(Boolean)
              .join("\n")
          );
        }

        campos.alertaFalha = true;
      } catch (avisoErro) {
        console.error("Aviso de falha no Telegram também falhou:", avisoErro.message);
      }
    }

    await store.atualizarTarefa(tarefa.id, campos);
  }
}

const ROTULOS = {
  lembrete: "lembrete de agendamento",
  agendou: "reunião agendada",
  remarcou: "reunião remarcada",
  cancelou: "reunião cancelada",
  recusou: "recusa de agendamento",
  nao_agendou: "não agendou",
  convite: "convite para o grupo",
  aula_lembrete: "lembrete da aula",
  live_lembrete: "lembrete da live",
  disparo: "disparo único",
  mentoria_msg: "mensagem do sorteio das mentorias",
  mentoria_nota: "anotação do sorteio na Monday",
  aula_email: "e-mail da aula",
  reuniao_aviso: "lembrete da reunião",
  reuniao_msg: "mensagem da reunião (reagendada/cancelada)",
  reuniao_nota: "anotação da reunião",
  sem_avisos: "pedido para não receber avisos",
  voltou_avisos: "pedido para voltar a receber avisos",
  chegadas_resumo: "resumo da ordem de chegada",
  telegram_resumo: "resumo no Telegram",
};

const ALERTA_INTERVALO_MS = 30 * 60000;
const ultimoAlerta = new Map();

let rodando = false;
let pedidoExtra = false;
const LOTE = 20;

async function processarTarefas() {
  if (rodando) {
    pedidoExtra = true;
    return;
  }

  rodando = true;

  try {
    let loteCheio;

    do {
      pedidoExtra = false;
      const lote = await getStore().tarefasPendentes(relogio(), LOTE);
      loteCheio = lote.length === LOTE;

      for (const tarefa of lote) {
        await processarTarefa(tarefa);
      }
    } while (pedidoExtra || loteCheio);
  } catch (error) {
    console.error("Processamento das tarefas de agendamento falhou:", error.code || error.message);
  } finally {
    rodando = false;
  }
}

let timerAgendado = null;

function agendarProcessamento() {
  if (!config.workerEnabled || timerAgendado) {
    return;
  }

  timerAgendado = setTimeout(() => {
    timerAgendado = null;
    processarTarefas();
  }, 200);
  timerAgendado.unref?.();
}

function iniciar({ tarefasMs = 60000, lembretesMs = 5 * 60000 } = {}) {
  if (!config.workerEnabled) {
    return;
  }

  processarTarefas();
  setInterval(processarTarefas, tarefasMs).unref();

  const lembretes = () => rodarLembretes().catch((error) => console.error("Lembretes falharam:", error.message));
  lembretes();
  setInterval(lembretes, lembretesMs).unref();
}

module.exports = {
  OBS,
  ROTULOS,
  agendou,
  iniciar,
  linkAgendamento,
  novaRef,
  agendarProcessamento,
  fecharLoteDe,
  pararAvisos,
  voltarAvisos,
  setRelogio,
  processarTarefas,
  proximoLembrete,
  receberWebhook,
  recusar,
  rodarLembretes,
};
