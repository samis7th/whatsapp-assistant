
const isProduction = process.env.NODE_ENV === "production";

function required(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return process.env[name];
}

// ID de automação do ManyChat ("content" + números, ex.: content20261021123456_123456).
// Qualquer outro valor (vazio, "-", "pendente"...) conta como não configurado: assim dá
// para deixar um valor provisório na Hostinger sem o sistema tentar disparar.
function fluxo(nome) {
  const valor = String(process.env[nome] || "").trim();

  if (!valor) {
    return "";
  }

  if (!/^content\d+(_\d+)?$/.test(valor)) {
    console.warn(`${nome} ignorado: não parece um ID de automação do ManyChat (deve começar com "content").`);
    return "";
  }

  return valor;
}

function dataValida(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) && !Number.isNaN(Date.parse(`${valor}T12:00:00Z`));
}

// Lista separada por vírgula (vazio = o padrão).
function lista(nome, padrao) {
  return Object.freeze(
    String(process.env[nome] || padrao)
      .split(",")
      .map((valor) => valor.trim())
      .filter(Boolean)
  );
}

// Chave da conta de serviço do Google (o arquivo JSON inteiro, em base64, numa linha só).
// Valor que não abre como chave é ignorado (os lembretes pela agenda ficam desligados).
function contaServicoGoogle() {
  const bruto = String(process.env.GOOGLE_AGENDA_CHAVE || "").trim();
  if (!bruto) return null;

  try {
    const json = JSON.parse(Buffer.from(bruto, "base64").toString("utf8"));
    if (!json.client_email || !String(json.private_key || "").includes("PRIVATE KEY")) throw new Error();
    return Object.freeze({ email: json.client_email, chave: json.private_key });
  } catch {
    console.warn("GOOGLE_AGENDA_CHAVE ignorado: não é o arquivo JSON da conta de serviço em base64.");
    return null;
  }
}

function opcional(nome, valido, motivo) {
  const valor = String(process.env[nome] || "").trim();

  if (valor && !valido(valor)) {
    console.warn(`${nome} ignorado: ${motivo}.`);
    return "";
  }

  return valor;
}

