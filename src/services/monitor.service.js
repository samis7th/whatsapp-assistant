const { config } = require("../config/env");
const { getStore } = require("../db");
const { formatarTelefone } = require("../domain/telefone");
const registro = require("../utils/registro");
const { ROTULOS } = require("./agendamento.service");
const pacote = require("../../package.json");

// Tela "Sistema" do painel: o que está configurado, o que vai sair, o que deu errado e
// as últimas linhas do log. Só leitura: nada aqui muda dados nem envia mensagens.
const INICIADO_EM = new Date();
const DIAS_CONTAGEM = 7;

function conexoes() {
  const f = config.manychat;
  const item = (grupo, nome, ok, detalhe = "") => ({ grupo, nome, ok: Boolean(ok), detalhe });

  return [
    item("Integrações", "Monday", config.monday.token),
    item("Integrações", "Telegram (avisos da equipe)", config.telegram.token && config.telegram.chatId),
    item("Integrações", "ManyChat (API)", f.apiKey),
    item("Integrações", "Calendly (aviso de agendamento)", config.calendly.token && config.calendly.webhookSecret),
    item("Integrações", "Painel (chave interna)", config.internoSecret),
    item("Integrações", "Brevo (e-mails da aula)", config.brevo.apiKey),

    item("Reunião com o consultor", "Lembrete para agendar (bloco 09)", true, "o ManyChat pergunta à Mani a cada dia"),
    item("Reunião com o consultor", "Confirmação do agendamento", f.flowConfirmacao),
    item("Reunião com o consultor", "Véspera (dia anterior)", f.flowReuniao.vespera, `${config.reunioes.horaVespera}h`),
    item("Reunião com o consultor", "No dia (ainda não confirmou)", f.flowReuniao.diaConfirmar, `${config.reunioes.horaDia}h`),
    item("Reunião com o consultor", "No dia (já confirmou)", f.flowReuniao.diaConfirmado, `${config.reunioes.horaDia}h`),
    item("Reunião com o consultor", "Reagendada", f.flowReuniao.reagendada),
    item("Reunião com o consultor", "Cancelada", f.flowReuniao.cancelada),
    item("Reunião com o consultor", "Agenda do consultor (reuniões fora do Calendly)", config.agenda.contaServico, config.agenda.id),

    item("Aula gratuita", "Data da turma", config.aula.data, config.aula.data || ""),
    item("Aula gratuita", "Link da aula (Meet)", config.aula.link),
    item("Aula gratuita", "Faltam 3 dias", f.flowAula.tresDias),
    item("Aula gratuita", "É amanhã", f.flowAula.amanha),
    item("Aula gratuita", "Falta 1 hora", f.flowAula.umaHora),
    item("Aula gratuita", "Começou agora", f.flowAula.aoVivo),
    item("Aula gratuita", "É hoje", f.flowAula.hoje, "desligado de propósito"),
    item("Aula gratuita", "Convite para amiga", f.flowAula.amiga, "desligado de propósito"),
    item("Aula gratuita", "Convite para o grupo (botão do painel)", f.flowConvite),
    item("Aula gratuita", "E-mail: faltam 3 dias", config.brevo.apiKey && config.brevo.modelosAula["3dias"]),
    item("Aula gratuita", "E-mail: é amanhã", config.brevo.apiKey && config.brevo.modelosAula.amanha),
    item("Aula gratuita", "E-mail: falta 1 hora", config.brevo.apiKey && config.brevo.modelosAula["1hora"]),
    item("Aula gratuita", "E-mail: começou agora", config.brevo.apiKey && config.brevo.modelosAula.aovivo),

    item("Sorteio das mentorias", "Primeira rodada (SORTEIO_INICIO)", config.sorteio.inicio, config.sorteio.inicio ? `${config.sorteio.vagas} vagas por semana` : ""),
    item("Sorteio das mentorias", "Aviso de terça (12h30)", f.flowSorteio.aviso),
    item("Sorteio das mentorias", "Sorteada (quarta 12h35, com o link do Calendly)", f.flowSorteio.sorteada),
    item("Sorteio das mentorias", "Lembrete de quarta (19h)", f.flowSorteio.lembrete1),
    item("Sorteio das mentorias", "Lembrete de quinta (12h)", f.flowSorteio.lembrete2),
    item("Sorteio das mentorias", "Perdeu a vaga (sexta 15h)", f.flowSorteio.perdeu),
    item("Sorteio das mentorias", "Mentoria: 1 dia antes", f.flowSorteio.vespera),
    item("Sorteio das mentorias", "Mentoria: 1 hora antes", f.flowSorteio.umaHora),
    item("Sorteio das mentorias", "Verificar cadastro (quem a página não achou)", f.flowSorteio.verificar),

    item("Disparo único", "Data e fluxo", config.disparo.data && f.flowDisparo, config.disparo.data ? `${config.disparo.data} às ${config.disparo.hora}h` : ""),

    item("Lives", "Datas das lives", config.lives.datas.length, config.lives.datas.join(", ")),
    item("Lives", "Véspera", f.flowLive.vespera),
    item("Lives", "Falta 1 hora", f.flowLive.umaHora),
    item("Lives", "Começou agora", f.flowLive.comecou),
  ];
}

// "aula:2026-10-29:amanha:+5511..." -> "2026-10-29 · amanha"; tira o telefone (ou o e-mail) da chave.
function detalheDa(tarefa) {
  const partes = String(tarefa.chave || "").split(":").slice(1).filter((parte) => !/^\+?\d{10,}$/.test(parte) && !parte.includes("@"));
  if (tarefa.tipo === "reuniao_aviso" || tarefa.tipo === "reuniao_msg") return tarefa.dados?.aviso || "";
  if (["agendou", "remarcou", "cancelou"].includes(tarefa.tipo)) return "";
  return partes.join(" · ").slice(0, 80);
}

function resumir(tarefa) {
  const dados = tarefa.dados || {};
  const telefone = dados.telefone ? formatarTelefone(dados.telefone) : "";
  return {
    id: tarefa.id,
    tipo: tarefa.tipo,
    rotulo: ROTULOS[tarefa.tipo] || tarefa.tipo,
    detalhe: detalheDa(tarefa),
    nome: String(dados.nome || "").slice(0, 80),
    telefone,
    status: tarefa.status,
    tentativas: tarefa.tentativas || 0,
    erro: tarefa.erro || dados.pulado || null,
    proxima: tarefa.proxima || null,
    atualizadoEm: tarefa.atualizadoEm || null,
  };
}

async function retrato(agora = new Date()) {
  const desde = new Date(agora.getTime() - DIAS_CONTAGEM * 86400000);
  const tarefas = await getStore().monitorTarefas({ agora, desde });

  return {
    versao: pacote.version,
    iniciadoEm: INICIADO_EM.toISOString(),
    agora: agora.toISOString(),
    conexoes: conexoes(),
    contagem: {
      dias: DIAS_CONTAGEM,
      linhas: tarefas.contagem.map((linha) => ({ ...linha, rotulo: ROTULOS[linha.tipo] || linha.tipo })),
    },
    proximas: tarefas.proximas.map(resumir),
    problemas: tarefas.problemas.map(resumir),
    recentes: tarefas.recentes.map(resumir),
    log: registro.ultimas(300),
  };
}

module.exports = {
  iniciadoEm: () => INICIADO_EM.toISOString(),
  retrato,
};
