const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataSP, horaMinutoSP } = require("../domain/datas");
const { normalizarTelefone } = require("../domain/telefone");
const agendamento = require("./agendamento.service");
const monday = require("./monday.service");
const telegram = require("./telegram.service");

// Disparo único: um modelo mandado uma vez para o mesmo público dos avisos das aulas
// (todo o quadro, menos as Etapas sem avisos), no dia DISPARO_DATA a partir da hora
// DISPARO_HORA (Brasília). O fluxo do ManyChat com o modelo fica em MANYCHAT_FLOW_DISPARO.
// Cada telefone recebe uma vez por data; para outro disparo, troque a data e o fluxo.
// Primeiro uso: aviso do sorteio semanal das mentorias (Aviso_sorteio_inscritos, 05/11/2026).

const TIPO = "unico";
// O envio começa na hora marcada e só pode começar até 2 horas depois (app reiniciado
// tarde não dispara no dia seguinte nem de madrugada).
const JANELA_HORAS = 2;
const MARCA_ABANDONADA_MS = 10 * 60000;
let varrendo = false;

function faltaConfigurar() {
  const falta = [];
  if (!config.manychat.apiKey) falta.push("MANYCHAT_API_KEY");
  if (!config.manychat.flowDisparo) falta.push("MANYCHAT_FLOW_DISPARO");
  if (!config.disparo.data) falta.push("DISPARO_DATA");
  return falta;
}

function devido(agora) {
  const { data, hora } = config.disparo;
  const agoraHora = horaMinutoSP(agora);
  return dataSP(agora) === data && agoraHora >= hora && agoraHora < hora + JANELA_HORAS;
}

async function varrer() {
  const fluxo = config.manychat.flowDisparo;
  const data = config.disparo.data;

  if (varrendo) {
    return { status: "ja_feito" };
  }

  const store = getStore();
  const marca = `disparo_varredura:${data}:${TIPO}`;

  // Só uma cópia do app monta a lista (mesma reserva dos lembretes da aula e das lives).
  const reserva = await store.criarTarefa({ chave: marca, tipo: "disparo_varredura", dados: { iniciadoEm: Date.now() } });

  if (!reserva.criada) {
    const dadosMarca = reserva.dados || {};
    const abandonada =
      dadosMarca.iniciadoEm && !dadosMarca.concluido && Date.now() - dadosMarca.iniciadoEm > MARCA_ABANDONADA_MS;

    if (!abandonada) {
      return { status: "ja_feito" };
    }

    await store.atualizarTarefa(reserva.id, { dados: { iniciadoEm: Date.now(), retomada: true } });
  }

  varrendo = true;
  let concluiu = false;

  try {
    const inscritos = await monday.listarInscritosAula();
    const excluidas = new Set(config.monday.etapasSemAvisos);
    const naoQuerMensagens = new Set(
      inscritos
        .filter((inscrito) => excluidas.has(inscrito.etapa))
        .map((inscrito) => normalizarTelefone(inscrito.telefone))
        .filter(Boolean)
    );

    let novos = 0;
    let semTelefone = 0;
    let naoQuerem = 0;
    const vistos = new Set();

    for (const inscrito of inscritos) {
      const telefone = normalizarTelefone(inscrito.telefone);

      if (!telefone) {
        semTelefone++;
        continue;
      }

      if (vistos.has(telefone)) continue;
      vistos.add(telefone);

      if (naoQuerMensagens.has(telefone)) {
        naoQuerem++;
        continue;
      }

      const tarefa = await store.criarTarefa({
        chave: `disparo:${data}:${TIPO}:${telefone}`,
        tipo: "disparo",
        dados: { nome: inscrito.nome, telefone, mondayItemId: inscrito.id, flowNs: fluxo },
      });

      if (tarefa.criada) novos++;
    }

    // Quem ficou de fora vai junto do resumo final ("concluído"), numa mensagem só (v2.13.0).
    const resumo = [
      semTelefone ? `${semTelefone} sem telefone válido ficaram de fora.` : null,
      naoQuerem ? `${naoQuerem} não ${naoQuerem === 1 ? "quer" : "querem"} receber mensagens.` : null,
    ].filter(Boolean);

    concluiu = true;
    await store.atualizarTarefa(reserva.id, {
      dados: { iniciadoEm: Date.now(), concluido: true, inscritos: vistos.size, novos, resumo },
    });
    await agendamento.fecharLoteDe("disparo", "disparo", data, TIPO);

    if (!novos) {
      try {
        await telegram.enviarAviso(["📣 <b>Disparo único</b>: nenhum envio novo.", ...resumo].join("\n"));
      } catch (error) {
        console.error("Resumo do disparo no Telegram falhou:", error.message);
      }
    }

    agendamento.agendarProcessamento();
    return { status: "enviado", data, novos, semTelefone, naoQuerem };
  } finally {
    varrendo = false;

    if (!concluiu) {
      await store.removerTarefa(marca);
    }
  }
}

// Roda a cada 5 minutos; sem fluxo, data ou fora da janela, não faz nada.
async function rodarDisparo(agora = new Date()) {
  if (faltaConfigurar().length) {
    return { status: "desligado" };
  }

  if (!devido(agora)) {
    return { status: "fora_do_horario" };
  }

  return varrer();
}

function iniciar(intervaloMs = 5 * 60000) {
  if (!config.workerEnabled) {
    return;
  }

  const rodar = () => rodarDisparo().catch((error) => console.error("Disparo único falhou:", error.message));
  rodar();
  setInterval(rodar, intervaloMs).unref();
}

module.exports = {
  JANELA_HORAS,
  faltaConfigurar,
  iniciar,
  rodarDisparo,
};
