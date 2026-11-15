const crypto = require("crypto");
const { config } = require("../config/env");

// Leitura da agenda do consultor (Google Calendar) por uma conta de serviço do Google Cloud,
// com quem a agenda foi compartilhada só para ver ("Ver todos os detalhes do evento").
// A chave da conta (arquivo JSON) vem em GOOGLE_AGENDA_CHAVE, em base64. Só leitura:
// o sistema nunca cria, muda nem apaga eventos.
const ESCOPO = "https://www.googleapis.com/auth/calendar.readonly";
const URL_TOKEN = "https://oauth2.googleapis.com/token";
const URL_API = "https://www.googleapis.com/calendar/v3";

let fetchImpl = (...args) => fetch(...args);
let cacheToken = null;

function setFetch(fn) {
  fetchImpl = fn;
  cacheToken = null;
}

class AgendaError extends Error {}

function isConfigured() {
  return Boolean(config.agenda.contaServico);
}

const base64url = (valor) => Buffer.from(valor).toString("base64url");

// Token de acesso da conta de serviço (JWT assinado com a chave dela), guardado até
// 5 minutos antes de vencer.
async function token() {
  if (cacheToken && cacheToken.venceEm - Date.now() > 5 * 60000) {
    return cacheToken.valor;
  }

  const conta = config.agenda.contaServico;
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = base64url(JSON.stringify({ iss: conta.email, scope: ESCOPO, aud: URL_TOKEN, iat: agora, exp: agora + 3600 }));
  const assinatura = crypto.createSign("RSA-SHA256").update(`${cabecalho}.${corpo}`).sign(conta.chave, "base64url");

  let response;

  try {
    response = await fetchImpl(URL_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${cabecalho}.${corpo}.${assinatura}`,
      }).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new AgendaError("Sem conexão com o Google.");
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.access_token) {
    throw new AgendaError(`O Google recusou a chave da conta de serviço (${response.status}): ${body.error_description || body.error || "sem detalhe"}`);
  }

  cacheToken = { valor: body.access_token, venceEm: Date.now() + Number(body.expires_in || 3600) * 1000 };
  return cacheToken.valor;
}

async function chamar(caminho, parametros) {
  const url = `${URL_API}${caminho}?${new URLSearchParams(parametros).toString()}`;
  let response;

  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(20000) });
  } catch (error) {
    if (error instanceof AgendaError) throw error;
    throw new AgendaError("Sem conexão com o Google Agenda.");
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const motivo = body.error?.message || response.status;
    const error = new AgendaError(
      response.status === 404
        ? `A agenda ${config.agenda.id} não foi encontrada para a conta de serviço: confira se ela foi compartilhada com ${config.agenda.contaServico?.email}.`
        : `O Google Agenda recusou a leitura (${response.status}): ${motivo}`
    );
    error.status = response.status;
    throw error;
  }

  return body;
}

// Eventos da agenda entre `de` e `ate` (Date), um por ocorrência, inclusive os cancelados
// (status "cancelled"), para os lembretes acompanharem mudanças e cancelamentos.
async function listarEventos({ de, ate }) {
  const eventos = [];
  let pagina = null;

  do {
    const parametros = {
      timeMin: de.toISOString(),
      timeMax: ate.toISOString(),
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "250",
    };
    if (pagina) parametros.pageToken = pagina;

    const body = await chamar(`/calendars/${encodeURIComponent(config.agenda.id)}/events`, parametros);
    eventos.push(...(body.items || []));
    pagina = body.nextPageToken || null;
  } while (pagina && eventos.length < 2500);

  return eventos;
}

async function obterEvento(id) {
  return chamar(`/calendars/${encodeURIComponent(config.agenda.id)}/events/${encodeURIComponent(id)}`, {});
}

// Link do Google Meet do evento (o próprio, nunca um fabricado).
function linkDoMeet(evento) {
  const video = (evento.conferenceData?.entryPoints || []).find((e) => e.entryPointType === "video");
  return evento.hangoutLink || video?.uri || "";
}

module.exports = {
  AgendaError,
  isConfigured,
  linkDoMeet,
  listarEventos,
  obterEvento,
  setFetch,
};
