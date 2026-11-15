const { config } = require("../config/env");
const { getStore } = require("../db");
const { normalizarTelefone } = require("../domain/telefone");
const manychat = require("./manychat.service");

// Convite para o grupo da aula, mandado pela Mani no privado de quem se inscreveu
// e não entrou no grupo. A lista vem do "Conferir grupo" do painel de inscritos.
const MAX_POR_ENVIO = 1000;

class ConviteError extends Error {}

// "2026-10-29" -> etiqueta "aula_2910" e texto "29/10" (campo do bot data_aula).
function turma() {
  const [, mes, dia] = config.aula.data.split("-");
  return { chave: config.aula.data, etiqueta: `aula_${dia}${mes}`, texto: `${dia}/${mes}` };
}

// 20 -> "20h"; 19.5 -> "19h30".
function textoHora(hora) {
  const h = Math.floor(hora);
  const m = Math.round((hora - h) * 60);
  return `${h}h${m ? String(m).padStart(2, "0") : ""}`;
}

function faltaConfigurar() {
  const faltando = [];
  if (!config.manychat.apiKey) faltando.push("MANYCHAT_API_KEY");
  if (!config.manychat.flowConvite) faltando.push("MANYCHAT_FLOW_CONVITE");
  if (!config.aula.data) faltando.push("AULA_DATA");
  return faltando;
}

// Recebe a lista e cria uma tarefa por pessoa. Cada telefone recebe no máximo um
// convite por turma, mesmo que a lista seja enviada de novo.
async function receberConvites(pessoas) {
  const faltando = faltaConfigurar();

  if (faltando.length) {
    const error = new ConviteError(`Convites desligados: falta configurar ${faltando.join(", ")} na Hostinger.`);
    error.status = 503;
    throw error;
  }

  if (!Array.isArray(pessoas) || !pessoas.length || pessoas.length > MAX_POR_ENVIO) {
    const error = new ConviteError(`Mande de 1 a ${MAX_POR_ENVIO} pessoas por vez.`);
    error.status = 400;
    throw error;
  }

  const store = getStore();
  const t = turma();

  // A data que aparece no texto do modelo ("vai ser dia 29/10").
  await manychat.definirCampoBot("data_aula", t.texto);

  const resultado = { novos: 0, jaEnviados: 0, invalidos: 0 };
  const vistos = new Set();

  for (const pessoa of pessoas) {
    const telefone = normalizarTelefone(pessoa?.telefone);

    if (!telefone) {
      resultado.invalidos++;
      continue;
    }

    if (vistos.has(telefone)) continue;
    vistos.add(telefone);

    const tarefa = await store.criarTarefa({
      chave: `convite:${t.chave}:${telefone}`,
      tipo: "convite",
      dados: {
        nome: String(pessoa.nome || "").slice(0, 120),
        telefone,
        mondayItemId: pessoa.mondayItemId ? String(pessoa.mondayItemId).slice(0, 20) : null,
        etiqueta: t.etiqueta,
      },
    });

    if (tarefa.criada) {
      resultado.novos++;
    } else {
      resultado.jaEnviados++;
    }
  }

  return { ...resultado, turma: t.texto };
}

// Etapas de uma tarefa "convite": acha/cria o contato, etiqueta da turma, dispara o fluxo.
const ETAPAS = ["contato", "etiqueta", "fluxo"];
const etiquetasFaltando = new Set();

async function executarEtapa(etapa, tarefa) {
  const store = getStore();
  const dados = tarefa.dados;

  if (etapa === "contato") {
    let contatoId = await store.contatoManychat(dados.telefone);

    if (!contatoId) {
      contatoId = await manychat.garantirContato({ telefoneE164: dados.telefone, nome: dados.nome });
      await store.salvarContatoManychat(dados.telefone, contatoId);
    }

    dados.contatoId = String(contatoId);
  } else if (etapa === "etiqueta") {
    const marcou = await manychat.tentarEtiqueta(dados.contatoId, dados.etiqueta);

    if (!marcou && !etiquetasFaltando.has(dados.etiqueta)) {
      etiquetasFaltando.add(dados.etiqueta);
      console.warn(`Etiqueta "${dados.etiqueta}" não existe no ManyChat: os avisos saem sem ela (crie a etiqueta para marcar a turma).`);
    }
  } else if (etapa === "link") {
    // Lembretes com o link da aula ("1 hora" e "começou agora").
    if (dados.link) await manychat.tentarCampo(dados.contatoId, "link_aula", dados.link);
  } else if (etapa === "fluxo") {
    // Lembretes da aula guardam o fluxo do dia; o convite usa o fluxo do convite.
    await manychat.enviarFluxo(dados.contatoId, dados.flowNs || config.manychat.flowConvite);
  }
}

module.exports = {
  ConviteError,
  ETAPAS,
  executarEtapa,
  faltaConfigurar,
  receberConvites,
  textoHora,
  turma,
};
