const express = require("express");

const calendly = require("../services/calendly.service");
const agendamento = require("../services/agendamento.service");

const router = express.Router();

// Avisos do Calendly (agendou / cancelou). O corpo chega bruto para conferir a
// assinatura exatamente sobre os bytes enviados.
router.post("/webhook", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
  const corpoBruto = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

  if (!calendly.assinaturaValida(req.get("calendly-webhook-signature"), corpoBruto)) {
    return res.status(401).json({ ok: false });
  }

  let corpo;

  try {
    corpo = JSON.parse(corpoBruto);
  } catch {
    return res.status(400).json({ ok: false });
  }

  try {
    const resultado = await agendamento.receberWebhook(corpo);
    res.json({ ok: true, ...resultado });
  } catch (error) {
    // Erro ao guardar: responde 500 para o Calendly reenviar o aviso depois.
    console.error("Webhook do Calendly falhou:", error.code || error.message);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
