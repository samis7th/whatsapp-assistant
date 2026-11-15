// Guarda as últimas linhas do log para a tela "Sistema" do painel (antes de tudo,
// para pegar também os avisos da configuração).
require("./utils/registro").instalar();

const app = require("./app");
const { config } = require("./config/env");
const { getStore } = require("./db");
const agendamento = require("./services/agendamento.service");
const aula = require("./services/aula.service");
const calendly = require("./services/calendly.service");
const chegadas = require("./services/chegadas.service");
const agendaDia = require("./services/agenda-dia.service");
const vigia = require("./services/vigia.service");
const privacidade = require("./services/privacidade.service");
const lives = require("./services/lives.service");
const disparo = require("./services/disparo.service");
const mentoria = require("./services/mentoria.service");
const reunioesAgenda = require("./services/reunioes-agenda.service");
const convites = require("./services/convites.service");
const manychat = require("./services/manychat.service");
const { iniciarWorker } = require("./services/preatendimento.service");

const PORT = process.env.PORT || 3000;
const RETRY_MS = 30000;

const server = app.listen(PORT, "0.0.0.0", () => {
  const ok = (valor) => (valor ? "configurado" : "SEM configuração");
  console.log(`Acme Pré-atendimento running on port ${PORT}`);
  console.log(
    `Monday: ${config.monday.token ? "token configurado" : "SEM token"} · Telegram: ${ok(config.telegram.token && config.telegram.chatId)}` +
      ` · Calendly: ${ok(config.calendly.url)} · Lembretes (ManyChat API): ${ok(manychat.isConfigured())}` +
      ` · Convites: ${ok(!convites.faltaConfigurar().length && config.internoSecret)}${config.aula.data ? ` (aula ${config.aula.data})` : ""}` +
      ` · Lembretes da aula: ${ok(!aula.faltaConfigurar().length)} (fluxos: 3 dias ${ok(config.manychat.flowAula.tresDias)}, amiga ${ok(config.manychat.flowAula.amiga)}, amanhã ${ok(config.manychat.flowAula.amanha)}, hoje ${ok(config.manychat.flowAula.hoje)}, 1 hora antes ${ok(config.manychat.flowAula.umaHora)}, ao vivo ${ok(config.manychat.flowAula.aoVivo)}; link da aula ${ok(config.aula.link)})` +
      ` · Lembretes da reunião: véspera ${ok(config.manychat.flowReuniao.vespera)}, dia ${ok(config.manychat.flowReuniao.diaConfirmar)}/${ok(config.manychat.flowReuniao.diaConfirmado)}, reagendada ${ok(config.manychat.flowReuniao.reagendada)}, cancelada ${ok(config.manychat.flowReuniao.cancelada)}` +
      ` · Lembretes das lives (${config.lives.datas.join(", ") || "sem data"}): véspera ${ok(config.manychat.flowLive.vespera)}, 1 hora ${ok(config.manychat.flowLive.umaHora)}, começou ${ok(config.manychat.flowLive.comecou)}` +
      ` · Sorteio das mentorias: ${config.sorteio.inicio ? `desde ${config.sorteio.inicio}, ${mentoria.faltaConfigurar().length ? `falta ${mentoria.faltaConfigurar().join(", ")}` : "configurado"}` : "SEM SORTEIO_INICIO (desligado)"}` +
      ` · Disparo único: ${config.disparo.data ? `${config.disparo.data} às ${config.disparo.hora}h, fluxo ${ok(config.manychat.flowDisparo)}` : "sem data"}` +
      ` · Agenda do consultor (Google): ${config.agenda.contaServico ? `configurado (${config.agenda.id})` : "SEM configuração"}` +
      ` · E-mails da aula (Brevo): ${config.brevo.apiKey ? `3 dias ${ok(config.brevo.modelosAula["3dias"])}, amanhã ${ok(config.brevo.modelosAula.amanha)}, 1 hora ${ok(config.brevo.modelosAula["1hora"])}, ao vivo ${ok(config.brevo.modelosAula.aovivo)}` : "SEM configuração"}`
  );
});

// Registra o webhook do Calendly (uma vez; nas próximas só confere).
async function prepararCalendly() {
  try {
    const { status } = await calendly.garantirWebhook();
    console.log(`Calendly webhook: ${status} (${calendly.urlWebhook()})`);
  } catch (error) {
    console.error("Calendly webhook não registrado, tentando de novo em 10 min:", error.message);
    setTimeout(prepararCalendly, 10 * 60000).unref();
  }
}

// Cria as tabelas (se ainda não existem) e só então liga o reenvio e os lembretes.
// Se o banco estiver fora, tenta de novo a cada 30 s sem derrubar o app.
async function prepareDatabase() {
  try {
    await getStore().init();
    console.log("Database ready.");
    iniciarWorker();
    agendamento.iniciar();
    aula.iniciar();
    chegadas.iniciar();
    agendaDia.iniciar();
    vigia.iniciar();
    privacidade.iniciar();
    lives.iniciar();
    disparo.iniciar();
    mentoria.iniciar();
    reunioesAgenda.iniciar();
    prepararCalendly();
  } catch (error) {
    console.error("Database not ready, retrying in 30s:", error.code || error.message);
    setTimeout(prepareDatabase, RETRY_MS).unref();
  }
}

prepareDatabase();

function shutdown(signal) {
  console.log(`${signal} received. Shutting down.`);

  server.close(() => {
    getStore()
      .close()
      .finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
