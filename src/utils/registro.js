const util = require("util");

// Últimas linhas do log (console.log/warn/error) guardadas na memória, para a tela
// "Sistema" do painel. Recomeça do zero quando o app reinicia; o histórico de envios
// e falhas vem do banco.
const MAX_LINHAS = 400;
const linhas = [];
let instalado = false;

function guardar(nivel, args) {
  const texto = util.format(...args).slice(0, 2000);
  linhas.push({ em: new Date().toISOString(), nivel, texto });
  if (linhas.length > MAX_LINHAS) linhas.splice(0, linhas.length - MAX_LINHAS);
}

function instalar() {
  if (instalado) return;
  instalado = true;

  for (const [metodo, nivel] of [["log", "info"], ["info", "info"], ["warn", "aviso"], ["error", "erro"]]) {
    const original = console[metodo].bind(console);
    console[metodo] = (...args) => {
      try {
        guardar(nivel, args);
      } catch {
        // o log nunca pode derrubar o app
      }
      original(...args);
    };
  }
}

function ultimas(limite = MAX_LINHAS) {
  return linhas.slice(-limite);
}

module.exports = {
  instalar,
  ultimas,
};
