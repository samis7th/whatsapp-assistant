// Datas sempre no fuso de São Paulo.
const FUSO = "America/Sao_Paulo";

// "AAAA-MM-DD" do dia em São Paulo.
function dataSP(data = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSO }).format(data);
}

// Hora cheia (0–23) em São Paulo.
function horaSP(data = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, hour: "2-digit", hourCycle: "h23" }).format(data));
}

// Hora com os minutos em fração, em Brasília: 19h30 -> 19.5.
function horaMinutoSP(data = new Date()) {
  const [hora, minuto] = new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(data)
    .split(":")
    .map(Number);
  return hora + minuto / 60;
}

// "19/10/2026 14:32"
function dataHoraBR(data) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, dateStyle: "short", timeStyle: "short" }).format(data);
}

// "23/10 às 15:00"
function diaHoraCurto(data) {
  const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit" }).format(data);
  const hora = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" }).format(data);
  return `${dia} às ${hora}`;
}

// "qui., 23/10 às 15:00"
function diaSemanaHora(data) {
  const semana = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, weekday: "short" }).format(data);
  return `${semana} ${diaHoraCurto(data)}`;
}

// "quinta-feira, 23/10, às 15h" (ou "às 15h30"): vai na confirmação da reunião.
function dataPorExtenso(data) {
  const semana = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, weekday: "long" }).format(data);
  const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit" }).format(data);
  const [hora, minuto] = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(data)
    .split(":");
  return `${semana}, ${dia}, às ${Number(hora)}h${minuto === "00" ? "" : minuto}`;
}

module.exports = {
  dataHoraBR,
  dataPorExtenso,
  dataSP,
  diaHoraCurto,
  diaSemanaHora,
  horaMinutoSP,
  horaSP,
};
