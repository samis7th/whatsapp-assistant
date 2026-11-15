const crypto = require("crypto");
const express = require("express");

const { config } = require("../config/env");
const agendamento = require("../services/agendamento.service");
const chegadas = require("../services/chegadas.service");
const convites = require("../services/convites.service");
const email = require("../services/email.service");
const reunioesAgenda = require("../services/reunioes-agenda.service");
const { getStore } = require("../db");
const { normalizarTelefone, variantesTelefone } = require("../domain/telefone");
const googleAgenda = require("../services/google-agenda.service");
const manychat = require("../services/manychat.service");
const monitor = require("../services/monitor.service");
const mentoria = require("../services/mentoria.service");

// Chamadas de outros sistemas da Acme (o painel de inscritos), com a chave INTERNO_SECRET.
const router = express.Router();

function exigirChaveInterna(req, res, next) {
  if (!config.internoSecret) {
    return res.status(503).json({ ok: false, erro: "INTERNO_SECRET não configurado." });
  }

  const recebida = Buffer.from(String(req.get("x-interno-key") || ""));
  const esperada = Buffer.from(config.internoSecret);

  if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) {
    return res.status(401).json({ ok: false, erro: "nao_autorizado" });
  }

  next();
}

router.use(exigirChaveInterna);
router.use(express.json({ limit: "200kb" }));

// Lista de quem se inscreveu e não entrou no grupo: [{ nome, telefone, mondayItemId }].
router.post("/convites", async (req, res) => {
  try {
    const resultado = await convites.receberConvites(req.body?.pessoas);
    agendamento.agendarProcessamento();
    res.json({ ok: true, ...resultado });
  } catch (error) {
    console.error("Convites falharam:", error.message);
    res.status(error.status || 502).json({ ok: false, erro: error.message });
  }
});

