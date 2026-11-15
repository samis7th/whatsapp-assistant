const crypto = require("crypto");
const express = require("express");

const { config } = require("../config/env");
const agendamento = require("../services/agendamento.service");
const chegadas = require("../services/chegadas.service");
const contatos = require("../services/contatos.service");
const mentoria = require("../services/mentoria.service");
const reunioes = require("../services/reunioes.service");
const service = require("../services/preatendimento.service");

const router = express.Router();

// O ManyChat manda a chave no header X-Api-Key (configurado no External Request).
// A mesma chave protege o disparo manual dos lembretes (/cron/lembretes).
function exigirChave(req, res, next) {
  const recebida = Buffer.from(String(req.get("x-api-key") || ""));
  const esperada = Buffer.from(config.manychatSecret);

  if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) {
    return res.status(401).json({ resultado: "nao_autorizado" });
  }

  next();
}

// Campo vazio no ManyChat chega como "{{cuf_123}}" ou texto vazio.
function campo(valor, limite = 200) {
  const texto = String(valor ?? "").trim();
  return !texto || /^\{\{.*\}\}$/.test(texto) ? "" : texto.slice(0, limite);
}

function contatoValido(contatoId) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(contatoId);
}

// O ManyChat cola o texto da pessoa direto no corpo, sem escapar: uma resposta com
// aspas ou com várias linhas deixa o JSON inválido. Primeiro tenta o JSON normal; se
// falhar, troca quebras de linha por espaço; em último caso, extrai campo a campo.
const CAMPOS_CORPO = ["contato_id", "whatsapp", "nome", "telefone", "email", "resposta"];

function interpretarCorpo(bruto) {
  const texto = String(bruto || "");

  for (const tentativa of [texto, texto.replace(/[\u0000-\u001f]+/g, " ")]) {
    try {
      const corpo = JSON.parse(tentativa);
      if (corpo && typeof corpo === "object") return corpo;
    } catch {
      // segue para a próxima tentativa
    }
  }

  const corpo = {};
  const proximo = CAMPOS_CORPO.join("|");

  for (const nome of CAMPOS_CORPO) {
    const achado = texto.match(new RegExp(`"${nome}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"(?:${proximo})"\\s*:|}\\s*$)`));
    if (achado) corpo[nome] = achado[1].replace(/[\u0000-\u001f]+/g, " ");
  }

  return corpo;
}

function lerCorpo(req, res, next) {
  req.body = interpretarCorpo(typeof req.body === "string" ? req.body : "");
  next();
}

// Todos os campos do mapeamento sempre vêm (vazios quando não se aplicam).
const VAZIA = { primeiro_nome: "", valor_texto: "", motivo: "", link_agendamento: "" };

// Sempre responde 200 com { resultado }: o fluxo do ManyChat decide a próxima
// mensagem por esse campo. Erro inesperado vira "erro" (nunca deixa a conversa sem resposta).
function rota(handler) {
  return async (req, res) => {
    const contatoId = campo(req.body?.contato_id, 64);

    if (!contatoValido(contatoId)) {
      return res.status(400).json({ resultado: "erro", motivo: "contato_id" });
    }

    try {
      const resposta = await handler(contatoId, req.body || {});
      res.json({ ...VAZIA, ...resposta });
    } catch (error) {
      console.error(`ManyChat ${req.path} falhou:`, error.code || error.message);
      res.json({ ...VAZIA, resultado: "erro" });
    }
  };
}

router.use(express.text({ type: "*/*", limit: "10kb" }));
router.use(exigirChave);
router.use(lerCorpo);

router.post(
  "/telefone",
  rota((contatoId, body) =>
    service.receberTelefone({
      contatoId,
      whatsapp: campo(body.whatsapp, 40),
      nome: campo(body.nome, 120),
      telefone: campo(body.telefone, 60),
    })
  )
);

// Botão "Verificar cadastro" do sorteio: a pessoa manda o e-mail pelo WhatsApp.
router.post("/email", rota((contatoId, body) => mentoria.receberEmail({ contatoId, email: campo(body.email, 160) })));

router.post(
  "/faturamento",
  rota((contatoId, body) => service.receberFaturamento({ contatoId, resposta: campo(body.resposta) }))
);

router.post(
  "/confirmacao",
  rota((contatoId, body) => service.confirmarValor({ contatoId, resposta: campo(body.resposta, 60) }))
);

// Primeiro bloco do fluxo da Mani: guarda a ordem de chegada (não muda a conversa).
router.post(
  "/chegada",
  rota((contatoId, body) =>
    chegadas.registrarChegada({ contatoId, whatsapp: campo(body.whatsapp, 40), nome: campo(body.nome, 120) })
  )
);

// O fluxo de lembrete do ManyChat pergunta, a cada dia, se ainda manda o lembrete.
router.post("/lembrete", rota((contatoId) => agendamento.proximoLembrete({ contatoId })));

// Botão "Não quero marcar a reunião" do lembrete.
router.post("/recusa", rota((contatoId) => agendamento.recusar({ contatoId })));

// Botão "Não quero receber" (modelo parar_avisos_aula): para os avisos da aula.
router.post("/parar-avisos", rota((contatoId) => agendamento.pararAvisos({ contatoId })));

// Botão "Quero voltar a receber" (v3.3.0), na confirmação do "parar". Devolve resultado:
// ok, sem_cadastro ou erro.
router.post("/voltar-avisos", rota((contatoId) => agendamento.voltarAvisos({ contatoId })));

// Resposta aos lembretes da reunião ("Sim, confirmo", "Não posso", "Não quero reagendar"
// ou texto digitado). Devolve resultado: confirmado, reagendar, cancelado, falha, humano
// ou sem_reuniao, e os campos da reunião para a mensagem de resposta.
router.post("/reuniao", rota((contatoId, body) => reunioes.responder({ contatoId, resposta: campo(body.resposta, 300) })));

// Automação "Preencher whatsapp_numero" (contatos antigos que a API não acha pelo número):
// só manda o ID do contato; a Mani lê o número pela API e guarda a ligação.
// Devolve resultado: ok ou sem_telefone.
router.post("/vincular", rota((contatoId) => contatos.vincular({ contatoId })));

module.exports = {
  exigirChave,
  interpretarCorpo,
  router,
};
