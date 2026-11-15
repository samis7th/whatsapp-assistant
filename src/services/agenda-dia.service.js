const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataSP, horaSP } = require("../domain/datas");
const { formatarTelefone } = require("../domain/telefone");
const telegram = require("./telegram.service");

// Reuniões do dia (v2.13.0): às 8h, uma lista no Telegram com as reuniões comerciais
// (Calendly e agenda do consultor) e as mentorias das sorteadas de hoje, com o horário e a
// situação de cada uma. Sem nenhuma reunião no dia, não manda nada.

const HORA = 8;
const FUSO = "America/Sao_Paulo";

const hora = (data) => {
  const [h, m] = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(data)
    .split(":");
  return `${Number(h)}h${m === "00" ? "" : m}`;
};

const SITUACAO = {
  confirmada: "✅ confirmou",
  reagendar_pendente: "🔁 pediu para reagendar",
  cancelamento_pendente: "🗑 pediu para cancelar",
};

// Reuniões comerciais ativas de hoje (registradas pelo Calendly ou pela agenda).
async function reunioesDeHoje(hoje) {
  const registros = await getStore().tarefasComPrefixo("reuniao:");
  return registros
    .filter((t) => t.tipo === "reuniao_registro" && t.dados?.situacao === "ativa" && t.dados.inicio && dataSP(new Date(t.dados.inicio)) === hoje)
    .map((t) => ({
      inicio: new Date(t.dados.inicio),
      nome: t.dados.nome || "Sem nome",
      telefone: t.dados.telefone || "",
      tipo: "Reunião comercial",
      situacao: SITUACAO[t.dados.confirmacao] || "⏳ ainda não confirmou",
    }));
}

// Mentorias agendadas para hoje (sorteadas das últimas rodadas).
async function mentoriasDeHoje(hoje, agora) {
  const desde = dataSP(new Date(agora.getTime() - 21 * 86400000));
  const sorteadas = await getStore().sorteadasMentoria(desde);
  return sorteadas
    .filter((i) => i.agendamento === "agendada" && i.mentoriaEm && dataSP(new Date(i.mentoriaEm)) === hoje)
    .map((i) => ({
      inicio: new Date(i.mentoriaEm),
      nome: i.nome || "Sem nome",
      telefone: i.telefone || "",
      tipo: "Mentoria (sorteada)",
      situacao: null,
    }));
}

// Painel (v3.1.0): reuniões comerciais e mentorias de "dias antes" até "dias depois", com
// a situação e os lembretes que já saíram. Só leitura.
const CONFIRMACAO = { pendente: "ainda não confirmou", confirmada: "confirmou", reagendar_pendente: "pediu para reagendar", cancelamento_pendente: "pediu para cancelar" };

async function paraPainel({ agora = new Date(), diasAntes = 7, diasDepois = 30 } = {}) {
  const de = new Date(agora.getTime() - diasAntes * 86400000);
  const ate = new Date(agora.getTime() + diasDepois * 86400000);
  const dentro = (data) => data >= de && data <= ate;

  const registros = (await getStore().tarefasComPrefixo("reuniao:"))
    .filter((t) => t.tipo === "reuniao_registro" && t.dados?.inicio && dentro(new Date(t.dados.inicio)))
    .map((t) => {
      const d = t.dados;
      return {
        tipo: "reuniao",
        inicio: d.inicio,
        fim: d.fim || null,
        nome: d.nome || "Sem nome",
        telefone: d.telefone ? formatarTelefone(d.telefone) : "",
        email: d.email || "",
        origem: d.origem === "agenda" ? "agenda" : "calendly",
        situacao: d.situacao || "ativa",
        confirmacao: d.confirmacao || "pendente",
        confirmacaoTexto: CONFIRMACAO[d.confirmacao] || "ainda não confirmou",
        recorrente: Boolean(d.recorrente),
        lembretes: Array.isArray(d.enviados) ? d.enviados : [],
        link: d.link || "",
      };
    });

  const sorteadas = await getStore().sorteadasMentoria(dataSP(new Date(de.getTime() - 21 * 86400000)));
  const mentorias = sorteadas
    .filter((i) => i.agendamento === "agendada" && i.mentoriaEm && dentro(new Date(i.mentoriaEm)))
    .map((i) => ({
      tipo: "mentoria",
      inicio: new Date(i.mentoriaEm).toISOString(),
      fim: null,
      nome: i.nome || "Sem nome",
      telefone: i.telefone ? formatarTelefone(i.telefone) : "",
      email: i.email || "",
      origem: "sorteio",
      situacao: "ativa",
      confirmacao: null,
      confirmacaoTexto: "",
      recorrente: false,
      lembretes: [],
      link: i.link || "",
    }));

  return {
    agora: agora.toISOString(),
    de: de.toISOString(),
    ate: ate.toISOString(),
    reunioes: [...registros, ...mentorias].sort((a, b) => new Date(a.inicio) - new Date(b.inicio)),
  };
}

function texto(hoje, lista) {
  const e = telegram.escapeHtml;
  const [ano, mes, dia] = hoje.split("-");
  const semana = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, weekday: "long" }).format(new Date(`${ano}-${mes}-${dia}T12:00:00-03:00`));
  const linhas = [`🗓 <b>Reuniões de hoje</b> · ${semana}, ${dia}/${mes}`, ""];

  for (const r of lista) {
    linhas.push(`<b>${hora(r.inicio)}</b> · ${e(r.nome)}${r.telefone ? ` · ${formatarTelefone(r.telefone)}` : ""}`);
    linhas.push(`${r.tipo}${r.situacao ? ` · ${r.situacao}` : ""}`);
    linhas.push("");
  }

  linhas.push(`Total: ${lista.length} ${lista.length === 1 ? "reunião" : "reuniões"}.`);
  return linhas.join("\n");
}

// Roda a cada 5 minutos; a partir das 8h monta a lista do dia (uma vez só, mesmo com duas
// cópias do app). O envio vai pela fila de tarefas, que tenta de novo se o Telegram falhar.
async function rodar(agora = new Date()) {
  if (horaSP(agora) < HORA) return { status: "cedo" };

  const store = getStore();
  const hoje = dataSP(agora);
  const chave = `agenda_dia:${hoje}`;
  if (await store.tarefaPorChave(chave)) return { status: "ja_feito" };

  const lista = [...(await reunioesDeHoje(hoje)), ...(await mentoriasDeHoje(hoje, agora))].sort((a, b) => a.inicio - b.inicio);
  const tarefa = await store.criarTarefa({
    chave,
    tipo: "telegram_resumo",
    dados: { texto: lista.length ? texto(hoje, lista) : null },
  });

  if (tarefa.criada && lista.length) require("./agendamento.service").agendarProcessamento();
  return { status: lista.length ? "enviado" : "sem_reunioes", total: lista.length };
}

function iniciar(intervaloMs = 5 * 60000) {
  if (!config.workerEnabled) return;
  const executar = () => rodar().catch((error) => console.error("Reuniões do dia falhou:", error.message));
  executar();
  setInterval(executar, intervaloMs).unref();
}

module.exports = { iniciar, paraPainel, rodar, texto };
