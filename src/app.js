const express = require("express");

const calendlyRoutes = require("./routes/calendly.routes");
const internoRoutes = require("./routes/interno.routes");
const sorteioRoutes = require("./routes/sorteio.routes");
const { exigirChave, router: manychatRoutes } = require("./routes/manychat.routes");
const { getStore } = require("./db");
const { version } = require("../package.json");
const agendamento = require("./services/agendamento.service");
const aula = require("./services/aula.service");

const app = express();

app.disable("x-powered-by");

// A Hostinger serve o app atrás de um proxy reverso.
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  });
  next();
});

app.get("/health", async (req, res) => {
  try {
    await getStore().ping();
    res.json({ ok: true, service: "whatsapp-assistant", version, db: "ok" });
  } catch {
    res.status(503).json({ ok: false, service: "whatsapp-assistant", version, db: "erro" });
  }
});

app.use("/manychat", manychatRoutes);
app.use("/calendly", calendlyRoutes);
app.use("/interno", internoRoutes);
app.use("/sorteio", sorteioRoutes);

// Reforço opcional para os lembretes (ex.: cron da Hostinger às 10h05), caso o app
// esteja dormindo na hora. Mesma chave do ManyChat no header X-Api-Key.
app.post("/cron/lembretes", exigirChave, async (req, res) => {
  try {
    const agendamentos = await agendamento.rodarLembretes();
    const lembretesAula = await aula.rodarLembretesAula();
    res.json({ ok: true, ...agendamentos, aula: lembretesAula });
  } catch (error) {
    console.error("Cron de lembretes falhou:", error.code || error.message);
    res.status(500).json({ ok: false });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false });
});

module.exports = app;
