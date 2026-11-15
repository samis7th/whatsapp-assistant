const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataSP } = require("../domain/datas");

// LGPD (v2.16.0): uma vez por dia apaga os dados pessoais que não são mais usados há mais
// de RETENCAO_MESES (padrão 12): tarefas já concluídas, pré-atendimentos antigos, ordem de
// chegada e inscrições do sorteio. O que está na fila nunca é apagado. Rodar duas vezes
// (duas cópias do app) não faz mal: é só um DELETE pela data.

let ultimoDia = null;

function limite(agora, meses = config.retencaoMeses) {
  const data = new Date(agora);
  data.setMonth(data.getMonth() - meses);
  return data;
}

async function limpar(agora = new Date()) {
  const hoje = dataSP(agora);
  if (ultimoDia === hoje) return { status: "ja_feito" };

  const apagados = await getStore().limparDadosAntigos(limite(agora));
  ultimoDia = hoje;
  const total = Object.values(apagados).reduce((a, b) => a + b, 0);
  if (total) console.log("Limpeza de dados antigos (LGPD):", apagados);
  return { status: "ok", apagados };
}

function reiniciar() {
  ultimoDia = null;
}

function iniciar(intervaloMs = 6 * 3600000) {
  if (!config.workerEnabled) return;
  const executar = () => limpar().catch((error) => console.error("Limpeza de dados antigos falhou:", error.message));
  setTimeout(executar, 5 * 60000).unref();
  setInterval(executar, intervaloMs).unref();
}

module.exports = { iniciar, limite, limpar, reiniciar };
