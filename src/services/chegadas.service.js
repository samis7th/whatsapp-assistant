const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataSP, horaSP } = require("../domain/datas");
const { formatarTelefone, normalizarTelefone } = require("../domain/telefone");
const telegram = require("./telegram.service");

// Ordem de chegada na Mani (link ou QR code da aula): o primeiro bloco do fluxo avisa
// aqui assim que a pessoa manda a mensagem, antes de qualquer pergunta. A contagem é
// por turma (AULA_DATA) e cada contato do WhatsApp conta uma vez só. A posição não é
// mostrada para a pessoa: só para a equipe (resumo diário no Telegram e painel).

// Resumo no grupo uma vez por dia, a partir das 8h (Brasília), com até 50 nomes.
const HORA_RESUMO = 8;
const MAX_NO_RESUMO = 20;

function turmaAtual() {
  return config.aula.data || "sem_turma";
}

async function registrarChegada({ contatoId, whatsapp, nome, agora = new Date() }) {
  await getStore().registrarChegada({
    turma: turmaAtual(),
    contatoId,
    whatsapp: normalizarTelefone(whatsapp) || null,
    nome: nome || null,
    em: agora,
  });

  return { resultado: "ok" };
}

// Lista da turma, na ordem, com o que a Mani descobriu depois (cadastro e resultado).
async function listar(turma = turmaAtual()) {
  const store = getStore();
  const chegadas = await store.chegadas(turma);
  const lista = [];

  for (const chegada of chegadas) {
    const atendimento = await store.atual(chegada.contatoId);
    lista.push({
      posicao: chegada.posicao,
      chegouEm: chegada.em,
      nomeWhatsapp: chegada.nome || "",
      whatsapp: chegada.whatsapp || "",
      nomeCadastro: atendimento?.mondayNome || "",
      telefoneCadastro: atendimento?.telefone || "",
      mondayItemId: atendimento?.mondayItemId || null,
      resultado: atendimento?.resultado || null,
      agendamento: atendimento?.agendamento || null,
    });
  }

  return { turma, total: lista.length, chegadas: lista };
}

function turmaTexto(turma) {
  const [, mes, dia] = String(turma).split("-");
  return dia ? `${dia}/${mes}` : "sem data";
}

// Texto do resumo: a lista da turma na ordem e quantos chegaram desde o resumo anterior.
function textoResumo({ turma, chegadas, novas }) {
  const e = telegram.escapeHtml;
  const total = chegadas.length;
  const linhas = [
    `📋 <b>Ordem de chegada na Mani · turma ${turmaTexto(turma)}</b>`,
    `${total} ${total === 1 ? "pessoa" : "pessoas"} até agora (+${novas} desde ontem às ${HORA_RESUMO}h).`,
    "",
  ];

  for (const item of chegadas.slice(0, MAX_NO_RESUMO)) {
    const telefone = item.whatsapp ? ` · ${formatarTelefone(item.whatsapp)}` : "";
    linhas.push(`${item.posicao}º ${e(item.nomeCadastro || item.nomeWhatsapp || "Sem nome")}${telefone}`);
  }

  if (total > MAX_NO_RESUMO) {
    linhas.push("", `…e mais ${total - MAX_NO_RESUMO}: veja a lista completa no painel (Ordem de chegada na Mani).`);
  }

  return linhas.join("\n");
}

// Roda a cada 5 minutos; a partir das 8h prepara o resumo do dia (uma vez só, mesmo com
// duas cópias do app). Sem ninguém novo nas últimas 24h, não manda nada.
async function rodarResumo(agora = new Date()) {
  if (!config.aula.data || horaSP(agora) < HORA_RESUMO) {
    return { status: "cedo" };
  }

  const store = getStore();
  const hoje = dataSP(agora);
  const chave = `chegadas_resumo:${hoje}`;

  if (await store.tarefaPorChave(chave)) {
    return { status: "ja_feito" };
  }

  const { turma, chegadas } = await listar();
  const desde = Date.parse(`${hoje}T${String(HORA_RESUMO).padStart(2, "0")}:00:00-03:00`) - 86400000;
  const novas = chegadas.filter((item) => new Date(item.chegouEm).getTime() >= desde).length;

  // A tarefa existe mesmo sem novidades: marca o dia como feito. O envio vai pela fila
  // de tarefas, que tenta de novo se o Telegram falhar.
  const tarefa = await store.criarTarefa({
    chave,
    tipo: "chegadas_resumo",
    dados: { texto: novas ? textoResumo({ turma, chegadas, novas }) : null },
  });

  if (tarefa.criada) {
    require("./agendamento.service").agendarProcessamento();
  }

  return { status: novas ? "enviado" : "sem_novidade", total: chegadas.length, novas };
}

function iniciar(intervaloMs = 5 * 60000) {
  if (!config.workerEnabled) {
    return;
  }

  const rodar = () => rodarResumo().catch((error) => console.error("Resumo das chegadas falhou:", error.message));
  rodar();
  setInterval(rodar, intervaloMs).unref();
}

module.exports = {
  iniciar,
  listar,
  registrarChegada,
  rodarResumo,
  turmaAtual,
};
