const mysql = require("mysql2/promise");

const { variantesTelefone } = require("../domain/telefone");
const { BOOLEANOS, CAMPOS, NUMEROS, novoAtendimento } = require("./campos");

// A tabela é criada sozinha na primeira vez que o app sobe.
const SCHEMA = `CREATE TABLE IF NOT EXISTS preatendimentos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  contato_id VARCHAR(64) NOT NULL,
  whatsapp VARCHAR(20) NULL,
  nome_whatsapp VARCHAR(120) NULL,
  telefone_informado VARCHAR(60) NULL,
  telefone VARCHAR(20) NULL,
  tentativas_telefone TINYINT UNSIGNED NOT NULL DEFAULT 0,
  monday_item_id VARCHAR(20) NULL,
  monday_nome VARCHAR(160) NULL,
  busca_pendente TINYINT(1) NOT NULL DEFAULT 0,
  faturamento_texto VARCHAR(200) NULL,
  faturamento_valor DECIMAL(14,2) NULL,
  valor_pendente DECIMAL(14,2) NULL,
  tentativas_faturamento TINYINT UNSIGNED NOT NULL DEFAULT 0,
  faixa VARCHAR(60) NULL,
  resultado VARCHAR(20) NULL,
  motivo VARCHAR(40) NULL,
  resposta_enviada VARCHAR(20) NULL,
  etapa_monday TINYINT(1) NOT NULL DEFAULT 0,
  etapa_comentario TINYINT(1) NOT NULL DEFAULT 0,
  etapa_telegram TINYINT(1) NOT NULL DEFAULT 0,
  sync VARCHAR(12) NOT NULL DEFAULT 'nenhum',
  sync_tentativas INT UNSIGNED NOT NULL DEFAULT 0,
  sync_erro VARCHAR(500) NULL,
  sync_proxima DATETIME NULL,
  alerta_falha TINYINT(1) NOT NULL DEFAULT 0,
  concluido_em DATETIME NULL,
  criado_em DATETIME NOT NULL,
  atualizado_em DATETIME NOT NULL,
  KEY idx_preatendimentos_contato (contato_id, id),
  KEY idx_preatendimentos_sync (sync, sync_proxima)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// Colunas do agendamento (v1.1): entram sozinhas na tabela que já existe.
const MIGRATIONS = [
  ["ref_agendamento", "VARCHAR(32) NULL"],
  ["agendamento", "VARCHAR(16) NULL"],
  ["lembretes", "TINYINT UNSIGNED NOT NULL DEFAULT 0"],
  ["ultimo_lembrete", "DATE NULL"],
  ["reuniao_em", "DATETIME NULL"],
  ["evento_calendly", "VARCHAR(255) NULL"],
  ["sync_bloqueio", "DATETIME NULL"],
];

// Colunas novas da tabela de tarefas.
const MIGRATIONS_TAREFAS = [["bloqueio", "DATETIME NULL"]];

const INDICES = [
  ["idx_preatendimentos_ref", "(ref_agendamento)"],
  ["idx_preatendimentos_agendamento", "(agendamento)"],
];

// Avisos do Calendly e ações do agendamento: cada um é feito uma vez só (chave única)
// e repetido em segundo plano se a Monday, o Telegram ou o ManyChat falharem.
const SCHEMA_TAREFAS = `CREATE TABLE IF NOT EXISTS preatendimento_tarefas (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  chave VARCHAR(190) NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  atendimento_id INT UNSIGNED NULL,
  dados TEXT NULL,
  etapas VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(12) NOT NULL DEFAULT 'pendente',
  tentativas INT UNSIGNED NOT NULL DEFAULT 0,
  erro VARCHAR(500) NULL,
  proxima DATETIME NULL,
  alerta_falha TINYINT(1) NOT NULL DEFAULT 0,
  bloqueio DATETIME NULL,
  criado_em DATETIME NOT NULL,
  atualizado_em DATETIME NOT NULL,
  UNIQUE KEY uq_tarefas_chave (chave),
  KEY idx_tarefas_status (status, proxima)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// Telefone -> ID do contato no ManyChat (criado pela API ou visto numa conversa),
// para não criar o mesmo contato duas vezes.
const SCHEMA_CONTATOS = `CREATE TABLE IF NOT EXISTS manychat_contatos (
  telefone VARCHAR(20) PRIMARY KEY,
  contato_id VARCHAR(64) NOT NULL,
  criado_em DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// Ordem de chegada na Mani, por turma: o ID crescente é a ordem (um por contato e turma).
const SCHEMA_CHEGADAS = `CREATE TABLE IF NOT EXISTS mani_chegadas (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  turma VARCHAR(10) NOT NULL,
  contato_id VARCHAR(64) NOT NULL,
  whatsapp VARCHAR(20) NULL,
  nome VARCHAR(120) NULL,
  chegou_em DATETIME(3) NOT NULL,
  UNIQUE KEY uq_chegadas_turma_contato (turma, contato_id),
  KEY idx_chegadas_turma (turma, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// Sorteio das mentorias: uma linha por pessoa e rodada (a rodada é a terça da semana).
// agendamento: null (não sorteada), pendente, agendada, perdeu, cancelada.
const SCHEMA_MENTORIA = `CREATE TABLE IF NOT EXISTS mentoria_inscricoes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rodada CHAR(10) NOT NULL,
  monday_item_id VARCHAR(20) NOT NULL,
  nome VARCHAR(160) NULL,
  telefone VARCHAR(20) NULL,
  email VARCHAR(160) NULL,
  inscrito_em DATETIME NOT NULL,
  sorteada TINYINT(1) NOT NULL DEFAULT 0,
  agendamento VARCHAR(12) NULL,
  evento_calendly VARCHAR(255) NULL,
  mentoria_em DATETIME NULL,
  meet_link VARCHAR(255) NULL,
  atualizado_em DATETIME NOT NULL,
  UNIQUE KEY uq_mentoria_rodada_item (rodada, monday_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// Campos que podem ser atualizados (o banco em memória dos testes aceita os mesmos).
const COLUNAS_MENTORIA = {
  nome: "nome",
  telefone: "telefone",
  email: "email",
  sorteada: "sorteada",
  agendamento: "agendamento",
  eventoCalendly: "evento_calendly",
  mentoriaEm: "mentoria_em",
  meetLink: "meet_link",
};

function deInscricao(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    rodada: row.rodada,
    mondayItemId: row.monday_item_id,
    nome: row.nome || "",
    telefone: row.telefone || "",
    email: row.email || "",
    inscritoEm: new Date(row.inscrito_em),
    sorteada: Boolean(row.sorteada),
    agendamento: row.agendamento || null,
    eventoCalendly: row.evento_calendly || null,
    mentoriaEm: row.mentoria_em ? new Date(row.mentoria_em) : null,
    meetLink: row.meet_link || null,
  };
}

function deChegada(row) {
  return {
    turma: row.turma,
    contatoId: row.contato_id,
    whatsapp: row.whatsapp,
    nome: row.nome,
    em: row.chegou_em,
  };
}

function deTarefa(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    chave: row.chave,
    tipo: row.tipo,
    atendimentoId: row.atendimento_id,
    dados: row.dados ? JSON.parse(row.dados) : {},
    etapas: row.etapas ? row.etapas.split(",").filter(Boolean) : [],
    status: row.status,
    tentativas: Number(row.tentativas),
    erro: row.erro,
    proxima: row.proxima,
    alertaFalha: Boolean(row.alerta_falha),
  };
}

const COLUNAS_TAREFA = {
  dados: (v) => ["dados", JSON.stringify(v || {})],
  etapas: (v) => ["etapas", (v || []).join(",")],
  status: (v) => ["status", v],
  tentativas: (v) => ["tentativas", v],
  erro: (v) => ["erro", v ? String(v).slice(0, 500) : null],
  proxima: (v) => ["proxima", v || null],
  alertaFalha: (v) => ["alerta_falha", v ? 1 : 0],
  bloqueio: (v) => ["bloqueio", v || null],
};

function deLinha(row) {
  if (!row) {
    return null;
  }

  const atendimento = { id: row.id, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em };

  for (const [campo, coluna] of Object.entries(CAMPOS)) {
    let valor = row[coluna];

    if (BOOLEANOS.has(campo)) {
      valor = Boolean(valor);
    } else if (NUMEROS.has(campo) && valor !== null) {
      valor = Number(valor);
    }

    atendimento[campo] = valor;
  }

  return atendimento;
}

function paraBanco(campo, valor) {
  if (BOOLEANOS.has(campo)) {
    return valor ? 1 : 0;
  }

  if (typeof valor === "string") {
    const limite =
      campo === "syncErro" ? 500 : campo === "eventoCalendly" ? 255 : campo === "faturamentoTexto" ? 200 : 160;
    return valor.slice(0, limite);
  }

  return valor === undefined ? null : valor;
}

function createMysqlStore(dbConfig) {
  const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 4,
    // DATE volta como texto "AAAA-MM-DD"; DATETIME é gravado e lido em UTC.
    dateStrings: ["DATE"],
    timezone: "Z",
    charset: "utf8mb4",
  });

  async function buscar(id) {
    const [rows] = await pool.query("SELECT * FROM preatendimentos WHERE id = ?", [id]);
    return deLinha(rows[0]);
  }

  return {
    async init() {
      await pool.query(SCHEMA);
      await pool.query(SCHEMA_TAREFAS);
      await pool.query(SCHEMA_CONTATOS);
      await pool.query(SCHEMA_CHEGADAS);
      await pool.query(SCHEMA_MENTORIA);

      const lista = [
        ...MIGRATIONS.map(([coluna, definicao]) => ["preatendimentos", coluna, definicao]),
        ...MIGRATIONS_TAREFAS.map(([coluna, definicao]) => ["preatendimento_tarefas", coluna, definicao]),
      ];

      for (const [tabela, coluna, definicao] of lista) {
        const [rows] = await pool.query(
          "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
          [tabela, coluna]
        );

        if (!rows.length) {
          await pool.query(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
          console.log(`Database migrated: ${tabela}.${coluna}`);
        }
      }

      for (const [indice, colunas] of INDICES) {
        const [rows] = await pool.query(
          "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'preatendimentos' AND INDEX_NAME = ?",
          [indice]
        );

        if (!rows.length) {
          await pool.query(`ALTER TABLE preatendimentos ADD INDEX ${indice} ${colunas}`);
        }
      }
    },

    async ping() {
      await pool.query("SELECT 1");
    },

    async close() {
      await pool.end();
    },

    async atual(contatoId) {
      const [rows] = await pool.query(
        "SELECT * FROM preatendimentos WHERE contato_id = ? ORDER BY id DESC LIMIT 1",
        [contatoId]
      );
      return deLinha(rows[0]);
    },

    async criar(dados) {
      const atendimento = novoAtendimento(dados);
      const colunas = [];
      const valores = [];

      for (const [campo, coluna] of Object.entries(CAMPOS)) {
        colunas.push(coluna);
        valores.push(paraBanco(campo, atendimento[campo]));
      }

      const agora = new Date();
      const [result] = await pool.query(
        `INSERT INTO preatendimentos (${colunas.join(", ")}, criado_em, atualizado_em)
         VALUES (${colunas.map(() => "?").join(", ")}, ?, ?)`,
        [...valores, agora, agora]
      );

      return buscar(result.insertId);
    },

    async atualizar(id, campos) {
      const sets = [];
      const valores = [];

      for (const [campo, valor] of Object.entries(campos)) {
        if (!CAMPOS[campo]) {
          throw new Error(`Campo desconhecido: ${campo}`);
        }

        sets.push(`${CAMPOS[campo]} = ?`);
        valores.push(paraBanco(campo, valor));
      }

      sets.push("atualizado_em = ?");
      valores.push(new Date(), id);

      await pool.query(`UPDATE preatendimentos SET ${sets.join(", ")} WHERE id = ?`, valores);
      return buscar(id);
    },

    async pendentes(agora = new Date(), limite = 20) {
      const [rows] = await pool.query(
        `SELECT * FROM preatendimentos
         WHERE sync = 'pendente' AND (sync_proxima IS NULL OR sync_proxima <= ?)
           AND (sync_bloqueio IS NULL OR sync_bloqueio <= ?)
         ORDER BY id LIMIT ?`,
        [agora, agora, limite]
      );
      return rows.map(deLinha);
    },

    async todos() {
      const [rows] = await pool.query("SELECT * FROM preatendimentos ORDER BY id");
      return rows.map(deLinha);
    },

    async porId(id) {
      return buscar(id);
    },

    async porRef(ref) {
      const [rows] = await pool.query("SELECT * FROM preatendimentos WHERE ref_agendamento = ? LIMIT 1", [ref]);
      return deLinha(rows[0]);
    },

    async porEvento(eventoUri) {
      const [rows] = await pool.query(
        "SELECT * FROM preatendimentos WHERE evento_calendly = ? ORDER BY id DESC LIMIT 1",
        [eventoUri]
      );
      return deLinha(rows[0]);
    },

    // Qualificadas com esse telefone (da inscrição ou do WhatsApp), mais recente primeiro.
    async qualificadasPorTelefone(telefone) {
      const [rows] = await pool.query(
        `SELECT * FROM preatendimentos
         WHERE resultado = 'qualificada' AND (telefone = ? OR whatsapp = ?)
         ORDER BY id DESC LIMIT 5`,
        [telefone, telefone]
      );
      return rows.map(deLinha);
    },

    async aguardandoAgendamento() {
      const [rows] = await pool.query(
        "SELECT * FROM preatendimentos WHERE agendamento = 'pendente' AND resultado = 'qualificada' ORDER BY id"
      );
      return rows.map(deLinha);
    },

    // Cria a tarefa; se a chave já existe (aviso repetido), devolve a que já existe.
    // proxima: quando a tarefa pode rodar (ex.: lembrete marcado para outro dia).
    async criarTarefa({ chave, tipo, atendimentoId = null, dados = {}, proxima = null }) {
      const agora = new Date();
      const [result] = await pool.query(
        `INSERT IGNORE INTO preatendimento_tarefas (chave, tipo, atendimento_id, dados, proxima, criado_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [chave, tipo, atendimentoId, JSON.stringify(dados), proxima, agora, agora]
      );
      const [rows] = await pool.query("SELECT * FROM preatendimento_tarefas WHERE chave = ?", [chave]);
      return { ...deTarefa(rows[0]), criada: result.affectedRows === 1 };
    },

    async atualizarTarefa(id, campos) {
      const sets = [];
      const valores = [];

      for (const [campo, valor] of Object.entries(campos)) {
        const [coluna, convertido] = COLUNAS_TAREFA[campo](valor);
        sets.push(`${coluna} = ?`);
        valores.push(convertido);
      }

      sets.push("atualizado_em = ?");
      valores.push(new Date(), id);
      await pool.query(`UPDATE preatendimento_tarefas SET ${sets.join(", ")} WHERE id = ?`, valores);
      const [rows] = await pool.query("SELECT * FROM preatendimento_tarefas WHERE id = ?", [id]);
      return deTarefa(rows[0]);
    },

    async tarefasPendentes(agora = new Date(), limite = 20) {
      const [rows] = await pool.query(
        `SELECT * FROM preatendimento_tarefas
         WHERE status = 'pendente' AND (proxima IS NULL OR proxima <= ?)
           AND (bloqueio IS NULL OR bloqueio <= ?)
         ORDER BY id LIMIT ?`,
        [agora, agora, limite]
      );
      return rows.map(deTarefa);
    },

    // ID do contato no ManyChat para o telefone (+55...): primeiro os já criados pela
    // API, depois quem conversou com a Mani por esse WhatsApp.
    async contatoManychat(telefone) {
      const telefones = variantesTelefone(telefone);
      if (!telefones.length) return null;
      const [criados] = await pool.query(
        "SELECT contato_id FROM manychat_contatos WHERE telefone IN (?) ORDER BY telefone = ? DESC LIMIT 1",
        [telefones, telefone]
      );
      if (criados[0]) return criados[0].contato_id;
      const [conversas] = await pool.query(
        "SELECT contato_id FROM preatendimentos WHERE whatsapp IN (?) ORDER BY id DESC LIMIT 1",
        [telefones]
      );
      return conversas[0]?.contato_id || null;
    },

    // O caminho inverso: o telefone (+55...) de um contato do ManyChat.
    async telefoneDoContato(contatoId) {
      const id = String(contatoId);
      const [criados] = await pool.query("SELECT telefone FROM manychat_contatos WHERE contato_id = ? LIMIT 1", [id]);
      if (criados[0]) return criados[0].telefone;
      const [conversas] = await pool.query(
        "SELECT whatsapp FROM preatendimentos WHERE contato_id = ? AND whatsapp IS NOT NULL ORDER BY id DESC LIMIT 1",
        [id]
      );
      return conversas[0]?.whatsapp || null;
    },

    async salvarContatoManychat(telefone, contatoId) {
      await pool.query(
        `INSERT INTO manychat_contatos (telefone, contato_id, criado_em) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE contato_id = VALUES(contato_id)`,
        [telefone, String(contatoId), new Date()]
      );
    },

    // Reserva a tarefa para este processo até `ate` (se outro processo já pegou, false).
    async travarTarefa(id, ate, agora = new Date()) {
      const [result] = await pool.query(
        `UPDATE preatendimento_tarefas SET bloqueio = ?
         WHERE id = ? AND status = 'pendente' AND (bloqueio IS NULL OR bloqueio <= ?)
           AND (proxima IS NULL OR proxima <= ?)`,
        [ate, id, agora, agora]
      );
      return result.affectedRows === 1;
    },

    async travarSync(id, ate, agora = new Date()) {
      const [result] = await pool.query(
        `UPDATE preatendimentos SET sync_bloqueio = ?
         WHERE id = ? AND sync = 'pendente' AND (sync_bloqueio IS NULL OR sync_bloqueio <= ?)`,
        [ate, id, agora]
      );
      return result.affectedRows === 1;
    },

    async removerTarefa(chave) {
      await pool.query("DELETE FROM preatendimento_tarefas WHERE chave = ?", [chave]);
    },

    async tarefasComPrefixo(prefixo) {
      const [rows] = await pool.query("SELECT * FROM preatendimento_tarefas WHERE chave LIKE ? ORDER BY id", [
        `${prefixo.replace(/[\\%_]/g, "\\$&")}%`,
      ]);
      return rows.map(deTarefa);
    },

    async tarefaPorChave(chave) {
      const [rows] = await pool.query("SELECT * FROM preatendimento_tarefas WHERE chave = ?", [chave]);
      return deTarefa(rows[0]);
    },

    async registrarChegada({ turma, contatoId, whatsapp, nome, em }) {
      const [result] = await pool.query(
        "INSERT IGNORE INTO mani_chegadas (turma, contato_id, whatsapp, nome, chegou_em) VALUES (?, ?, ?, ?, ?)",
        [turma, contatoId, whatsapp, nome, em]
      );
      const [rows] = await pool.query("SELECT * FROM mani_chegadas WHERE turma = ? AND contato_id = ?", [turma, contatoId]);
      const [contagem] = await pool.query("SELECT COUNT(*) AS posicao FROM mani_chegadas WHERE turma = ? AND id <= ?", [
        turma,
        rows[0].id,
      ]);
      return { ...deChegada(rows[0]), posicao: Number(contagem[0].posicao), nova: result.affectedRows === 1 };
    },

    async chegadas(turma) {
      const [rows] = await pool.query("SELECT * FROM mani_chegadas WHERE turma = ? ORDER BY id", [turma]);
      return rows.map((row, indice) => ({ ...deChegada(row), posicao: indice + 1 }));
    },

    // ---------- sorteio das mentorias ----------

    // Inscreve na rodada; se a pessoa já está nela, devolve a inscrição original.
    async inscreverMentoria({ rodada, mondayItemId, nome, telefone, email, em = new Date() }) {
      const [result] = await pool.query(
        `INSERT IGNORE INTO mentoria_inscricoes (rodada, monday_item_id, nome, telefone, email, inscrito_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [rodada, String(mondayItemId), nome, telefone, email, em, em]
      );
      const [rows] = await pool.query("SELECT * FROM mentoria_inscricoes WHERE rodada = ? AND monday_item_id = ?", [
        rodada,
        String(mondayItemId),
      ]);
      return { ...deInscricao(rows[0]), nova: result.affectedRows === 1 };
    },

    async inscricoesMentoria(rodada) {
      const [rows] = await pool.query("SELECT * FROM mentoria_inscricoes WHERE rodada = ? ORDER BY id", [rodada]);
      return rows.map(deInscricao);
    },

    async inscricaoMentoria(id) {
      const [rows] = await pool.query("SELECT * FROM mentoria_inscricoes WHERE id = ?", [id]);
      return deInscricao(rows[0]);
    },

    // Sorteadas das rodadas a partir de `desde` (para ligar o agendamento do Calendly).
    async sorteadasMentoria(desde) {
      const [rows] = await pool.query(
        "SELECT * FROM mentoria_inscricoes WHERE sorteada = 1 AND rodada >= ? ORDER BY rodada DESC, id",
        [desde]
      );
      return rows.map(deInscricao);
    },

    async atualizarInscricaoMentoria(id, campos) {
      const sets = [];
      const valores = [];
      for (const [campo, valor] of Object.entries(campos)) {
        if (!COLUNAS_MENTORIA[campo]) throw new Error(`Campo desconhecido: ${campo}`);
        sets.push(`${COLUNAS_MENTORIA[campo]} = ?`);
        valores.push(typeof valor === "boolean" ? Number(valor) : valor);
      }
      sets.push("atualizado_em = ?");
      valores.push(new Date(), id);
      await pool.query(`UPDATE mentoria_inscricoes SET ${sets.join(", ")} WHERE id = ?`, valores);
      return this.inscricaoMentoria(id);
    },

    async todasTarefas() {
      const [rows] = await pool.query("SELECT * FROM preatendimento_tarefas ORDER BY id");
      return rows.map(deTarefa);
    },

    // Tela "Sistema" do painel: contagem dos últimos dias, próximos envios marcados,
    // problemas (falhou ou tentando de novo) e atividade recente. Só leitura.
    async monitorTarefas({ agora = new Date(), desde }) {
      const internos = ["reuniao_registro", "reuniao_indice", "aula_varredura", "live_varredura", "disparo_varredura", "resumo_lote", "chegadas_marca", "mentoria_varredura", "mentoria_rodada", "grupo_lista"];
      const fora = `tipo NOT IN (${internos.map(() => "?").join(", ")})`;
      const comDatas = (row) => ({ ...deTarefa(row), criadoEm: row.criado_em, atualizadoEm: row.atualizado_em });

      const [contagem] = await pool.query(
        `SELECT tipo, status, COUNT(*) AS total FROM preatendimento_tarefas
         WHERE ${fora} AND atualizado_em >= ? GROUP BY tipo, status`,
        [...internos, desde]
      );
      const [proximas] = await pool.query(
        `SELECT * FROM preatendimento_tarefas
         WHERE ${fora} AND status = 'pendente' AND proxima > ? ORDER BY proxima LIMIT 40`,
        [...internos, agora]
      );
      const [problemas] = await pool.query(
        `SELECT * FROM preatendimento_tarefas
         WHERE ${fora} AND (status = 'falhou' OR (status = 'pendente' AND tentativas > 0))
         ORDER BY atualizado_em DESC LIMIT 40`,
        internos
      );
      const [recentes] = await pool.query(
        `SELECT * FROM preatendimento_tarefas WHERE ${fora} ORDER BY atualizado_em DESC LIMIT 60`,
        internos
      );

      return {
        contagem: contagem.map((row) => ({ tipo: row.tipo, status: row.status, total: Number(row.total) })),
        proximas: proximas.map(comDatas),
        problemas: problemas.map(comDatas),
        recentes: recentes.map(comDatas),
      };
    },

    // LGPD (v2.16.0): apaga o que não é mais usado há mais de `antesDe` (padrão 12 meses),
    // em lotes de até 5000 por tabela e por dia (sem travar a tabela por muito tempo).
    // Nunca apaga: tarefas na fila (pendente), pré-atendimentos esperando a Monday e o pedido
    // de parar as mensagens (sem_avisos: é o registro do opt-out). Antes de apagar um
    // pré-atendimento, a ligação telefone -> contato do ManyChat dele vai para
    // manychat_contatos (é o que permite mandar mensagens para essa pessoa depois).
    async limparDadosAntigos(antesDe) {
      const total = async (sql, valores = [antesDe]) => (await pool.query(sql, valores))[0].affectedRows || 0;
      await pool.query(
        `INSERT IGNORE INTO manychat_contatos (telefone, contato_id, criado_em)
         SELECT whatsapp, contato_id, ? FROM preatendimentos
         WHERE whatsapp LIKE '+%' AND sync <> 'pendente' AND atualizado_em < ?
         ORDER BY id DESC`,
        [new Date(), antesDe]
      );
      return {
        tarefas: await total("DELETE FROM preatendimento_tarefas WHERE status <> 'pendente' AND tipo <> 'sem_avisos' AND atualizado_em < ? LIMIT 5000"),
        atendimentos: await total("DELETE FROM preatendimentos WHERE sync <> 'pendente' AND atualizado_em < ? LIMIT 5000"),
        chegadas: await total("DELETE FROM mani_chegadas WHERE chegou_em < ? LIMIT 5000"),
        inscricoes: await total("DELETE FROM mentoria_inscricoes WHERE atualizado_em < ? LIMIT 5000"),
      };
    },

    // Contagem das tarefas cuja chave começa com o prefixo, por status e erro.
    async resumoTarefas(prefixo) {
      const [rows] = await pool.query(
        "SELECT status, erro, COUNT(*) AS total FROM preatendimento_tarefas WHERE chave LIKE ? GROUP BY status, erro",
        [`${prefixo.replace(/[\\%_]/g, "\\$&")}%`]
      );
      return rows.map((row) => ({ status: row.status, erro: row.erro, total: Number(row.total) }));
    },
  };
}

module.exports = {
  createMysqlStore,
};
