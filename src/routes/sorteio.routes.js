const express = require("express");

const { config } = require("../config/env");
const mentoria = require("../services/mentoria.service");

// Página de inscrição no sorteio das mentorias (fica no Squarespace e chama estas rotas).
// Só os sites de SORTEIO_ORIGENS podem chamar pelo navegador.
const router = express.Router();

router.use((req, res, next) => {
  const origem = req.get("origin");

  if (origem && config.sorteio.origens.includes(origem)) {
    res.set({
      "Access-Control-Allow-Origin": origem,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

// Limite simples por IP contra abuso (envio de mensagens pagas em massa). Decisão de
// 07/11/2026: 10 a cada 10 minutos; se clientes reais esbarrarem (operadoras de celular
// põem muita gente no mesmo IP), suba com SORTEIO_TENTATIVAS_IP.
const TENTATIVAS = new Map();
const JANELA_MS = 10 * 60000;
// v2.15.0: 10 por padrão (SORTEIO_TENTATIVAS_IP); uma pessoa real tenta uma ou duas vezes.
const MAXIMO = config.sorteio.tentativasPorIp;

function limitar(req, res, next) {
  const agora = Date.now();
  const ip = req.ip || "?";
  const recentes = (TENTATIVAS.get(ip) || []).filter((t) => agora - t < JANELA_MS);

  if (recentes.length >= MAXIMO) {
    return res.status(429).json({ ok: false, resultado: "muitas_tentativas" });
  }

  recentes.push(agora);
  TENTATIVAS.set(ip, recentes);

  if (TENTATIVAS.size > 5000) {
    for (const [chave, lista] of TENTATIVAS) if (!lista.some((t) => agora - t < JANELA_MS)) TENTATIVAS.delete(chave);
  }

  next();
}

// A página pergunta se as inscrições estão abertas (e até quando).
router.get("/estado", (req, res) => {
  res.json({ ok: true, ...mentoria.estado(new Date()) });
});

router.post("/inscricao", express.json({ limit: "4kb" }), limitar, async (req, res) => {
  try {
    const resultado = await mentoria.inscrever(req.body || {}, new Date());
    res.status(resultado.resultado === "invalido" ? 400 : 200).json({ ok: true, ...resultado });
  } catch (error) {
    console.error("Inscrição no sorteio falhou:", error.code || error.message);
    res.status(503).json({ ok: false, resultado: "erro" });
  }
});

module.exports = router;
