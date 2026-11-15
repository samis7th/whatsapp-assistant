const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataSP } = require("../domain/datas");
const { normalizarTelefone, variantesTelefone } = require("../domain/telefone");
const calendly = require("./calendly.service");
const googleAgenda = require("./google-agenda.service");
const manychat = require("./manychat.service");
const telegram = require("./telegram.service");

// Lembretes da reunião marcada no Calendly, pelo WhatsApp (ManyChat):
//  - pedido de confirmação no dia anterior (13h, dia de calendário: sem exceção para fim
//    de semana nem feriado) e lembrete no dia (8h), com o
//    modelo de "confirmar" ou de "já confirmou" conforme a resposta;
//  - respostas pelos botões: "Sim, confirmo", "Não posso" (manda o link de reagendar e
//    tira dos lembretes) e "Não quero reagendar" (cancela no Calendly);
//  - reagendou ou cancelou (pelo WhatsApp ou direto no Calendly): os avisos antigos
//    perdem a validade e sai uma mensagem só de "reagendada" ou "cancelada".
// Cada reunião tem um registro (tarefa "reuniao_registro", chave reuniao:<ID do evento>)
// com o estado atual; os avisos conferem esse registro na hora de sair. Reuniões marcadas
// direto na agenda do consultor (sem Calendly) chegam por reunioes-agenda.service, com
// registro "reuniao:agenda:<ID do evento no Google>" e origem "agenda".

const CAMPOS = { data: "reuniao_data", hora: "reuniao_hora", link: "reuniao_link", reagendar: "reuniao_reagendar" };
const SEM_LEMBRETES = ["reagendar_pendente", "cancelamento_pendente"];

// Relógio trocável nos testes.
let relogio = () => new Date();

function setRelogio(fn) {
  relogio = fn;
}

// Carregado na hora de usar (o agendamento também usa este módulo).
function agendamento() {
  return require("./agendamento.service");
}

function idDoEvento(uri) {
  return String(uri || "").split("/").filter(Boolean).pop() || "";
}

function chaveRegistro(eventoUri) {
  return `reuniao:${idDoEvento(eventoUri)}`;
}

function eventoDoConvidado(inviteeUri) {
  return String(inviteeUri || "").split("/invitees/")[0] || null;
}

// "AAAA-MM-DD" + hora em fração (18.5 = 18h30) -> o instante em Brasília (UTC-3).
function emBrasilia(iso, hora) {
  const h = Math.floor(hora);
  const m = Math.round((hora - h) * 60);
  return new Date(`${iso}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-03:00`);
}

// "03/11 (segunda-feira)"
function textoData(data) {
  const fmt = (opcoes) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", ...opcoes }).format(data);
  return `${fmt({ day: "2-digit", month: "2-digit" })} (${fmt({ weekday: "long" })})`;
}

// "14h30" ou "10h"
function textoHora(data) {
  const [h, m] = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(data)
    .split(":");
  return `${Number(h)}h${m === "00" ? "" : m}`;
}

// "2026-11-09" -> "2026-11-08".
function diaAnterior(iso) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

// Quando sai cada aviso (null = não sai). A véspera é no dia anterior (de calendário); o do dia
// sai às 8h, ou antes se a reunião for cedo. Nada sai muito perto do agendamento nem
// depois do início; se o horário do dia já passou e ainda dá tempo, sai um pedido só.
function planejarAvisos(inicio, agendadoEm) {
  const r = config.reunioes;
  const dia = dataSP(inicio);
  const minimo = agendadoEm.getTime() + r.intervaloMin * 60000;
  const limiteDia = inicio.getTime() - r.antecedenciaMin * 60000;

  let noDia = Math.min(emBrasilia(dia, r.horaDia).getTime(), limiteDia);
  if (noDia < minimo) noDia = minimo <= limiteDia ? minimo : null;

  const vespera = emBrasilia(diaAnterior(dia), r.horaVespera).getTime();
  const vesperaValida = vespera >= minimo && vespera < inicio.getTime() && (!noDia || vespera < noDia);

  return {
    vespera: vesperaValida ? new Date(vespera) : null,
    dia: noDia ? new Date(noDia) : null,
  };
}

