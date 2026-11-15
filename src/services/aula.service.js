const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataSP, horaMinutoSP } = require("../domain/datas");
const { normalizarTelefone } = require("../domain/telefone");
const agendamento = require("./agendamento.service");
const convites = require("./convites.service");
const email = require("./email.service");
const manychat = require("./manychat.service");
const monday = require("./monday.service");
const telegram = require("./telegram.service");

// Lembretes da aula no privado, para todos do quadro, menos
// as Etapas de AULA_ETAPAS_EXCLUIDAS: 3 dias antes, 1 dia antes e no dia (a partir das 10h),
// 1 hora antes (19h, com o link) e na hora da aula ("começou agora", das 20h às 21h,
// com o link de acesso). Cada inscrito
// recebe cada lembrete uma vez só. Os lembretes com modelo no Brevo (BREVO_MODELO_AULA_*)
// também saem por e-mail, no mesmo horário, para o e-mail da inscrição.
const TIPOS = [
  { chave: "3dias", dias: 3, rotulo: "faltam 3 dias", fluxo: () => config.manychat.flowAula.tresDias },
  // 2 dias antes: pedido para indicar a aula a uma amiga (modelo de Marketing, envio único,
  // para todos os inscritos, inclusive quem está no grupo).
  { chave: "amiga", dias: 2, rotulo: "convite para amiga", fluxo: () => config.manychat.flowAula.amiga },
  { chave: "amanha", dias: 1, rotulo: "é amanhã", fluxo: () => config.manychat.flowAula.amanha },
  // "É hoje" a partir das 10h e só até a aula começar.
  { chave: "hoje", dias: 0, rotulo: "é hoje", fluxo: () => config.manychat.flowAula.hoje, horaFim: () => config.aula.horaAula },
  {
    chave: "1hora",
    dias: 0,
    rotulo: "falta 1 hora, com o link",
    fluxo: () => config.manychat.flowAula.umaHora,
    // Na hora que antecede a aula; depois das 20h já sai o "começou agora".
    horaInicio: () => config.aula.horaAula - 1,
    horaFim: () => config.aula.horaAula,
    precisaLink: true,
  },
  {
    chave: "aovivo",
    dias: 0,
    rotulo: "começou agora, com o link",
    fluxo: () => config.manychat.flowAula.aoVivo,
    // Na primeira hora da aula; depois disso não faz sentido mandar.
    horaInicio: () => config.aula.horaAula,
    horaFim: () => config.aula.horaAula + 1,
    precisaLink: true,
  },
];

function diasAte(hojeIso, aulaIso) {
  return Math.round((Date.parse(`${aulaIso}T12:00:00Z`) - Date.parse(`${hojeIso}T12:00:00Z`)) / 86400000);
}

function faltaConfigurar() {
  const faltando = [];
  if (!config.manychat.apiKey) faltando.push("MANYCHAT_API_KEY");
  if (!config.aula.data) faltando.push("AULA_DATA");
  return faltando;
}

// Lembretes que podem sair agora (pelo dia e pela hora).
function devidos(agora) {
  const dias = diasAte(dataSP(agora), config.aula.data);
  const hora = horaMinutoSP(agora);

  return TIPOS.filter((tipo) => {
    if (tipo.dias !== dias) return false;
    const inicio = tipo.horaInicio ? tipo.horaInicio() : config.aula.horas[tipo.chave] ?? config.aula.horaLembrete;
    const fim = tipo.horaFim ? tipo.horaFim() : 24;
    return hora >= inicio && hora < fim;
  });
}

let varrendo = false;

// Marca de lembrete que ficou "em andamento" sem concluir (app derrubado no meio).
const MARCA_ABANDONADA_MS = 10 * 60000;

// Roda várias vezes por dia (a cada 5 min e no /cron/lembretes). Para cada lembrete
// devido, lê os inscritos na Monday uma vez e cria uma tarefa por pessoa; as tarefas
// criam o contato no ManyChat (se preciso) e disparam o fluxo daquele lembrete.
async function rodarLembretesAula(agora = new Date()) {
  if (faltaConfigurar().length) {
    return { status: "desligado" };
  }

  const dias = diasAte(dataSP(agora), config.aula.data);

  if (!TIPOS.some((tipo) => tipo.dias === dias)) {
    return { status: "sem_lembrete_hoje" };
  }

  const lista = devidos(agora);

  if (!lista.length) {
    return { status: "cedo" };
  }

  let resultado = null;

  for (const tipo of lista) {
    const atual = await varrer(tipo, agora);
    if (!resultado || resultado.status === "ja_feito") resultado = atual;
  }

  return resultado;
}

