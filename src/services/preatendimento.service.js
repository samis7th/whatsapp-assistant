const { config } = require("../config/env");
const { getStore } = require("../db");
const {
  FAIXA_A_VERIFICAR,
  LIMITE_QUALIFICACAO,
  faixaDoValor,
  formatarReais,
  interpretarFaturamento,
  qualifica,
} = require("../domain/faturamento");
const { dataHoraBR } = require("../domain/datas");
const { formatarTelefone, normalizarTelefone } = require("../domain/telefone");
const { emFila, proximaTentativa } = require("../utils/fila");
const agendamento = require("./agendamento.service");
const monday = require("./monday.service");
const telegram = require("./telegram.service");

// Uma conversa sem resultado há mais tempo que isso recomeça do zero.
const SESSAO_MS = 24 * 60 * 60 * 1000;

// Tentativas antes de passar a conversa para a equipe.
const MAX_NAO_ENCONTRADO = 2;
const MAX_TELEFONE = 4;
const MAX_FATURAMENTO = 3;

// Reenvio em segundo plano.
const ALERTAR_APOS = 3;
const DESISTIR_APOS = 60;

const MOTIVOS = {
  nao_encontrado: "Telefone informado não encontrado na Monday",
  cadastro_duplicado: "Mais de um cadastro com esse telefone",
  telefone_invalido: "A pessoa não conseguiu informar um telefone válido",
  faturamento_nao_informado: "A pessoa não conseguiu informar o faturamento",
};

// ---------- utilidades ----------

function primeiroNome(nome) {
  const primeiro = String(nome || "").trim().split(/\s+/)[0] || "";
  return primeiro ? primeiro[0].toUpperCase() + primeiro.slice(1).toLowerCase() : "";
}

// Status escrito na coluna OBS.
const OBS = {
  qualificada: agendamento.OBS.aguardando,
  fora_do_perfil: "Perfil não qualificado por renda",
  a_verificar: "Faturamento a verificar",
};

function obsDoResultado(atendimento) {
  if (atendimento.resultado === "qualificada") return OBS.qualificada;
  if (atendimento.resultado === "fora_do_perfil") return OBS.fora_do_perfil;
  if (atendimento.faixa === FAIXA_A_VERIFICAR) return OBS.a_verificar;
  return null;
}

function labelResultado(atendimento) {
  if (atendimento.resultado === "qualificada") return config.monday.labels.qualificada;
  if (atendimento.resultado === "fora_do_perfil") return config.monday.labels.foraDoPerfil;
  return null;
}

async function sessaoAberta(contatoId, { whatsapp, nome }) {
  const store = getStore();
  const atual = await store.atual(contatoId);
  const dados = {
    whatsapp: normalizarTelefone(whatsapp) || (whatsapp ? String(whatsapp).slice(0, 20) : null),
    nomeWhatsapp: nome ? String(nome).slice(0, 120) : null,
  };

  if (atual && !atual.resultado && Date.now() - new Date(atual.criadoEm).getTime() < SESSAO_MS) {
    const campos = {};
    if (dados.whatsapp && !atual.whatsapp) campos.whatsapp = dados.whatsapp;
    if (dados.nomeWhatsapp && !atual.nomeWhatsapp) campos.nomeWhatsapp = dados.nomeWhatsapp;
    return Object.keys(campos).length ? store.atualizar(atual.id, campos) : atual;
  }

  return store.criar({ contatoId, ...dados });
}

// Encerra a conversa passando para a equipe (o aviso sai pelo Telegram).
async function encaminhar(atendimento, motivo) {
  await getStore().atualizar(atendimento.id, {
    resultado: "encaminhado",
    motivo,
    respostaEnviada: "encaminhado",
    faixa: motivo === "faturamento_nao_informado" ? FAIXA_A_VERIFICAR : atendimento.faixa,
    // Sem cadastro único não há o que gravar na Monday; só avisa a equipe.
    etapaMonday: !atendimento.mondayItemId,
    etapaComentario: !atendimento.mondayItemId,
    buscaPendente: false,
    sync: "pendente",
    syncProxima: null,
    concluidoEm: new Date(),
  });

  agendarSincronizacao();
  return { resultado: "encaminhado" };
}

// ---------- etapa 1: telefone ----------