// Cria as tarefas dos avisos de uma reunião. `versao` separa os avisos de um novo horário
// do mesmo evento (reunião remarcada direto na agenda).
async function programarAvisos(evento, inicio, agora, versao = "") {
  const store = getStore();
  const plano = planejarAvisos(inicio, agora);
  const id = idDoEvento(evento);

  for (const [aviso, quando] of Object.entries(plano)) {
    if (quando) {
      await store.criarTarefa({
        chave: `reuniao_aviso:${id}:${aviso}${versao ? `:${versao}` : ""}`,
        tipo: "reuniao_aviso",
        dados: { evento, aviso, inicio: inicio.toISOString(), versao },
        proxima: quando,
      });
    }
  }

  return plano;
}

function marcaCalendly(email, inicio) {
  return `reuniao_marca:${String(email).trim().toLowerCase()}:${new Date(inicio).toISOString()}`;
}

async function atualizarRegistro(registro, mudancas) {
  const dados = { ...registro.dados, ...mudancas };
  await getStore().atualizarTarefa(registro.id, { dados });
  return { ...registro, dados };
}

// Índice contato do ManyChat -> reuniões (para achar a reunião da resposta).
async function indexar(contatoId, eventoUri) {
  if (!contatoId) return;
  const store = getStore();
  const chave = `reuniao_contato:${contatoId}`;
  const indice = await store.criarTarefa({ chave, tipo: "reuniao_indice", dados: { eventos: [eventoUri] } });
  const eventos = indice.dados?.eventos || [];

  if (!indice.criada && !eventos.includes(eventoUri)) {
    await store.atualizarTarefa(indice.id, { dados: { eventos: [...eventos, eventoUri].slice(-20) } });
  }
}

// ---------- avisos do Calendly ----------

// Origem do link do Calendly: o utm_source que veio no link de agendamento (o Calendly
// devolve em payload.tracking.utm_source no invitee.created). "reuniao-consultor" = página
// de pré-reunião do site; "mani" = link mandado pela Mani. Sem origem: null (v3.5.0).
function origemDoLink(p) {
  const valor = p?.tracking?.utm_source;
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const texto = String(valor).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  return texto || null;
}

async function registrarAgendamento(p, { atendimento = null } = {}) {
  const store = getStore();
  const evento = p.scheduled_event?.uri;
  const inicio = new Date(p.scheduled_event?.start_time);

  if (!evento || Number.isNaN(inicio.getTime())) {
    return { ignorado: "sem_dados" };
  }

  const agora = relogio();
  const telefones = [p.text_reminder_number, ...(p.questions_and_answers || []).map((qa) => qa.answer)]
    .map((valor) => normalizarTelefone(valor))
    .filter(Boolean);
  const anterior = p.old_invitee ? eventoDoConvidado(p.old_invitee) : null;

  const registro = await store.criarTarefa({
    chave: chaveRegistro(evento),
    tipo: "reuniao_registro",
    dados: {
      evento,
      convidado: p.uri,
      nome: p.name || "",
      email: p.email || "",
      telefone: telefones[0] || "",
      contatoId: atendimento?.contatoId || null,
      itemId: atendimento?.mondayItemId || null,
      inicio: inicio.toISOString(),
      fim: p.scheduled_event?.end_time || null,
      link: p.scheduled_event?.location?.join_url || "",
      reagendar: p.reschedule_url || "",
      cancelar: p.cancel_url || "",
      origemLink: origemDoLink(p),
      anterior,
      situacao: "ativa",
      confirmacao: "pendente",
      enviados: [],
      agendadoEm: agora.toISOString(),
    },
  });

  // Aviso repetido do Calendly: já está registrado.
  if (!registro.criada) {
    return { duplicado: true };
  }

  // Reagendamento: a reunião antiga deixa de valer (os avisos dela não saem mais).
  if (anterior) {
    const antigo = await store.tarefaPorChave(chaveRegistro(anterior));
    if (antigo) {
      await atualizarRegistro(antigo, { situacao: "substituida", substituidaPor: evento });
      if (!registro.dados.contatoId && antigo.dados.contatoId) {
        await atualizarRegistro(registro, { contatoId: antigo.dados.contatoId, itemId: registro.dados.itemId || antigo.dados.itemId });
      }
    }
  }

  await indexar(atendimento?.contatoId, evento);

  // O Consultor já tinha criado o mesmo horário à mão para a mesma pessoa: a reunião da agenda
  // dá lugar à do Calendly (sem lembretes em dobro) (v2.18.0).
  const emailCal = String(p.email || "").trim().toLowerCase();
  const telefonesCal = new Set(telefones.flatMap((t) => variantesTelefone(t)));
  for (const t of await store.tarefasComPrefixo("reuniao:agenda:")) {
    const a = t.dados || {};
    const mesmaPessoa = (emailCal && String(a.email || "").toLowerCase() === emailCal) || (a.telefone && telefonesCal.has(a.telefone));
    if (t.tipo === "reuniao_registro" && a.situacao === "ativa" && a.inicio === inicio.toISOString() && mesmaPessoa) {
      await atualizarRegistro(t, { situacao: "substituida", substituidaPor: evento });
    }
  }

  // Marca de "esta reunião já veio pelo Calendly": a leitura da agenda não a pega de novo.
  if (p.email) {
    await store.criarTarefa({ chave: marcaCalendly(p.email, inicio), tipo: "reuniao_marca", dados: { evento } });
  }

  const plano = await programarAvisos(evento, inicio, agora);
  const id = idDoEvento(evento);

  // "Sua reunião foi reagendada" (uma vez, no lugar da confirmação de agendamento).
  if (anterior && config.manychat.flowReuniao.reagendada) {
    await store.criarTarefa({ chave: `reuniao_msg:${id}:reagendada`, tipo: "reuniao_msg", dados: { evento, aviso: "reagendada" } });
  }

  agendamento().agendarProcessamento();
  return { registrado: true, avisos: Object.fromEntries(Object.entries(plano).map(([k, v]) => [k, v && v.toISOString()])) };
}

