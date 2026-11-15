// Campos de um pré-atendimento (uma conversa da Mani) e a coluna de cada um no banco.
const CAMPOS = Object.freeze({
  contatoId: "contato_id",
  whatsapp: "whatsapp",
  nomeWhatsapp: "nome_whatsapp",
  telefoneInformado: "telefone_informado",
  telefone: "telefone",
  tentativasTelefone: "tentativas_telefone",
  mondayItemId: "monday_item_id",
  mondayNome: "monday_nome",
  buscaPendente: "busca_pendente",
  faturamentoTexto: "faturamento_texto",
  faturamentoValor: "faturamento_valor",
  valorPendente: "valor_pendente",
  tentativasFaturamento: "tentativas_faturamento",
  faixa: "faixa",
  resultado: "resultado",
  motivo: "motivo",
  respostaEnviada: "resposta_enviada",
  etapaMonday: "etapa_monday",
  etapaComentario: "etapa_comentario",
  etapaTelegram: "etapa_telegram",
  sync: "sync",
  syncTentativas: "sync_tentativas",
  syncErro: "sync_erro",
  syncProxima: "sync_proxima",
  alertaFalha: "alerta_falha",
  concluidoEm: "concluido_em",
  // Agendamento pelo Calendly (só para qualificadas).
  refAgendamento: "ref_agendamento",
  agendamento: "agendamento", // pendente | agendado | recusou | nao_agendou | cancelado
  lembretes: "lembretes",
  ultimoLembrete: "ultimo_lembrete", // AAAA-MM-DD (São Paulo)
  reuniaoEm: "reuniao_em",
  eventoCalendly: "evento_calendly",
  // Até quando um processo está cuidando do reenvio (outro processo não pega junto).
  syncBloqueio: "sync_bloqueio",
});

const BOOLEANOS = new Set(["buscaPendente", "etapaMonday", "etapaComentario", "etapaTelegram", "alertaFalha"]);
const NUMEROS = new Set([
  "tentativasTelefone",
  "tentativasFaturamento",
  "syncTentativas",
  "faturamentoValor",
  "valorPendente",
  "lembretes",
]);

function novoAtendimento(dados) {
  return {
    whatsapp: null,
    nomeWhatsapp: null,
    telefoneInformado: null,
    telefone: null,
    tentativasTelefone: 0,
    mondayItemId: null,
    mondayNome: null,
    buscaPendente: false,
    faturamentoTexto: null,
    faturamentoValor: null,
    valorPendente: null,
    tentativasFaturamento: 0,
    faixa: null,
    resultado: null,
    motivo: null,
    respostaEnviada: null,
    etapaMonday: false,
    etapaComentario: false,
    etapaTelegram: false,
    sync: "nenhum",
    syncTentativas: 0,
    syncErro: null,
    syncProxima: null,
    alertaFalha: false,
    concluidoEm: null,
    refAgendamento: null,
    agendamento: null,
    lembretes: 0,
    ultimoLembrete: null,
    reuniaoEm: null,
    eventoCalendly: null,
    syncBloqueio: null,
    ...dados,
  };
}

module.exports = {
  BOOLEANOS,
  CAMPOS,
  NUMEROS,
  novoAtendimento,
};
