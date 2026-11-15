const { variantesTelefone } = require("../domain/telefone");
const { novoAtendimento } = require("./campos");

// Mesmos campos atualizáveis do MySQL (sem carregar o mysql2 nos testes).
const CAMPOS_MENTORIA = ["nome", "telefone", "email", "sorteada", "agendamento", "eventoCalendly", "mentoriaEm", "meetLink"];

// Mesmo contrato do mysql-store, em memória: só para testes e uso local.
function createMemoryStore() {
  const linhas = [];
  const tarefas = [];
  const contatos = new Map();
  const chegadas = [];
  const inscricoes = [];
  let proximaInscricao = 1;
  const copiaInscricao = (item) => (item ? { ...item } : null);
  let proximoId = 1;
  let proximaTarefa = 1;

  const copia = (linha) => (linha ? { ...linha } : null);
  const copiaTarefa = (tarefa) =>
    tarefa ? { ...tarefa, dados: { ...tarefa.dados }, etapas: [...tarefa.etapas] } : null;

  return {
    async init() {},
    async ping() {},
    async close() {},

    async atual(contatoId) {
      const doContato = linhas.filter((linha) => linha.contatoId === contatoId);
      return copia(doContato[doContato.length - 1]);
    },

    async criar(dados) {
      const agora = new Date();
      const linha = { ...novoAtendimento(dados), id: proximoId++, criadoEm: agora, atualizadoEm: agora };
      linhas.push(linha);
      return copia(linha);
    },

    async atualizar(id, campos) {
      const linha = linhas.find((item) => item.id === id);
      Object.assign(linha, campos, { atualizadoEm: new Date() });
      return copia(linha);
    },

    async pendentes(agora = new Date(), limite = 20) {
      return linhas
        .filter(
          (linha) =>
            linha.sync === "pendente" &&
            (!linha.syncProxima || linha.syncProxima <= agora) &&
            (!linha.syncBloqueio || linha.syncBloqueio <= agora)
        )
        .slice(0, limite)
        .map(copia);
    },

    async todos() {
      return linhas.map(copia);
    },

    async porId(id) {
      return copia(linhas.find((linha) => linha.id === id));
    },

    async porRef(ref) {
      return copia(linhas.find((linha) => linha.refAgendamento === ref));
    },

    async porEvento(eventoUri) {
      return copia([...linhas].reverse().find((linha) => linha.eventoCalendly === eventoUri));
    },

    async qualificadasPorTelefone(telefone) {
      return [...linhas]
        .reverse()
        .filter((linha) => linha.resultado === "qualificada" && (linha.telefone === telefone || linha.whatsapp === telefone))
        .slice(0, 5)
        .map(copia);
    },

    async aguardandoAgendamento() {
      return linhas
        .filter((linha) => linha.agendamento === "pendente" && linha.resultado === "qualificada")
        .map(copia);
    },

    async criarTarefa({ chave, tipo, atendimentoId = null, dados = {}, proxima = null }) {
      let tarefa = tarefas.find((item) => item.chave === chave);
      const criada = !tarefa;

      if (!tarefa) {
        tarefa = {
          id: proximaTarefa++,
          chave,
          tipo,
          atendimentoId,
          dados: { ...dados },
          etapas: [],
          status: "pendente",
          tentativas: 0,
          erro: null,
          proxima,
          criadoEm: new Date(),
          atualizadoEm: new Date(),
          alertaFalha: false,
          bloqueio: null,
        };
        tarefas.push(tarefa);
      }

      return { ...copiaTarefa(tarefa), criada };
    },

    async atualizarTarefa(id, campos) {
      const tarefa = tarefas.find((item) => item.id === id);
      Object.assign(tarefa, campos, { atualizadoEm: new Date() });
      return copiaTarefa(tarefa);
    },

    async tarefasPendentes(agora = new Date(), limite = 20) {
      return tarefas
        .filter(
          (tarefa) =>
            tarefa.status === "pendente" &&
            (!tarefa.proxima || tarefa.proxima <= agora) &&
            (!tarefa.bloqueio || tarefa.bloqueio <= agora)
        )
        .slice(0, limite)
        .map(copiaTarefa);
    },

    async contatoManychat(telefone) {
      const telefones = variantesTelefone(telefone);
      const criado = telefones.find((item) => contatos.has(item));
      if (criado) return contatos.get(criado);
      const conversa = [...linhas].reverse().find((linha) => telefones.includes(linha.whatsapp));
      return conversa?.contatoId || null;
    },

    async telefoneDoContato(contatoId) {
      const id = String(contatoId);
      for (const [telefone, valor] of contatos) if (valor === id) return telefone;
      const conversa = [...linhas].reverse().find((linha) => linha.contatoId === id && linha.whatsapp);
      return conversa?.whatsapp || null;
    },

    async salvarContatoManychat(telefone, contatoId) {
      contatos.set(telefone, String(contatoId));
    },

    async travarTarefa(id, ate, agora = new Date()) {
      const tarefa = tarefas.find((item) => item.id === id);
      if (!tarefa || tarefa.status !== "pendente" || (tarefa.bloqueio && tarefa.bloqueio > agora)) return false;
      if (tarefa.proxima && tarefa.proxima > agora) return false;
      tarefa.bloqueio = ate;
      return true;
    },

    async travarSync(id, ate, agora = new Date()) {
      const linha = linhas.find((item) => item.id === id);
      if (!linha || linha.sync !== "pendente" || (linha.syncBloqueio && linha.syncBloqueio > agora)) return false;
      linha.syncBloqueio = ate;
      return true;
    },

    async removerTarefa(chave) {
      const indice = tarefas.findIndex((tarefa) => tarefa.chave === chave);
      if (indice >= 0) tarefas.splice(indice, 1);
    },

    async tarefasComPrefixo(prefixo) {
      return tarefas.filter((tarefa) => tarefa.chave.startsWith(prefixo)).map(copiaTarefa);
    },

    async tarefaPorChave(chave) {
      return copiaTarefa(tarefas.find((tarefa) => tarefa.chave === chave));
    },

    async registrarChegada({ turma, contatoId, whatsapp, nome, em }) {
      let chegada = chegadas.find((item) => item.turma === turma && item.contatoId === contatoId);
      const nova = !chegada;
      if (nova) {
        chegada = { turma, contatoId, whatsapp, nome, em };
        chegadas.push(chegada);
      }
      const posicao = chegadas.filter((item) => item.turma === turma).indexOf(chegada) + 1;
      return { ...chegada, posicao, nova };
    },

    async chegadas(turma) {
      return chegadas.filter((item) => item.turma === turma).map((item, indice) => ({ ...item, posicao: indice + 1 }));
    },

    async inscreverMentoria({ rodada, mondayItemId, nome, telefone, email, em = new Date() }) {
      let item = inscricoes.find((i) => i.rodada === rodada && i.mondayItemId === String(mondayItemId));
      const nova = !item;
      if (nova) {
        item = {
          id: proximaInscricao++,
          rodada,
          mondayItemId: String(mondayItemId),
          nome: nome || "",
          telefone: telefone || "",
          email: email || "",
          inscritoEm: em,
          atualizadoEm: em,
          sorteada: false,
          agendamento: null,
          eventoCalendly: null,
          mentoriaEm: null,
          meetLink: null,
        };
        inscricoes.push(item);
      }
      return { ...copiaInscricao(item), nova };
    },

    async inscricoesMentoria(rodada) {
      return inscricoes.filter((i) => i.rodada === rodada).map(copiaInscricao);
    },

    async inscricaoMentoria(id) {
      return copiaInscricao(inscricoes.find((i) => i.id === id));
    },

    async sorteadasMentoria(desde) {
      return inscricoes
        .filter((i) => i.sorteada && i.rodada >= desde)
        .sort((a, b) => (a.rodada === b.rodada ? a.id - b.id : a.rodada < b.rodada ? 1 : -1))
        .map(copiaInscricao);
    },

    async atualizarInscricaoMentoria(id, campos) {
      const item = inscricoes.find((i) => i.id === id);
      for (const campo of Object.keys(campos)) if (!CAMPOS_MENTORIA.includes(campo)) throw new Error(`Campo desconhecido: ${campo}`);
      Object.assign(item, campos, { atualizadoEm: new Date() });
      return copiaInscricao(item);
    },

    async limparDadosAntigos(antesDe) {
      const apagar = (lista, velho) => {
        let n = 0;
        for (let i = lista.length - 1; i >= 0; i--) if (velho(lista[i])) (lista.splice(i, 1), n++);
        return n;
      };
      // A ligação com o ManyChat dos pré-atendimentos que vão sair fica guardada.
      for (const l of [...linhas].reverse()) {
        if (l.sync !== "pendente" && l.atualizadoEm < antesDe && /^\+/.test(l.whatsapp || "") && !contatos.has(l.whatsapp)) {
          contatos.set(l.whatsapp, String(l.contatoId));
        }
      }
      return {
        tarefas: apagar(tarefas, (t) => t.status !== "pendente" && t.tipo !== "sem_avisos" && t.atualizadoEm < antesDe),
        atendimentos: apagar(linhas, (l) => l.sync !== "pendente" && l.atualizadoEm < antesDe),
        chegadas: apagar(chegadas, (c) => new Date(c.em) < antesDe),
        inscricoes: apagar(inscricoes, (i) => (i.atualizadoEm || i.inscritoEm) < antesDe),
      };
    },

    async todasTarefas() {
      return tarefas.map(copiaTarefa);
    },

    // Tela "Sistema" do painel: contagem dos últimos dias, próximos envios marcados,
    // problemas (falhou ou tentando de novo) e atividade recente.
    async monitorTarefas({ agora = new Date(), desde }) {
      const internos = new Set(["reuniao_registro", "reuniao_indice", "aula_varredura", "live_varredura", "disparo_varredura", "resumo_lote", "chegadas_marca", "mentoria_varredura", "mentoria_rodada", "grupo_lista"]);
      const visiveis = tarefas.filter((t) => !internos.has(t.tipo));
      const recentesPrimeiro = (a, b) => b.atualizadoEm - a.atualizadoEm;
      const contagem = new Map();

      for (const t of visiveis.filter((item) => item.atualizadoEm >= desde)) {
        const chave = `${t.tipo}\u0000${t.status}`;
        contagem.set(chave, (contagem.get(chave) || 0) + 1);
      }

      return {
        contagem: [...contagem].map(([chave, total]) => {
          const [tipo, status] = chave.split("\u0000");
          return { tipo, status, total };
        }),
        proximas: visiveis
          .filter((t) => t.status === "pendente" && t.proxima && t.proxima > agora)
          .sort((a, b) => a.proxima - b.proxima)
          .slice(0, 40)
          .map(copiaTarefa),
        problemas: visiveis
          .filter((t) => t.status === "falhou" || (t.status === "pendente" && t.tentativas > 0))
          .sort(recentesPrimeiro)
          .slice(0, 40)
          .map(copiaTarefa),
        recentes: [...visiveis].sort(recentesPrimeiro).slice(0, 60).map(copiaTarefa),
      };
    },

    // Contagem das tarefas cuja chave começa com o prefixo, por status e erro.
    async resumoTarefas(prefixo) {
      const contagem = new Map();
      for (const tarefa of tarefas.filter((item) => item.chave.startsWith(prefixo))) {
        const chave = `${tarefa.status}\u0000${tarefa.erro || ""}`;
        contagem.set(chave, (contagem.get(chave) || 0) + 1);
      }
      return [...contagem].map(([chave, total]) => {
        const [status, erro] = chave.split("\u0000");
        return { status, erro: erro || null, total };
      });
    },
  };
}

module.exports = {
  createMemoryStore,
};