async function registrarCancelamento(p) {
  if (p.rescheduled) {
    return { ignorado: "reagendamento" }; // o novo agendamento cuida disso
  }

  const store = getStore();
  const evento = p.scheduled_event?.uri;
  const registro = evento ? await store.tarefaPorChave(chaveRegistro(evento)) : null;

  if (!registro || registro.dados.situacao !== "ativa") {
    return { ignorado: registro ? registro.dados.situacao : "sem_registro" };
  }

  await atualizarRegistro(registro, { situacao: "cancelada", canceladaEm: relogio().toISOString() });

  // Cancelou direto no Calendly: avisa pelo WhatsApp (pelo WhatsApp a mensagem já saiu).
  if (!registro.dados.mensagemCancelamento && config.manychat.flowReuniao.cancelada) {
    await store.criarTarefa({
      chave: `reuniao_msg:${idDoEvento(evento)}:cancelada`,
      tipo: "reuniao_msg",
      dados: { evento, aviso: "cancelada" },
    });
    agendamento().agendarProcessamento();
  }

  return { cancelada: true };
}

// ---------- envio (etapa "envio" das tarefas reuniao_aviso / reuniao_msg) ----------

function fluxoDo(aviso, registro) {
  const f = config.manychat.flowReuniao;
  if (aviso === "vespera") return f.vespera;
  if (aviso === "dia") return registro.dados.confirmacao === "confirmada" ? f.diaConfirmado : f.diaConfirmar;
  return f[aviso] || "";
}

async function contatoDo(registro) {
  if (registro.dados.contatoId) return registro.dados.contatoId;
  if (!registro.dados.telefone) return null;

  const store = getStore();
  const contatoId =
    (await store.contatoManychat(registro.dados.telefone)) ||
    (await manychat.garantirContato({ telefoneE164: registro.dados.telefone, nome: registro.dados.nome }));
  await store.salvarContatoManychat(registro.dados.telefone, contatoId);
  return String(contatoId);
}

// O link do Meet pode demorar a ser gerado: busca de novo no Calendly. Sem link, o
// aviso não sai (nunca com o campo vazio); a tarefa tenta de novo e avisa a equipe.
async function garantirLink(registro) {
  if (registro.dados.link) return registro;

  if (registro.dados.origem === "agenda") {
    const link = googleAgenda.linkDoMeet(await googleAgenda.obterEvento(registro.dados.googleId));
    if (!link) throw new Error("A reunião na agenda ainda não tem link do Meet.");
    return atualizarRegistro(registro, { link });
  }

  const evento = await calendly.obterEvento(registro.dados.evento);
  const link = evento.location?.join_url || "";
  if (!link) throw new Error("O link do Meet ainda não está disponível no Calendly.");
  return atualizarRegistro(registro, { link });
}

