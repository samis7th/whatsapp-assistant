const { config } = require("../config/env");

class TelegramError extends Error {}

let fetchImpl = (...args) => fetch(...args);

// Últimos avisos mandados ao grupo (v3.1.0), para o painel. Só na memória: zera quando o
// app reinicia. Guarda o texto sem as tags HTML.
const HISTORICO_MAX = 200;
const historico = [];

function guardar(texto, ok, erro = null) {
  historico.push({
    em: new Date().toISOString(),
    ok,
    erro,
    texto: String(texto || "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").slice(0, 1500),
  });
  if (historico.length > HISTORICO_MAX) historico.splice(0, historico.length - HISTORICO_MAX);
}

// Mais recentes primeiro.
function ultimosAvisos(limite = 100) {
  return historico.slice(-limite).reverse();
}

function setFetch(fn) {
  fetchImpl = fn;
}

function isConfigured() {
  return Boolean(config.telegram.token && config.telegram.chatId);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Limite do Telegram é 4096: corta numa quebra de linha, para não partir uma tag HTML.
function cortar(texto, limite = 3800) {
  if (texto.length <= limite) return texto;
  const quebra = texto.lastIndexOf("\n", limite);
  return `${texto.slice(0, quebra > 0 ? quebra : limite)}\n…`;
}

// Aviso para o grupo da equipe. O token vai só na URL e nunca aparece em logs.
async function enviarAviso(texto) {
  if (!isConfigured()) {
    throw new TelegramError("Telegram não configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).");
  }

  let response;

  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: cortar(texto),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    guardar(texto, false, "Sem conexão com o Telegram.");
    throw new TelegramError("Sem conexão com o Telegram.");
  }

  const body = await response.json().catch(() => ({}));

  if (!body.ok) {
    const erro = `O Telegram recusou o aviso: ${body.description || response.status}`;
    guardar(texto, false, erro);
    throw new TelegramError(erro);
  }

  guardar(texto, true);
}

module.exports = {
  TelegramError,
  enviarAviso,
  escapeHtml,
  isConfigured,
  setFetch,
  ultimosAvisos,
};