// Lista do grupo do WhatsApp (o painel manda quando a equipe sobe a lista do dia): usada no
// alerta de inscrição no sorteio sem cadastro ("Está no grupo").
router.post("/grupo-lista", async (req, res) => {
  try {
    res.json({ ok: true, ...(await mentoria.guardarListaDoGrupo(req.body?.numeros, req.body?.salvaEm)) });
  } catch (error) {
    console.error("Lista do grupo falhou:", error.message);
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Tela Mentorias do painel: as últimas rodadas do sorteio, com inscritas e sorteadas.
router.get("/mentorias", async (req, res) => {
  try {
    res.json({ ok: true, ...(await mentoria.resumo()) });
  } catch (error) {
    console.error("Mentorias falharam:", error.message);
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Troca de sorteadas pelo painel (v3.2.0), até quarta 12h e antes dos avisos às sorteadas:
// { rodada: "AAAA-MM-DD", remover: [inscricaoId], por: "Nome" }.
router.post("/mentorias/trocar", async (req, res) => {
  try {
    const { status, ...resposta } = await mentoria.trocar(req.body || {}, new Date());
    res.status(status).json(resposta);
  } catch (error) {
    console.error("Troca do sorteio falhou:", error.message);
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Tela "Sistema" do painel: configuração, próximos envios, problemas e o log recente.
router.get("/monitor", async (req, res) => {
  try {
    res.json({ ok: true, ...(await monitor.retrato()) });
  } catch (error) {
    console.error("Monitor falhou:", error.message);
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Painel (v3.1.0): reuniões e mentorias de 7 dias atrás a 30 dias à frente.
router.get("/reunioes", async (req, res) => {
  try {
    res.json({ ok: true, ...(await require("../services/agenda-dia.service").paraPainel()) });
  } catch (error) {
    console.error("Reuniões do painel falharam:", error.message);
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Painel (v3.1.0): últimos avisos mandados ao grupo do Telegram (desde que a Mani subiu).
router.get("/telegram-avisos", (req, res) => {
  const telegram = require("../services/telegram.service");
  res.json({ ok: true, configurado: telegram.isConfigured(), desde: monitor.iniciadoEm(), avisos: telegram.ultimosAvisos(100) });
});

// Ordem de chegada na Mani da turma atual (ou ?turma=AAAA-MM-DD), para o painel.
router.get("/chegadas", async (req, res) => {
  const turma = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.turma || "")) ? req.query.turma : undefined;

  try {
    res.json({ ok: true, ...(await chegadas.listar(turma)) });
  } catch (error) {
    console.error("Lista de chegadas falhou:", error.message);
    res.status(502).json({ ok: false, erro: "Não foi possível ler a ordem de chegada agora." });
  }
});

// Diagnóstico (só leitura): esse WhatsApp já é contato conhecido aqui ou no ManyChat?
// Com &nome=, testa também a busca pelo nome dos contatos antigos (v2.11.0), sem enviar
// nada e sem guardar a ligação. Ex.: GET /interno/diagnostico/manychat?telefone=11912345678&nome=Maria Silva
router.get("/diagnostico/manychat", async (req, res) => {
  const telefone = normalizarTelefone(req.query.telefone);

  if (!telefone) {
    return res.status(400).json({ ok: false, erro: "Telefone inválido." });
  }

  try {
    res.json({
      ok: true,
      telefone,
      contatoNoSistema: await getStore().contatoManychat(telefone),
      contatoNoManychatPeloNumero: config.manychat.apiKey ? await manychat.buscarPorTelefone(telefone) : "sem MANYCHAT_API_KEY",
      contatoNoManychatPeloCampo: config.manychat.apiKey ? await manychat.buscarPorCampoWhatsapp(telefone) : "sem MANYCHAT_API_KEY",
      ...(req.query.nome
        ? { contatoNoManychatPeloNome: config.manychat.apiKey ? await manychat.buscarPorNome(telefone, String(req.query.nome).slice(0, 120)) : "sem MANYCHAT_API_KEY" }
        : {}),
    });
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Diagnóstico: tenta CRIAR o contato no ManyChat e mostra a resposta (não envia nenhuma
// mensagem). Serve para saber o que o ManyChat faz com um WhatsApp que já é contato:
// devolve o mesmo ID ou dá erro. Ex.: POST /interno/diagnostico/manychat/criar?telefone=...
router.post("/diagnostico/manychat/criar", async (req, res) => {
  const telefone = normalizarTelefone(req.query.telefone);

  if (!telefone) {
    return res.status(400).json({ ok: false, erro: "Telefone inválido." });
  }

  if (!config.manychat.apiKey) {
    return res.status(503).json({ ok: false, erro: "Sem MANYCHAT_API_KEY." });
  }

  try {
    const contatoId = await manychat.garantirContato({ telefoneE164: telefone, nome: "Teste Diagnostico" });
    res.json({ ok: true, telefone, contatoNoSistema: await getStore().contatoManychat(telefone), contatoDevolvidoPeloManychat: contatoId });
  } catch (error) {
    res.json({ ok: false, telefone, contatoNoSistema: await getStore().contatoManychat(telefone), erroDoManychat: error.message });
  }
});

// Teste de uma automação do ManyChat: manda DE VERDADE a mensagem para um contato que o
// sistema já conhece (ex.: quem passou pela Mani). Cada envio é uma mensagem cobrada.
// Ex.: POST /interno/diagnostico/manychat/enviar?telefone=14996053086&fluxo=3dias
const FLUXOS_TESTE = {
  "3dias": () => config.manychat.flowAula.tresDias,
  amiga: () => config.manychat.flowAula.amiga,
  amanha: () => config.manychat.flowAula.amanha,
  hoje: () => config.manychat.flowAula.hoje,
  "1hora": () => config.manychat.flowAula.umaHora,
  aovivo: () => config.manychat.flowAula.aoVivo,
  convite: () => config.manychat.flowConvite,
  confirmacao: () => config.manychat.flowConfirmacao,
  live_vespera: () => config.manychat.flowLive.vespera,
  live_1hora: () => config.manychat.flowLive.umaHora,
  live_comecou: () => config.manychat.flowLive.comecou,
  reuniao_vespera: () => config.manychat.flowReuniao.vespera,
  reuniao_dia_confirmar: () => config.manychat.flowReuniao.diaConfirmar,
  reuniao_dia_confirmado: () => config.manychat.flowReuniao.diaConfirmado,
  reuniao_reagendada: () => config.manychat.flowReuniao.reagendada,
  reuniao_cancelada: () => config.manychat.flowReuniao.cancelada,
  // Sorteio das mentorias e disparo único (v2.12.0).
  sorteio_aviso: () => config.manychat.flowSorteio.aviso,
  sorteio_sorteada: () => config.manychat.flowSorteio.sorteada,
  sorteio_lembrete1: () => config.manychat.flowSorteio.lembrete1,
  sorteio_lembrete2: () => config.manychat.flowSorteio.lembrete2,
  sorteio_perdeu: () => config.manychat.flowSorteio.perdeu,
  sorteio_verificar: () => config.manychat.flowSorteio.verificar,
  mentoria_vespera: () => config.manychat.flowSorteio.vespera,
  mentoria_1hora: () => config.manychat.flowSorteio.umaHora,
  disparo: () => config.manychat.flowDisparo,
};

router.post("/diagnostico/manychat/enviar", async (req, res) => {
  const telefone = normalizarTelefone(req.query.telefone);
  const fluxo = FLUXOS_TESTE[String(req.query.fluxo || "")]?.();

  if (!telefone || !fluxo) {
    return res.status(400).json({
      ok: false,
      erro: `Informe um telefone válido e um fluxo configurado: ${Object.keys(FLUXOS_TESTE).join(", ")}.`,
    });
  }

  try {
    // Contato que o sistema ainda não ligou: procura no ManyChat (sem criar contato).
    const contatoId =
      (await getStore().contatoManychat(telefone)) ||
      (await manychat.buscarPorTelefone(telefone)) ||
      (await manychat.buscarPorCampoWhatsapp(telefone));

    if (!contatoId) {
      return res.status(404).json({ ok: false, erro: "Esse WhatsApp não foi achado no ManyChat (nem pelo campo whatsapp_numero)." });
    }

    // Os mesmos campos que os envios de verdade preenchem antes de disparar.
    if (config.aula.data) await manychat.definirCampoBot("data_aula", convites.turma().texto);
    if (config.aula.link) {
      await manychat.tentarCampoBot("link_aula", config.aula.link);
      await manychat.tentarCampo(contatoId, "link_aula", config.aula.link);
    }
    if (req.query.fluxo === "confirmacao") {
      await manychat.definirCampo(contatoId, "reuniao_texto", "sexta-feira, 23/10, às 15h (teste)");
    }
    if (String(req.query.fluxo).startsWith("reuniao_")) {
      await manychat.definirCampo(contatoId, "reuniao_data", "03/11 (segunda-feira)");
      await manychat.definirCampo(contatoId, "reuniao_hora", "14h30");
      await manychat.definirCampo(contatoId, "reuniao_link", "https://meet.google.com/abc-defg-hij");
      await manychat.definirCampo(contatoId, "reuniao_reagendar", "https://calendly.com/reagendar-teste");
    }
    if (String(req.query.fluxo).startsWith("mentoria_")) {
      await manychat.definirCampo(contatoId, "mentoria_data", "12/11");
      await manychat.definirCampo(contatoId, "mentoria_hora", "15h");
      await manychat.definirCampo(contatoId, "mentoria_link", "https://meet.google.com/abc-defg-hij");
    }

    await manychat.enviarFluxo(contatoId, fluxo);
    res.json({ ok: true, telefone, contatoId, fluxo });
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Teste de um e-mail da aula pelo Brevo, saindo do servidor (o Brevo só aceita os IPs
// autorizados na conta; se recusar, a resposta traz o motivo, com o IP a autorizar).
// Ex.: POST /interno/diagnostico/email/enviar?email=voce@exemplo.com&modelo=3dias&nome=Maria
router.post("/diagnostico/email/enviar", async (req, res) => {
  const endereco = String(req.query.email || "").trim().toLowerCase();
  const chave = String(req.query.modelo || "");
  const modeloId = email.modeloDaAula(chave);

  if (!email.emailValido(endereco) || !modeloId) {
    return res.status(400).json({
      ok: false,
      erro: "Informe um e-mail válido e um modelo configurado (3dias, amanha, 1hora, aovivo), com BREVO_API_KEY na Hostinger.",
    });
  }

  const nome = String(req.query.nome || "Teste").slice(0, 70);
  const params = {
    NOME: email.primeiroNome(nome),
    DATA_AULA: config.aula.data ? convites.turma().texto : "",
    LINK_AULA: config.aula.link || "",
  };

  try {
    await email.enviarModelo({ email: endereco, nome, modeloId, params });
    res.json({ ok: true, email: endereco, modelo: modeloId, params });
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Teste (sem enviar nada): os pulados de um disparo por serem contatos antigos do ManyChat
// seriam achados agora pela busca pelo nome (v2.11.0)? Não cria contato, não envia e não
// guarda a ligação. Devolve as contagens e os nomes de quem continuaria pulado; com
// &telefones=1, também o telefone de cada um (para achar o contato na tela do ManyChat).
// Ex.: GET /interno/diagnostico/pulados?data=2026-11-05&telefones=1
router.get("/diagnostico/pulados", async (req, res) => {
  const data = String(req.query.data || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ ok: false, erro: "Use ?data=AAAA-MM-DD." });
  if (!config.manychat.apiKey) return res.status(503).json({ ok: false, erro: "Sem MANYCHAT_API_KEY." });

  try {
    const pulados = (await getStore().tarefasComPrefixo(`disparo:${data}:`)).filter(
      (t) => t.status === "ignorado" && /already exists|contato antigo/i.test(String(t.erro || ""))
    );
    const continuariam = [];
    let achados = 0;

    for (const tarefa of pulados) {
      const { nome, telefone } = tarefa.dados || {};
      const id = telefone ? await manychat.buscarPorNome(telefone, nome) : null;
      if (id) achados++;
      else if (req.query.telefones === "1") continuariam.push({ nome: nome || "(sem nome)", telefone: telefone || "" });
      else continuariam.push(nome || "(sem nome)");
    }

    res.json({ ok: true, data, pulados: pulados.length, achadosPeloNome: achados, continuariamPulados: continuariam });
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Conferência (sem enviar nada): dos pulados de um disparo, quem já está ligado agora?
// Na mesma ordem de um envio: ligação guardada aqui (etiqueta preencher_whatsapp ou envio
// anterior), campo whatsapp_numero no ManyChat e busca pelo nome. Não cria contato, não
// envia e não guarda nada. Com &telefones=1, os que faltam vêm com o telefone.
// Ex.: GET /interno/diagnostico/ligados?data=2026-11-05
router.get("/diagnostico/ligados", async (req, res) => {
  const data = String(req.query.data || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ ok: false, erro: "Use ?data=AAAA-MM-DD." });
  if (!config.manychat.apiKey) return res.status(503).json({ ok: false, erro: "Sem MANYCHAT_API_KEY." });

  try {
    const pulados = (await getStore().tarefasComPrefixo(`disparo:${data}:`)).filter(
      (t) => t.status === "ignorado" && /already exists|contato antigo/i.test(String(t.erro || ""))
    );
    const r = { ligadosNoSistema: 0, achadosPeloCampo: 0, achadosPeloNome: 0 };
    const faltam = [];

    for (const tarefa of pulados) {
      const { nome, telefone } = tarefa.dados || {};
      if (telefone && (await getStore().contatoManychat(telefone))) r.ligadosNoSistema++;
      else if (telefone && (await manychat.buscarPorCampoWhatsapp(telefone))) r.achadosPeloCampo++;
      else if (telefone && (await manychat.buscarPorNome(telefone, nome))) r.achadosPeloNome++;
      else faltam.push(req.query.telefones === "1" ? { nome: nome || "(sem nome)", telefone: telefone || "" } : nome || "(sem nome)");
    }

    res.json({ ok: true, data, pulados: pulados.length, ...r, prontos: pulados.length - faltam.length, faltam });
  } catch (error) {
    res.status(502).json({ ok: false, erro: error.message });
  }
});

// Teste da leitura da agenda do consultor: roda uma leitura agora e devolve só contagens
// (nenhum título nem convidado). Ex.: POST /interno/diagnostico/agenda
// Diagnóstico (só leitura): os registros de reunião de uma pessoa, pelo telefone, e como o
// evento está agora na agenda do consultor. Ex.: GET /interno/diagnostico/reunioes?telefone=11900004566
router.get("/diagnostico/reunioes", async (req, res) => {
  const telefone = normalizarTelefone(req.query.telefone);
  if (!telefone) return res.status(400).json({ ok: false, erro: "Informe ?telefone=" });
  const alvo = new Set(variantesTelefone(telefone));
  const registros = (await getStore().tarefasComPrefixo("reuniao:")).filter(
    (t) => t.tipo === "reuniao_registro" && alvo.has(normalizarTelefone(t.dados?.telefone || ""))
  );
  const lista = [];
  for (const t of registros) {
    const d = t.dados;
    let agenda = null;
    if (d.googleId && googleAgenda.isConfigured()) {
      try {
        const ev = await googleAgenda.obterEvento(d.googleId);
        agenda = { status: ev.status, inicio: ev.start?.dateTime || null, titulo: ev.summary || "", recorrente: Boolean(ev.recurringEventId) };
      } catch (error) {
        agenda = { erro: error.status || error.message };
      }
    }
    lista.push({ chave: t.chave, origem: d.origem || "calendly", inicio: d.inicio, situacao: d.situacao, confirmacao: d.confirmacao, enviados: d.enviados || [], recorrente: Boolean(d.recorrente), agenda });
  }
  res.json({ ok: true, telefone, total: lista.length, reunioes: lista });
});

// Diagnóstico: o endereço que a Mani enxerga para esta chamada (o limite de tentativas da
// página do sorteio é por endereço). Ex.: GET /interno/diagnostico/ip
router.get("/diagnostico/ip", (req, res) => {
  res.json({ ok: true, ip: req.ip, cadeia: req.get("x-forwarded-for") || null, proxiesConfiado: req.app.get("trust proxy") });
});

router.post("/diagnostico/agenda", async (req, res) => {
  const r = await reunioesAgenda.sincronizarAgenda();
  res.status(r.status === "falhou" ? 502 : 200).json({ ok: r.status === "ok", agenda: config.agenda.id, ...r });
});

module.exports = router;