async function avisarPendencia(registro) {
  const d = registro.dados;
  const motivo = d.confirmacao === "reagendar_pendente" ? "pediu para reagendar e ainda não escolheu outro horário" : "pediu para cancelar e o cancelamento não foi concluído";

  try {
    await telegram.enviarAviso(
      [
        "⚠️ <b>Reunião com pendência</b>",
        `👤 ${telegram.escapeHtml(d.nome || "")}`,
        `🗓 Hoje, às ${textoHora(new Date(d.inicio))}`,
        `A pessoa ${motivo}. O lembrete do dia não foi enviado: confira com ela.`,
      ].join("\n")
    );
  } catch (error) {
    console.error("Aviso de pendência da reunião no Telegram falhou:", error.message);
  }
}

async function executarEtapa(etapa, tarefa) {
  const store = getStore();
  const { aviso } = tarefa.dados;
  let registro = await store.tarefaPorChave(chaveRegistro(tarefa.dados.evento));
  const pular = (motivo) => {
    tarefa.dados.pulado = motivo;
  };

  if (!registro) return pular("reunião não encontrada");

  const d = registro.dados;
  const inicio = new Date(d.inicio);
  const agora = relogio();

  if (aviso === "cancelada") {
    if (d.situacao !== "cancelada") return pular("a reunião não está cancelada");
    // Apagada depois de acontecer: não manda "cancelada" (v2.18.0).
    if (agora >= inicio) return pular("a reunião já tinha acontecido");
  } else {
    if (d.situacao !== "ativa") return pular(`reunião ${d.situacao}`);
    if (agora >= inicio) return pular("a reunião já começou");
  }

  if (tarefa.tipo === "reuniao_aviso") {
    if (tarefa.dados.inicio && tarefa.dados.inicio !== d.inicio) return pular("o horário da reunião mudou");
    // Cada remarcação/troca gera uma versão nova; lembrete de versão anterior não sai, e o
    // mesmo lembrete nunca sai duas vezes (v2.18.0: ida e volta de horário duplicava).
    if ((tarefa.dados.versao || "") !== (d.avisosVersao || "")) return pular("lembrete de uma versão anterior da reunião");
    if ((d.enviados || []).includes(aviso)) return pular("este lembrete já saiu");
    if (SEM_LEMBRETES.includes(d.confirmacao)) {
      if (aviso === "dia") await avisarPendencia(registro);
      return pular("pediu para reagendar ou cancelar");
    }
    if (aviso === "vespera" && (d.enviados || []).includes("dia")) return pular("o lembrete do dia já saiu");
  }

  const fluxo = fluxoDo(aviso, registro);
  if (!fluxo) return pular("fluxo do ManyChat não configurado");

  const contatoId = await contatoDo(registro);
  if (!contatoId) return pular("sem WhatsApp no agendamento");
  if (contatoId !== d.contatoId) {
    registro = await atualizarRegistro(registro, { contatoId });
    await indexar(contatoId, d.evento);
  }

  // "Não quero receber" vale para os avisos da aula e das lives: quem marcou uma reunião
  // depois disso recebe os lembretes dela (decisão do negócio).

  if (aviso === "dia" || aviso === "reagendada") {
    registro = await garantirLink(registro);
  }

  const atual = registro.dados;
  await manychat.definirCampo(contatoId, CAMPOS.data, textoData(inicio));
  await manychat.definirCampo(contatoId, CAMPOS.hora, textoHora(inicio));
  if (atual.link) await manychat.definirCampo(contatoId, CAMPOS.link, atual.link);
  if (atual.reagendar) await manychat.definirCampo(contatoId, CAMPOS.reagendar, atual.reagendar);
  await manychat.enviarFluxo(contatoId, fluxo);

  await atualizarRegistro(registro, { enviados: [...(atual.enviados || []), aviso] });
  tarefa.dados.telefone = atual.telefone;
  tarefa.dados.nome = atual.nome;
}

