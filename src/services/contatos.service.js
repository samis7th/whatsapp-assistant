const { config } = require("../config/env");
const { getStore } = require("../db");
const { normalizarTelefone } = require("../domain/telefone");
const manychat = require("./manychat.service");

// Contatos antigos do ManyChat: a API não acha esses contatos pelo número do WhatsApp
// ("This WhatsApp ID already exists"), então os avisos para eles são pulados. A automação
// "Preencher whatsapp_numero" do ManyChat chama POST /manychat/vincular com o ID do contato
// (a única variável que funciona ali); a Mani lê o número pela API e guarda a ligação
// telefone -> contato. Todos os envios procuram primeiro essa ligação, então os próximos
// avisos saem. Também preenche o campo whatsapp_numero, como reserva.
async function vincular({ contatoId }) {
  const info = (await manychat.obterContato(contatoId)) || {};
  // Primeiro os campos próprios do WhatsApp. O "phone" genérico só vale para contato que
  // não é do Instagram: contato do Instagram com telefone ligaria o número ao canal errado.
  const doInstagram = Boolean(info.ig_id || info.ig_username || info.instagram_id);
  const origem = ["whatsapp_phone", "wa_id", "whatsapp_id"].find((k) => info[k]) || (!doInstagram && info.phone ? "phone" : null);
  const telefone = origem ? normalizarTelefone(String(info[origem])) : null;

  if (!telefone) {
    // Sem número: devolve só os nomes dos campos (sem valores), para conferir no teste
    // da requisição do ManyChat onde o número está.
    return { resultado: "sem_telefone", motivo: Object.keys(info).join(",").slice(0, 400) };
  }

  await getStore().salvarContatoManychat(telefone, contatoId);

  try {
    await manychat.definirCampo(contatoId, config.manychat.campoWhatsapp, telefone.slice(1));
  } catch (error) {
    console.error("Campo whatsapp_numero não gravado:", error.message);
  }

  // motivo = de qual campo veio o número (só o nome), para conferir no teste do ManyChat.
  return { resultado: "ok", motivo: origem };
}

module.exports = { vincular };
