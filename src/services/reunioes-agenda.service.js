const crypto = require("crypto");
const { config } = require("../config/env");
const { getStore } = require("../db");
const { formatarTelefone, normalizarTelefone, variantesTelefone } = require("../domain/telefone");
const calendly = require("./calendly.service");
const googleAgenda = require("./google-agenda.service");
const monday = require("./monday.service");
const reunioes = require("./reunioes.service");
const telegram = require("./telegram.service");

// Lembretes pelas reuniões da agenda do consultor (só leitura), lida a cada poucos minutos.
// Quem decide é a PESSOA, não o nome do evento (decisão de produto): em cada
// reunião, procura a pessoa na Monday pelo telefone da reunião ou pelo e-mail do convidado.
//  - Achou e o título tem "Mentoria" (GOOGLE_AGENDA_IGNORAR): lembretes das sorteadas,
//    se ela for uma sorteada que ainda não agendou.
//  - Achou e é qualquer outro título: lembretes da reunião comercial.
//  - Não achou: nada sai, sem alerta (compromissos pessoais do consultor).
// Eventos do Calendly normalmente já chegaram pelo aviso do Calendly; os que não chegaram
// (aviso perdido ou ignorado) são registrados aqui com os dados do próprio Calendly, como se
// o aviso tivesse chegado, e a equipe recebe um alerta no Telegram.
// Reuniões marcadas direto na agenda: horário mudado -> "reagendada"; evento apagado ou
// cancelado -> "cancelada". Eventos de dia inteiro ficam de fora.
const INDICE = "reuniao_agenda_indice";
const DEMORA_ALERTA_MS = 6 * 60 * 60000;

let rodando = false;
let ultimoAlerta = 0;
// Aviso só depois de 2 falhas seguidas (cerca de 10 min): uma oscilação de rede de
// segundos não vira alarme. Quando voltar, avisa que voltou (v2.16.1).
const FALHAS_PARA_AVISAR = 2;
let falhasSeguidas = 0;
let avisado = false;

function reiniciarAlertas() {
  ultimoAlerta = 0;
  falhasSeguidas = 0;
  avisado = false;
}

function agendamento() {
  return require("./agendamento.service");
}

// O ID de um evento do Google pode ser bem longo (convites vindos de outros calendários):
// as chaves usam um código curto e fixo tirado dele (o ID inteiro fica no registro).
const ref = (texto) => crypto.createHash("sha1").update(String(texto)).digest("hex").slice(0, 24);
const chave = (googleId) => `reuniao:agenda:${ref(googleId)}`;
const evento = (googleId) => `agenda:${ref(googleId)}`;

function doCalendly(ev) {
  return /calendly\.com/i.test(`${ev.description || ""} ${ev.location || ""}`);
}

// "https://calendly.com/events/<ID>/google_meet" na descrição -> o evento na API do Calendly.
function eventoCalendly(ev) {
  const m = `${ev.description || ""} ${ev.location || ""}`.match(/calendly\.com\/events\/([0-9a-f-]{20,})/i);
  return m ? `https://api.calendly.com/scheduled_events/${m[1]}` : null;
}

// Telefones escritos na descrição ("Seu WhatsApp com DDD: 51999001234", "Telefone: ...").
function telefonesDaDescricao(ev) {
  // v2.18.0: aceita rótulo em negrito do editor do Google (<b>WhatsApp:</b> 21 9...), número
  // na linha de baixo, link tel:/wa.me, hora na mesma linha e dois números na linha.
  const texto = String(ev.description || "")
    .replace(/<br\s*\/?>|<\/(p|div|li)>/gi, "\n")
    .replace(/<a[^>]*href="tel:([^"]+)"[^>]*>/gi, " tel: $1 ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ");
  const linhas = texto.split(/\n/);
  // Texto do Google Meet ("Participar por telefone", "(BR) +55 21 4560-7276 PIN: ...",
  // tel.meet/...): não é o telefone da pessoa.
  const doMeet = (linha) => /PIN|meet\.|participar por telefone|join by phone|mais números|more phone/i.test(linha || "");
  const telefones = [];
  linhas.forEach((linha, i) => {
    if (!/whats|telefone|celular|fone|wa\.me|tel:/i.test(linha) || doMeet(linha)) return;
    // Jeito antigo (v2.17): todos os dígitos depois do último ":" (aceita 51-9-9900-1234 etc.).
    const antigo = normalizarTelefone((linha.split(":").pop() || "").replace(/[^\d+]/g, ""));
    if (antigo) telefones.push(antigo);
    const seguinte = doMeet(linhas[i + 1]) ? "" : linhas[i + 1] || "";
    const alvo = `${linha} ${/\d/.test(linha.replace(/\d{1,2}:\d{2}/g, "")) ? "" : seguinte}`;
    for (const m of alvo.matchAll(/(?:\+?\s?55[\s.-]*)?\(?\d{2}\)?[\s.-]*9?\s?\d{4}[\s.-]?\d{4}/g)) {
      const telefone = normalizarTelefone(m[0].replace(/[^\d+]/g, ""));
      if (telefone) telefones.push(telefone);
    }
  });
  return [...new Set(telefones)];
}

