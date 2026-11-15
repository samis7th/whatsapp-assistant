const { config } = require("../config/env");
const { getStore } = require("../db");
const { dataSP, horaMinutoSP } = require("../domain/datas");
const { normalizarTelefone } = require("../domain/telefone");
const agendamento = require("./agendamento.service");
const monday = require("./monday.service");
const telegram = require("./telegram.service");

// Lembretes das lives (20h, no YouTube), no privado, para o mesmo público dos avisos
// das aulas (todo o quadro, qualquer Funil), menos as Etapas do Funil
// sem avisos (ex.: "Não quer receber mensagens", pelo botão ou pela equipe).
// O link da live fica no campo do bot link_live (no ManyChat), igual para todos.
// Só saem para as datas em LIVE_DATA (uma ou várias); vazio = nenhum lembrete de live.

const TIPOS = [
  {
    chave: "vespera",
    rotulo: "véspera",
    diasAntes: 1,
    fluxo: () => config.manychat.flowLive.vespera,
    inicio: () => config.lives.horaVespera,
    fim: () => 24,
  },
  {
    chave: "1hora",
    rotulo: "começa em 1 hora",
    diasAntes: 0,
    fluxo: () => config.manychat.flowLive.umaHora,
    inicio: () => config.lives.horaLive - 1,
    fim: () => config.lives.horaLive,
  },
  {
    chave: "comecou",
    rotulo: "começou agora",
    diasAntes: 0,
    fluxo: () => config.manychat.flowLive.comecou,
    inicio: () => config.lives.horaLive,
    fim: () => config.lives.horaLive + 1,
  },
];

function somarDias(iso, dias) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
}

// Lembretes que podem sair agora, cada um com a data da live.
function devidos(agora) {
  const hoje = dataSP(agora);
  const hora = horaMinutoSP(agora);

  return TIPOS.map((tipo) => ({ tipo, live: somarDias(hoje, tipo.diasAntes) })).filter(
    ({ tipo, live }) =>
      config.lives.datas.includes(live) && hora >= tipo.inicio() && hora < tipo.fim()
  );
}

const MARCA_ABANDONADA_MS = 10 * 60000;
let varrendo = false;

async function varrer(tipo, live) {
  const fluxo = tipo.fluxo();

  if (!fluxo) {
    return { status: "sem_fluxo", tipo: tipo.chave };
  }

  if (varrendo) {
    return { status: "ja_feito", tipo: tipo.chave };
  }

  const store = getStore();
  const marca = `live_varredura:${live}:${tipo.chave}`;

  // Só uma cópia do app faz a leitura (mesma reserva dos lembretes da aula).
  const reserva = await store.criarTarefa({ chave: marca, tipo: "live_varredura", dados: { iniciadoEm: Date.now() } });

  if (!reserva.criada) {
    const dadosMarca = reserva.dados || {};
    const abandonada =
      dadosMarca.iniciadoEm && !dadosMarca.concluido && Date.now() - dadosMarca.iniciadoEm > MARCA_ABANDONADA_MS;

    if (!abandonada) {
      return { status: "ja_feito", tipo: tipo.chave };
    }

    await store.atualizarTarefa(reserva.id, { dados: { iniciadoEm: Date.now(), retomada: true } });
  }

  varrendo = true;
  let concluiu = false;

  try {
    // O mesmo público dos avisos das aulas: todo o quadro, menos as Etapas sem avisos.
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
        chave: `live:${live}:${tipo.chave}:${telefone}`,
        tipo: "live_lembrete",
        dados: { nome: inscrito.nome, telefone, mondayItemId: inscrito.id, flowNs: fluxo },
      });

      if (tarefa.criada) novos++;
    }

    concluiu = true;
    await store.atualizarTarefa(reserva.id, {
      dados: { iniciadoEm: Date.now(), concluido: true, inscritos: vistos.size, novos },
    });
    await agendamento.fecharLoteDe("live_lembrete", "live", live, tipo.chave);

    const [, mes, dia] = live.split("-");

    try {
      await telegram.enviarAviso(
        [
          `📺 <b>Lembrete da live (${tipo.rotulo})</b>`,
          `Saindo no privado para ${novos} ${novos === 1 ? "inscrito" : "inscritos"} (live de ${dia}/${mes}).`,
          semTelefone ? `${semTelefone} sem telefone válido ficaram de fora.` : null,
          naoQuerem ? `${naoQuerem} não ${naoQuerem === 1 ? "quer" : "querem"} receber mensagens.` : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (error) {
      console.error("Resumo do lembrete da live no Telegram falhou:", error.message);
    }

    agendamento.agendarProcessamento();
    return { status: "enviado", tipo: tipo.chave, live, novos, semTelefone };
  } finally {
    varrendo = false;

    if (!concluiu) {
      await store.removerTarefa(marca);
    }
  }
}

// Roda a cada 5 minutos, junto com os lembretes da aula.
async function rodarLembretesLives(agora = new Date()) {
  if (!config.manychat.apiKey) {
    return { status: "desligado" };
  }

  const lista = devidos(agora);

  if (!lista.length) {
    return { status: "sem_lembrete_agora" };
  }

  let resultado = null;

  for (const { tipo, live } of lista) {
    const atual = await varrer(tipo, live);
    if (!resultado || resultado.status === "ja_feito") resultado = atual;
  }

  return resultado;
}

function iniciar(intervaloMs = 5 * 60000) {
  if (!config.workerEnabled) {
    return;
  }

  const rodar = () => rodarLembretesLives().catch((error) => console.error("Lembretes das lives falharam:", error.message));
  rodar();
  setInterval(rodar, intervaloMs).unref();
}

module.exports = {
  iniciar,
  rodarLembretesLives,
};