// Contato antigo do ManyChat que a API não acha pelo telefone: os lembretes dessa reunião
// não saem. Avisa a equipe uma vez por reunião (mandar manualmente ou preencher o campo
// whatsapp_numero no contato, que faz os próximos saírem).
async function avisarSemContato(evento) {
  const store = getStore();
  const registro = await store.tarefaPorChave(chaveRegistro(evento));
  if (!registro) return;

  const marca = await store.criarTarefa({ chave: `reuniao_sem_contato:${idDoEvento(evento)}`, tipo: "reuniao_marca", dados: {} });
  if (!marca.criada) return;

  const d = registro.dados;
  const inicio = new Date(d.inicio);
  const e = telegram.escapeHtml;
  try {
    await telegram.enviarAviso(
      [
        "⚠️ <b>Lembrete de reunião não enviado</b>",
        `👤 ${e(d.nome || "")}${d.telefone ? ` · ${e(d.telefone)}` : ""}`,
        `🗓 ${textoData(inicio)}, às ${textoHora(inicio)}`,
        `O ManyChat tem esse contato, mas não deixa achá-lo pelo número. Mande este aviso manualmente e preencha o campo ${e(config.manychat.campoWhatsapp)} no contato (ex.: ${e(String(d.telefone || "").replace("+", ""))}) para os próximos saírem.`,
      ].join("\n")
    );
  } catch (error) {
    console.error("Aviso de lembrete não enviado no Telegram falhou:", error.message);
  }
}

// ---------- respostas pelo WhatsApp ----------

function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Regras fixas (sem IA). O que não for claro vai para a equipe.
function interpretar(texto) {
  const t = normalizar(texto);
  if (/^(nao quero reagendar|pode cancelar|pode cancelar a reuniao|quero cancelar|quero cancelar a reuniao|cancelar|cancela|cancelar a reuniao)$/.test(t)) return "cancelar";
  if (/^(sim|sim confirmo|confirmo|confirmado|confirmada|s|ok sim|sim confirmado)$/.test(t)) return "sim";
  if (/^(nao|nao posso|n|nao vou poder|nao consigo|nao consigo ir)$/.test(t)) return "nao";
  return null;
}

async function reunioesDoContato(contatoId) {
  const store = getStore();
  const indice = await store.tarefaPorChave(`reuniao_contato:${contatoId}`);
  const agora = relogio();
  const lista = [];

  for (const evento of indice?.dados?.eventos || []) {
    const registro = await store.tarefaPorChave(chaveRegistro(evento));
    if (
      registro &&
      registro.dados.situacao === "ativa" &&
      new Date(registro.dados.inicio) > agora &&
      !((registro.dados.contatosAntigos || []).includes(String(contatoId)) && String(registro.dados.contatoId || "") !== String(contatoId))
    ) {
      lista.push(registro);
    }
  }

  return lista;
}

function respostaCom(registro, resultado) {
  const d = registro.dados;
  const inicio = new Date(d.inicio);
  return {
    resultado,
    primeiro_nome: String(d.nome || "").trim().split(/\s+/)[0] || "",
    reuniao_data: textoData(inicio),
    reuniao_hora: textoHora(inicio),
    reuniao_link: d.link || "",
    reuniao_reagendar: d.reagendar || "",
  };
}

// Anotação na Monday (e, se for o caso, aviso no Telegram) pela fila de tarefas.
async function anotar(registro, chave, texto, avisoTelegram = null) {
  await getStore().criarTarefa({
    chave,
    tipo: "reuniao_nota",
    dados: {
      texto,
      telegram: avisoTelegram,
      itemId: registro.dados.itemId,
      telefone: registro.dados.telefone,
      nome: registro.dados.nome,
    },
  });
  agendamento().agendarProcessamento();
}

async function avisarEquipe(linhas) {
  try {
    await telegram.enviarAviso(linhas.filter(Boolean).join("\n"));
  } catch (error) {
    console.error("Aviso da resposta da reunião no Telegram falhou:", error.message);
  }
}