function telefonesDoConvidado(p) {
  const candidatos = [p.text_reminder_number, ...(p.questions_and_answers || []).map((qa) => qa.answer)];
  return [...new Set(candidatos.map((v) => normalizarTelefone(v)).filter(Boolean))];
}

// Cadastro na Monday pelo telefone e, se não achar, pelo e-mail. Devolve { item, email } ou null.
async function cadastroDaPessoa({ telefones = [], emails = [] }) {
  for (const telefone of telefones) {
    const itens = await monday.buscarPorTelefone(telefone);
    // v2.18.0: achada pelo telefone, o e-mail do convite pode ser de outra pessoa (ex.:
    // secretária): não é guardado como o e-mail dela.
    if (itens.length) return { item: { ...itens[0], telefone }, email: "", via: "telefone" };
  }
  for (const email of emails) {
    const itens = await monday.buscarPorEmail(email);
    if (itens.length) return { item: itens[0], email, via: "email" };
  }
  return null;
}

// Marca de "evento já conferido nesta versão" (não consulta Monday nem Calendly de novo).
const marcaConferido = (ev) => `reuniao_agenda_sem_cadastro:${ref(`${ev.id}:${ev.updated || ""}`)}`;

const semAcento = (texto) => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// Mentoria das sorteadas: título com uma palavra de GOOGLE_AGENDA_IGNORAR ("Mentoria").
function ehMentoria(ev) {
  const titulo = semAcento(ev.summary);
  return config.agenda.ignorar.some((palavra) => titulo.includes(semAcento(palavra)));
}

// E-mails dos convidados (sem o dono da agenda e sem salas).
function convidados(ev) {
  return (ev.attendees || [])
    .filter((a) => a.email && !a.self && !a.resource && a.email.toLowerCase() !== config.agenda.id.toLowerCase())
    .map((a) => a.email.trim().toLowerCase());
}

// A pessoa do registro ainda está no evento? Pelo e-mail do convite ou pelo telefone da
// descrição (os dois jeitos de achar o cadastro). Registro sem nenhum dos dois: continua.
function pessoaContinua(registro, ev) {
  const { email, telefone, via } = registro.dados;
  const pelaEmail = () => Boolean(email) && convidados(ev).includes(String(email).toLowerCase());
  const peloTelefone = () => {
    if (!telefone) return false;
    const alvo = new Set(variantesTelefone(telefone));
    return telefonesDaDescricao(ev).some((t) => alvo.has(t));
  };
  // Confere pelo mesmo jeito que a pessoa foi achada (v2.18.0).
  if (via === "telefone") return peloTelefone();
  if (via === "email") return pelaEmail();
  if (!email && !telefone) return true;
  return pelaEmail() || peloTelefone();
}

// Reunião marcada (ou remarcada) sem tempo para nenhum lembrete (v2.17.0): a equipe avisa
// a pessoa. Uma vez por reunião e horário.
async function avisarSemLembrete(registroDados, inicio, plano) {
  if (plano.vespera || plano.dia) return;
  await getStore().criarTarefa({
    chave: `reuniao_sem_lembrete:${ref(registroDados.googleId || registroDados.evento)}:${inicio.toISOString()}`,
    tipo: "telegram_resumo",
    dados: {
      texto: [
        "⏰ <b>Reunião sem lembrete</b>",
        `👤 ${telegram.escapeHtml(registroDados.nome || "")}${registroDados.telefone ? ` · ${telegram.escapeHtml(formatarTelefone(registroDados.telefone))}` : ""}`,
        `🗓 ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}`,
        "Marcada em cima da hora: não dá tempo de mandar o lembrete pelo WhatsApp. Avise a pessoa.",
      ].join("\n"),
    },
  });
  agendamento().agendarProcessamento();
}

// Versão nova dos lembretes (contador): lembretes de versões anteriores não saem (v2.18.0).
function proximaVersao(dados, inicio) {
  const n = (dados.versaoN || 0) + 1;
  return { n, versao: `${inicio.getTime()}-${n}` };
}

// Cadastro sem WhatsApp válido: os lembretes não têm para onde ir (v2.18.0).
async function avisarSemWhatsapp(registroDados, inicio) {
  if (registroDados.telefone) return;
  await getStore().criarTarefa({
    chave: `reuniao_sem_whatsapp:${ref(registroDados.googleId || registroDados.evento)}:${registroDados.itemId || ""}`,
    tipo: "telegram_resumo",
    dados: {
      texto: [
        "📵 <b>Reunião sem WhatsApp no cadastro</b>",
        `👤 ${telegram.escapeHtml(registroDados.nome || "")}`,
        `🗓 ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}`,
        "O cadastro na Monday não tem um telefone válido: os lembretes não vão sair. Corrija o telefone ou avise a pessoa.",
      ].join("\n"),
    },
  });
  agendamento().agendarProcessamento();
}