function loadConfig() {
  // Somente local: banco em memória e Monday/Telegram simulados nos testes.
  const memoryStore = process.env.DATA_MEMORY === "true";

  if (memoryStore && isProduction) {
    throw new Error("DATA_MEMORY cannot be enabled in production");
  }

  const manychatSecret = process.env.MANYCHAT_SECRET || "";

  if (manychatSecret.length < 32) {
    throw new Error("MANYCHAT_SECRET must have at least 32 characters");
  }

  if (!memoryStore) {
    required("DB_HOST");
    required("DB_USER");
    required("DB_NAME");
  }

  if (isProduction) {
    required("MONDAY_API_TOKEN");
  }

  // Variáveis opcionais com valor inválido são ignoradas com um aviso no log, em vez de
  // derrubar o app (e a Mani junto) por causa de um valor provisório.
  const telegramToken = opcional("TELEGRAM_BOT_TOKEN", (v) => /^\d+:[\w-]{30,}$/.test(v), "formato de token inválido");
  const telegramChatId = opcional("TELEGRAM_CHAT_ID", (v) => /^-?\d+$/.test(v), "deve ser um número (grupos começam com -)");
  const internoSecret = opcional("INTERNO_SECRET", (v) => v.length >= 32, "precisa de 32 caracteres ou mais");
  const aulaData = opcional("AULA_DATA", dataValida, "use o formato 2026-10-29");
  // Minutos (número inteiro); outro valor é ignorado e fica o padrão.
  const minutos = (nome, padrao) => {
    const valor = opcional(nome, (v) => /^\d{1,4}$/.test(v), "use um número de minutos, como 120");
    return valor ? Number(valor) : padrao;
  };
  // Uma ou mais datas de live, separadas por vírgula; vazio = sem lembrete de live.
  const liveDatas = opcional(
    "LIVE_DATA",
    (v) => v.split(",").every((d) => dataValida(d.trim())),
    "use o formato 2026-11-05 (ou várias: 2026-11-05,2026-11-19)"
  );
  // Hora de 0 a 23, com ou sem minutos ("19" ou "19:30"); outro valor é ignorado
  // (fica o padrão de 10h). Vira número com os minutos em fração: "19:30" -> 19.5.
  const hora = (nome) => {
    const valor = opcional(nome, (v) => /^([01]?\d|2[0-3])(:[0-5]\d)?$/.test(v), 'use a hora, como 18 ou 19:30');
    if (!valor) return null;
    const [h, m = "0"] = valor.split(":");
    return Number(h) + Number(m) / 60;
  };
  const aulaLink = opcional("AULA_LINK", (v) => /^https:\/\/\S+$/.test(v), "precisa ser um link https://");
  const calendlySecret = opcional("CALENDLY_WEBHOOK_SECRET", (v) => v.length >= 32, "precisa de 32 caracteres ou mais");
  // Número do modelo de e-mail no Brevo (aparece na lista de modelos, ex.: 3); vazio = não sai.
  const modeloBrevo = (nome) => {
    const valor = opcional(nome, (v) => /^\d{1,6}$/.test(v), "use o número do modelo no Brevo, como 3");
    return valor ? Number(valor) : null;
  };

  return Object.freeze({
    isProduction,
    memoryStore,
    manychatSecret,
    db: {
      host: process.env.DB_HOST || "",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || "",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "",
    },
    monday: {
      token: String(process.env.MONDAY_API_TOKEN || "").trim(),
      boardId: process.env.MONDAY_BOARD_ID || "1234567890",
      phoneColumnId: process.env.MONDAY_PHONE_COLUMN_ID || "phonenhzs51c9",
      // E-mail da inscrição (o mesmo que a API de inscrições grava).
      emailColumnId: process.env.MONDAY_EMAIL_COLUMN_ID || "emailhnvgrjbb",
      // Quem está no quadro recebe os avisos das aulas (sem ciclo desde 04/11/2026), menos
      // estas Etapas do Funil.
      // Etapas de cliente que a Mani nunca troca (v3.4.0).
      etapasProtegidas: lista("MONDAY_ETAPAS_PROTEGIDAS", "Cliente Consultoria,Cliente Infoproduto,Negócio fechado"),
      etapasSemAvisos: lista(
        "AULA_ETAPAS_EXCLUIDAS",
        "Não quer receber mensagens,Deixou de ser cliente,Aguardando pagamento"
      ),
      // Colunas encontradas pelo título; troque aqui se renomearem no quadro.
      titles: {
        faixa: process.env.MONDAY_TITULO_FAIXA || "Faturamento Mensal",
        resultado: process.env.MONDAY_TITULO_RESULTADO || "Etapa do Funil",
        proximoContato: process.env.MONDAY_TITULO_PROXIMO_CONTATO || "Próximo Contato",
        ultimoContato: process.env.MONDAY_TITULO_ULTIMO_CONTATO || "Último Contato",
      },
      // Colunas que podem não existir no quadro: sem elas, só a parte que as usa para.
      // A OBS saiu do quadro em 03/11/2026 (virou "Data de Cadastro"): os status do
      // pré-atendimento ficam no histórico do cadastro; se a OBS voltar, é usada de novo.
      titulosOpcionais: {
        grupo: process.env.MONDAY_TITULO_GRUPO || "Grupo WhatsApp",
        obs: process.env.MONDAY_TITULO_OBS || "OBS",
      },
      labels: {
        // Faturamento a partir do limite (o gestor renomeou "Qualificado" em 28/10/2026).
        qualificada: process.env.MONDAY_LABEL_QUALIFICADA || "Quer reunião",
        foraDoPerfil: process.env.MONDAY_LABEL_FORA_DO_PERFIL || "Fora do Perfil",
        reuniaoMarcada: process.env.MONDAY_LABEL_REUNIAO_MARCADA || "Reunião Marcada",
        // Etapa do Funil de quem tocou em "Não quero agendar" (o gestor juntou com "Não agendou").
        naoQuisAgendar: process.env.MONDAY_LABEL_RECUSOU || "Não agendou",
        // Etapa do Funil de quem recebeu todos os lembretes e não respondeu.
        naoAgendou: process.env.MONDAY_LABEL_SEM_RESPOSTA || "Não respondeu",
        // Etapa do Funil quando a reunião é cancelada no Calendly (reagendada continua
        // "Reunião Marcada", com a nova data).
        reuniaoCancelada: process.env.MONDAY_LABEL_REUNIAO_CANCELADA || "Reunião cancelada",
        // Etiquetas da coluna "Grupo WhatsApp" (gravadas pelo painel).
        noGrupo: "Está no grupo",
        foraDoGrupo: "Não está no grupo",
        // Etapa do Funil de quem pediu para parar as mensagens (estava na coluna Grupo
        // WhatsApp até 03/11/2026).
        naoQuerMensagens: process.env.MONDAY_LABEL_NAO_QUER_MENSAGENS || "Não quer receber mensagens",
        // v3.3.0: Etapa de quem volta a receber as mensagens, quando a anterior não é conhecida.
        voltou: process.env.MONDAY_LABEL_VOLTOU || "A Definir",
      },
      // Opcional: link do quadro (ex.: https://suaconta.monday.com/boards/1234567890)
      // para o aviso do Telegram trazer o link direto do cadastro.
      boardUrl: (process.env.MONDAY_BOARD_URL || "").replace(/\/+$/, ""),
    },
    telegram: {
      token: telegramToken,
      chatId: telegramChatId,
    },
    // Endereço público do app (o Calendly manda os agendamentos para cá).
    publicOrigin: (process.env.PUBLIC_ORIGIN || "https://assistente.example.com").replace(/\/+$/, ""),
    calendly: {
      // Link do evento que a Mani manda (ex.: https://calendly.com/consultor/reuniao).
      url: (process.env.CALENDLY_URL || "").trim(),
      // Token pessoal do Calendly (Integrações > API e webhooks): só para registrar o webhook.
      token: String(process.env.CALENDLY_TOKEN || "").trim(),
      // Segredo que assina cada aviso do Calendly (32+ caracteres).
      webhookSecret: calendlySecret,
      // Opcional: pergunta do formulário que recebe o telefone pré-preenchido (ex.: a1).
      campoTelefone: /^a(10|[1-9])$/.test(process.env.CALENDLY_CAMPO_TELEFONE || "")
        ? process.env.CALENDLY_CAMPO_TELEFONE
        : "",
      // Opcional: nome do evento da reunião no Calendly. Com ele, agendamentos de outros
      // eventos da conta (que não vieram pelo link da Mani) são ignorados.
      eventoNome: String(process.env.CALENDLY_EVENTO_NOME || "").trim(),
    },
    manychat: {
      // Chave da API do ManyChat (Configurações > API): para mandar os lembretes.
      apiKey: String(process.env.MANYCHAT_API_KEY || "").trim(),
      // ID do fluxo de lembrete (aparece no endereço do fluxo, ex.: content20261020...).
      flowLembrete: fluxo("MANYCHAT_FLOW_LEMBRETE"),
      // Campo do usuário (Texto) com o WhatsApp de cada contato, copiado do campo do
      // sistema em Contatos > Ações em lote. A API acha contatos antigos por ele.
      campoWhatsapp: String(process.env.MANYCHAT_CAMPO_WHATSAPP || "whatsapp_numero").trim(),
      // Fluxo com o modelo convite_grupo_aula (convite para quem não entrou no grupo).
      flowConvite: fluxo("MANYCHAT_FLOW_CONVITE"),
      // Fluxo com o modelo confirmacao_reuniao (mandado quando a pessoa agenda no Calendly).
      flowConfirmacao: fluxo("MANYCHAT_FLOW_CONFIRMACAO"),
      // Lembretes da reunião marcada no Calendly (um fluxo por modelo).
      flowReuniao: {
        vespera: fluxo("MANYCHAT_FLOW_REUNIAO_VESPERA"),
        diaConfirmar: fluxo("MANYCHAT_FLOW_REUNIAO_DIA_CONFIRMAR"),
        diaConfirmado: fluxo("MANYCHAT_FLOW_REUNIAO_DIA_CONFIRMADO"),
        reagendada: fluxo("MANYCHAT_FLOW_REUNIAO_REAGENDADA"),
        cancelada: fluxo("MANYCHAT_FLOW_REUNIAO_CANCELADA"),
      },
      // Fluxos dos lembretes da aula (um por modelo: 3 dias antes, 1 dia antes e no dia).
      flowAula: {
        tresDias: fluxo("MANYCHAT_FLOW_AULA_3DIAS"),
        amiga: fluxo("MANYCHAT_FLOW_AULA_AMIGA"),
        amanha: fluxo("MANYCHAT_FLOW_AULA_AMANHA"),
        hoje: fluxo("MANYCHAT_FLOW_AULA_HOJE"),
        umaHora: fluxo("MANYCHAT_FLOW_AULA_1HORA"),
        aoVivo: fluxo("MANYCHAT_FLOW_AULA_AOVIVO"),
      },
      // Fluxos dos lembretes das lives (véspera à noite, no dia às 19h e às 20h).
      flowLive: {
        vespera: fluxo("MANYCHAT_FLOW_LIVE_VESPERA"),
        umaHora: fluxo("MANYCHAT_FLOW_LIVE_1HORA"),
        comecou: fluxo("MANYCHAT_FLOW_LIVE_COMECOU"),
      },
      // Disparo único (ex.: aviso do sorteio das mentorias), no dia DISPARO_DATA.
      flowDisparo: fluxo("MANYCHAT_FLOW_DISPARO"),
      // Sorteio semanal das mentorias (um fluxo por modelo).
      flowSorteio: {
        aviso: fluxo("MANYCHAT_FLOW_SORTEIO_AVISO"),
        sorteada: fluxo("MANYCHAT_FLOW_SORTEIO_SORTEADA"),
        lembrete1: fluxo("MANYCHAT_FLOW_SORTEIO_LEMBRETE1"),
        lembrete2: fluxo("MANYCHAT_FLOW_SORTEIO_LEMBRETE2"),
        perdeu: fluxo("MANYCHAT_FLOW_SORTEIO_PERDEU_VAGA"),
        vespera: fluxo("MANYCHAT_FLOW_MENTORIA_VESPERA"),
        umaHora: fluxo("MANYCHAT_FLOW_MENTORIA_1HORA"),
        // Modelo sorteio_verificar_cadastro: quem a página não achou confirma pelo WhatsApp.
        verificar: fluxo("MANYCHAT_FLOW_SORTEIO_VERIFICAR"),
      },
    },
    // Sorteio semanal das mentorias (documento do gestor, Parte 3). Rodada = terça.
    // Terça 12h30 aviso, inscrições até quarta 8h (sorteio), mensagens 12h35, régua até sexta.
    // Sem SORTEIO_INICIO (a primeira terça), nada roda e a página mostra "encerrada".
    sorteio: {
      inicio: opcional("SORTEIO_INICIO", (v) => dataValida(v) && new Date(`${v}T12:00:00Z`).getUTCDay() === 2, "use uma terça-feira, como 2026-11-10"),
      vagas: Number(opcional("SORTEIO_VAGAS", (v) => /^[1-9]$/.test(v), "use um número de 1 a 9")) || 4,
      // Quem tem uma destas Etapas não recebe o aviso e não entra na rodada.
      etapasExcluidas: lista(
        "SORTEIO_ETAPAS_EXCLUIDAS",
        "Negócio Recusado,Não Respondeu,Fora do Perfil,Não quer receber mensagens,Deixou de ser cliente,Aguardando pagamento"
      ),
      // Sites que podem enviar a inscrição (a página fica no Squarespace).
      origens: lista("SORTEIO_ORIGENS", "https://www.example.com,https://example.com"),
      // Teto de mensagens "Verificar cadastro" (pagas) por rodada (v2.15.0): a página é
      // pública, então ninguém consegue usá-la para disparar mensagens em massa.
      tetoVerificar: Number(opcional("SORTEIO_TETO_VERIFICAR", (v) => /^[1-9]\d{0,3}$/.test(v), "use um número de 1 a 9999")) || 60,
      // Tentativas na página por endereço de internet a cada 10 minutos.
      tentativasPorIp: Number(opcional("SORTEIO_TENTATIVAS_IP", (v) => /^[1-9]\d{0,2}$/.test(v), "use um número de 1 a 999")) || 10,
    },
    // Disparo único para o público dos avisos das aulas: dia (AAAA-MM-DD) e hora de
    // Brasília (padrão 20h). Sem data ou sem fluxo, não sai nada.
    disparo: {
      data: opcional("DISPARO_DATA", dataValida, "use o formato 2026-11-05"),
      hora: hora("DISPARO_HORA") ?? 20,
    },
    // Chave que o painel de inscritos usa para mandar a lista de convites (32+ caracteres).
    internoSecret,
    aula: {
      // Data da turma atual (AAAA-MM-DD): vai no texto dos modelos e na etiqueta da turma.
      data: aulaData,
      // Horário (Brasília) a partir do qual saem os lembretes da aula.
      horaLembrete: 10,
      // Horário (Brasília, 0 a 23) de cada lembrete que sai durante o dia; vazio = 10h.
      // Ex.: AULA_HORA_3DIAS=12, AULA_HORA_AMIGA=19:30, AULA_HORA_AMANHA=20.
      horas: {
        "3dias": hora("AULA_HORA_3DIAS"),
        amiga: hora("AULA_HORA_AMIGA"),
        amanha: hora("AULA_HORA_AMANHA"),
        hoje: hora("AULA_HORA_HOJE"),
      },
      // Aula às 20h; a mensagem "começou agora" com o link sai entre 20h e 21h.
      // Horário da aula (Brasília), como "20" ou "19:30" em AULA_HORA; vazio = 20h. Vai no texto
      // dos lembretes (campo do bot hora_aula) e marca o "falta 1 hora" e o "começou agora".
      horaAula: hora("AULA_HORA") ?? 20,
      // Link de acesso da aula (vai na mensagem "começou agora", campo do bot link_aula).
      link: aulaLink,
      // Lembretes que pulam quem está no grupo (coluna Grupo WhatsApp = "Está no grupo"),
      // separados por vírgula: ex. AULA_PULAR_NO_GRUPO=3dias,amanha. Vazio: todos recebem.
      pularNoGrupo: new Set(
        String(process.env.AULA_PULAR_NO_GRUPO || "")
          .split(",")
          .map((chave) => chave.trim().toLowerCase())
          .filter(Boolean)
      ),
    },
    // E-mails de lembrete da aula mensal pelo Brevo (as lives não recebem e-mail). Saem
    // junto com o WhatsApp de cada lembrete, para o e-mail da inscrição na Monday.
    brevo: {
      apiKey: String(process.env.BREVO_API_KEY || "").trim(),
      modelosAula: {
        "3dias": modeloBrevo("BREVO_MODELO_AULA_3DIAS"),
        amanha: modeloBrevo("BREVO_MODELO_AULA_AMANHA"),
        "1hora": modeloBrevo("BREVO_MODELO_AULA_1HORA"),
        aovivo: modeloBrevo("BREVO_MODELO_AULA_AOVIVO"),
      },
    },
    lives: {
      // Lives às 20h (Brasília), nas datas de LIVE_DATA. O lembrete de 1 hora e o
      // "começou agora" saem às 19h e às 20h; a véspera no horário de LIVE_HORA_VESPERA.
      datas: liveDatas ? liveDatas.split(",").map((d) => d.trim()) : [],
      horaLive: 20,
      horaVespera: hora("LIVE_HORA_VESPERA") ?? 19.5,
    },
    // Agenda do consultor no Google: dispara os lembretes das reuniões marcadas fora do
    // Calendly (as do Calendly seguem pelo aviso do próprio Calendly). Só leitura.
    agenda: {
      id: String(process.env.GOOGLE_AGENDA_ID || "consultor@example.com").trim(),
      contaServico: contaServicoGoogle(),
      // Eventos com uma destas palavras no título (agenda) ou no nome do evento do Calendly
      // ficam fora dos lembretes comerciais ("Mentoria Sorteada", com lembretes próprios).
      ignorar: lista("GOOGLE_AGENDA_IGNORAR", "Mentoria"),
      // Quantos dias à frente a agenda é lida, e de quanto em quanto tempo.
      dias: 30,
      intervaloMin: 5,
    },
    reunioes: {
      // Pedido de confirmação no dia anterior (13h, dia de calendário, sem exceção para fim de
      // semana nem feriado; documento do gestor de 30/10/2026) e lembrete no dia (8h), em Brasília.
      // Reunião antes disso: o lembrete do dia sai REUNIAO_ANTECEDENCIA_MIN antes do início.
      horaVespera: hora("REUNIAO_HORA_VESPERA") ?? 13,
      horaDia: hora("REUNIAO_HORA_DIA") ?? 8,
      antecedenciaMin: minutos("REUNIAO_ANTECEDENCIA_MIN", 120),
      // Aviso que cairia muito perto do agendamento (ou de outro aviso) não sai.
      intervaloMin: minutos("REUNIAO_INTERVALO_MIN", 60),
    },
    lembretes: {
      hora: 10, // horário de Brasília
      maximo: 5,
    },
    // LGPD (v2.16.0): dados que ninguém usa há mais destes meses são apagados (padrão 12).
    retencaoMeses: Number(opcional("RETENCAO_MESES", (v) => /^([6-9]|[1-9]\d)$/.test(v), "use um número de 6 a 99")) || 12,
    // Vigia cruzada (v2.14.0): endereço da API de inscrições que a Mani confere a cada
    // 5 minutos (aviso no Telegram se cair). VIGIA_URL=off desliga.
    vigia: {
      url: /^(off|false|0)$/i.test(String(process.env.VIGIA_URL || "").trim())
        ? ""
        : String(process.env.VIGIA_URL || "https://api.example.com/health/db").trim(),
      nome: "API de inscrições",
    },
    timeZone: "America/Sao_Paulo",
    workerEnabled: process.env.WORKER_ENABLED !== "false",
  });
}

const config = loadConfig();

module.exports = {
  config,
};