async function responder({ contatoId, resposta }) {
  const e = telegram.escapeHtml;
  const tipo = interpretar(resposta);
  const reunioes = await reunioesDoContato(contatoId);

  if (!reunioes.length) {
    return { resultado: "sem_reuniao" };
  }

  if (reunioes.length > 1 || !tipo) {
    const r = reunioes[0].dados;
    await avisarEquipe([
      "💬 <b>Resposta sobre reunião para conferir</b>",
      `👤 ${e(r.nome || "")}${r.telefone ? ` · ${e(r.telefone)}` : ""}`,
      reunioes.length > 1 ? `Tem ${reunioes.length} reuniões marcadas: não sei de qual está falando.` : null,
      `Respondeu: "${e(String(resposta || "").slice(0, 300))}"`,
    ]);
    return { ...respostaCom(reunioes[0], "humano") };
  }

  const registro = reunioes[0];
  const d = registro.dados;
  const id = idDoEvento(d.evento);

  if (tipo === "sim") {
    if (d.confirmacao !== "confirmada") {
      await atualizarRegistro(registro, { confirmacao: "confirmada" });
      await anotar(registro, `reuniao_nota:${id}:confirmou`, `Presença confirmada pelo WhatsApp para ${textoData(new Date(d.inicio))}, às ${textoHora(new Date(d.inicio))}.`);
    }
    return respostaCom(registro, "confirmado");
  }

  if (tipo === "nao") {
    if (d.confirmacao !== "reagendar_pendente") {
      await atualizarRegistro(registro, { confirmacao: "reagendar_pendente" });
      await anotar(
        registro,
        `reuniao_nota:${id}:reagendar`,
        "Respondeu pelo WhatsApp que não pode na data marcada; recebeu o link para reagendar.",
        [
          "🔁 <b>Pediu para reagendar a reunião</b>",
          `👤 ${e(d.nome || "")}`,
          `🗓 Era em ${textoData(new Date(d.inicio))}, às ${textoHora(new Date(d.inicio))}`,
          "Recebeu o link para escolher outro horário. Os lembretes desse horário foram suspensos.",
          d.origem === "agenda"
            ? "⚠️ Essa reunião foi marcada direto na agenda: quando ela escolher o novo horário pelo Calendly, apague o horário antigo na agenda."
            : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    return respostaCom(registro, "reagendar");
  }

  // Marcada direto na agenda: o sistema só lê a agenda, então a equipe cancela lá. Quando
  // o evento sumir da agenda, sai a mensagem de "cancelada" (reunioes-agenda.service).
  if (d.origem === "agenda") {
    if (d.confirmacao !== "cancelamento_pendente") {
      await atualizarRegistro(registro, { confirmacao: "cancelamento_pendente" });
      await avisarEquipe([
        "🗑 <b>Pediu para cancelar a reunião</b>",
        `👤 ${e(d.nome || "")}`,
        `🗓 ${textoData(new Date(d.inicio))}, às ${textoHora(new Date(d.inicio))}`,
        "Foi marcada direto na agenda: cancele o evento na agenda do consultor. Quando ele sumir da agenda, a pessoa recebe a mensagem de cancelada.",
      ]);
    }
    return respostaCom(registro, "falha");
  }

  // Cancelar: só confirma para a pessoa depois que o Calendly aceitar.
  try {
    await calendly.cancelarEvento(d.evento, "Cancelado pela pessoa pelo WhatsApp (não quis reagendar).");
    await atualizarRegistro(registro, { situacao: "cancelada", mensagemCancelamento: true, canceladaEm: relogio().toISOString() });
    return respostaCom(registro, "cancelado");
  } catch (error) {
    console.error("Cancelamento da reunião no Calendly falhou:", error.message);
    await atualizarRegistro(registro, { confirmacao: "cancelamento_pendente" });
    await avisarEquipe([
      "🔴 <b>Cancelamento de reunião não concluído</b>",
      `👤 ${e(d.nome || "")}`,
      `🗓 ${textoData(new Date(d.inicio))}, às ${textoHora(new Date(d.inicio))}`,
      "A pessoa pediu para cancelar pelo WhatsApp, mas o Calendly recusou. Cancele manualmente no Calendly.",
      `(${e(error.message)})`,
    ]);
    return respostaCom(registro, "falha");
  }
}

module.exports = {
  CAMPOS,
  agora: () => relogio(),
  anotar,
  atualizarRegistro,
  avisarSemContato,
  chaveRegistro,
  executarEtapa,
  idDoEvento,
  indexar,
  marcaCalendly,
  origemDoLink,
  programarAvisos,
  interpretar,
  planejarAvisos,
  registrarAgendamento,
  registrarCancelamento,
  responder,
  setRelogio,
  textoData,
  textoHora,
};