// Reunião que já aconteceu (ou foi marcada como passada): fecha sem mensagem nem aviso.
async function encerrar(registro) {
  await reunioes.atualizarRegistro(registro, { situacao: "realizada", canceladaPelaAgenda: true });
}

async function lerIndice() {
  const store = getStore();
  const indice = await store.criarTarefa({ chave: INDICE, tipo: "reuniao_indice", dados: { eventos: [] } });
  return indice;
}

async function salvarIndice(indice, eventos) {
  await getStore().atualizarTarefa(indice.id, { dados: { eventos: [...new Set(eventos)].slice(-300) } });
}

// Cadastro na Monday de quem está na reunião (telefone da descrição ou e-mail do convidado).
async function cadastroDoConvidado(ev) {
  const store = getStore();
  const emails = convidados(ev);

  // Com marca do Calendly para o mesmo horário: a reunião já está registrada por lá.
  for (const email of emails) {
    if (await store.tarefaPorChave(reunioes.marcaCalendly(email, ev.start.dateTime))) return { calendly: true };
  }

  return cadastroDaPessoa({ telefones: telefonesDaDescricao(ev), emails });
}

async function registrarNova(ev, agora, indice, eventos) {
  const store = getStore();
  const inicio = new Date(ev.start.dateTime);
  // Evento sem convidado cadastrado já conferido nesta versão: não consulta a Monday de novo.
  const conferido = marcaConferido(ev);

  if (await store.tarefaPorChave(conferido)) return "sem_cadastro";

  const achado = await cadastroDoConvidado(ev);

  if (achado?.calendly) return "calendly";

  if (!achado) {
    await store.criarTarefa({ chave: conferido, tipo: "reuniao_marca", dados: {} });
    return "sem_cadastro";
  }

  const registro = await store.criarTarefa({
    chave: chave(ev.id),
    tipo: "reuniao_registro",
    dados: {
      evento: evento(ev.id),
      origem: "agenda",
      googleId: ev.id,
      // Ocorrência de um evento que se repete (ex.: "Consultoria - Andreia", toda segunda).
      recorrente: Boolean(ev.recurringEventId),
      nome: achado.item.nome,
      email: achado.email,
      via: achado.via,
      telefone: normalizarTelefone(achado.item.telefone) || "",
      contatoId: null,
      itemId: achado.item.id,
      inicio: inicio.toISOString(),
      fim: ev.end?.dateTime || null,
      link: googleAgenda.linkDoMeet(ev),
      // Sem Calendly não há link individual: "Não posso" manda o link geral para marcar outro horário.
      reagendar: config.calendly.url || "",
      cancelar: "",
      situacao: "ativa",
      confirmacao: "pendente",
      enviados: [],
      agendadoEm: agora.toISOString(),
    },
  });

  if (!registro.criada) return "ja_registrada";
  if (!registro.dados) throw new Error("O registro da reunião não foi gravado no banco.");

  eventos.push(ev.id);
  await salvarIndice(indice, eventos);
  const plano = await reunioes.programarAvisos(evento(ev.id), inicio, agora);
  await avisarSemLembrete(registro.dados, inicio, plano);
  await avisarSemWhatsapp(registro.dados, inicio);
  await reunioes.anotar(
    registro,
    `reuniao_nota:agenda:${ref(ev.id)}:marcada`,
    `Reunião marcada direto na agenda do consultor para ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}: entra nos lembretes pelo WhatsApp.`
  );
  return "registrada";
}

async function remarcar(registro, ev, agora) {
  const inicio = new Date(ev.start.dateTime);
  const { n, versao } = proximaVersao(registro.dados, inicio);
  const atual = await reunioes.atualizarRegistro(registro, {
    inicio: inicio.toISOString(),
    fim: ev.end?.dateTime || null,
    link: googleAgenda.linkDoMeet(ev) || registro.dados.link,
    confirmacao: "pendente",
    enviados: [],
    agendadoEm: agora.toISOString(),
    versaoN: n,
    avisosVersao: versao,
  });

  const plano = await reunioes.programarAvisos(registro.dados.evento, inicio, agora, versao);
  await avisarSemLembrete(atual.dados, inicio, plano);

  if (config.manychat.flowReuniao.reagendada) {
    await getStore().criarTarefa({
      chave: `reuniao_msg:agenda:${ref(ev.id)}:reagendada:${versao}`,
      tipo: "reuniao_msg",
      dados: { evento: registro.dados.evento, aviso: "reagendada" },
    });
  }

  await reunioes.anotar(
    atual,
    `reuniao_nota:agenda:${ref(ev.id)}:remarcada:${versao}`,
    `Reunião remarcada na agenda para ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}.`
  );
}