async function avisarUmaVez(chave, texto) {
  // criarTarefa só cria uma vez (mesmo com duas cópias do app): quem criou avisa.
  const marca = await getStore().criarTarefa({ chave, tipo: "aula_varredura" });
  if (!marca.criada) return;

  try {
    await telegram.enviarAviso(texto);
  } catch (error) {
    console.error("Aviso do lembrete da aula no Telegram falhou:", error.message);
  }
}

async function varrer(tipo, agora = new Date()) {
  const fluxo = tipo.fluxo();
  const modeloEmail = email.modeloDaAula(tipo.chave);

  if (!fluxo && !modeloEmail) {
    return { status: "sem_fluxo", tipo: tipo.chave };
  }

  if (tipo.precisaLink && !config.aula.link) {
    await avisarUmaVez(
      `aula_alerta_link:${config.aula.data}:${tipo.chave}`,
      `⚠️ <b>O lembrete "${tipo.rotulo}" não saiu</b>\nFalta o link da aula: coloque em <code>AULA_LINK</code> na Hostinger e reinicie o app (ainda dá tempo até as ${tipo.horaFim()}h).`
    );
    return { status: "sem_link", tipo: tipo.chave };
  }

  const store = getStore();
  const marca = `aula_varredura:${config.aula.data}:${tipo.chave}`;

  if (varrendo) {
    return { status: "ja_feito", tipo: tipo.chave };
  }

  // A marca do lembrete é reservada no começo (só uma cópia do app faz a leitura). Se
  // algo falhar no meio, ela é apagada; se o app for derrubado no meio (sem chance de
  // apagar), uma marca não concluída há mais de 10 minutos é retomada.
  const reserva = await store.criarTarefa({ chave: marca, tipo: "aula_varredura", dados: { iniciadoEm: Date.now() } });

  if (!reserva.criada) {
    const dadosMarca = reserva.dados || {};
    const abandonada =
      dadosMarca.iniciadoEm && !dadosMarca.concluido && Date.now() - dadosMarca.iniciadoEm > MARCA_ABANDONADA_MS;

    if (!abandonada) {
      return { status: "ja_feito", tipo: tipo.chave };
    }

    await store.atualizarTarefa(reserva.id, { dados: { iniciadoEm: Date.now(), retomada: true } });
  }

  varrendo = true;
  let concluiu = false;

  try {
    const turma = convites.turma();
    const inscritos = await monday.listarInscritosAula();

    // Campos do bot usados nos textos: a data ("vai ser dia 29/10") e o link da aula.
    if (fluxo) {
      await manychat.definirCampoBot("data_aula", turma.texto);
      // "20h" ou "19h30" (AULA_HORA), para os modelos com o horário da aula.
      await manychat.tentarCampoBot("hora_aula", convites.textoHora(config.aula.horaAula));

      if (tipo.precisaLink) {
        await manychat.tentarCampoBot("link_aula", config.aula.link);
      }
    }

    let novos = 0;
    let emails = 0;
    const emailsVistos = new Set();
    let semTelefone = 0;
    let naoQuerem = 0;
    let semAvisos = 0;
    let noGrupo = 0;
    const vistos = new Set();

    // Etapa do Funil que não recebe avisos (ex.: "Não quer receber mensagens", pelo botão
    // ou pela equipe; "Deixou de ser cliente"). Com cadastro duplicado, a etapa de qualquer
    // um vale para o telefone e para o e-mail.
    const excluidas = new Set(config.monday.etapasSemAvisos);
    const naoQuer = (inscrito) => inscrito.etapa === config.monday.labels.naoQuerMensagens;
    const foraDosAvisos = inscritos.filter((inscrito) => excluidas.has(inscrito.etapa));
    const telefonesDe = (lista) => new Set(lista.map((inscrito) => normalizarTelefone(inscrito.telefone)).filter(Boolean));
    const naoQuerMensagens = telefonesDe(foraDosAvisos.filter(naoQuer));
    const telefonesSemAvisos = telefonesDe(foraDosAvisos);
    const emailsSemAvisos = new Set(foraDosAvisos.map((inscrito) => inscrito.email.toLowerCase()).filter(Boolean));
    // Opcional (AULA_PULAR_NO_GRUPO): este lembrete não vai para quem está no grupo,
    // marcado pela conferência do painel (Marcar na Monday).
    const estaoNoGrupo = config.aula.pularNoGrupo.has(tipo.chave)
      ? telefonesDe(inscritos.filter((inscrito) => inscrito.grupo === config.monday.labels.noGrupo))
      : new Set();

    for (const inscrito of inscritos) {
      const telefone = normalizarTelefone(inscrito.telefone);
      const enderecoEmail = inscrito.email.toLowerCase();

      // E-mail: um por endereço, mesmo sem telefone válido.
      if (
        modeloEmail &&
        email.emailValido(enderecoEmail) &&
        !emailsVistos.has(enderecoEmail) &&
        !emailsSemAvisos.has(enderecoEmail) &&
        !(telefone && telefonesSemAvisos.has(telefone))
      ) {
        emailsVistos.add(enderecoEmail);
        const tarefaEmail = await store.criarTarefa({
          chave: `aula_email:${config.aula.data}:${tipo.chave}:${enderecoEmail}`,
          tipo: "aula_email",
          dados: {
            nome: inscrito.nome,
            email: enderecoEmail,
            telefone: telefone || null,
            mondayItemId: inscrito.id,
            modeloId: modeloEmail,
            params: {
              NOME: email.primeiroNome(inscrito.nome),
              DATA_AULA: turma.texto,
              HORA_AULA: convites.textoHora(config.aula.horaAula),
              LINK_AULA: config.aula.link || "",
            },
          },
        });

        if (tarefaEmail.criada) emails++;
      }

      if (!fluxo) continue;

      if (!telefone) {
        semTelefone++;
        continue;
      }

      if (vistos.has(telefone)) continue;
      vistos.add(telefone);

      if (naoQuerMensagens.has(telefone)) {
        naoQuerem++;
        continue;
      }

      if (telefonesSemAvisos.has(telefone)) {
        semAvisos++;
        continue;
      }

      if (estaoNoGrupo.has(telefone)) {
        noGrupo++;
        continue;
      }

      const tarefa = await store.criarTarefa({
        chave: `aula:${config.aula.data}:${tipo.chave}:${telefone}`,
        tipo: "aula_lembrete",
        dados: {
          nome: inscrito.nome,
          telefone,
          mondayItemId: inscrito.id,
          etiqueta: turma.etiqueta,
          flowNs: fluxo,
          // Gravado também no campo link_aula do contato antes do envio.
          link: tipo.precisaLink ? config.aula.link : null,
        },
      });

      if (tarefa.criada) novos++;
    }

    // Quem ficou de fora vai junto do resumo final ("concluído"), numa mensagem só
    // (v2.13.0). Sem WhatsApp configurado, vai no resumo dos e-mails.
    const resumo = [
      `👥 Turma de ${turma.texto}`,
      semTelefone ? `${semTelefone} sem telefone válido ficaram de fora.` : null,
      noGrupo ? `${noGrupo} já ${noGrupo === 1 ? "está" : "estão"} no grupo (recebem por lá).` : null,
      naoQuerem ? `${naoQuerem} não ${naoQuerem === 1 ? "quer" : "querem"} receber mensagens.` : null,
      semAvisos ? `${semAvisos} fora pela Etapa do Funil (ex.: deixou de ser cliente, aguardando pagamento).` : null,
    ].filter(Boolean);

    concluiu = true;
    await store.atualizarTarefa(reserva.id, {
      dados: {
        iniciadoEm: Date.now(),
        concluido: true,
        inscritos: vistos.size,
        novos,
        ...(modeloEmail ? { emails } : {}),
        resumo,
        resumoEm: fluxo ? "aula_lembrete" : "aula_email",
      },
    });
    await agendamento.fecharLoteDe("aula_lembrete", "aula", config.aula.data, tipo.chave);
    await agendamento.fecharLoteDe("aula_email", "aula_email", config.aula.data, tipo.chave);

    // Nada entrou na fila: não haverá resumo "concluído", então avisa agora.
    if (!novos && !emails) {
      try {
        await telegram.enviarAviso([`📣 <b>Lembrete da aula (${tipo.rotulo})</b>: nenhum envio novo.`, ...resumo].join("\n"));
      } catch (error) {
        console.error("Resumo do lembrete da aula no Telegram falhou:", error.message);
      }
    }

    agendamento.agendarProcessamento();
    return { status: "enviado", tipo: tipo.chave, novos, semTelefone, ...(modeloEmail ? { emails } : {}) };
  } finally {
    varrendo = false;

    if (!concluiu) {
      await store.removerTarefa(marca);
    }
  }
}

function iniciar(intervaloMs = 5 * 60000) {
  if (!config.workerEnabled) {
    return;
  }

  const rodar = () => rodarLembretesAula().catch((error) => console.error("Lembretes da aula falharam:", error.message));
  rodar();
  setInterval(rodar, intervaloMs).unref();
}

module.exports = {
  diasAte,
  faltaConfigurar,
  iniciar,
  rodarLembretesAula,
};