async function receberTelefone({ contatoId, whatsapp, nome, telefone }) {
  const prazo = monday.prazoDaConversa();

  return emFila(contatoId, async () => {
    const store = getStore();
    let atendimento = await sessaoAberta(contatoId, { whatsapp, nome });
    const normalizado = normalizarTelefone(telefone);

    if (!normalizado) {
      atendimento = await store.atualizar(atendimento.id, {
        telefoneInformado: String(telefone || "").slice(0, 60),
        tentativasTelefone: atendimento.tentativasTelefone + 1,
      });

      if (atendimento.tentativasTelefone >= MAX_TELEFONE) {
        return encaminhar(atendimento, "telefone_invalido");
      }

      return { resultado: "telefone_invalido" };
    }

    atendimento = await store.atualizar(atendimento.id, {
      telefoneInformado: String(telefone).slice(0, 60),
      telefone: normalizado,
    });

    let encontrados;

    try {
      encontrados = await monday.buscarPorTelefone(normalizado, { conversa: true, prazo });
    } catch (error) {
      // Monday fora: guarda o telefone e segue a conversa; a busca é refeita depois.
      console.error("Busca na Monday falhou, seguindo a conversa:", error.code || error.message);
      await store.atualizar(atendimento.id, { buscaPendente: true, mondayItemId: null, mondayNome: null });
      return { resultado: "seguir", primeiro_nome: primeiroNome(atendimento.nomeWhatsapp) };
    }

    if (encontrados.length === 1) {
      const [item] = encontrados;
      await store.atualizar(atendimento.id, {
        mondayItemId: item.id,
        mondayNome: item.nome,
        buscaPendente: false,
      });
      return { resultado: "seguir", primeiro_nome: primeiroNome(item.nome || atendimento.nomeWhatsapp) };
    }

    if (encontrados.length > 1) {
      return encaminhar(atendimento, "cadastro_duplicado");
    }

    atendimento = await store.atualizar(atendimento.id, {
      tentativasTelefone: atendimento.tentativasTelefone + 1,
    });

    if (atendimento.tentativasTelefone >= MAX_NAO_ENCONTRADO) {
      return encaminhar(atendimento, "nao_encontrado");
    }

    return { resultado: "nao_encontrado" };
  });
}

// ---------- etapa 2: faturamento ----------

async function sessaoParaFaturamento(contatoId) {
  const atendimento = await getStore().atual(contatoId);

  if (!atendimento || atendimento.resultado || (!atendimento.mondayItemId && !atendimento.buscaPendente)) {
    return null;
  }

  return atendimento;
}

async function contarTentativa(atendimento, resposta) {
  const atualizado = await getStore().atualizar(atendimento.id, {
    tentativasFaturamento: atendimento.tentativasFaturamento + 1,
    valorPendente: null,
  });

  if (atualizado.tentativasFaturamento >= MAX_FATURAMENTO) {
    return encaminhar(atualizado, "faturamento_nao_informado");
  }

  return resposta;
}

async function receberFaturamento({ contatoId, resposta }) {
  const prazo = monday.prazoDaConversa();

  return emFila(contatoId, async () => {
    let atendimento = await sessaoParaFaturamento(contatoId);

    if (!atendimento) {
      return { resultado: "sem_sessao" };
    }

    atendimento = await getStore().atualizar(atendimento.id, {
      faturamentoTexto: String(resposta || "").slice(0, 200),
    });

    const interpretado = interpretarFaturamento(resposta);

    if (interpretado.tipo === "ok") {
      return finalizar(atendimento, interpretado.valor, prazo);
    }

    if (interpretado.tipo === "confirmar") {
      await getStore().atualizar(atendimento.id, { valorPendente: interpretado.valor });
      return { resultado: "confirmar_valor", valor_texto: formatarReais(interpretado.valor) };
    }

    if (interpretado.tipo === "pedir_media") {
      return contarTentativa(atendimento, { resultado: "pedir_media" });
    }

    return contarTentativa(atendimento, { resultado: "nao_entendi", motivo: interpretado.motivo });
  });
}