// O Consultor reaproveitou o evento para outra pessoa (trocou o convidado) (v2.17.0): o
// registro passa para a pessoa nova (os lembretes já agendados vão para ela). Sem cadastro
// da pessoa nova na Monday (ou sem convidado): o registro sai em silêncio.
async function trocarPessoa(registro, ev, agora, resultado) {
  const achado = await cadastroDoConvidado(ev);
  if (!achado || achado.calendly) {
    await cancelar(registro, agora, { silencioso: true });
    resultado.canceladas++;
    return;
  }

  const antes = registro.dados;
  const inicio = new Date(ev.start.dateTime);
  const telefone = normalizarTelefone(achado.item.telefone) || "";

  // Mesma pessoa, achada de outro jeito (descrição editada, telefone tirado): só atualiza
  // como ela é reconhecida. Sem versão nova, sem lembrete repetido, sem aviso.
  if (String(achado.item.id) === String(antes.itemId)) {
    await reunioes.atualizarRegistro(registro, { via: achado.via, email: achado.email || antes.email, telefone: telefone || antes.telefone });
    return;
  }

  const contatoNovo = telefone ? await getStore().contatoManychat(telefone) : null;
  const antigos = new Set([...(antes.contatosAntigos || []), ...(antes.contatoId ? [String(antes.contatoId)] : [])]);
  if (contatoNovo) antigos.delete(String(contatoNovo)); // quem saiu e voltou responde de novo
  const { n, versao } = proximaVersao(antes, inicio);
  const atual = await reunioes.atualizarRegistro(registro, {
    nome: achado.item.nome,
    email: achado.email,
    via: achado.via,
    telefone,
    itemId: achado.item.id,
    contatoId: contatoNovo || null,
    // Quem saiu não confirma nem desmarca a reunião da pessoa nova pelo WhatsApp.
    contatosAntigos: [...antigos],
    confirmacao: "pendente",
    enviados: [],
    inicio: inicio.toISOString(),
    fim: ev.end?.dateTime || null,
    link: googleAgenda.linkDoMeet(ev) || antes.link,
    versaoN: n,
    avisosVersao: versao,
  });
  resultado.trocadas = (resultado.trocadas || 0) + 1;

  // Lembretes refeitos para a pessoa nova a partir de agora (v2.18.0: antes, se o do dia já
  // tinha saído para quem saiu, a pessoa nova ficava sem nada).
  const plano = await reunioes.programarAvisos(antes.evento, inicio, agora, versao);
  await avisarSemLembrete(atual.dados, inicio, plano);
  await avisarSemWhatsapp(atual.dados, inicio);

  await getStore().criarTarefa({
    chave: `reuniao_troca:${ref(antes.googleId)}:${achado.item.id}:${n}`,
    tipo: "telegram_resumo",
    dados: {
      texto: [
        "🔄 <b>Convidado trocado na agenda do consultor</b>",
        `🗓 ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}`,
        `Era: ${telegram.escapeHtml(antes.nome || "?")}`,
        `Agora: ${telegram.escapeHtml(achado.item.nome || "?")}`,
        "Os lembretes passam a ir para a pessoa nova.",
      ].join("\n"),
    },
  });
  agendamento().agendarProcessamento();
  await reunioes.anotar(
    atual,
    `reuniao_nota:agenda:${ref(antes.googleId)}:troca:${achado.item.id}:${n}`,
    `Reunião marcada direto na agenda do consultor para ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}: entra nos lembretes pelo WhatsApp.`
  );
}

// Reunião fechada que volta a valer na agenda (desfez a exclusão, ou a pessoa nova passou a
// ter cadastro) (v2.18.0): reativa com a pessoa do evento e avisa a equipe.
async function reativar(registro, ev, agora, resultado) {
  const store = getStore();
  const conferido = marcaConferido(ev);
  if (await store.tarefaPorChave(conferido)) return;

  const achado = await cadastroDoConvidado(ev);
  if (!achado || achado.calendly) {
    await store.criarTarefa({ chave: conferido, tipo: "reuniao_marca", dados: {} });
    return;
  }

  const antes = registro.dados;
  const inicio = new Date(ev.start.dateTime);
  const telefone = normalizarTelefone(achado.item.telefone) || "";
  const { n, versao } = proximaVersao(antes, inicio);
  const atual = await reunioes.atualizarRegistro(registro, {
    situacao: "ativa",
    canceladaPelaAgenda: false,
    canceladaSemAviso: false,
    nome: achado.item.nome,
    email: achado.email,
    via: achado.via,
    telefone,
    itemId: achado.item.id,
    contatoId: (telefone && (await store.contatoManychat(telefone))) || null,
    confirmacao: "pendente",
    enviados: [],
    mensagemCancelamento: false,
    inicio: inicio.toISOString(),
    fim: ev.end?.dateTime || null,
    link: googleAgenda.linkDoMeet(ev) || antes.link,
    versaoN: n,
    avisosVersao: versao,
  });
  resultado.registradas++;

  const plano = await reunioes.programarAvisos(antes.evento, inicio, agora, versao);
  await avisarSemLembrete(atual.dados, inicio, plano);
  await avisarSemWhatsapp(atual.dados, inicio);

  await store.criarTarefa({
    chave: `reuniao_voltou:${ref(antes.googleId)}:${n}`,
    tipo: "telegram_resumo",
    dados: {
      texto: [
        "🔁 <b>Reunião de volta à agenda do consultor</b>",
        `👤 ${telegram.escapeHtml(achado.item.nome || "")}`,
        `🗓 ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}`,
        (antes.enviados || []).includes("cancelada")
          ? "Ela tinha recebido o aviso de cancelamento: avise que a reunião continua. Os lembretes voltam a sair normalmente."
          : "Os lembretes voltam a sair normalmente.",
      ].join("\n"),
    },
  });
  agendamento().agendarProcessamento();
  await reunioes.anotar(atual, `reuniao_nota:agenda:${ref(antes.googleId)}:voltou:${n}`, `Reunião de volta à agenda do consultor para ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}.`);
}

