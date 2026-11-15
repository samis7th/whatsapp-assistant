const { config } = require("../config/env");
const { chaveTelefone } = require("../domain/telefone");

const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2026-07";

// O ManyChat espera no máximo ~10 s pela resposta: as chamadas feitas durante a
// conversa usam um limite curto; o reenvio em segundo plano pode esperar mais.
const TIMEOUT_CONVERSA_MS = 6000;
const TIMEOUT_FUNDO_MS = 15000;

// Telefones do quadro ficam em memória por pouco tempo para não gastar o limite
// diário de chamadas da Monday a cada conversa.
const CACHE_TELEFONES_MS = 60000;

let cacheTelefones = null;
let cacheColunas = null;

class MondayError extends Error {}

// Permite trocar o fetch nos testes.
let fetchImpl = (...args) => fetch(...args);

function setFetch(fn) {
  fetchImpl = fn;
  cacheTelefones = null;
  cacheColunas = null;
}

// Prazo total de uma resposta ao ManyChat (ele desiste em ~10 s). Cada chamada usa o
// que sobrou desse prazo, para a soma de várias chamadas não passar dele.
const PRAZO_CONVERSA_MS = 8000;

function prazoDaConversa() {
  return Date.now() + PRAZO_CONVERSA_MS;
}

function opcoesDe({ conversa = false, prazo = null } = {}) {
  return { timeoutMs: conversa ? TIMEOUT_CONVERSA_MS : TIMEOUT_FUNDO_MS, prazo: conversa ? prazo : null };
}

