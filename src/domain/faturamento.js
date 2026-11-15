// Interpreta o faturamento mensal digitado pela pessoa e classifica nas faixas
// que já existem na coluna "Faturamento Mensal" da Monday. Só regras fixas, sem IA.

// Faixas do CRM. Cada faixa vai do seu "min" (incluído) até o "min" da próxima
// (excluído), então não há sobreposição: R$ 10.000 cai em "R$ 10 mil a R$ 20 mil".
const FAIXAS = Object.freeze([
  Object.freeze({ min: 0, label: "R$ 0 a R$ 10 mil" }),
  Object.freeze({ min: 10000, label: "R$ 10 mil a R$ 20 mil" }),
  Object.freeze({ min: 20000, label: "R$ 20 mil a R$ 30 mil" }),
  Object.freeze({ min: 30000, label: "Acima de R$ 30 mil" }),
]);

// Faixa usada quando a pessoa não consegue informar um valor.
const FAIXA_A_VERIFICAR = "A Verificar";

// Critério aprovado: faturamento de R$ 10 mil ou mais vai para a reunião (era 12 mil até 30/10/2026).
const LIMITE_QUALIFICACAO = 10000;

// Acima disso o valor é tão fora do comum que vale confirmar (provável erro de digitação).
const VALOR_ALTO_CONFIRMAR = 10000000;

const PALAVRAS = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14,
  catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70,
  oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200, trezentos: 300,
  quatrocentos: 400, quinhentos: 500,
};

const PALAVRA = `(?:${Object.keys(PALAVRAS).join("|")})`;
const SEQUENCIA_PALAVRAS = new RegExp(`\\b${PALAVRA}(?:\\s+e\\s+${PALAVRA})*\\b`, "g");

function faixaDoValor(valor) {
  let faixa = FAIXAS[0];

  for (const candidata of FAIXAS) {
    if (valor >= candidata.min) {
      faixa = candidata;
    }
  }

  return faixa.label;
}

function qualifica(valor) {
  return valor >= LIMITE_QUALIFICACAO;
}

function formatarNumero(valor, casas = 1) {
  return valor.toLocaleString("pt-BR", { maximumFractionDigits: casas });
}

// 17000 -> "R$ 17 mil"; 17500 -> "R$ 17,5 mil"; 1200000 -> "R$ 1,2 milhão".
function formatarReais(valor) {
  if (valor >= 1000000) {
    const milhoes = valor / 1000000;
    return `R$ ${formatarNumero(milhoes)} ${milhoes >= 2 ? "milhões" : "milhão"}`;
  }

  if (valor >= 1000 && valor % 100 === 0) {
    return `R$ ${formatarNumero(valor / 1000)} mil`;
  }

  return `R$ ${formatarNumero(valor, 2)}`;
}

function semAcentos(texto) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// "1.234,56" -> 1234.56; "17.000" -> 17000; "17,5" -> 17.5; "17,000" -> 17000.
function lerNumero(bruto) {
  const temPonto = bruto.includes(".");
  const temVirgula = bruto.includes(",");

  if (temPonto && temVirgula) {
    const decimalVirgula = bruto.lastIndexOf(",") > bruto.lastIndexOf(".");
    return Number(
      decimalVirgula ? bruto.replace(/\./g, "").replace(",", ".") : bruto.replace(/,/g, "")
    );
  }

  if (temPonto) {
    return Number(/^\d{1,3}(\.\d{3})+$/.test(bruto) ? bruto.replace(/\./g, "") : bruto);
  }

  if (temVirgula) {
    return Number(/^\d{1,3}(,\d{3})+$/.test(bruto) ? bruto.replace(/,/g, "") : bruto.replace(",", "."));
  }

  return Number(bruto);
}

// "vinte e cinco mil" -> "25 mil".
function palavrasParaDigitos(texto) {
  return texto.replace(SEQUENCIA_PALAVRAS, (trecho) =>
    String(
      trecho
        .split(/\s+e\s+/)
        .reduce((soma, palavra) => soma + PALAVRAS[palavra.trim()], 0)
    )
  );
}

const MULTIPLICADORES = { mil: 1000, k: 1000, milhao: 1000000, milhoes: 1000000, mi: 1000000 };