// Ocorrência de série que se repete: quando o consultor muda a série, a ocorrência antiga
// some ou vira "cancelada" sem que a reunião tenha sido desmarcada com a cliente.
function ehRecorrente(registro, ev) {
  return Boolean(registro.dados.recorrente || ev?.recurringEventId || /_\d{8}T\d{6}Z$/.test(String(registro.dados.googleId || "")));
}

// silencioso (v2.16.2): reunião que saiu da agenda sem ter sido apagada (ex.: série
// recorrente alterada). Não manda "cancelada" para a pessoa; avisa a equipe para conferir.
async function cancelar(registro, agora, { silencioso = false } = {}) {
  // canceladaPelaAgenda: só estas podem voltar a valer se o evento reaparecer (v2.18.0);
  // cancelamento pedido pela pessoa (WhatsApp/Calendly) nunca é reativado.
  const atual = await reunioes.atualizarRegistro(registro, { situacao: "cancelada", canceladaEm: agora.toISOString(), canceladaPelaAgenda: true, canceladaSemAviso: Boolean(silencioso) });

  if (silencioso) {
    const inicio = new Date(registro.dados.inicio);
    await getStore().criarTarefa({
      chave: `reuniao_sumiu:${ref(registro.dados.googleId)}:${registro.dados.inicio}${registro.dados.versaoN ? `:${registro.dados.versaoN}` : ""}`,
      tipo: "telegram_resumo",
      dados: {
        texto: [
          "⚠️ <b>Reunião saiu da agenda do consultor</b>",
          `👤 ${telegram.escapeHtml(registro.dados.nome || "")}`,
          `🗓 Era ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}`,
          "O evento foi alterado ou removido sem ser apagado (ex.: mudança numa reunião que se repete). Não mandei mensagem de cancelamento para a pessoa: confira se precisa avisá-la.",
        ].join("\n"),
      },
    });
    agendamento().agendarProcessamento();
    await reunioes.anotar(atual, `reuniao_nota:agenda:${ref(registro.dados.googleId)}:saiu${registro.dados.versaoN ? `:${registro.dados.versaoN}` : ""}`, "Reunião saiu da agenda do consultor (sem mensagem de cancelamento para a pessoa).");
    return;
  }

  if (!registro.dados.mensagemCancelamento && config.manychat.flowReuniao.cancelada) {
    await getStore().criarTarefa({
      chave: `reuniao_msg:agenda:${ref(registro.dados.googleId)}:cancelada${registro.dados.versaoN ? `:${registro.dados.versaoN}` : ""}`,
      tipo: "reuniao_msg",
      dados: { evento: registro.dados.evento, aviso: "cancelada" },
    });
  }

  await reunioes.anotar(atual, `reuniao_nota:agenda:${ref(registro.dados.googleId)}:cancelada${registro.dados.versaoN ? `:${registro.dados.versaoN}` : ""}`, "Reunião cancelada na agenda do consultor.");
}