async function mondayRequest(query, variables = {}, { timeoutMs = TIMEOUT_FUNDO_MS, prazo = null } = {}) {
  if (prazo) {
    const restante = prazo - Date.now();

    if (restante < 500) {
      const error = new MondayError("Sem tempo para responder a conversa a tempo");
      error.code = "MONDAY_TIMEOUT";
      throw error;
    }

    timeoutMs = Math.min(timeoutMs, restante);
  }

  if (!config.monday.token) {
    const error = new MondayError("Monday não configurada (MONDAY_API_TOKEN).");
    error.code = "MONDAY_NOT_CONFIGURED";
    throw error;
  }

  let response;

  try {
    response = await fetchImpl(MONDAY_API_URL, {
      method: "POST",
      headers: {
        Authorization: config.monday.token,
        "Content-Type": "application/json",
        "API-Version": MONDAY_API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
    const error = new MondayError(timedOut ? "Monday demorou para responder" : "Sem conexão com a Monday");
    error.code = timedOut ? "MONDAY_TIMEOUT" : "MONDAY_UNREACHABLE";
    throw error;
  }

  const body = await response.json().catch(() => null);
  const mondayCode = body?.errors?.[0]?.extensions?.code || body?.error_code || null;

  if (!body || !response.ok || (Array.isArray(body.errors) && body.errors.length)) {
    const error = new MondayError(
      body?.errors?.map((item) => item.message).join("; ") ||
        body?.error_message ||
        `Monday respondeu HTTP ${response.status}`
    );

    if (mondayCode === "DAILY_LIMIT_EXCEEDED") {
      error.code = "MONDAY_DAILY_LIMIT";
    } else if (response.status === 429 || /RATE_LIMIT|COMPLEXITY|BUDGET/i.test(String(mondayCode))) {
      error.code = "MONDAY_RATE_LIMIT";
    } else {
      error.code = "MONDAY_ERROR";
    }

    error.mondayCode = mondayCode;
    throw error;
  }

  return body.data;
}

const PRIMEIRA_PAGINA = `
  query Telefones($boardId: [ID!], $colunas: [String!]) {
    boards(ids: $boardId) {
      items_page(limit: 500) {
        cursor
        items { id name column_values(ids: $colunas) { id text ... on PhoneValue { phone } } }
      }
    }
  }
`;

const PROXIMA_PAGINA = `
  query MaisTelefones($cursor: String!, $colunas: [String!]) {
    next_items_page(limit: 500, cursor: $cursor) {
      cursor
      items { id name column_values(ids: $colunas) { id text ... on PhoneValue { phone } } }
    }
  }
`;

// Muitas buscas ao mesmo tempo (ex.: inscrições do sorteio às 12h30) usam a mesma leitura
// do quadro em vez de cada uma baixar tudo de novo. A conversa da Mani, que tem prazo para
// responder, faz a própria leitura.
let leituraTelefones = null;

async function carregarTelefones(opcoes) {
  if (cacheTelefones && Date.now() - cacheTelefones.em < CACHE_TELEFONES_MS) {
    return cacheTelefones.itens;
  }

  if (opcoes?.prazo) return lerTelefones(opcoes);

  if (!leituraTelefones) {
    leituraTelefones = lerTelefones(opcoes).finally(() => {
      leituraTelefones = null;
    });
  }

  return leituraTelefones;
}

async function lerTelefones(opcoes) {
  const colunas = [config.monday.phoneColumnId];
  const itens = [];

  function guardar(pagina) {
    for (const item of pagina?.items || []) {
      const coluna = item.column_values?.[0];
      const chave = chaveTelefone(coluna?.phone || coluna?.text);

      if (chave) {
        itens.push({ id: String(item.id), nome: item.name || "", chave });
      }
    }
  }

  const primeira = await mondayRequest(
    PRIMEIRA_PAGINA,
    { boardId: [config.monday.boardId], colunas },
    opcoes
  );
  let pagina = primeira?.boards?.[0]?.items_page;
  guardar(pagina);

  while (pagina?.cursor) {
    const proxima = await mondayRequest(PROXIMA_PAGINA, { cursor: pagina.cursor, colunas }, opcoes);
    pagina = proxima?.next_items_page;
    guardar(pagina);
  }

  cacheTelefones = { em: Date.now(), itens };
  return itens;
}

const INSCRITOS_PRIMEIRA = `
  query Inscritos($boardId: [ID!], $colunas: [String!]) {
    boards(ids: $boardId) {
      items_page(limit: 500) {
        cursor
        items { id name created_at column_values(ids: $colunas) {
          id text ... on PhoneValue { phone } ... on EmailValue { email } ... on StatusValue { label updated_at } ... on DateValue { date }
        } }
      }
    }
  }
`;

const INSCRITOS_PROXIMA = `
  query MaisInscritos($cursor: String!, $colunas: [String!]) {
    next_items_page(limit: 500, cursor: $cursor) {
      cursor
      items { id name created_at column_values(ids: $colunas) {
        id text ... on PhoneValue { phone } ... on EmailValue { email } ... on StatusValue { label updated_at } ... on DateValue { date }
      } }
    }
  }
`;

// Todos os cadastros do quadro (sem ciclo desde 04/11/2026), com a Etapa do Funil e o
// Grupo WhatsApp de cada um. Quem fica de fora pela etapa decide quem chama.
async function listarInscritosAula() {
  const ids = await colunas();
  const etapaId = ids.resultado.id;
  const grupoId = ids.grupo?.id || null;
  const pedidas = [config.monday.phoneColumnId, config.monday.emailColumnId, etapaId, grupoId].filter(Boolean);
  const inscritos = [];

  function guardar(pagina) {
    for (const item of pagina?.items || []) {
      const coluna = (id) => (id ? item.column_values?.find((valor) => valor.id === id) : null);
      const telefone = coluna(config.monday.phoneColumnId);
      const email = coluna(config.monday.emailColumnId);

      inscritos.push({
        id: String(item.id),
        nome: item.name || "",
        telefone: telefone?.phone || telefone?.text || "",
        email: String(email?.email || email?.text || "").trim(),
        etapa: String(coluna(etapaId)?.label || coluna(etapaId)?.text || "").trim(),
        grupo: String(coluna(grupoId)?.label || coluna(grupoId)?.text || "").trim(),
      });
    }
  }

  const primeira = await mondayRequest(INSCRITOS_PRIMEIRA, { boardId: [config.monday.boardId], colunas: pedidas });
  let pagina = primeira?.boards?.[0]?.items_page;
  guardar(pagina);

  while (pagina?.cursor) {
    const proxima = await mondayRequest(INSCRITOS_PROXIMA, { cursor: pagina.cursor, colunas: pedidas });
    pagina = proxima?.next_items_page;
    guardar(pagina);
  }

  return inscritos;
}

const POR_EMAIL = `
  query PorEmail($boardId: ID!, $coluna: String!, $valores: [String]!, $colunas: [String!]) {
    items_page_by_column_values(board_id: $boardId, limit: 20, columns: [{ column_id: $coluna, column_values: $valores }]) {
      items { id name column_values(ids: $colunas) { id text ... on PhoneValue { phone } ... on EmailValue { email } } }
    }
  }
`;

// Cadastros com esse e-mail (comparação exata, sem maiúsculas): [{ id, nome, telefone }].
async function buscarPorEmail(email) {
  const alvo = String(email || "").trim().toLowerCase();
  if (!alvo) return [];

  const data = await mondayRequest(POR_EMAIL, {
    boardId: String(config.monday.boardId),
    coluna: config.monday.emailColumnId,
    valores: [alvo],
    colunas: [config.monday.emailColumnId, config.monday.phoneColumnId],
  });

  return (data?.items_page_by_column_values?.items || [])
    .filter((item) => {
      const coluna = item.column_values?.find((c) => c.id === config.monday.emailColumnId);
      return String(coluna?.email || coluna?.text || "").trim().toLowerCase() === alvo;
    })
    .map((item) => {
      const telefone = item.column_values?.find((c) => c.id === config.monday.phoneColumnId);
      return { id: String(item.id), nome: item.name || "", telefone: telefone?.phone || telefone?.text || "" };
    });
}

// Devolve todos os cadastros do quadro com esse telefone (0, 1 ou mais).
async function buscarPorTelefone(telefone, { conversa = false, prazo = null } = {}) {
  const chave = chaveTelefone(telefone);

  if (!chave) {
    return [];
  }

  const opcoes = opcoesDe({ conversa, prazo });
  let encontrados = filtrar(await carregarTelefones(opcoes), chave);

  // Quem acabou de se inscrever pode não estar na lista em memória: se não achou
  // e a lista não é dos últimos segundos, busca de novo direto na Monday.
  if (!encontrados.length && cacheTelefones && Date.now() - cacheTelefones.em > 5000) {
    cacheTelefones = null;
    encontrados = filtrar(await carregarTelefones(opcoes), chave);
  }

  return encontrados;
}

function filtrar(itens, chave) {
  const vistos = new Set();

  return itens.filter((item) => {
    if (item.chave !== chave || vistos.has(item.id)) {
      return false;
    }

    vistos.add(item.id);
    return true;
  });
}

const COLUNAS_QUERY = `
  query Colunas($boardId: [ID!]) {
    boards(ids: $boardId) { columns { id title type } }
  }
`;

function normalizarTitulo(titulo) {
  return String(titulo || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

// IDs das colunas pelo título (o quadro não precisa de configuração extra).
async function colunas(opcoes) {
  if (cacheColunas) {
    return cacheColunas;
  }

  const data = await mondayRequest(COLUNAS_QUERY, { boardId: [config.monday.boardId] }, opcoes);
  const lista = data?.boards?.[0]?.columns || [];
  const porTitulo = new Map(lista.map((coluna) => [normalizarTitulo(coluna.title), coluna]));
  const encontradas = {};

  for (const [chave, titulo] of Object.entries(config.monday.titles)) {
    const coluna = porTitulo.get(normalizarTitulo(titulo));

    if (!coluna) {
      const error = new MondayError(`Coluna "${titulo}" não encontrada no quadro da Monday.`);
      error.code = "MONDAY_COLUMN_MISSING";
      throw error;
    }

    encontradas[chave] = { id: coluna.id, tipo: coluna.type };
  }

  for (const [chave, titulo] of Object.entries(config.monday.titulosOpcionais)) {
    const coluna = porTitulo.get(normalizarTitulo(titulo));
    encontradas[chave] = coluna ? { id: coluna.id, tipo: coluna.type } : null;
  }

  cacheColunas = encontradas;
  return encontradas;
}

const ATUALIZAR_COLUNAS = `
  mutation Atualizar($boardId: ID!, $itemId: ID!, $valores: JSON!) {
    change_multiple_column_values(
      board_id: $boardId, item_id: $itemId, column_values: $valores, create_labels_if_missing: false
    ) { id }
  }
`;

// Data e hora do pré-atendimento em "Último Contato": coluna de data recebe data e
// hora (a Monday guarda em UTC e mostra no fuso de quem vê); coluna de texto, "19/10/2026 14:32".
function valorUltimoContato(tipo, quando) {
  if (tipo === "date") {
    const iso = quando.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  }

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: config.timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(quando);
}

const LER_OBS = `
  query Obs($itemId: [ID!], $coluna: [String!]) {
    items(ids: $itemId) { column_values(ids: $coluna) { text } }
  }
`;

// Começo dos status que o próprio sistema escreve na OBS. Um status novo substitui o
// anterior (ex.: "Aguardando agendamento" vira "Reunião marcada ...").
const STATUS_DO_SISTEMA = [
  "Aguardando agendamento",
  "Aguardando reunião",
  "Perfil não qualificado por renda",
  "Faturamento a verificar",
  "Reunião marcada",
  "Reunião reagendada",
  "Reunião cancelada",
  "Presença confirmada",
  "Não quis agendar reunião",
  "Não respondeu",
  "Não agendou a reunião",
];

// Status do pré-atendimento na coluna OBS sem apagar o que a equipe já escreveu:
// troca só a linha de status do sistema; anotações da equipe ficam como estão.
async function valorObs(itemId, coluna, status, opcoes) {
  const data = await mondayRequest(LER_OBS, { itemId: [String(itemId)], coluna: [coluna.id] }, opcoes);
  const atual = String(data?.items?.[0]?.column_values?.[0]?.text || "").trim();
  const separador = coluna.tipo === "long_text" ? "\n" : " | ";
  const partes = atual
    .split(coluna.tipo === "long_text" ? /\r?\n/ : / \| /)
    .map((parte) => parte.trim())
    .filter((parte) => parte && !STATUS_DO_SISTEMA.some((prefixo) => parte.startsWith(prefixo)));

  partes.push(status);
  const texto = partes.join(separador);
  return coluna.tipo === "long_text" ? { text: texto } : texto;
}

// Grava faixa, resultado, próximo contato (data da reunião), último contato e o status
// na OBS. Usa só opções que já existem no quadro: se alguém renomear uma, dá erro
// (e alerta) em vez de criar outra. Repetir com os mesmos dados não duplica nada.
async function atualizarCadastro(
  itemId,
  { faixa, resultadoLabel, proximoContato, ultimoContato, obs, grupo },
  { conversa = false, prazo = null } = {}
) {
  const opcoes = opcoesDe({ conversa, prazo });
  const ids = await colunas(opcoes);
  const valores = {};

  if (faixa) {
    valores[ids.faixa.id] = { label: faixa };
  }

  // Etapas de cliente (v3.4.0): quem já é cliente de outro produto não tem a Etapa trocada
  // pela Mani (reunião, pré-atendimento, parar avisos). A equipe muda à mão se quiser.
  if (resultadoLabel && !(await etapaProtegida(itemId, resultadoLabel))) {
    valores[ids.resultado.id] = { label: resultadoLabel };
  }

  // "AAAA-MM-DD" (só a data) ou um Date (data e hora da reunião, gravada em UTC).
  if (proximoContato instanceof Date) {
    const iso = proximoContato.toISOString();
    valores[ids.proximoContato.id] = { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  } else if (proximoContato) {
    valores[ids.proximoContato.id] = { date: proximoContato };
  }

  if (ultimoContato) {
    valores[ids.ultimoContato.id] = valorUltimoContato(ids.ultimoContato.tipo, new Date(ultimoContato));
  }

  // Sem a coluna OBS no quadro, o status fica só no histórico do cadastro.
  if (obs && ids.obs) {
    valores[ids.obs.id] = await valorObs(itemId, ids.obs, obs, opcoes);
  }

  if (grupo) {
    if (!ids.grupo) {
      const error = new MondayError(`Coluna "${config.monday.titulosOpcionais.grupo}" não encontrada no quadro da Monday.`);
      error.code = "MONDAY_COLUMN_MISSING";
      throw error;
    }

    valores[ids.grupo.id] = { label: grupo };
  }

  if (!Object.keys(valores).length) {
    return;
  }

  await mondayRequest(
    ATUALIZAR_COLUNAS,
    { boardId: String(config.monday.boardId), itemId: String(itemId), valores: JSON.stringify(valores) },
    opcoes
  );
}

// Troca a etiqueta da coluna Funil (ex.: "SDR Aula Gratuita"). A etiqueta precisa existir.
async function definirFunil(itemId, label) {
  await mondayRequest(ATUALIZAR_COLUNAS, {
    boardId: String(config.monday.boardId),
    itemId: String(itemId),
    valores: JSON.stringify({ [config.monday.funnelColumnId]: { label } }),
  });
}

// Troca o telefone do cadastro (inscrição no sorteio com o mesmo e-mail e outro telefone).
// Mesmo formato que a API de inscrições grava: só dígitos, com o 55.
async function atualizarTelefone(itemId, telefoneE164) {
  await mondayRequest(ATUALIZAR_COLUNAS, {
    boardId: String(config.monday.boardId),
    itemId: String(itemId),
    valores: JSON.stringify({
      [config.monday.phoneColumnId]: { phone: String(telefoneE164).replace(/\D/g, ""), countryShortName: "BR" },
    }),
  });
  cacheTelefones = null;
}

const CRIAR_ATUALIZACAO = `
  mutation Comentar($itemId: ID!, $texto: String!) {
    create_update(item_id: $itemId, body: $texto) { id }
  }
`;

// Comentário no histórico do cadastro (atualizações não ocupam coluna).
async function comentar(itemId, textoHtml) {
  await mondayRequest(CRIAR_ATUALIZACAO, { itemId: String(itemId), texto: textoHtml });
}

function linkDoCadastro(itemId) {
  return config.monday.boardUrl && itemId ? `${config.monday.boardUrl}/pulses/${itemId}` : null;
}

// Etiqueta atual da Etapa do Funil (para não voltar uma etapa mais adiante do funil).
const semAcentoMinusculo = (texto) => String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

// A Etapa atual é de cliente (MONDAY_ETAPAS_PROTEGIDAS)? Se a leitura falhar, não bloqueia.
async function etapaProtegida(itemId, novaEtapa) {
  const protegidas = (config.monday.etapasProtegidas || []).map(semAcentoMinusculo);
  if (!protegidas.length || protegidas.includes(semAcentoMinusculo(novaEtapa))) return false;
  try {
    const atual = semAcentoMinusculo(await lerEtapa(itemId));
    if (atual && protegidas.includes(atual)) {
      console.log(`Etapa mantida no cadastro ${itemId}: é de cliente (${atual}).`);
      return true;
    }
  } catch (error) {
    console.warn("Não consegui ler a Etapa antes de gravar:", error.message);
  }
  return false;
}

async function lerEtapa(itemId) {
  const ids = await colunas();
  const data = await mondayRequest(LER_OBS, { itemId: [String(itemId)], coluna: [ids.resultado.id] });
  return String(data?.items?.[0]?.column_values?.[0]?.text || "").trim();
}

module.exports = {
  MondayError,
  lerEtapa,
  atualizarCadastro,
  atualizarTelefone,
  buscarPorTelefone,
  buscarPorEmail,
  comentar,
  definirFunil,
  linkDoCadastro,
  listarInscritosAula,
  prazoDaConversa,
  setFetch,
};
