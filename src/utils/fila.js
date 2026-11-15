// Uma tarefa por vez por chave (ex.: por contato do ManyChat): chamadas repetidas
// ou simultâneas para o mesmo contato esperam a anterior terminar.
const filas = new Map();

function emFila(chave, tarefa) {
  const anterior = filas.get(chave) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(tarefa);
  const fim = atual.catch(() => {}).finally(() => {
    if (filas.get(chave) === fim) filas.delete(chave);
  });
  filas.set(chave, fim);
  return atual;
}

// Espera do reenvio: cresce a cada falha (em minutos). Limite diário da Monday
// só volta à meia-noite UTC (21h em Brasília).
const ESPERAS_MIN = [1, 2, 5, 10, 30, 60];

function proximaTentativa(error, tentativas) {
  if (error.code === "MONDAY_DAILY_LIMIT") {
    const amanha = new Date();
    amanha.setUTCHours(24, 2, 0, 0);
    return amanha;
  }

  const minutos = ESPERAS_MIN[Math.min(tentativas - 1, ESPERAS_MIN.length - 1)];
  return new Date(Date.now() + minutos * 60000);
}

module.exports = {
  emFila,
  proximaTentativa,
};