// Uma leitura da agenda. Devolve contagens (sem dados pessoais) para o log e o diagnóstico.
async function sincronizarAgenda(agora = reunioes.agora()) {
  if (!googleAgenda.isConfigured()) return { status: "desligado" };
  if (rodando) return { status: "ja_rodando" };
  rodando = true;

  const store = getStore();
  const resultado = { eventos: 0, registradas: 0, recuperadas: 0, mentorias: 0, remarcadas: 0, canceladas: 0, calendly: 0, semCadastro: 0, erros: 0 };

  try {
    const fim = new Date(agora.getTime() + config.agenda.dias * 86400000);
    const lista = await googleAgenda.listarEventos({ de: new Date(agora.getTime() - 2 * 3600000), ate: fim });
    const indice = await lerIndice();
    const eventos = [...(indice.dados?.eventos || [])];
    const vistos = new Set();

    for (const ev of lista) {
      vistos.add(ev.id);
      try {
        await lerEvento(ev, agora, indice, eventos, resultado);
      } catch (error) {
        // Um evento com problema não impede os outros; o erro vai para o log.
        resultado.erros++;
        // Título e horário para achar o evento na agenda.
        console.error(`Evento da agenda não processado ("${ev.summary || "sem título"}", ${ev.start?.dateTime || ev.start?.date || "?"}):`, error.message);
      }
    }

    // O índice pode perder itens (duas cópias do app no deploy): confere também todas as
    // reuniões da agenda ainda ativas e futuras (v2.16.2).
    // Inclui registros antigos, gravados antes de a chave usar o código resumido (03/11).
    const extras = new Map();
    for (const t of await store.tarefasComPrefixo("reuniao:agenda:")) {
      if (t.tipo === "reuniao_registro" && t.dados?.situacao === "ativa" && t.dados.googleId && new Date(t.dados.inicio) > agora && t.chave !== chave(t.dados.googleId)) {
        extras.set(t.dados.googleId, t);
      } else if (t.tipo === "reuniao_registro" && t.dados?.situacao === "ativa" && t.dados.googleId && new Date(t.dados.inicio) > agora && !eventos.includes(t.dados.googleId)) {
        eventos.push(t.dados.googleId);
      }
    }

    // Registro antigo (chave longa): confere direto, mesmo que o código apareça na leitura.
    for (const [googleId, registro] of extras) {
      try {
        await conferirSumida(googleId, agora, resultado, registro);
      } catch (error) {
        resultado.erros++;
        console.error("Reunião da agenda não conferida:", error.message);
      }
    }

    // Reunião registrada que sumiu da leitura (apagada da agenda ou movida para longe).
    for (const googleId of eventos) {
      if (vistos.has(googleId)) continue;
      try {
        await conferirSumida(googleId, agora, resultado);
      } catch (error) {
        resultado.erros++;
        console.error("Reunião da agenda não conferida:", error.message);
      }
    }

    // O índice guarda só as reuniões que ainda vão acontecer.
    const futuras = [];
    for (const googleId of eventos) {
      const registro = await store.tarefaPorChave(chave(googleId));
      if (registro?.dados?.situacao === "ativa" && new Date(registro.dados.inicio) > agora) futuras.push(googleId);
    }
    await salvarIndice(indice, futuras);

    if (resultado.registradas || resultado.recuperadas || resultado.mentorias || resultado.remarcadas || resultado.canceladas || resultado.erros) {
      console.log("Agenda do consultor lida:", resultado);
      agendamento().agendarProcessamento();
    }

    await voltou();
    return { status: "ok", ...resultado };
  } catch (error) {
    return falhou(error);
  } finally {
    rodando = false;
  }
}

// Um evento da leitura: cancelado, remarcado, já registrado ou uma reunião nova.
async function lerEvento(ev, agora, indice, eventos, resultado) {
  const registro = await getStore().tarefaPorChave(chave(ev.id));

  if (ev.status === "cancelled") {
    if (registro?.dados.situacao === "ativa") {
      // Apagada depois de acontecer: só fecha, sem "cancelada" (v2.18.0).
      if (new Date(registro.dados.inicio) <= agora) await encerrar(registro);
      else await cancelar(registro, agora, { silencioso: ehRecorrente(registro, ev) });
      resultado.canceladas++;
    }
    return;
  }

  if (!ev.start?.dateTime) {
    // Virou evento de dia inteiro: não é mais reunião com horário (v2.18.0).
    if (registro?.dados.situacao === "ativa" && registro.dados.origem === "agenda" && new Date(registro.dados.inicio) > agora) {
      await cancelar(registro, agora, { silencioso: true });
      resultado.canceladas++;
    }
    return; // dia inteiro
  }
  resultado.eventos++;

  if (registro) {
    const novoInicio = new Date(ev.start.dateTime);
    // Fechada (apagada e desfeita, ou pessoa sem cadastro que passou a ter): reativa.
    if (["cancelada", "realizada"].includes(registro.dados.situacao) && registro.dados.origem === "agenda" && registro.dados.canceladaPelaAgenda && novoInicio > agora) {
      await reativar(registro, ev, agora, resultado);
      return;
    }
    // Movida para um horário que já passou: fecha em silêncio (v2.18.0).
    if (registro.dados.situacao === "ativa" && novoInicio <= agora && novoInicio.toISOString() !== registro.dados.inicio && new Date(registro.dados.inicio) > agora) {
      await encerrar(registro);
      return;
    }
    if (registro.dados.situacao === "ativa" && registro.dados.origem === "agenda" && new Date(registro.dados.inicio) > agora && !pessoaContinua(registro, ev)) {
      await trocarPessoa(registro, ev, agora, resultado);
      return;
    }
    const inicio = new Date(ev.start.dateTime).toISOString();
    if (registro.dados.situacao === "ativa" && inicio !== registro.dados.inicio && new Date(inicio) > agora) {
      await remarcar(registro, ev, agora);
      resultado.remarcadas++;
    } else if (!registro.dados.link && googleAgenda.linkDoMeet(ev)) {
      await reunioes.atualizarRegistro(registro, { link: googleAgenda.linkDoMeet(ev) });
    }
    return;
  }

  if (new Date(ev.start.dateTime) <= agora) return;

  const uriCalendly = eventoCalendly(ev);
  if (uriCalendly) return lerDoCalendly(ev, uriCalendly, agora, resultado);
  if (doCalendly(ev)) {
    resultado.calendly++;
    return;
  }

  if (ehMentoria(ev)) return mentoriaDaAgenda(ev, agora, resultado);

  const r = await registrarNova(ev, agora, indice, eventos);
  if (r === "registrada") resultado.registradas++;
  else if (r === "calendly") resultado.calendly++;
  else if (r === "sem_cadastro") resultado.semCadastro++;
}

