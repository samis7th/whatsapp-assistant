const { config } = require("../config/env");
const { normalizarTelefone, variantesTelefone } = require("../domain/telefone");

// API do ManyChat (plano Pro): cria contatos a partir das inscrições, coloca
// etiquetas, atualiza campos e dispara fluxos (convites e lembretes). O resto da
// conversa é o ManyChat chamando este sistema.
const MANYCHAT_API_URL = "https://api.manychat.com";

class ManychatError extends Error {}

let fetchImpl = (...args) => fetch(...args);

function setFetch(fn) {
  fetchImpl = fn;
  cacheCampoWhatsapp = null;
}

// Lembretes de agendamento disparados por aqui (opcional; o padrão é o fluxo pedir).
function isConfigured() {
  return Boolean(config.manychat.apiKey && config.manychat.flowLembrete);
}

async function chamar(caminho, corpo, { metodo = "POST" } = {}) {
  if (!config.manychat.apiKey) {
    throw new ManychatError("ManyChat não configurado (MANYCHAT_API_KEY).");
  }

  let response;

  try {
    response = await fetchImpl(`${MANYCHAT_API_URL}${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${config.manychat.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: metodo === "GET" ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ManychatError("Sem conexão com o ManyChat.");
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.status !== "success") {
    // A mensagem geral ("Validation error") mais os detalhes, que dizem o porquê.
    const detalhes = Array.isArray(body.details?.messages)
      ? body.details.messages.map((item) => item?.message || JSON.stringify(item)).join("; ")
      : body.details
        ? JSON.stringify(body.details)
        : "";
    const detalhe =
      [body.message, detalhes].filter(Boolean).join(" — ").slice(0, 400) || String(response.status);
    const error = new ManychatError(`O ManyChat recusou (${caminho.split("?")[0]}): ${detalhe}`);
    error.status = response.status;
    throw error;
  }

  return body.data;
}

// Grava um campo do contato (ex.: o link de agendamento usado no lembrete).
async function definirCampo(contatoId, campo, valor) {
  await chamar("/fb/subscriber/setCustomFieldByName", {
    subscriber_id: Number(contatoId),
    field_name: campo,
    field_value: valor,
  });
}

// Dados do contato pelo ID (nome, telefone do WhatsApp, campos).
async function obterContato(contatoId) {
  return chamar(`/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(contatoId)}`, null, { metodo: "GET" });
}

// Campo do bot (vale para a conta toda), ex.: data_aula = "29/10".
async function definirCampoBot(campo, valor) {
  await chamar("/fb/page/setBotFieldByName", { field_name: campo, field_value: valor });
}

// O link da aula pode estar num campo do bot ou num campo do contato (o modelo
// aula_comecou foi aprovado com o do contato). Grava onde existir; campo que não
// existe no ManyChat é pulado em vez de travar o envio.
async function seExistir(gravar) {
  try {
    await gravar();
    return true;
  } catch (error) {
    if (/does not exist/i.test(error.message)) return false;
    throw error;
  }
}

function tentarCampoBot(campo, valor) {
  return seExistir(() => definirCampoBot(campo, valor));
}

function tentarCampo(contatoId, campo, valor) {
  return seExistir(() => definirCampo(contatoId, campo, valor));
}

async function adicionarEtiqueta(contatoId, etiqueta) {
  await chamar("/fb/subscriber/addTagByName", { subscriber_id: Number(contatoId), tag_name: etiqueta });
}

// Etiqueta da turma que não existe no ManyChat não trava o envio do lembrete.
function tentarEtiqueta(contatoId, etiqueta) {
  return seExistir(() => adicionarEtiqueta(contatoId, etiqueta));
}

// Dispara um fluxo do ManyChat para o contato.
async function enviarFluxo(contatoId, flowNs) {
  if (!flowNs) {
    throw new ManychatError("Fluxo do ManyChat não configurado.");
  }

  await chamar("/fb/sending/sendFlow", {
    subscriber_id: Number(contatoId),
    flow_ns: flowNs,
  });
}

function partesDoNome(nome) {
  const partes = String(nome || "").trim().split(/\s+/).filter(Boolean);
  return { first_name: partes[0] || "Inscrito", last_name: partes.slice(1).join(" ") };
}

// ID do campo do usuário com o WhatsApp (procurado pelo nome; guardado em memória).
let cacheCampoWhatsapp = null;

async function idCampoWhatsapp() {
  if (cacheCampoWhatsapp && Date.now() - cacheCampoWhatsapp.em < 10 * 60000) {
    return cacheCampoWhatsapp.id;
  }

  const campos = await chamar("/fb/page/getCustomFields", null, { metodo: "GET" });
  const campo = (Array.isArray(campos) ? campos : []).find(
    (item) => String(item.name || "").toLowerCase() === config.manychat.campoWhatsapp.toLowerCase()
  );
  cacheCampoWhatsapp = { em: Date.now(), id: campo ? campo.id : null };
  return cacheCampoWhatsapp.id;
}

// Procura o contato pelo campo do usuário com o WhatsApp (o campo do sistema não é
// pesquisável pela API). Tenta o número com e sem "+" e com e sem o 9 da frente.
async function buscarPorCampoWhatsapp(telefoneE164) {
  const campoId = await idCampoWhatsapp();

  if (!campoId) {
    return null;
  }

  const valores = variantesTelefone(telefoneE164).flatMap((telefone) => [telefone.slice(1), telefone]);

  for (const valor of valores) {
    try {
      const data = await chamar(
        `/fb/subscriber/findByCustomField?field_id=${encodeURIComponent(campoId)}&field_value=${encodeURIComponent(valor)}`,
        null,
        { metodo: "GET" }
      );
      const contato = Array.isArray(data) ? data[0] : data;
      if (contato?.id) return String(contato.id);
    } catch (error) {
      if (error.status !== 400 && error.status !== 404) throw error;
    }
  }

  return null;
}

// Procura pelo telefone (com e sem o 9 da frente); null se não achar.
async function buscarPorTelefone(telefoneE164) {
  for (const telefone of variantesTelefone(telefoneE164)) {
    try {
      const data = await chamar(`/fb/subscriber/findBySystemField?phone=${encodeURIComponent(telefone)}`, null, {
        metodo: "GET",
      });
      const contato = Array.isArray(data) ? data[0] : data;
      if (contato?.id) return String(contato.id);
    } catch (error) {
      if (error.status !== 400 && error.status !== 404) throw error;
    }
  }

  return null;
}

// Último recurso para contato antigo (a API não acha pelo número): procura pelo nome da
// inscrição e só aceita o contato cujo WhatsApp (whatsapp_phone) é o mesmo número. Nome
// diferente no ManyChat: não acha e o contato segue pulado.
async function buscarPorNome(telefoneE164, nome) {
  const alvo = new Set(variantesTelefone(telefoneE164));
  // "Dra. Juliana Alves" / "Everton (Marido da Dra. Marcella)": a equipe cadastra com
  // título e anotação; no ManyChat fica o nome do perfil. Tenta o nome como está e sem eles.
  const original = String(nome || "").trim().split(/\s+/).filter(Boolean);
  const limpo = String(nome || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/(^|\s)(dra?|dr\.?a?)\.?(?=\s)/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const nomes = [
    ...new Set([original.join(" "), limpo.join(" "), limpo.slice(0, 2).join(" "), limpo[0]]),
  ].filter((n) => n && n.length >= 3 && !/^dra?\.?$/i.test(n));
  let leituras = 0;

  for (const n of nomes) {
    let lista;
    try {
      lista = await chamar(`/fb/subscriber/findByName?name=${encodeURIComponent(n)}`, null, { metodo: "GET" });
    } catch (error) {
      if (error.status !== 400 && error.status !== 404) throw error;
      continue;
    }

    for (const contato of (Array.isArray(lista) ? lista : [lista]).filter((c) => c?.id)) {
      let whatsapp = contato.whatsapp_phone;
      // A busca pode não trazer o WhatsApp: lê o contato (no máximo 20 leituras por busca).
      if (whatsapp === undefined && leituras < 20) {
        leituras++;
        whatsapp = (await obterContato(contato.id))?.whatsapp_phone;
      }
      if (whatsapp && alvo.has(normalizarTelefone(String(whatsapp)))) return String(contato.id);
    }
  }

  return null;
}

// Cria o contato de WhatsApp a partir da inscrição (ou acha o que já existe).
// Devolve o ID do contato no ManyChat.
async function garantirContato({ telefoneE164, nome }) {
  try {
    const data = await chamar("/fb/subscriber/createSubscriber", {
      ...partesDoNome(nome),
      whatsapp_phone: telefoneE164,
      has_opt_in_sms: false,
      has_opt_in_email: false,
    });

    if (data?.id) {
      return String(data.id);
    }

    throw new ManychatError("O ManyChat não devolveu o ID do contato criado.");
  } catch (error) {
    // Já existe (ou outro motivo): tenta achar pelo telefone antes de desistir.
    if (error.status !== 400) throw error;
    const existente =
      (await buscarPorTelefone(telefoneE164)) ||
      (await buscarPorCampoWhatsapp(telefoneE164)) ||
      (/already exists/i.test(error.message) ? await buscarPorNome(telefoneE164, nome) : null);
    if (existente) return existente;

    // Erro de dados: tentar de novo não resolve. "Já existe" é quem já conversou com o
    // número antes (a API não informa o ID): decisão da equipe é pular essas pessoas em
    // silêncio. Outros erros de dados param a tarefa e avisam o grupo.
    const definitivo = new ManychatError(`${error.message} (contato ${telefoneE164} não encontrado pela API)`);
    definitivo.naoRepetir = true;
    definitivo.contatoExistente = /already exists/i.test(error.message);
    throw definitivo;
  }
}

module.exports = {
  ManychatError,
  adicionarEtiqueta,
  buscarPorCampoWhatsapp,
  buscarPorNome,
  buscarPorTelefone,
  definirCampo,
  definirCampoBot,
  enviarFluxo,
  garantirContato,
  obterContato,
  isConfigured,
  setFetch,
  tentarCampo,
  tentarCampoBot,
  tentarEtiqueta,
};
