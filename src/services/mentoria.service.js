const crypto = require("crypto");
const os = require("os");

const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataHoraBR, dataSP, diaSemanaHora } = require("../domain/datas");
const { chaveTelefone, formatarTelefone, normalizarTelefone } = require("../domain/telefone");
const { emFila } = require("../utils/fila");
const calendly = require("./calendly.service");
const convites = require("./convites.service");
const manychat = require("./manychat.service");
const monday = require("./monday.service");
const telegram = require("./telegram.service");

// Sorteio semanal das mentorias individuais (documento do gestor, Parte 3).
//
// A rodada é identificada pela terça da semana (AAAA-MM-DD). Calendário, em Brasília:
//   terça 12h30   aviso para quem pode concorrer (o quadro menos as Etapas excluídas)
//   quarta 8h     a página fecha (v3.2.2) e o sistema sorteia entre as inscritas; o
//                 resultado vai para o Telegram (v3.2.0)
//   quarta 12h    fim das trocas pelo painel (POST /interno/mentorias/trocar)
//   quarta 12h35  saem os avisos para as sorteadas (a lista já trocada)
//   quarta 19h    lembrete 1 para a sorteada que não agendou
//   quinta 12h    lembrete 2, com o prazo
//   sexta 12h     prazo: quem não agendou perde a vaga
//   sexta 15h     aviso de perda da vaga
// A mentoria agendada (evento do Calendly com "Mentoria" no nome) recebe lembrete
// 1 dia antes e 1 hora antes, com dia, hora e link do Meet nos campos mentoria_*.
// Cada passo deixa um comentário no cadastro da Monday (sem coluna nova).
// Nada aqui é manual. Se o sorteio falhar, avisa no Telegram e não avisa ninguém.

const HORA_MS = 3600000;
const MARCA_ABANDONADA_MS = 10 * 60000;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Mensagem -> [chave em config.manychat.flowSorteio, variável da Hostinger].
const FLUXOS = {
  aviso: ["aviso", "MANYCHAT_FLOW_SORTEIO_AVISO"],
  sorteada: ["sorteada", "MANYCHAT_FLOW_SORTEIO_SORTEADA"],
  lembrete1: ["lembrete1", "MANYCHAT_FLOW_SORTEIO_LEMBRETE1"],
  lembrete2: ["lembrete2", "MANYCHAT_FLOW_SORTEIO_LEMBRETE2"],
  perdeu: ["perdeu", "MANYCHAT_FLOW_SORTEIO_PERDEU_VAGA"],
  vespera: ["vespera", "MANYCHAT_FLOW_MENTORIA_VESPERA"],
  "1hora": ["umaHora", "MANYCHAT_FLOW_MENTORIA_1HORA"],
  verificar: ["verificar", "MANYCHAT_FLOW_SORTEIO_VERIFICAR"],
};

const fluxoDo = (tipo) => config.manychat.flowSorteio[FLUXOS[tipo][0]];
const escapar = (texto) => telegram.escapeHtml(String(texto ?? ""));
const fmt = (opcoes) => new Intl.DateTimeFormat("pt-BR", { timeZone: config.timeZone, ...opcoes });

// ---------- datas ----------

// Brasília não tem horário de verão desde 2019: UTC-3 o ano todo.
const noSP = (data, hora) => new Date(`${data}T${hora}:00-03:00`);

function somarDias(iso, dias) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
}

// A terça da semana de `agora` (a semana da rodada vai de terça a segunda).
function rodadaDe(agora = new Date()) {
  const hoje = dataSP(agora);
  const diaDaSemana = new Date(`${hoje}T12:00:00Z`).getUTCDay();
  return somarDias(hoje, -((diaDaSemana - 2 + 7) % 7));
}

function calendario(rodada) {
  const [quarta, quinta, sexta] = [1, 2, 3].map((dias) => somarDias(rodada, dias));
  return {
    aviso: noSP(rodada, "12:30"),
    // Sorteio (v3.2.0): concorre quem se inscreveu até as 8h, quando a página fecha (v3.2.2).
    sorteio: noSP(quarta, "08:00"),
    // 1 minuto de folga: a inscrição enviada às 7h59 termina de gravar antes do sorteio.
    sorteioRoda: noSP(quarta, "08:01"),
    trocaAte: noSP(quarta, "12:00"),
    // A página fecha na hora do sorteio (v3.2.2; antes, 12h30).
    corte: noSP(quarta, "08:00"),
    // Avisos para as sorteadas (com a lista depois das trocas).
    envio: noSP(quarta, "12:35"),
    sorteioAte: noSP(quarta, "20:00"),
    lembrete1: noSP(quarta, "19:00"),
    lembrete2: noSP(quinta, "12:00"),
    prazo: noSP(sexta, "12:00"),
    perdeu: noSP(sexta, "15:00"),
    // Até quando cada mensagem ainda faz sentido (fila atrasada não sai depois disso).
    validade: {
      aviso: noSP(quarta, "08:00"),
      sorteada: noSP(quarta, "21:00"),
      lembrete1: noSP(quarta, "22:00"),
      lembrete2: noSP(quinta, "18:00"),
      perdeu: noSP(sexta, "20:00"),
    },
  };
}

const diaMes = (iso) => iso.split("-").reverse().slice(0, 2).join("/");