function respondeuSim(resposta) {
  const texto = String(resposta || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
  return /^(sim|s|isso|correto|certo|exato|yes|ok|1|true|confirmo)\b/.test(texto);
}

async function confirmarValor({ contatoId, resposta }) {
  const prazo = monday.prazoDaConversa();

  return emFila(contatoId, async () => {
    const atendimento = await sessaoParaFaturamento(contatoId);

    if (!atendimento || atendimento.valorPendente === null || atendimento.valorPendente === undefined) {
      return { resultado: "sem_sessao" };
    }

    if (respondeuSim(resposta)) {
      return finalizar(atendimento, atendimento.valorPendente, prazo);
    }

    return contarTentativa(atendimento, { resultado: "digitar_novamente" });
  });
}

// Grava o resultado. A pessoa só recebe "qualificada" ou "fora do perfil" depois
// que a Monday confirmou a gravação; se a Monday falhar, ela recebe a mensagem
// genérica ("registrado") e o reenvio em segundo plano termina o trabalho.
async function finalizar(atendimento, valor, prazo) {
  const store = getStore();
  const resultado = qualifica(valor) ? "qualificada" : "fora_do_perfil";

  atendimento = await store.atualizar(atendimento.id, {
    faturamentoValor: valor,
    valorPendente: null,
    faixa: faixaDoValor(valor),
    resultado,
    concluidoEm: new Date(),
    sync: "pendente",
    syncProxima: new Date(Date.now() + 60000), // a conversa tenta agora; o reenvio só depois
    // Qualificada recebe o link do Calendly e entra nos lembretes até agendar ou recusar.
    ...(resultado === "qualificada"
      ? { refAgendamento: agendamento.novaRef(), agendamento: "pendente", lembretes: 0, ultimoLembrete: null }
      : {}),
  });

  try {
    if (atendimento.buscaPendente) {
      const encontrados = await monday.buscarPorTelefone(atendimento.telefone, { conversa: true, prazo });

      if (encontrados.length !== 1) {
        return encaminhar(
          await store.atualizar(atendimento.id, { mondayItemId: null }),
          encontrados.length ? "cadastro_duplicado" : "nao_encontrado"
        );
      }

      atendimento = await store.atualizar(atendimento.id, {
        mondayItemId: encontrados[0].id,
        mondayNome: encontrados[0].nome,
        buscaPendente: false,
      });
    }

    await monday.atualizarCadastro(
      atendimento.mondayItemId,
      {
        faixa: atendimento.faixa,
        resultadoLabel: labelResultado(atendimento),
        ultimoContato: atendimento.concluidoEm,
        obs: obsDoResultado(atendimento),
      },
      { conversa: true, prazo }
    );

    await store.atualizar(atendimento.id, { etapaMonday: true, respostaEnviada: "resultado", syncProxima: null });
    agendarSincronizacao();
    return resultado === "qualificada"
      ? { resultado, link_agendamento: agendamento.linkAgendamento(atendimento) }
      : { resultado };
  } catch (error) {
    console.error("Gravação na Monday falhou, vai para o reenvio:", error.code || error.message);
    await store.atualizar(atendimento.id, {
      respostaEnviada: "generica",
      syncErro: error.message,
      syncProxima: null,
    });
    agendarSincronizacao();
    return { resultado: "registrado" };
  }
}

// ---------- textos para a equipe ----------

function comentarioMonday(atendimento) {
  const linhas = [`<b>📲 Pré-atendimento pelo WhatsApp (Mani)</b> — ${dataHoraBR(atendimento.concluidoEm || new Date())}`];

  if (atendimento.faturamentoValor !== null && atendimento.faturamentoValor !== undefined) {
    linhas.push(
      `Faturamento informado: "${telegram.escapeHtml(atendimento.faturamentoTexto)}" → ${formatarReais(atendimento.faturamentoValor)}`
    );
  } else if (atendimento.faturamentoTexto) {
    linhas.push(`Faturamento informado: "${telegram.escapeHtml(atendimento.faturamentoTexto)}" (não deu para entender)`);
  }

  if (atendimento.faixa) {
    linhas.push(`Faixa: ${telegram.escapeHtml(atendimento.faixa)}`);
  }

  if (atendimento.resultado === "qualificada") {
    linhas.push(
      atendimento.respostaEnviada === "generica"
        ? "Resultado: <b>Qualificada</b> — link de agendamento vai no lembrete do dia seguinte"
        : "Resultado: <b>Qualificada</b> — link de agendamento enviado"
    );
  } else if (atendimento.resultado === "fora_do_perfil") {
    linhas.push(`Resultado: Fora do perfil (faturamento abaixo de ${formatarReais(LIMITE_QUALIFICACAO)})`);
  } else {
    linhas.push(`Resultado: encaminhado para a equipe (${MOTIVOS[atendimento.motivo] || atendimento.motivo})`);
  }

  if (atendimento.whatsapp) {
    linhas.push(`WhatsApp da conversa: ${formatarTelefone(atendimento.whatsapp)}`);
  }

  if (atendimento.telefone) {
    linhas.push(`Telefone informado: ${formatarTelefone(atendimento.telefone)}`);
  }

  linhas.push("Origem: Pré-atendimento pelo WhatsApp");
  return linhas.join("<br>");
}

// Avisa a equipe só quando há algo a fazer: conversa encaminhada ou pessoa que
// recebeu só a mensagem genérica. Qualificada não avisa aqui: o aviso sai quando
// ela agendar a reunião no Calendly.
function precisaAviso(atendimento) {
  return atendimento.resultado === "encaminhado" || atendimento.respostaEnviada === "generica";
}

function avisoTelegram(atendimento) {
  const e = telegram.escapeHtml;
  const nome = atendimento.mondayNome || atendimento.nomeWhatsapp || "Sem nome";
  const linhas = [];

  if (atendimento.resultado === "qualificada") {
    linhas.push("✅ <b>Pré-atendimento: lead qualificada</b>");
  } else if (atendimento.resultado === "fora_do_perfil") {
    linhas.push("ℹ️ <b>Pré-atendimento: fora do perfil</b>");
  } else {
    linhas.push("⚠️ <b>Pré-atendimento: conferir cadastro</b>");
    linhas.push(`Motivo: ${e(MOTIVOS[atendimento.motivo] || atendimento.motivo)}`);
  }

  // O faturamento não vai para o grupo: fica só na Monday (faixa e atualização do cadastro).
  linhas.push(`👤 ${e(nome)}`);

  if (atendimento.whatsapp) {
    linhas.push(`📲 Responder no WhatsApp: ${formatarTelefone(atendimento.whatsapp)}`);
  }

  if (atendimento.telefone && atendimento.telefone !== atendimento.whatsapp) {
    linhas.push(`📞 Telefone da inscrição: ${formatarTelefone(atendimento.telefone)}`);
  } else if (!atendimento.telefone && atendimento.telefoneInformado) {
    linhas.push(`📞 Digitou: ${e(atendimento.telefoneInformado)}`);
  }

  linhas.push(`🗓 Pré-atendimento: ${dataHoraBR(atendimento.concluidoEm || new Date())}`);

  if (atendimento.respostaEnviada === "generica") {
    const link = agendamento.linkAgendamento(atendimento);
    linhas.push(
      atendimento.resultado === "qualificada"
        ? `❗ A Monday estava fora na hora: a pessoa recebeu só "recebemos suas informações", sem o link de agendamento. Ela recebe o link no lembrete de amanhã às ${config.lembretes.hora}h${link ? `, ou mande agora: ${e(link)}` : "."}`
        : atendimento.resultado === "fora_do_perfil"
          ? "❗ A Monday estava fora na hora: a pessoa recebeu só \"recebemos suas informações\". Falta responder que a consultoria ainda não é o momento."
          : "❗ A pessoa recebeu só \"recebemos suas informações\"."
    );
  }

  const link = monday.linkDoCadastro(atendimento.mondayItemId);

  if (link) {
    linhas.push(`🔗 ${e(link)}`);
  }

  return linhas.join("\n");
}

// ---------- reenvio em segundo plano ----------

async function sincronizar(atendimento) {
  const store = getStore();

  try {
    if (atendimento.buscaPendente && !atendimento.mondayItemId && atendimento.resultado !== "encaminhado") {
      const encontrados = await monday.buscarPorTelefone(atendimento.telefone);

      if (encontrados.length === 1) {
        atendimento = await store.atualizar(atendimento.id, {
          mondayItemId: encontrados[0].id,
          mondayNome: encontrados[0].nome,
          buscaPendente: false,
        });
      } else {
        atendimento = await store.atualizar(atendimento.id, {
          resultado: "encaminhado",
          motivo: encontrados.length ? "cadastro_duplicado" : "nao_encontrado",
          buscaPendente: false,
          etapaMonday: true,
          etapaComentario: true,
        });
      }
    }

    if (!atendimento.etapaMonday && atendimento.mondayItemId) {
      await monday.atualizarCadastro(atendimento.mondayItemId, {
        faixa: atendimento.faixa,
        resultadoLabel: labelResultado(atendimento),
        ultimoContato: atendimento.concluidoEm || new Date(),
        obs: obsDoResultado(atendimento),
      });
      atendimento = await store.atualizar(atendimento.id, { etapaMonday: true });
    }

    if (!atendimento.etapaComentario && atendimento.mondayItemId) {
      await monday.comentar(atendimento.mondayItemId, comentarioMonday(atendimento));
      atendimento = await store.atualizar(atendimento.id, { etapaComentario: true });
    }

    if (!atendimento.etapaTelegram) {
      if (precisaAviso(atendimento)) {
        await telegram.enviarAviso(avisoTelegram(atendimento));
      }
      atendimento = await store.atualizar(atendimento.id, { etapaTelegram: true });
    }

    await store.atualizar(atendimento.id, { sync: "ok", syncErro: null, syncProxima: null, syncBloqueio: null });
  } catch (error) {
    const tentativas = atendimento.syncTentativas + 1;
    const desistir = tentativas >= DESISTIR_APOS;
    const campos = {
      syncTentativas: tentativas,
      syncErro: error.message,
      syncProxima: proximaTentativa(error, tentativas),
      sync: desistir ? "falhou" : "pendente",
      syncBloqueio: null,
    };

    console.error(`Pré-atendimento ${atendimento.id}: tentativa ${tentativas} falhou:`, error.code || error.message);

    if ((tentativas >= ALERTAR_APOS || desistir) && !atendimento.alertaFalha) {
      try {
        await telegram.enviarAviso(
          [
            "🔴 <b>Pré-atendimento com falha</b>",
            `Não consegui gravar na Monday depois de ${tentativas} tentativas (${telegram.escapeHtml(error.message)}).`,
            `👤 ${telegram.escapeHtml(atendimento.mondayNome || atendimento.nomeWhatsapp || "Sem nome")}`,
            atendimento.whatsapp ? `📲 WhatsApp: ${formatarTelefone(atendimento.whatsapp)}` : null,
            desistir ? "Parei de tentar: confira manualmente." : "Os dados estão guardados e vou continuar tentando.",
          ]
            .filter(Boolean)
            .join("\n")
        );
        campos.alertaFalha = true;
      } catch (avisoErro) {
        console.error("Aviso de falha no Telegram também falhou:", avisoErro.message);
      }
    }

    await store.atualizar(atendimento.id, campos);
  }
}

let rodando = false;
let pedidoExtra = false;

async function processarPendentes() {
  if (rodando) {
    pedidoExtra = true;
    return;
  }

  rodando = true;

  try {
    do {
      pedidoExtra = false;
      const pendentes = await getStore().pendentes(new Date(), 20);

      for (const atendimento of pendentes) {
        await emFila(atendimento.contatoId, async () => {
          const atual = await getStore().atual(atendimento.contatoId);
          // Só sincroniza se ainda é a mesma conversa e continua pendente.
          const alvo = atual && atual.id === atendimento.id ? atual : atendimento;
          // Outra cópia do app pode estar cuidando dele: só segue quem reservar.
          if (alvo.sync === "pendente" && (await getStore().travarSync(alvo.id, new Date(Date.now() + 5 * 60000)))) {
            await sincronizar(alvo);
          }
        });
      }
    } while (pedidoExtra);
  } catch (error) {
    console.error("Reenvio do pré-atendimento falhou:", error.code || error.message);
  } finally {
    rodando = false;
  }
}

let timerAgendado = null;

// Roda a sincronização logo depois da resposta ao ManyChat (sem atrasar a conversa).
function agendarSincronizacao() {
  if (!config.workerEnabled || timerAgendado) {
    return;
  }

  timerAgendado = setTimeout(() => {
    timerAgendado = null;
    processarPendentes();
  }, 200);
  timerAgendado.unref?.();
}

function iniciarWorker(intervaloMs = 60000) {
  if (!config.workerEnabled) {
    return null;
  }

  processarPendentes();
  const timer = setInterval(processarPendentes, intervaloMs);
  timer.unref();
  return timer;
}

module.exports = {
  avisoTelegram,
  comentarioMonday,
  confirmarValor,
  iniciarWorker,
  processarPendentes,
  receberFaturamento,
  receberTelefone,
  respondeuSim,
};
