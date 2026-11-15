const { config } = require("../config/env");
const telegram = require("./telegram.service");

// Vigia cruzada (v2.14.0): a cada 5 minutos a Mani confere se a API de inscrições está no
// ar (e com o banco). A API faz o mesmo com a Mani. Se uma cair, a outra avisa no
// Telegram; quando voltar, avisa de novo. Duas falhas seguidas (cerca de 10 minutos) antes
// do aviso, para os reinícios rápidos da Hostinger não virarem alarme.
// VIGIA_URL=off desliga.

const FALHAS_PARA_AVISAR = 2;
const TIMEOUT_MS = 15000;

let fetchImpl = (...args) => fetch(...args);
const estado = { falhas: 0, avisado: false, desde: null, motivo: "" };

function setFetch(fn) {
  fetchImpl = fn;
}

function reiniciarEstado() {
  Object.assign(estado, { falhas: 0, avisado: false, desde: null, motivo: "" });
}

const hora = (data) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: config.timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(data);

// No ar = responde 200 com "ok": true (o /health/db da API só responde assim com o banco).
async function conferir(url) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const corpo = await response.json().catch(() => ({}));
    if (response.ok && corpo.ok === true) return { ok: true };
    return { ok: false, motivo: `respondeu ${response.status}${corpo.database === "unavailable" ? ", banco fora" : ""}` };
  } catch (error) {
    return { ok: false, motivo: error.name === "TimeoutError" ? "não respondeu em 15 s" : "sem conexão" };
  }
}

async function avisar(texto) {
  try {
    await telegram.enviarAviso(texto);
  } catch (error) {
    console.error("Aviso da vigia no Telegram falhou:", error.message);
  }
}

async function rodar(agora = new Date()) {
  const { url, nome } = config.vigia;
  if (!url) return { status: "desligado" };

  const r = await conferir(url);

  if (r.ok) {
    const voltou = estado.avisado;
    const desde = estado.desde;
    reiniciarEstado();
    if (voltou) await avisar(`✅ <b>${nome} voltou ao ar</b>\nFora desde ${hora(desde)}.`);
    return { status: voltou ? "voltou" : "ok" };
  }

  estado.falhas++;
  estado.desde = estado.desde || agora;
  estado.motivo = r.motivo;
  console.error(`Vigia: ${nome} fora (${r.motivo}), falha ${estado.falhas}.`);

  if (estado.falhas >= FALHAS_PARA_AVISAR && !estado.avisado) {
    estado.avisado = true;
    await avisar(
      `🔴 <b>${nome} fora do ar</b>\nDesde ${hora(estado.desde)} (${r.motivo}).\nConfira na Hostinger. Aviso de novo quando voltar.`
    );
    return { status: "avisado" };
  }

  return { status: "fora", falhas: estado.falhas };
}

function iniciar(intervaloMs = 5 * 60000) {
  if (!config.workerEnabled || !config.vigia.url) return;
  const executar = () => rodar().catch((error) => console.error("Vigia falhou:", error.message));
  setTimeout(executar, 60000).unref();
  setInterval(executar, intervaloMs).unref();
}

module.exports = { iniciar, reiniciarEstado, rodar, setFetch };
