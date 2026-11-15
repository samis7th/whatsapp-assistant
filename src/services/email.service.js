const { config } = require("../config/env");

// E-mails de lembrete da aula mensal pelo Brevo (envio transacional com modelo). O texto
// fica no modelo, editável no Brevo; aqui só vão o destinatário e as variáveis do modelo:
// {{ params.NOME }}, {{ params.DATA_AULA }} e {{ params.LINK_AULA }}.
const URL_ENVIO = "https://api.brevo.com/v3/smtp/email";

let fetchImpl = (...args) => fetch(...args);

function setFetch(fn) {
  fetchImpl = fn;
}

class EmailError extends Error {}

function emailValido(email) {
  const texto = String(email || "").trim();
  return texto.length <= 254 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(texto);
}

// Modelo do Brevo para o lembrete (3dias, amanha, 1hora, aovivo); null = esse e-mail não sai.
function modeloDaAula(chave) {
  return config.brevo.apiKey ? config.brevo.modelosAula[chave] || null : null;
}

function primeiroNome(nome) {
  const primeiro = String(nome || "").trim().split(/\s+/)[0] || "";
  return primeiro ? primeiro[0].toUpperCase() + primeiro.slice(1).toLowerCase() : "";
}

async function enviarModelo({ email, nome, modeloId, params }) {
  let response;

  try {
    // A chave vai só no header e nunca aparece em logs.
    response = await fetchImpl(URL_ENVIO, {
      method: "POST",
      headers: { "api-key": config.brevo.apiKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        templateId: modeloId,
        to: [nome ? { email, name: String(nome).slice(0, 70) } : { email }],
        params,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new EmailError("Sem conexão com o Brevo.");
  }

  if (response.ok) {
    return;
  }

  const body = await response.json().catch(() => ({}));
  const error = new EmailError(`O Brevo recusou o e-mail (${response.status}): ${body.message || body.code || "sem detalhe"}`);
  error.status = response.status;
  // E-mail ou modelo inválido, chave errada: tentar de novo não resolve (para e avisa).
  // Limite de envio (429) e Brevo fora do ar (5xx) tentam de novo mais tarde.
  error.naoRepetir = response.status >= 400 && response.status < 500 && response.status !== 429;
  throw error;
}

// Etapa única de uma tarefa "aula_email".
async function executarEtapa(etapa, tarefa) {
  if (etapa !== "email") return;
  const { dados } = tarefa;
  await enviarModelo({ email: dados.email, nome: dados.nome, modeloId: dados.modeloId, params: dados.params });
}

module.exports = {
  EmailError,
  emailValido,
  enviarModelo,
  executarEtapa,
  modeloDaAula,
  primeiroNome,
  setFetch,
};