// Resultado:
//  { tipo: "ok", valor }                 valor entendido
//  { tipo: "confirmar", valor }          pedir "Só para confirmar: você quis dizer ...?"
//  { tipo: "pedir_media" }               intervalo que atravessa duas faixas
//  { tipo: "nao_entendi", motivo }       sem número, número demais ou valor anual
const VALOR_MAXIMO = 1e9;

function interpretarFaturamento(entrada) {
  // Aspas e asteriscos (negrito do WhatsApp) entre o número e o "mil" atrapalham a leitura.
  let texto = semAcentos(String(entrada || "").toLowerCase())
    .replace(/["'“”‘’*_~`]/g, " ")
    .trim();

  if (!texto) {
    return { tipo: "nao_entendi", motivo: "vazio" };
  }

  if (/\b(ano|anual|anuais|por ano)\b/.test(texto)) {
    return { tipo: "nao_entendi", motivo: "anual" };
  }

  texto = palavrasParaDigitos(texto);

  // "17 mil e 500" -> 17500 (o "e 500" completa o valor, não é um segundo número).
  texto = texto.replace(/(\d+)\s*mil\s+e\s+(\d{1,3})\b(?!\s*(?:mil|k|reais\s+a))/g, (_, mil, resto) =>
    String(Number(mil) * 1000 + Number(resto))
  );

  const numeros = [];
  const regex = /(\d+(?:[.,]\d+)*)\s*(milhoes|milhao|mil|mi|k)?\b/g;
  let encontrado;

  while ((encontrado = regex.exec(texto))) {
    const valor = lerNumero(encontrado[1]);

    if (Number.isFinite(valor)) {
      numeros.push({ valor, unidade: encontrado[2] || null });
    }
  }

  if (!numeros.length) {
    return { tipo: "nao_entendi", motivo: "sem_numero" };
  }

  if (numeros.length > 2) {
    return { tipo: "nao_entendi", motivo: "numeros_demais" };
  }

  // "10 a 15 mil": a unidade escrita vale para o número que ficou sem.
  const unidadeComum = numeros.find((n) => n.unidade)?.unidade || null;
  // Sem nenhuma unidade e valor baixo ("17"): provavelmente mil, mas confirma.
  const semUnidade = !unidadeComum;

  const valores = numeros.map((n) => {
    const multiplicador = MULTIPLICADORES[n.unidade || unidadeComum] || 1;
    let valor = n.valor * multiplicador;

    if (semUnidade && valor > 0 && valor < 1000) {
      valor *= 1000;
    }

    return Math.round(valor * 100) / 100;
  });

  // Acima de R$ 1 bilhão por mês é engano de digitação (ex.: um CNPJ colado).
  if (valores.some((v) => v > VALOR_MAXIMO)) {
    return { tipo: "nao_entendi", motivo: "alto_demais" };
  }

  const precisaConfirmar = semUnidade && numeros.some((n) => n.valor > 0 && n.valor < 1000);

  if (valores.length === 2) {
    const [menor, maior] = valores.slice().sort((a, b) => a - b);

    if (faixaDoValor(menor) !== faixaDoValor(maior)) {
      return { tipo: "pedir_media" };
    }

    const media = Math.round((menor + maior) / 2);
    return { tipo: precisaConfirmar ? "confirmar" : "ok", valor: media };
  }

  let valor = valores[0];

  // "menos de 10 mil" fica abaixo do limite, não em cima dele.
  if (/\b(menos de|abaixo de|inferior a|nao chega a|nem chega a)\b/.test(texto) && valor > 0) {
    valor -= 1;
  }

  // "até 10 mil" pode ser bem menos: confirma o valor.
  const ate = /\b(ate|no maximo)\b/.test(texto);

  if (precisaConfirmar || ate || valor >= VALOR_ALTO_CONFIRMAR) {
    return { tipo: "confirmar", valor };
  }

  return { tipo: "ok", valor };
}

module.exports = {
  FAIXAS,
  FAIXA_A_VERIFICAR,
  LIMITE_QUALIFICACAO,
  faixaDoValor,
  formatarReais,
  interpretarFaturamento,
  qualifica,
};
