const crypto = require("crypto");

const { config } = require("../config/env");

const CALENDLY_API_URL = "https://api.calendly.com";
// O Calendly recomenda recusar avisos assinados há mais de 3 minutos (evita reenvio de aviso antigo).
const TOLERANCIA_ASSINATURA_MS = 3 * 60 * 1000;
const EVENTOS = ["invitee.created", "invitee.canceled"];

class CalendlyError extends Error {}

let fetchImpl = (...args) => fetch(...args);

function setFetch(fn) {
  fetchImpl = fn;
}

function urlWebhook() {
  return `${config.publicOrigin}/calendly/webhook`;
}

// Header "Calendly-Webhook-Signature: t=<segundos>,v1=<hmac>", com
// hmac = HMAC-SHA256(segredo, "<t>.<corpo bruto>").
function assinaturaValida(cabecalho, corpoBruto, agora = Date.now()) {
  if (!config.calendly.webhookSecret || !cabecalho) {
    return false;
  }

  const partes = Object.fromEntries(
    String(cabecalho)
      .split(",")
      .map((parte) => parte.trim().split("="))
      .filter((par) => par.length === 2)
  );

  const t = Number(partes.t);

  if (!Number.isFinite(t) || !partes.v1 || Math.abs(agora - t * 1000) > TOLERANCIA_ASSINATURA_MS) {
    return false;
  }

  const esperada = crypto
    .createHmac("sha256", config.calendly.webhookSecret)
    .update(`${partes.t}.${corpoBruto}`)
    .digest("hex");

  const a = Buffer.from(esperada);
  const b = Buffer.from(String(partes.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function chamar(metodo, caminho, corpo) {
  let response;

  try {
    response = await fetchImpl(`${CALENDLY_API_URL}${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${config.calendly.token}`,
        "Content-Type": "application/json",
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new CalendlyError("Sem conexão com o Calendly.");
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // O Calendly explica o erro em "details" (qual parâmetro e por quê); vai para o log.
    const detalhes = (body.details || [])
      .map((item) => [item.parameter, item.message].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("; ");
    const error = new CalendlyError(
      `O Calendly recusou (${metodo} ${caminho.split("?")[0]}, HTTP ${response.status}): ` +
        `${body.message || body.title || "sem mensagem"}${detalhes ? ` [${detalhes}]` : ""}`
    );
    error.status = response.status;
    throw error;
  }

  return body;
}

async function assinaturaExistente(params) {
  const lista = await chamar("GET", `/webhook_subscriptions?${new URLSearchParams({ ...params, count: "100" })}`);
  return (lista.collection || []).find((item) => item.callback_url === urlWebhook()) || null;
}

// Registra no Calendly o endereço que recebe os agendamentos (uma vez só: se já
// existe uma assinatura para este endereço, não faz nada). Tenta no nível da
// organização (pega os eventos de todos da conta); se o Calendly não aceitar,
// registra no nível do usuário dono do token.
async function garantirWebhook() {
  if (!config.calendly.token || !config.calendly.webhookSecret) {
    return { status: "desligado" };
  }

  const eu = await chamar("GET", "/users/me");
  const organizacao = eu.resource?.current_organization;
  const usuario = eu.resource?.uri;

  const existente =
    (await assinaturaExistente({ organization: organizacao, scope: "organization" })) ||
    (await assinaturaExistente({ organization: organizacao, user: usuario, scope: "user" }));

  if (existente) {
    return { status: existente.state === "active" ? "ativo" : existente.state };
  }

  const base = { url: urlWebhook(), events: EVENTOS, organization: organizacao, signing_key: config.calendly.webhookSecret };

  try {
    await chamar("POST", "/webhook_subscriptions", { ...base, scope: "organization" });
    return { status: "criado (organização)" };
  } catch (erroOrganizacao) {
    if (erroOrganizacao.status !== 400 && erroOrganizacao.status !== 403) {
      throw erroOrganizacao;
    }

    console.error("Webhook no nível da organização recusado, tentando no do usuário:", erroOrganizacao.message);
    await chamar("POST", "/webhook_subscriptions", { ...base, user: usuario, scope: "user" });
    return { status: "criado (usuário)" };
  }
}

// "https://api.calendly.com/scheduled_events/<ID>" -> "/scheduled_events/<ID>".
function caminhoDoEvento(eventoUri) {
  const caminho = String(eventoUri || "").replace(CALENDLY_API_URL, "");
  if (!/^\/scheduled_events\/[\w-]+$/.test(caminho)) {
    throw new CalendlyError(`Endereço de evento inválido: ${eventoUri}`);
  }
  return caminho;
}

// Dados atuais do evento (ex.: o link do Meet, que pode demorar a ser gerado).
async function obterEvento(eventoUri) {
  const corpo = await chamar("GET", caminhoDoEvento(eventoUri));
  return corpo.resource || {};
}

// Cancela o evento no Calendly (a pessoa pediu pelo WhatsApp). O próprio Calendly
// avisa a pessoa por e-mail e manda o aviso de cancelamento (webhook) para cá.
async function cancelarEvento(eventoUri, motivo) {
  await chamar("POST", `${caminhoDoEvento(eventoUri)}/cancellation`, { reason: motivo });
}

// Convidados ativos do evento, no mesmo formato do aviso de agendamento (nome, e-mail,
// telefone, respostas e links de reagendar/cancelar).
async function listarConvidados(eventoUri) {
  const corpo = await chamar("GET", `${caminhoDoEvento(eventoUri)}/invitees?status=active&count=10`);
  return corpo.collection || [];
}

module.exports = {
  CalendlyError,
  cancelarEvento,
  listarConvidados,
  obterEvento,
  assinaturaValida,
  garantirWebhook,
  setFetch,
  urlWebhook,
};