// Evento do Calendly na agenda. Normalmente o aviso do Calendly já registrou a reunião;
// se não registrou, busca os dados no Calendly e registra como se o aviso tivesse chegado.
async function lerDoCalendly(ev, uri, agora, resultado) {
  const store = getStore();
  const mentoria = ehMentoria(ev);

  if (!mentoria && (await store.tarefaPorChave(reunioes.chaveRegistro(uri)))) {
    resultado.calendly++;
    return;
  }

  const conferido = marcaConferido(ev);
  if (await store.tarefaPorChave(conferido)) {
    resultado.calendly++;
    return;
  }

  // Recém-agendado: o aviso do Calendly chega em segundos. Espera 10 minutos antes de
  // concluir que ele não chegou (sem isso, sairia um alerta de "recuperada" à toa).
  if (ev.created && agora.getTime() - Date.parse(ev.created) < 10 * 60000) {
    resultado.calendly++;
    return;
  }

  let eventoCal;
  let lista;
  try {
    [eventoCal, lista] = await Promise.all([calendly.obterEvento(uri), calendly.listarConvidados(uri)]);
  } catch (error) {
    // Link do Calendly de OUTRA conta (ex.: o consultor marcou no Calendly de outra pessoa) ou
    // evento apagado: não é reunião nossa. Marca como conferido para não tentar a cada 5
    // minutos (v2.16.1); se o evento for editado na agenda, confere de novo.
    if (error.status !== 403 && error.status !== 404) throw error;
    await store.criarTarefa({ chave: conferido, tipo: "reuniao_marca", dados: { calendly: error.status } });
    resultado.calendly++;
    return;
  }
  const convidado = lista[0];
  if (!convidado || eventoCal.status === "canceled") {
    await store.criarTarefa({ chave: conferido, tipo: "reuniao_marca", dados: {} });
    resultado.calendly++;
    return;
  }

  const p = { ...convidado, scheduled_event: { ...eventoCal, uri } };

  if (mentoria) {
    const r = await mentoriaSvc().receberDaAgenda(p, agora);
    await store.criarTarefa({ chave: conferido, tipo: "reuniao_marca", dados: {} });
    if (r.mentoria === "agendada") resultado.mentorias++;
    else resultado.calendly++;
    return;
  }

  const email = String(p.email || "").trim().toLowerCase();
  const achado = await cadastroDaPessoa({ telefones: telefonesDoConvidado(p), emails: email ? [email] : [] });
  if (!achado) {
    await store.criarTarefa({ chave: conferido, tipo: "reuniao_marca", dados: {} });
    resultado.semCadastro++;
    return;
  }

  await agendamento().agendou(p);
  resultado.recuperadas++;

  const inicio = new Date(ev.start.dateTime);
  try {
    await telegram.enviarAviso(
      [
        "🛟 <b>Reunião recuperada pela agenda</b>",
        `👤 ${telegram.escapeHtml(p.name || achado.item.nome || "")}`,
        `🗓 ${reunioes.textoData(inicio)}, às ${reunioes.textoHora(inicio)}`,
        `O aviso do Calendly não tinha registrado essa reunião (evento "${telegram.escapeHtml(eventoCal.name || "?")}"). Ela entrou agora nos lembretes.`,
      ].join("\n")
    );
  } catch (error) {
    console.error("Aviso da reunião recuperada no Telegram falhou:", error.message);
  }
}