function semAcento(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function excluida(etapa) {
  const alvo = semAcento(etapa);
  return Boolean(alvo) && config.sorteio.etapasExcluidas.some((e) => semAcento(e) === alvo);
}

// ---------- estado da página ----------

// O que a página de inscrição mostra: aberta (com o horário do corte) ou a próxima abertura.
function estado(agora = new Date()) {
  const inicio = config.sorteio.inicio;
  if (!inicio) return { aberta: false, rodada: null, encerraEm: null, proximaAbertura: null };

  const rodada = rodadaDe(agora);
  const cal = calendario(rodada);

  if (rodada >= inicio && agora >= cal.aviso && agora < cal.corte) {
    return {
      aberta: true,
      rodada,
      encerraEm: cal.corte.toISOString(),
      proximaAbertura: null,
      sorteioEm: cal.sorteio.toISOString(),
      // v3.2.2: a página fecha às 8h, então é sempre null (o painel ainda lê o campo).
      depoisDoSorteioVaiPara: null,
    };
  }

  const proxima = [agora < cal.aviso ? rodada : somarDias(rodada, 7), inicio].sort().pop();
  const prox = calendario(proxima);
  return {
    aberta: false,
    rodada: null,
    encerraEm: null,
    proximaAbertura: prox.aviso.toISOString(),
    sorteioEm: prox.sorteio.toISOString(),
    depoisDoSorteioVaiPara: null,
  };
}

// ---------- avisos para a equipe ----------

async function avisarTelegram(texto) {
  try {
    await telegram.enviarAviso(texto);
  } catch (error) {
    console.error("Aviso do sorteio no Telegram falhou:", error.message);
  }
}

// Comentário no histórico do cadastro da Monday, pela fila (tenta de novo se a Monday falhar).
// Com `telefone`, antes troca o telefone do cadastro.
function anotar(chave, itemId, texto, telefone = null) {
  if (!itemId) return null;
  return getStore().criarTarefa({ chave: `mentoria_nota:${chave}`, tipo: "mentoria_nota", dados: { itemId: String(itemId), texto, telefone } });
}

// Achou o cadastro pelo e-mail, com outro telefone: o telefone do cadastro passa a ser o
// informado (regra do documento do gestor), com comentário na Monday.
function trocarTelefone(chave, cadastro, telefone, como) {
  if (chaveTelefone(cadastro.telefone) === chaveTelefone(telefone)) return null;
  return anotar(
    `${chave}:telefone`,
    cadastro.id,
    `Telefone atualizado pelo sorteio das mentorias (${como}): ${formatarTelefone(telefone)} (antes: ${cadastro.telefone || "vazio"}).`,
    telefone
  );
}

const primeiroNome = (nome) => String(nome || "").trim().split(/\s+/)[0] || "";

// ---------- inscrição ----------

// Lista do grupo do WhatsApp que o painel manda (a mesma que a equipe sobe todo dia útil).
async function guardarListaDoGrupo(numeros, salvaEm) {
  const chaves = [...new Set((Array.isArray(numeros) ? numeros : []).map(chaveTelefone).filter(Boolean))];
  const dados = { chaves, salvaEm: new Date(salvaEm || Date.now()).toISOString() };
  const store = getStore();
  const tarefa = await store.criarTarefa({ chave: "grupo_lista:atual", tipo: "grupo_lista", dados });
  if (!tarefa.criada) await store.atualizarTarefa(tarefa.id, { dados });
  return { numeros: chaves.length };
}

async function linhaDoGrupo(telefone) {
  const lista = (await getStore().tarefaPorChave("grupo_lista:atual"))?.dados;
  if (!lista?.chaves) return "Está no grupo: sem lista do grupo no sistema";
  const dia = fmt({ day: "2-digit", month: "2-digit" }).format(new Date(lista.salvaEm));
  return `Está no grupo (lista de ${dia}): ${lista.chaves.includes(chaveTelefone(telefone)) ? "sim" : "não"}`;
}

async function alertarSemCadastro({ rodada, nome, telefone, email, agora, detalhe = null }) {
  // Um alerta por telefone e rodada, mesmo que a pessoa tente várias vezes.
  const marca = await getStore().criarTarefa({ chave: `mentoria_varredura:${rodada}:sem_cadastro:${telefone}`, tipo: "mentoria_varredura" });
  if (!marca.criada) return;

  await avisarTelegram(
    [
      "⚠️ <b>Inscrição no sorteio sem cadastro</b>",
      `Nome: ${escapar(nome)}`,
      `Telefone: ${escapar(formatarTelefone(telefone))} · E-mail: ${escapar(email)}`,
      `Data e hora: ${dataHoraBR(agora)}`,
      await linhaDoGrupo(telefone),
      detalhe ? escapar(detalhe) : null,
      "Essa pessoa tentou se inscrever mas não tem cadastro.",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

// Cadastro pelo telefone digitado (com mais de um, vale o que também tem o e-mail).
async function cadastroPeloTelefone(telefone, email) {
  const porTelefone = await monday.buscarPorTelefone(telefone);
  if (porTelefone.length < 2) return porTelefone[0] || null;
  const porEmail = await monday.buscarPorEmail(email);
  return porTelefone.find((item) => porEmail.some((outro) => outro.id === item.id)) || porTelefone[0];
}

async function inscreverCadastro(rodada, cadastro, { nome, telefone, email, agora }) {
  const inscricao = await getStore().inscreverMentoria({ rodada, mondayItemId: cadastro.id, nome: cadastro.nome || nome, telefone, email, em: agora });
  if (inscricao.nova) {
    await anotar(`${rodada}:inscricao:${cadastro.id}`, cadastro.id, `🎲 Inscreveu-se no sorteio das mentorias (rodada de ${diaMes(rodada)}).`);
    require("./agendamento.service").agendarProcessamento();
  }
  return inscricao.nova;
}

// Quantas mensagens "Verificar cadastro" a rodada já gerou.
async function verificacoesDaRodada(rodada) {
  return (await getStore().tarefasComPrefixo(`mentoria:${rodada}:verificar:`)).length;
}

async function avisarTetoVerificar(rodada) {
  const marca = await getStore().criarTarefa({ chave: `mentoria_varredura:${rodada}:teto_verificar`, tipo: "mentoria_varredura", dados: { concluido: true } });
  if (!marca.criada) return;
  console.error(`Sorteio: teto de ${config.sorteio.tetoVerificar} verificações atingido na rodada ${rodada}.`);
  await avisarTelegram(
    [
      `⚠️ <b>Sorteio: teto de verificações atingido</b> (rodada de ${diaMes(rodada)})`,
      `Já saíram ${config.sorteio.tetoVerificar} mensagens "Verificar cadastro" nesta rodada (inscrições na página sem cadastro na Monday).`,
      "Novos números sem cadastro não recebem mais a mensagem até a próxima rodada. Pode ser abuso da página: confira as inscrições no painel.",
    ].join("\n")
  );
}

// Nem o telefone nem o e-mail acharam o cadastro: a Mani manda o modelo "Verificar cadastro"
// para o número digitado e a pessoa confere o e-mail pelo WhatsApp. Sem o fluxo configurado,
// só avisa a equipe.
async function pedirConfirmacao({ rodada, nome, telefone, email, agora }) {
  if (!fluxoDo("verificar")) {
    await alertarSemCadastro({ rodada, nome, telefone, email, agora }).catch((error) => console.error("Alerta de inscrição sem cadastro falhou:", error.message));
    return { resultado: "nao_encontrada" };
  }

  // Teto por rodada (v2.15.0): número novo depois do teto não recebe a mensagem paga; a
  // equipe é avisada uma vez (possível abuso da página pública).
  const jaPedida = await getStore().tarefaPorChave(chaveDaVerificacao(rodada, telefone));
  if (!jaPedida && (await verificacoesDaRodada(rodada)) >= config.sorteio.tetoVerificar) {
    await avisarTetoVerificar(rodada);
    return { resultado: "nao_encontrada" };
  }

  // Uma verificação por número e rodada: se a anterior não achou o e-mail, a equipe já foi avisada.
  const { criada, dados } = await getStore().criarTarefa({ chave: chaveDaVerificacao(rodada, telefone), tipo: "mentoria_varredura", dados: { nome, email, tentativas: 0 } });
  if (!criada && dados.resolvido) return { resultado: "nao_encontrada" };

  await criarMensagem({ data: rodada, tipo: "verificar", pessoa: { nome, telefone }, ate: calendario(rodada).corte });
  require("./agendamento.service").agendarProcessamento();
  return { resultado: "verificar_whatsapp" };
}

// Inscrição pela página. Resultados: confirmada, verificar_whatsapp, encerrada, nao_encontrada,
// nao_elegivel, invalido.
async function inscrever(corpo, agora = new Date()) {
  const nome = String(corpo?.nome || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const email = String(corpo?.email || "").trim().toLowerCase().slice(0, 160);
  const telefone = normalizarTelefone(corpo?.whatsapp);

  if (!nome || !RE_EMAIL.test(email) || !telefone || corpo?.aceite !== true) return { resultado: "invalido" };

  const { aberta, rodada, proximaAbertura } = estado(agora);
  if (!aberta) return { resultado: "encerrada", proximaAbertura };

  // Documento do gestor: pelo telefone; se não achar, pelo e-mail (aí troca o telefone do cadastro).
  // Quem confirmou pelo WhatsApp nesta rodada já é reconhecida (a troca do telefone na Monday
  // pode ainda estar na fila).
  let cadastro = await cadastroPeloTelefone(telefone, email);
  const peloEmail = !cadastro;
  if (peloEmail) [cadastro] = await monday.buscarPorEmail(email);
  if (!cadastro) cadastro = await cadastroConfirmado(rodada, telefone);

  if (!cadastro) return pedirConfirmacao({ rodada, nome, telefone, email, agora });
  if (excluida(await monday.lerEtapa(cadastro.id))) return { resultado: "nao_elegivel" };
  if (peloEmail) await trocarTelefone(`${rodada}:${cadastro.id}`, cadastro, telefone, "achado pelo e-mail na página");

  return { resultado: "confirmada", nova: await inscreverCadastro(rodada, cadastro, { nome, telefone, email, agora }) };
}

// ---------- confirmação pelo WhatsApp ----------

const TENTATIVAS_EMAIL = 2;

const chaveDaVerificacao = (rodada, telefone) => `mentoria_verificacao:${rodada}:${telefone}`;

// Existe um pedido de verificação do sorteio para o número desse contato nesta rodada?
async function verificacaoPendente(contatoId, agora) {
  const telefone = await getStore().telefoneDoContato(contatoId);
  if (!telefone) return null;
  const tarefa = await getStore().tarefaPorChave(chaveDaVerificacao(rodadaDe(agora), telefone));
  return tarefa && !tarefa.dados.resolvido ? { ...tarefa, telefone } : null;
}

// O cadastro que esse número confirmou pelo WhatsApp nesta rodada (ou null).
async function cadastroConfirmado(rodada, telefone) {
  const dados = (await getStore().tarefaPorChave(chaveDaVerificacao(rodada, telefone)))?.dados;
  return dados?.mondayItemId ? { id: dados.mondayItemId, nome: dados.nomeCadastro, telefone: dados.telefoneAntes } : null;
}

// A pessoa tocou em "Verificar cadastro" e mandou o e-mail (rota /manychat/email). Resultados:
// encontrado (o fluxo manda o link da página de novo), nao_encontrado (pede de novo),
// encaminhado (avisa a equipe), nao_elegivel, encerrada, email_invalido, sem_verificacao.
async function receberEmail({ contatoId, email }, agora = new Date()) {
  return emFila(contatoId, async () => {
    const verificacao = await verificacaoPendente(contatoId, agora);
    return verificacao ? confirmarPorEmail(verificacao, email, agora) : { resultado: "sem_verificacao" };
  });
}

async function confirmarPorEmail(verificacao, email, agora) {
  const alvo = String(email || "").trim().toLowerCase();
  if (!RE_EMAIL.test(alvo)) return { resultado: "email_invalido" };

  const store = getStore();
  const { telefone, dados } = verificacao;
  const rodada = rodadaDe(agora);
  const guardar = (extra) => store.atualizarTarefa(verificacao.id, { dados: { ...dados, ...extra } });

  if (!estado(agora).aberta) {
    await guardar({ resolvido: true });
    return { resultado: "encerrada" };
  }

  const [cadastro] = await monday.buscarPorEmail(alvo);

  if (!cadastro) {
    const tentativas = (dados.tentativas || 0) + 1;
    await guardar({ tentativas, resolvido: tentativas >= TENTATIVAS_EMAIL });
    if (tentativas < TENTATIVAS_EMAIL) return { resultado: "nao_encontrado" };
    await alertarSemCadastro({ rodada, nome: dados.nome, telefone, email: dados.email, agora, detalhe: `Pelo WhatsApp também não achei o e-mail ${alvo}.` });
    return { resultado: "encaminhado" };
  }

  if (excluida(await monday.lerEtapa(cadastro.id))) {
    await guardar({ resolvido: true });
    return { resultado: "nao_elegivel" };
  }

  // Com o telefone certo no cadastro, a inscrição pela página passa a achar a pessoa.
  await guardar({ resolvido: true, mondayItemId: cadastro.id, nomeCadastro: cadastro.nome, telefoneAntes: cadastro.telefone });
  await trocarTelefone(`${rodada}:${cadastro.id}`, cadastro, telefone, "confirmado pelo WhatsApp");
  require("./agendamento.service").agendarProcessamento();
  return { resultado: "encontrado", primeiro_nome: primeiroNome(cadastro.nome) };
}

// ---------- mensagens ----------

// Uma mensagem por pessoa (a chave impede repetir). `exige`: o estado da inscrição que
// ainda precisa valer na hora do envio (ex.: lembrete só se continua sem agendar).
function criarMensagem({ data, tipo, pessoa, inscricao = null, exige = null, evento = null, ate, proxima = null, sufixo = "" }) {
  const telefone = normalizarTelefone(pessoa.telefone);
  if (!telefone || !fluxoDo(tipo)) return { criada: false };

  return getStore().criarTarefa({
    chave: `mentoria:${data}:${tipo}:${telefone}${sufixo}`,
    tipo: "mentoria_msg",
    proxima,
    dados: {
      nome: pessoa.nome || "",
      telefone,
      mondayItemId: pessoa.mondayItemId,
      flowNs: fluxoDo(tipo),
      mensagem: tipo,
      inscricaoId: inscricao?.id || null,
      exige,
      evento,
      ate: ate.toISOString(),
    },
  });
}

function motivoParaNaoEnviar(inscricao, { exige, evento }) {
  if (!inscricao) return "Inscrição não encontrada.";
  if (exige === "pendente" && inscricao.agendamento !== "pendente") return "Já agendou ou perdeu a vaga.";
  if (exige === "perdeu" && inscricao.agendamento !== "perdeu") return "Agendou antes do aviso.";
  if (exige === "agendada" && (inscricao.agendamento !== "agendada" || inscricao.eventoCalendly !== evento)) return "Mentoria cancelada ou remarcada.";
  return null;
}

// Mensagens do sorteio que a pessoa PRECISA receber (a sorteada perde a vaga sem o link).
const AVISAR_SE_PULADA = {
  sorteada: "aviso de sorteada (com o link do Calendly)",
  lembrete1: "lembrete para agendar (quarta)",
  lembrete2: "lembrete para agendar (quinta)",
  vespera: "lembrete da mentoria (1 dia antes)",
  "1hora": "lembrete da mentoria (1 hora antes)",
};

// Contato antigo do ManyChat que a API não acha: a mensagem não saiu (v2.18.1). Avisa a
// equipe com o nome, uma vez por mensagem, para mandar à mão ou preencher whatsapp_numero.
async function avisarSemContato(tarefa) {
  const d = tarefa.dados || {};
  const qual = AVISAR_SE_PULADA[d.mensagem];
  if (!qual) return;
  await getStore().criarTarefa({
    chave: `mentoria_sem_contato:${tarefa.chave}`,
    tipo: "telegram_resumo",
    dados: {
      texto: [
        "⚠️ <b>Mensagem do sorteio não enviada</b>",
        `👤 ${escapar(d.nome || "")}${d.telefone ? ` · ${escapar(formatarTelefone(d.telefone))}` : ""}`,
        `📨 ${qual}`,
        "Contato não encontrado no ManyChat. Mande à mão ou preencha o campo whatsapp_numero no contato (os próximos saem sozinhos).",
      ].join("\n"),
    },
  });
  require("./agendamento.service").agendarProcessamento();
}

// Etapas das tarefas do sorteio (o processamento das tarefas chama estas duas funções).
function etapasDa(tarefa) {
  if (tarefa.tipo === "mentoria_nota") return tarefa.dados?.telefone ? ["telefone", "comentario"] : ["comentario"];
  return ["vespera", "1hora"].includes(tarefa.dados?.mensagem) ? ["contato", "campos", "fluxo"] : ["contato", "fluxo"];
}

async function camposDaMentoria(contatoId, inscricao) {
  let link = inscricao.meetLink;

  // O link do Meet às vezes só aparece depois do aviso do Calendly.
  if (!link && inscricao.eventoCalendly) {
    link = (await calendly.obterEvento(inscricao.eventoCalendly))?.location?.join_url || null;
    if (link) await getStore().atualizarInscricaoMentoria(inscricao.id, { meetLink: link });
  }

  if (!link) throw new Error("A mentoria ainda não tem o link do Meet no Calendly.");

  const [hora, minuto] = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(inscricao.mentoriaEm).split(":");
  await manychat.definirCampo(contatoId, "mentoria_data", fmt({ day: "2-digit", month: "2-digit" }).format(inscricao.mentoriaEm));
  await manychat.definirCampo(contatoId, "mentoria_hora", `${Number(hora)}h${minuto === "00" ? "" : minuto}`);
  await manychat.definirCampo(contatoId, "mentoria_link", link);
}

async function executarEtapa(etapa, tarefa) {
  const dados = tarefa.dados;

  if (etapa === "telefone") return monday.atualizarTelefone(dados.itemId, dados.telefone);
  if (etapa === "comentario") return monday.comentar(dados.itemId, dados.texto);
  if (dados.pulado) return;

  // Antes de achar o contato e antes de enviar: a mensagem ainda faz sentido?
  const inscricao = dados.inscricaoId ? await getStore().inscricaoMentoria(dados.inscricaoId) : null;
  if (dados.inscricaoId && etapa !== "campos") {
    dados.pulado = motivoParaNaoEnviar(inscricao, dados) || undefined;
    if (dados.pulado) return;
  }

  if (etapa === "campos") return camposDaMentoria(dados.contatoId, inscricao);

  // "contato" e "fluxo": iguais aos avisos da aula.
  return convites.executarEtapa(etapa, tarefa);
}

// ---------- rotina semanal ----------

// Cada passo da semana roda uma vez só (marca no banco, como os avisos da aula), mesmo
// com duas cópias do app. Se falhar no meio, a marca sai e o passo tenta de novo.
async function passo(rodada, nome, fazer) {
  const store = getStore();
  const chave = `mentoria_varredura:${rodada}:${nome}`;
  const reserva = await store.criarTarefa({ chave, tipo: "mentoria_varredura", dados: { iniciadoEm: Date.now() } });

  if (!reserva.criada) {
    const marca = reserva.dados || {};
    const abandonada = marca.iniciadoEm && !marca.concluido && Date.now() - marca.iniciadoEm > MARCA_ABANDONADA_MS;
    if (!abandonada) return { status: "ja_feito", passo: nome };
    await store.atualizarTarefa(reserva.id, { dados: { iniciadoEm: Date.now(), retomada: true } });
  }

  try {
    const resultado = await fazer();
    await store.atualizarTarefa(reserva.id, { dados: { iniciadoEm: Date.now(), concluido: true, ...resultado } });
    await require("./agendamento.service").fecharLoteDe("mentoria_msg", "mentoria", rodada, nome);
    return { status: "feito", passo: nome, ...resultado };
  } catch (error) {
    await store.removerTarefa(chave);
    throw error;
  }
}

// Terça 12h30: aviso para todo o quadro, menos quem tem uma Etapa excluída.
async function enviarAviso(rodada) {
  const ate = calendario(rodada).validade.aviso;
  const inscritos = await monday.listarInscritosAula();
  const fora = new Set(inscritos.filter((i) => excluida(i.etapa)).map((i) => normalizarTelefone(i.telefone)).filter(Boolean));
  const vistos = new Set();
  let novos = 0;

  for (const pessoa of inscritos) {
    const telefone = normalizarTelefone(pessoa.telefone);
    if (!telefone || vistos.has(telefone) || fora.has(telefone)) continue;
    vistos.add(telefone);
    if ((await criarMensagem({ data: rodada, tipo: "aviso", pessoa: { ...pessoa, mondayItemId: pessoa.id }, ate })).criada) novos++;
  }

  // Vai junto do resumo final ("concluído"), numa mensagem só (v2.13.0).
  const resumo = ["Inscrições até quarta às 8h, quando acontece o sorteio.", fora.size ? `${fora.size} ficaram de fora pela Etapa do Funil.` : null].filter(Boolean);
  if (!novos) {
    await avisarTelegram([`🎲 <b>Sorteio das mentorias: aviso de inscrição</b> (rodada de ${diaMes(rodada)}): nenhum envio novo.`, ...resumo].join("\n"));
  }
  return { novos, fora: fora.size, resumo };
}

// Embaralha com o gerador do sistema (crypto), sem viés.
function embaralhar(lista) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

const chaveDaRodada = (rodada) => `mentoria_rodada:${rodada}`;
const nomeTel = (i) => `${escapar(i.nome)}${i.telefone ? ` · ${escapar(formatarTelefone(i.telefone))}` : ""}`;

// Registro auditável da rodada: quem concorria, quem ficou de fora (e por quê), quem
// foi sorteada, quando e por qual execução. Gravado uma vez só, antes de qualquer aviso.
// Desde a v3.2.0 também guarda as trocas feitas pelo painel (removidas e trocas).
async function registrarSorteio(rodada, inscritas, agora) {
  // Confere a Etapa de novo: quem pediu para parar depois de se inscrever não concorre.
  const etapaDe = new Map((inscritas.length ? await monday.listarInscritosAula() : []).map((item) => [String(item.id), item.etapa]));
  const concorrentes = [];
  const excluidas = [];

  for (const inscricao of inscritas) {
    const etapa = etapaDe.get(inscricao.mondayItemId);
    if (etapa === undefined || excluida(etapa)) {
      excluidas.push({ id: inscricao.id, nome: inscricao.nome, motivo: etapa === undefined ? "cadastro não está mais no quadro" : etapa });
    } else {
      concorrentes.push(inscricao);
    }
  }

  const { dados } = await getStore().criarTarefa({
    chave: chaveDaRodada(rodada),
    tipo: "mentoria_rodada",
    dados: {
      rodada,
      sorteadoEm: agora.toISOString(),
      execucao: `${os.hostname()}:${process.pid}`,
      vagas: config.sorteio.vagas,
      inscritas: inscritas.length,
      concorrentes: concorrentes.map(({ id, mondayItemId, nome, telefone }) => ({ id, mondayItemId, nome, telefone })),
      excluidas,
      sorteadas: embaralhar(concorrentes).slice(0, config.sorteio.vagas).map((i) => i.id),
      removidas: [],
      trocas: [],
    },
  });
  return dados;
}

// ---------- quem já foi sorteada antes ----------

function situacaoAnterior(inscricao, agora) {
  if (inscricao.agendamento === "agendada") return inscricao.mentoriaEm && new Date(inscricao.mentoriaEm) <= agora ? "realizada" : "agendou";
  if (inscricao.agendamento === "perdeu") return "não agendou/perdeu a vaga";
  if (inscricao.agendamento === "cancelada") return "cancelou";
  return "ainda não agendou";
}

const todasSorteadas = () => getStore().sorteadasMentoria("2000-01-01");

// Para cada pessoa, as rodadas anteriores em que ela foi sorteada (pelo cadastro da Monday
// ou pelo telefone), da mais recente para a mais antiga: { [inscricaoId]: [inscricao] }.
function anterioresDe(rodada, pessoas, sorteadas) {
  const antigas = sorteadas.filter((a) => a.rodada < rodada);
  const mapa = {};
  for (const pessoa of pessoas) {
    const telefone = chaveTelefone(pessoa.telefone);
    const achadas = antigas.filter(
      (a) => (pessoa.mondayItemId && String(a.mondayItemId) === String(pessoa.mondayItemId)) || (telefone && chaveTelefone(a.telefone) === telefone)
    );
    if (achadas.length) mapa[pessoa.id] = achadas;
  }
  return mapa;
}

// ---------- avisos do sorteio para a equipe ----------

const RODAPE_TROCA = "Para trocar alguém, use o painel › Mentorias até 12h. As mensagens para as sorteadas saem às 12h35.";
const RODAPE_VAZIAS = "Para trocar alguém ou sortear as vagas vazias, use o painel › Mentorias até 12h. As mensagens para as sorteadas saem às 12h35.";

// Pelo processamento das tarefas: uma vez só por chave, e tenta de novo se o Telegram falhar.
async function filaTelegram(chave, texto) {
  await getStore().criarTarefa({ chave, tipo: "telegram_resumo", dados: { texto } });
  require("./agendamento.service").agendarProcessamento();
}

function linhaContagem(registro) {
  const inscritas = registro.inscritas ?? registro.concorrentes.length + registro.excluidas.length;
  return `📝 Inscritas: ${inscritas} · 🎲 Concorreram: ${registro.concorrentes.length} · 🚫 Fora pela Etapa: ${registro.excluidas.length}`;
}

// A lista das sorteadas, com o alerta de quem já foi sorteada em outra rodada.
async function linhasSorteadas(rodada, registro, agora) {
  const porId = new Map(registro.concorrentes.map((c) => [c.id, c]));
  const pessoas = registro.sorteadas.map((id) => porId.get(id)).filter(Boolean);
  const anteriores = anterioresDe(rodada, pessoas, await todasSorteadas());
  const linhas = [];
  for (const pessoa of pessoas) {
    linhas.push(`• ${nomeTel(pessoa)}`);
    const antes = anteriores[pessoa.id];
    if (antes) linhas.push(`   ⚠️ já sorteada em ${antes.map((a) => `${diaMes(a.rodada)} (${situacaoAnterior(a, agora)})`).join(", ")}`);
  }
  return ["", `🎉 Sorteadas (${pessoas.length}):`, ...linhas];
}

async function textoSorteio(rodada, registro, agora) {
  if (!registro.concorrentes.length) {
    return (registro.inscritas ?? registro.excluidas.length)
      ? `🎲 <b>Sorteio das mentorias</b> (rodada de ${diaMes(rodada)}): ninguém pôde concorrer, ninguém foi sorteada.\n${linhaContagem(registro)}`
      : `🎲 <b>Sorteio das mentorias</b> (rodada de ${diaMes(rodada)}): nenhuma inscrição nesta semana, ninguém foi sorteada.`;
  }
  // Sorteio atrasado (a Mani estava fora do ar às 8h): já não dá tempo de trocar.
  const cal = calendario(rodada);
  const atrasado = agora >= cal.trocaAte;
  const quando = agora >= cal.envio ? "saem agora" : "saem às 12h35";
  return [
    `🎲 <b>Sorteio das mentorias feito</b> (rodada de ${diaMes(rodada)})`,
    linhaContagem(registro),
    ...(await linhasSorteadas(rodada, registro, agora)),
    "",
    atrasado ? `O sorteio saiu atrasado (a Mani estava fora do ar às 8h): sem tempo para trocas, as mensagens para as sorteadas ${quando}.` : RODAPE_TROCA,
  ].join("\n");
}

async function avisarSorteio(rodada, registro, agora) {
  const chave = `mentoria_sorteio_aviso:${rodada}`;
  if (await getStore().tarefaPorChave(chave)) return;
  await filaTelegram(chave, await textoSorteio(rodada, registro, agora));
}

// ---------- sorteio (quarta 8h) e avisos às sorteadas (quarta 12h35) ----------

// O registro da rodada, sorteando se ainda não houver (e o aviso no Telegram, uma vez).
// Chamar dentro da fila da rodada.
async function garantirSorteio(rodada, agora) {
  const store = getStore();
  const registro = (await store.tarefaPorChave(chaveDaRodada(rodada)))?.dados || (await registrarSorteio(rodada, await store.inscricoesMentoria(rodada), agora));
  await avisarSorteio(rodada, registro, agora);
  return registro;
}

function exigirFluxoSorteada() {
  if (!fluxoDo("sorteada")) throw new Error("MANYCHAT_FLOW_SORTEIO_SORTEADA não configurado: sem ele as sorteadas não recebem o link.");
}

// Quarta 8h: só sorteia e avisa a equipe (ninguém de fora é avisada ainda). Rodar de novo
// reaproveita o mesmo resultado.
async function sortear(rodada, agora) {
  exigirFluxoSorteada();
  const registro = await emFila(chaveDaRodada(rodada), () => garantirSorteio(rodada, agora));
  return { concorrentes: registro.concorrentes.length, sorteadas: registro.sorteadas.length };
}

// Quarta 12h35: avisa as sorteadas da lista atual (depois das trocas). Se o sorteio das 8h
// não aconteceu (Mani fora do ar), sorteia agora antes de avisar.
async function enviarSorteadas(rodada, agora) {
  exigirFluxoSorteada();
  const store = getStore();

  return emFila(chaveDaRodada(rodada), async () => {
    await garantirSorteio(rodada, agora);
    const tarefa = await store.tarefaPorChave(chaveDaRodada(rodada));
    const registro = tarefa.dados;
    // Fecha as trocas antes de qualquer aviso.
    if (!registro.enviadoEm) await store.atualizarTarefa(tarefa.id, { dados: { ...registro, enviadoEm: agora.toISOString() } });

    const sorteadas = (await store.inscricoesMentoria(rodada)).filter((i) => registro.sorteadas.includes(i.id));
    for (const inscricao of sorteadas.filter((i) => !i.sorteada)) {
      await store.atualizarInscricaoMentoria(inscricao.id, { sorteada: true, agendamento: "pendente" });
    }

    // Só depois de todas gravadas é que os avisos entram na fila.
    const ate = calendario(rodada).validade.sorteada;
    for (const inscricao of sorteadas) {
      await criarMensagem({ data: rodada, tipo: "sorteada", pessoa: inscricao, inscricao, exige: "pendente", ate });
      await anotar(`${rodada}:sorteada:${inscricao.id}`, inscricao.mondayItemId, `🎉 Sorteada para a mentoria individual (rodada de ${diaMes(rodada)}). Recebeu o link do Calendly para agendar até sexta ao meio-dia.`);
    }
    return { concorrentes: registro.concorrentes.length, sorteadas: sorteadas.length };
  });
}

// ---------- troca pelo painel (até quarta 12h) ----------

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const recusa = (status, erro) => ({ status, ok: false, erro });
const pessoaDe = ({ id, nome, telefone }) => ({ id, nome, telefone });

const vagasDo = (registro) => registro.vagas ?? config.sorteio.vagas;
const vagasVazias = (registro) => Math.max(0, vagasDo(registro) - registro.sorteadas.length);

// Telegram da troca. `modo` (v3.2.1): "troca" (tira e sorteia outra), "exclusao" (tira e a
// vaga fica vazia) ou "preencher" (sorteia as vagas vazias).
async function textoTroca(rodada, registro, { por, saiu, entrou, faltaram, modo = "troca" }, agora) {
  const lista = (pessoas) => pessoas.map(nomeTel).join("; ");
  const titulo = {
    troca: `🔁 <b>Sorteio refeito por ${escapar(por)}</b>`,
    exclusao: `➖ <b>${saiu.length === 1 ? "Sorteada excluída" : "Sorteadas excluídas"} por ${escapar(por)}</b> (${saiu.length === 1 ? "vaga fica vazia" : "vagas ficam vazias"})`,
    preencher: `➕ <b>Vagas vazias sorteadas por ${escapar(por)}</b>`,
  }[modo];
  const vazias = vagasVazias(registro);
  return [
    `${titulo} (rodada de ${diaMes(rodada)})`,
    linhaContagem(registro),
    modo === "preencher" ? null : `➖ Saíram: ${lista(saiu)}`,
    modo === "exclusao" ? null : `➕ Entraram: ${entrou.length ? lista(entrou) : "ninguém"}`,
    faltaram ? `⚠️ Faltaram ${faltaram}: não há mais quem concorria para completar as vagas.` : null,
    ...(await linhasSorteadas(rodada, registro, agora)),
    vazias || modo === "exclusao" ? `Vagas vazias: ${vazias}` : null,
    "",
    vazias ? RODAPE_VAZIAS : RODAPE_TROCA,
  ]
    .filter((linha) => linha !== null)
    .join("\n");
}

// POST /interno/mentorias/trocar: tira sorteadas (que não voltam nesta rodada) e sorteia
// outras entre quem concorria. v3.2.1: com `substituir: false`, só tira (a vaga fica vazia);
// com `preencher: true` e `remover: []`, sorteia as vagas vazias. Responde { status, ok, ... }.
async function trocar(corpo, agora = new Date()) {
  const rodada = String(corpo?.rodada || "");
  const por = String(corpo?.por || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const pedido = Array.isArray(corpo?.remover) ? corpo.remover : [];
  const remover = [...new Set(pedido.map((id) => (typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id)))];

  if (!RE_DATA.test(rodada) || Number.isNaN(Date.parse(`${rodada}T12:00:00Z`)) || rodadaDe(noSP(rodada, "12:00")) !== rodada) {
    return recusa(400, "rodada inválida: use a terça da rodada (AAAA-MM-DD).");
  }
  for (const campo of ["substituir", "preencher"]) {
    if (corpo?.[campo] !== undefined && typeof corpo[campo] !== "boolean") return recusa(400, `${campo}: use true ou false.`);
  }
  const preencher = corpo?.preencher === true;
  const substituir = corpo?.substituir !== false;
  if (preencher && (pedido.length || !substituir)) return recusa(400, "preencher: mande remover vazio (só sorteia as vagas vazias).");
  if (!preencher && (!remover.length || remover.some((id) => !Number.isInteger(id) || id <= 0))) return recusa(400, "remover: informe os ids das inscrições sorteadas a tirar.");
  if (!por) return recusa(400, "por: informe quem está fazendo a troca.");
  const modo = preencher ? "preencher" : substituir ? "troca" : "exclusao";

  const store = getStore();
  const chave = chaveDaRodada(rodada);

  return emFila(chave, async () => {
    const tarefa = await store.tarefaPorChave(chave);
    if (!tarefa) return recusa(409, "O sorteio desta rodada ainda não foi feito.");
    const registro = tarefa.dados;
    if (registro.enviadoEm) return recusa(409, "As mensagens para as sorteadas já saíram: não dá mais para trocar.");
    if (agora >= calendario(rodada).trocaAte) return recusa(409, "Passou do horário das trocas (quarta, 12h).");

    const naoSorteadas = remover.filter((id) => !registro.sorteadas.includes(id));
    if (naoSorteadas.length) return recusa(409, `Não está entre as sorteadas agora: ${naoSorteadas.join(", ")}.`);

    const jaRemovidas = (registro.removidas || []).map((r) => r.id);
    const candidatas = registro.concorrentes.filter((c) => !registro.sorteadas.includes(c.id) && !jaRemovidas.includes(c.id));
    const pedidas = modo === "troca" ? remover.length : modo === "preencher" ? vagasVazias(registro) : 0;
    if (modo === "preencher" && !pedidas) return recusa(409, "Não há vaga vazia para sortear.");
    if (modo === "preencher" && !candidatas.length) return recusa(409, "Não há mais quem concorria para sortear as vagas vazias.");
    const novas = embaralhar(candidatas).slice(0, pedidas);
    const porId = new Map(registro.concorrentes.map((c) => [c.id, c]));
    const em = agora.toISOString();

    const dados = {
      ...registro,
      sorteadas: [...registro.sorteadas.filter((id) => !remover.includes(id)), ...novas.map((c) => c.id)],
      removidas: [...(registro.removidas || []), ...remover.map((id) => ({ id, nome: porId.get(id)?.nome || "", por, em }))],
      trocas: [
        ...(registro.trocas || []),
        {
          em,
          por,
          removidas: remover,
          novas: novas.map((c) => c.id),
          ...(modo === "exclusao" ? { semSubstituta: true } : {}),
          ...(modo === "preencher" ? { preencher: true } : {}),
        },
      ],
    };

    // A fila acima vale dentro de um processo; com duas cópias do app, confere se nada
    // mudou desde a leitura antes de gravar.
    const agoraNoBanco = (await store.tarefaPorChave(chave)).dados;
    if ((agoraNoBanco.trocas || []).length !== (registro.trocas || []).length || agoraNoBanco.enviadoEm) {
      return recusa(409, "Outra troca foi feita ao mesmo tempo: atualize o painel e confira antes de trocar de novo.");
    }
    await store.atualizarTarefa(tarefa.id, { dados });

    const saiu = remover.map((id) => porId.get(id)).filter(Boolean);
    const faltaram = pedidas - novas.length;
    await filaTelegram(`mentoria_troca_aviso:${rodada}:${dados.trocas.length}`, await textoTroca(rodada, dados, { por, saiu, entrou: novas, faltaram, modo }, agora));

    return {
      status: 200,
      ok: true,
      sorteadas: dados.sorteadas.map((id) => pessoaDe(porId.get(id))),
      novas: novas.map(pessoaDe),
      removidas: saiu.map(pessoaDe),
      faltaram,
    };
  });
}

// Lembretes da quarta e da quinta, e o aviso de perda da vaga: só para quem ainda está
// naquela situação.
async function regua(rodada, tipo) {
  const exige = tipo === "perdeu" ? "perdeu" : "pendente";
  const ate = calendario(rodada).validade[tipo];
  const lista = (await getStore().inscricoesMentoria(rodada)).filter((i) => i.sorteada && i.agendamento === exige);
  let novos = 0;

  for (const inscricao of lista) {
    if ((await criarMensagem({ data: rodada, tipo, pessoa: inscricao, inscricao, exige, ate })).criada) novos++;
  }
  return { novos };
}

// Fechamento da semana (v2.13.0): uma mensagem com quem foi sorteada e como terminou.
function textoFechamento(rodada, inscricoes) {
  const sorteadas = inscricoes.filter((i) => i.sorteada);
  const grupo = (titulo, lista, linha) => (lista.length ? ["", `${titulo} (${lista.length}):`, ...lista.map((i) => `• ${linha(i)}`)] : []);
  const agendaram = sorteadas
    .filter((i) => i.agendamento === "agendada")
    .sort((a, b) => new Date(a.mentoriaEm) - new Date(b.mentoriaEm));

  return [
    `🏁 <b>Fechamento do sorteio das mentorias</b> (rodada de ${diaMes(rodada)})`,
    `🎲 ${inscricoes.length} ${inscricoes.length === 1 ? "inscrita" : "inscritas"} · ${sorteadas.length} ${sorteadas.length === 1 ? "sorteada" : "sorteadas"}`,
    ...grupo("✅ Agendaram", agendaram, (i) => `${nomeTel(i)} · ${i.mentoriaEm ? diaSemanaHora(new Date(i.mentoriaEm)) : "?"}`),
    ...grupo("⏳ Perderam a vaga", sorteadas.filter((i) => i.agendamento === "perdeu"), nomeTel),
    ...grupo("❌ Cancelaram", sorteadas.filter((i) => i.agendamento === "cancelada"), nomeTel),
  ].join("\n");
}

// Sexta 12h: quem não agendou perde a vaga (não é redistribuída na mesma semana), e a
// equipe recebe o fechamento da semana.
async function encerrarPrazo(rodada) {
  const store = getStore();
  const semAgendar = (await store.inscricoesMentoria(rodada)).filter((i) => i.sorteada && i.agendamento === "pendente");

  for (const inscricao of semAgendar) {
    await store.atualizarInscricaoMentoria(inscricao.id, { agendamento: "perdeu" });
    await anotar(`${rodada}:perdeu:${inscricao.id}`, inscricao.mondayItemId, `⏳ Não agendou a mentoria até sexta ao meio-dia e perdeu a vaga (rodada de ${diaMes(rodada)}). Pode se inscrever de novo nas próximas rodadas.`);
  }

  const inscricoes = await store.inscricoesMentoria(rodada);
  if (inscricoes.some((i) => i.sorteada)) {
    await avisarTelegram(textoFechamento(rodada, inscricoes));
  }
  return { perderam: semAgendar.length };
}

// Quarta 8h (o corte): quem recebeu o "Verificar cadastro" e não respondeu até o corte vira alerta
// para a equipe (com os dados que digitou na página).
async function alertarSemResposta(rodada, agora) {
  const store = getStore();
  const pendentes = (await store.tarefasComPrefixo(chaveDaVerificacao(rodada, ""))).filter((t) => !t.dados?.resolvido);

  for (const tarefa of pendentes) {
    const telefone = tarefa.chave.slice(chaveDaVerificacao(rodada, "").length);
    await store.atualizarTarefa(tarefa.id, { dados: { ...tarefa.dados, resolvido: true } });
    await alertarSemCadastro({ rodada, nome: tarefa.dados.nome, telefone, email: tarefa.dados.email, agora, detalhe: "Recebeu o \"Verificar cadastro\" no WhatsApp e não respondeu até o fim das inscrições." });
  }
  return { semResposta: pendentes.length };
}

// Falhou: avisa a equipe uma vez por hora (marca no banco, vale para as duas cópias do app).
// Dois passos (v3.2.0): "sorteio" (quarta 8h, só sorteia) e "sorteada" (quarta 12h35, avisa
// as sorteadas). A marca de falha por hora é a mesma: no máximo um alerta por hora.
async function tentarSorteio(rodada, agora, etapa = "sorteada") {
  try {
    return etapa === "sorteio"
      ? await passo(rodada, "sorteio", () => sortear(rodada, agora))
      : await passo(rodada, "sorteada", () => enviarSorteadas(rodada, agora));
  } catch (error) {
    console.error(`Sorteio da rodada ${rodada} falhou:`, error.message);
    const hora = fmt({ hour: "2-digit", hourCycle: "h23" }).format(agora);
    const marca = await getStore().criarTarefa({ chave: `mentoria_varredura:${rodada}:falha:${hora}`, tipo: "mentoria_varredura", dados: { concluido: true } });
    if (marca.criada) {
      await avisarTelegram(
        `🚨 <b>O sorteio das mentorias falhou</b> (rodada de ${diaMes(rodada)}): ${escapar(error.message)}
${etapa === "sorteio" ? "Ninguém foi sorteada ainda. O sistema tenta de novo a cada 5 minutos; às 12h35, antes dos avisos às sorteadas, tenta mais uma vez." : "Ninguém foi avisada (o aviso às sorteadas sai a partir das 12h35). O sistema tenta de novo a cada 5 minutos até as 20h."}`
      );
    }
    return null;
  }
}

// Aviso de terça (v2.18.1): falhou -> alerta uma vez por hora (como o sorteio); janela de
// 2 h acabou sem o aviso (app fora do ar) -> alerta uma vez.
async function tentarAviso(rodada, agora) {
  try {
    return await passo(rodada, "aviso", () => enviarAviso(rodada));
  } catch (error) {
    console.error(`Aviso do sorteio da rodada ${rodada} falhou:`, error.message);
    const hora = fmt({ hour: "2-digit", hourCycle: "h23" }).format(agora);
    const marca = await getStore().criarTarefa({ chave: `mentoria_varredura:${rodada}:falha_aviso:${hora}`, tipo: "mentoria_varredura", dados: { concluido: true } });
    if (marca.criada) {
      await avisarTelegram(
        `🚨 <b>O aviso do sorteio das mentorias falhou</b> (rodada de ${diaMes(rodada)}): ${escapar(error.message)}\nO sistema tenta de novo a cada 5 minutos até as 14h30.`
      );
    }
    return null;
  }
}

async function avisoPerdido(rodada) {
  if ((await getStore().tarefaPorChave(`mentoria_varredura:${rodada}:aviso`))?.dados?.concluido) return null;
  const marca = await getStore().criarTarefa({ chave: `mentoria_varredura:${rodada}:aviso_perdido`, tipo: "mentoria_varredura", dados: { concluido: true } });
  if (marca.criada) {
    await avisarTelegram(
      `🚨 <b>O aviso de terça do sorteio não saiu</b> (rodada de ${diaMes(rodada)}).\nA janela (12h30 às 14h30) passou sem o envio: confira o log da Mani. A página de inscrição continua aberta até quarta às 8h.`
    );
  }
  return null;
}

// Roda a cada 5 minutos: faz o passo da semana que estiver na hora.
async function rodar(agora = new Date()) {
  const inicio = config.sorteio.inicio;
  if (!inicio || !config.manychat.apiKey) return { status: "desligado" };

  const rodada = rodadaDe(agora);
  if (rodada < inicio) return { status: "antes_do_inicio" };

  const cal = calendario(rodada);
  const naHora = (de, horas, tipo) => agora >= de && agora < new Date(de.getTime() + horas * HORA_MS) && (!tipo || Boolean(fluxoDo(tipo)));
  const feitos = [];

  if (naHora(cal.aviso, 2, "aviso")) feitos.push(await tentarAviso(rodada, agora));
  else if (fluxoDo("aviso") && agora >= new Date(cal.aviso.getTime() + 2 * HORA_MS) && agora < cal.corte) feitos.push(await avisoPerdido(rodada));
  if (agora >= cal.corte && agora < cal.sorteioAte) feitos.push(await passo(rodada, "sem_resposta", () => alertarSemResposta(rodada, agora)));
  if (agora >= cal.sorteioRoda && agora < cal.envio) feitos.push(await tentarSorteio(rodada, agora, "sorteio"));
  if (agora >= cal.envio && agora < cal.sorteioAte) feitos.push(await tentarSorteio(rodada, agora, "sorteada"));
  if (naHora(cal.lembrete1, 2, "lembrete1")) feitos.push(await passo(rodada, "lembrete1", () => regua(rodada, "lembrete1")));
  if (naHora(cal.lembrete2, 2, "lembrete2")) feitos.push(await passo(rodada, "lembrete2", () => regua(rodada, "lembrete2")));
  if (agora >= cal.prazo) feitos.push(await passo(rodada, "prazo", () => encerrarPrazo(rodada)));

  // O aviso de perda só depois do prazo encerrado.
  if (naHora(cal.perdeu, 2, "perdeu") && (await getStore().tarefaPorChave(`mentoria_varredura:${rodada}:prazo`))?.dados?.concluido) {
    feitos.push(await passo(rodada, "perdeu", () => regua(rodada, "perdeu")));
  }

  if (feitos.length) require("./agendamento.service").agendarProcessamento();
  return { status: "ok", rodada, feitos: feitos.filter(Boolean) };
}

function iniciar(intervaloMs = 5 * 60000) {
  if (!config.workerEnabled) return;
  const executar = () => rodar().catch((error) => console.error("Rotina do sorteio falhou:", error.message));
  executar();
  setInterval(executar, intervaloMs).unref();
}

// ---------- agendamento no Calendly ----------

function telefonesDoConvidado(p) {
  const candidatos = [p.text_reminder_number, ...(p.questions_and_answers || []).map((qa) => qa.answer)];
  return [...new Set(candidatos.map(normalizarTelefone).filter(Boolean))];
}

async function cancelouNoCalendly(p, sorteadas, agora) {
  if (p.rescheduled) return { ignorado: "remarcacao" };

  const inscricao = sorteadas.find((i) => i.eventoCalendly === p.scheduled_event?.uri && i.agendamento === "agendada");
  if (!inscricao) return { ignorado: "mentoria_desconhecida" };

  // Cancelou antes do prazo: a régua volta (ainda pode agendar). Depois do prazo, a vaga acabou.
  const voltaParaRegua = agora < calendario(inscricao.rodada).prazo;
  const era = inscricao.mentoriaEm ? diaSemanaHora(inscricao.mentoriaEm) : "?";
  await getStore().atualizarInscricaoMentoria(inscricao.id, { agendamento: voltaParaRegua ? "pendente" : "cancelada" });
  await anotar(`cancelou:${p.uri}`, inscricao.mondayItemId, `❌ Cancelou a mentoria de ${era} no Calendly.${voltaParaRegua ? " Ainda pode agendar até sexta ao meio-dia." : ""}`);
  await avisarTelegram(`❌ <b>Mentoria cancelada no Calendly:</b> ${escapar(inscricao.nome)} (${escapar(formatarTelefone(inscricao.telefone))}), era ${era}.${voltaParaRegua ? " Ainda pode agendar até sexta ao meio-dia." : ""}`);
  return { ok: true, mentoria: "cancelada" };
}

async function agendouNoCalendly(p, sorteadas, agora) {
  const store = getStore();
  const email = String(p.email || "").trim().toLowerCase();
  const telefones = telefonesDoConvidado(p);
  const candidatas = sorteadas.filter((i) => (email && i.email === email) || telefones.includes(i.telefone));
  const evento = p.scheduled_event?.uri;

  // O Calendly pode mandar o mesmo aviso de novo: já registrado, nada a fazer.
  if (candidatas.some((i) => i.eventoCalendly === evento && i.agendamento === "agendada")) return { ok: true, mentoria: "ja_registrada" };

  // Remarcação só de uma mentoria que ainda vai acontecer; quem já fez a dela não agenda outra.
  const inscricao = candidatas.find((i) => i.agendamento === "pendente") || candidatas.find((i) => i.agendamento === "agendada" && i.mentoriaEm > agora);
  const inicio = p.scheduled_event?.start_time ? new Date(p.scheduled_event.start_time) : null;

  if (!inscricao || !inicio) {
    const depoisDoPrazo = candidatas.length > 0;
    await avisarTelegram(
      [
        depoisDoPrazo ? "⚠️ <b>Mentoria agendada depois do prazo</b>" : "⚠️ <b>Mentoria agendada por quem não foi sorteada</b>",
        `${escapar(p.name || "?")} · ${escapar(email || "sem e-mail")}${telefones[0] ? ` · ${escapar(formatarTelefone(telefones[0]))}` : ""}`,
        inicio ? `Horário: ${diaSemanaHora(inicio)}` : null,
        depoisDoPrazo
          ? "A vaga dela já tinha acabado. Confira e, se for o caso, cancele no Calendly."
          : "Não achei essa pessoa entre as sorteadas (pode ter usado outro e-mail e telefone). Confira e, se for o caso, cancele no Calendly.",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return { ok: true, mentoria: "sem_sorteada" };
  }

  const atualizada = await store.atualizarInscricaoMentoria(inscricao.id, {
    agendamento: "agendada",
    eventoCalendly: evento,
    mentoriaEm: inicio,
    meetLink: p.scheduled_event?.location?.join_url || null,
  });

  // Lembretes: 1 dia antes (se ainda dá) e 1 hora antes. A chave leva o evento, para uma
  // remarcação ganhar lembretes novos (os antigos são pulados na hora do envio).
  const base = { data: dataSP(inicio), pessoa: atualizada, inscricao: atualizada, exige: "agendada", evento };
  const sufixo = `:${crypto.createHash("sha1").update(String(evento)).digest("hex").slice(0, 10)}`;
  const vespera = new Date(inicio.getTime() - 24 * HORA_MS);
  const umaHora = new Date(inicio.getTime() - HORA_MS);

  if (vespera.getTime() > agora.getTime() + 5 * 60000) {
    await criarMensagem({ ...base, tipo: "vespera", proxima: vespera, ate: new Date(inicio.getTime() - 2 * HORA_MS), sufixo });
  }
  if (inicio.getTime() > agora.getTime() + 10 * 60000) {
    await criarMensagem({ ...base, tipo: "1hora", proxima: umaHora > agora ? umaHora : null, ate: inicio, sufixo });
  }

  await anotar(`agendou:${p.uri}`, atualizada.mondayItemId, `📅 Agendou a mentoria individual para ${diaSemanaHora(inicio)}.`);
  await avisarTelegram(`📅 <b>Mentoria agendada:</b> ${escapar(atualizada.nome)} (${escapar(formatarTelefone(atualizada.telefone))}), ${diaSemanaHora(inicio)}.`);
  require("./agendamento.service").agendarProcessamento();
  return { ok: true, mentoria: "agendada" };
}

// Aviso do Calendly de um evento "Mentoria": liga à sorteada (pelo e-mail ou pelo telefone).
async function receberCalendly(corpo, agora = new Date()) {
  const sorteadas = await getStore().sorteadasMentoria(somarDias(rodadaDe(agora), -21));
  if (corpo?.event === "invitee.canceled") return cancelouNoCalendly(corpo.payload || {}, sorteadas, agora);
  if (corpo?.event === "invitee.created") return agendouNoCalendly(corpo.payload || {}, sorteadas, agora);
  return { ignorado: corpo?.event || "evento" };
}

// Mentoria achada na agenda do consultor sem ter chegado pelo aviso do Calendly (rede de
// segurança): só liga a uma sorteada que ainda não agendou. Sem sorteada, nada acontece e
// não há alerta (a agenda é lida a cada 5 minutos; o alerta fica para o aviso do Calendly).
async function receberDaAgenda(p, agora = new Date()) {
  const sorteadas = await getStore().sorteadasMentoria(somarDias(rodadaDe(agora), -21));
  const email = String(p.email || "").trim().toLowerCase();
  const telefones = telefonesDoConvidado(p);
  const candidatas = sorteadas.filter((i) => (email && i.email === email) || telefones.includes(i.telefone));

  if (candidatas.some((i) => i.eventoCalendly === p.scheduled_event?.uri)) return { mentoria: "ja_registrada" };
  if (!candidatas.some((i) => i.agendamento === "pendente")) return { mentoria: "sem_sorteada" };
  return agendouNoCalendly(p, sorteadas, agora);
}

// ---------- painel ----------

function faltaConfigurar() {
  const falta = Object.keys(FLUXOS).filter((tipo) => !fluxoDo(tipo)).map((tipo) => FLUXOS[tipo][1]);
  if (!config.manychat.apiKey) falta.unshift("MANYCHAT_API_KEY");
  if (!config.sorteio.inicio) falta.unshift("SORTEIO_INICIO");
  return falta;
}

// O sorteio da rodada para o painel (v3.2.0): sorteadas atuais, trocas e o que vem antes do envio.
function resumoDoSorteio(rodada, registro, inscricoes, sorteadasAntes) {
  const cal = calendario(rodada);
  const atuais = registro.concorrentes.filter((c) => registro.sorteadas.includes(c.id));
  const anteriores = anterioresDe(rodada, atuais, sorteadasAntes);
  return {
    sorteadoEm: registro.sorteadoEm || null,
    sorteadas: registro.sorteadas,
    vagas: vagasDo(registro),
    vagasVazias: vagasVazias(registro),
    removidas: registro.removidas || [],
    trocas: registro.trocas || [],
    trocaAte: cal.trocaAte.toISOString(),
    envioEm: cal.envio.toISOString(),
    enviado: Boolean(registro.enviadoEm) || inscricoes.some((i) => i.sorteada),
    anteriores: Object.fromEntries(Object.entries(anteriores).map(([id, lista]) => [id, lista.map((a) => ({ rodada: a.rodada, agendamento: a.agendamento }))])),
  };
}

// Últimas rodadas, com as inscritas e o resultado (tela Mentorias do painel).
async function resumo({ rodadas = 8, agora = new Date() } = {}) {
  const store = getStore();
  const lista = [];
  const sorteadasAntes = await todasSorteadas();
  const atual = rodadaDe(agora);

  const datas = [];
  for (let i = 0, rodada = atual; i < rodadas && (!config.sorteio.inicio || rodada >= config.sorteio.inicio); i++, rodada = somarDias(rodada, -7)) datas.push(rodada);

  for (const rodada of datas) {
    const registro = (await store.tarefaPorChave(chaveDaRodada(rodada)))?.dados;
    const inscricoes = await store.inscricoesMentoria(rodada);
    lista.push({
      rodada,
      sorteadoEm: registro?.sorteadoEm || null,
      excluidas: registro?.excluidas || [],
      sorteio: registro ? resumoDoSorteio(rodada, registro, inscricoes, sorteadasAntes) : null,
      inscricoes: inscricoes.map((i) => ({
        id: i.id,
        nome: i.nome,
        telefone: i.telefone,
        email: i.email,
        inscritoEm: i.inscritoEm,
        sorteada: i.sorteada,
        agendamento: i.agendamento,
        mentoriaEm: i.mentoriaEm,
        link: monday.linkDoCadastro(i.mondayItemId),
      })),
    });
  }

  return { estado: estado(agora), vagas: config.sorteio.vagas, falta: faltaConfigurar(), rodadas: lista };
}

module.exports = {
  avisarSemContato,
  calendario,
  estado,
  etapasDa,
  executarEtapa,
  faltaConfigurar,
  guardarListaDoGrupo,
  iniciar,
  inscrever,
  receberCalendly,
  receberDaAgenda,
  receberEmail,
  resumo,
  rodadaDe,
  rodar,
  trocar,
};