// Mentoria marcada direto na agenda (sem Calendly): liga à sorteada que ainda não agendou.
async function mentoriaDaAgenda(ev, agora, resultado) {
  const store = getStore();
  const conferido = marcaConferido(ev);
  if (await store.tarefaPorChave(conferido)) {
    resultado.semCadastro++;
    return;
  }

  const id = `agenda:${ref(ev.id)}`;
  const telefones = telefonesDaDescricao(ev);
  const p = {
    uri: id,
    name: ev.summary || "",
    email: convidados(ev)[0] || "",
    text_reminder_number: telefones[0] || null,
    questions_and_answers: telefones.slice(1).map((answer) => ({ answer })),
    scheduled_event: {
      uri: id,
      name: ev.summary || "",
      start_time: ev.start.dateTime,
      end_time: ev.end?.dateTime || null,
      location: { join_url: googleAgenda.linkDoMeet(ev) },
    },
  };

  const r = await mentoriaSvc().receberDaAgenda(p, agora);
  await store.criarTarefa({ chave: conferido, tipo: "reuniao_marca", dados: {} });
  if (r.mentoria === "agendada") resultado.mentorias++;
  else resultado.semCadastro++;
}

function mentoriaSvc() {
  return require("./mentoria.service");
}

async function conferirSumida(googleId, agora, resultado, registroAntigo = null) {
  const store = getStore();
  const registro = registroAntigo || (await store.tarefaPorChave(chave(googleId)));
  if (!registro || registro.dados.situacao !== "ativa" || new Date(registro.dados.inicio) <= agora) return;

  let ev = null;
  try {
    ev = await googleAgenda.obterEvento(googleId);
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) throw error;
  }

  if (!ev || ev.status === "cancelled") {
    // Não existe mais (404) ou ocorrência de série alterada: sem mensagem para a pessoa.
    await cancelar(registro, agora, { silencioso: !ev || ehRecorrente(registro, ev) });
    resultado.canceladas++;
    return;
  }

  // O evento existe, mas não veio na leitura com este código, e o novo horário está dentro
  // do período lido: a agenda o mostra com outro código (ex.: série que se repete foi
  // alterada) e ele tem (ou terá) o próprio registro. Remarcar aqui duplicaria os lembretes
  // e mandaria "reagendada" à toa (caso Beatriz, 09/11): sai em silêncio (v2.16.3).
  const novoInicio = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
  if (!novoInicio) {
    await cancelar(registro, agora, { silencioso: true }); // virou dia inteiro
    resultado.canceladas++;
    return;
  }
  if (novoInicio <= agora) {
    await encerrar(registro); // marcada para um horário que já passou
    return;
  }
  const fimLeitura = new Date(agora.getTime() + config.agenda.dias * 86400000);
  if (novoInicio && novoInicio.toISOString() !== registro.dados.inicio && novoInicio >= new Date(agora.getTime() - 2 * 3600000) && novoInicio <= fimLeitura) {
    await cancelar(registro, agora, { silencioso: true });
    resultado.canceladas++;
    return;
  }

  if (ev.start?.dateTime && new Date(ev.start.dateTime).toISOString() !== registro.dados.inicio) {
    // Movido para depois do período lido (mais de 30 dias): remarca.
    await remarcar(registro, ev, agora);
    resultado.remarcadas++;
  }
}

async function voltou() {
  const estavaAvisado = avisado;
  falhasSeguidas = 0;
  avisado = false;
  if (!estavaAvisado) return;
  try {
    await telegram.enviarAviso("✅ <b>Voltei a ler a agenda do consultor</b>\nOs lembretes das reuniões marcadas direto na agenda seguem normalmente.");
  } catch {
    // O log já registra a leitura.
  }
}

async function falhou(error) {
  console.error("Leitura da agenda do consultor falhou:", error.message);
  falhasSeguidas++;

  // Depois de 2 falhas seguidas; e de novo a cada 6 horas, se continuar falhando.
  if (falhasSeguidas >= FALHAS_PARA_AVISAR && Date.now() - ultimoAlerta > DEMORA_ALERTA_MS) {
    ultimoAlerta = Date.now();
    avisado = true;
    try {
      await telegram.enviarAviso(
        `🔴 <b>Não consegui ler a agenda do consultor</b>\nOs lembretes das reuniões marcadas direto na agenda podem não sair.\n(${telegram.escapeHtml(error.message)})`
      );
    } catch {
      // O log já registrou.
    }
  }

  return { status: "falhou", erro: error.message };
}

function iniciar() {
  if (!config.workerEnabled || !googleAgenda.isConfigured()) {
    if (!googleAgenda.isConfigured()) console.log("Lembretes pela agenda do consultor desligados (sem GOOGLE_AGENDA_CHAVE).");
    return;
  }

  const rodar = () => sincronizarAgenda().catch((error) => console.error("Agenda do consultor:", error.message));
  setTimeout(rodar, 20000).unref();
  setInterval(rodar, config.agenda.intervaloMin * 60000).unref();
}

module.exports = {
  iniciar,
  reiniciarAlertas,
  sincronizarAgenda,
  telefonesDaDescricao,
};
