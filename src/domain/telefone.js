// Padronização de telefone brasileiro, igual nos dois lados da comparação:
// o que a pessoa digita no WhatsApp e o que está na coluna de telefone da Monday.

const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

// Tira tudo que não é dígito, o "00" de discagem internacional, o 0 de operadora
// ("011 9...") e o código do país, devolvendo só DDD + número (10 ou 11 dígitos).
function digitosNacionais(valor) {
  let digitos = String(valor || "").replace(/\D/g, "");

  if (digitos.startsWith("00")) {
    digitos = digitos.slice(2);
  }

  if (digitos.startsWith("55") && (digitos.length === 12 || digitos.length === 13)) {
    digitos = digitos.slice(2);
  } else if (digitos.startsWith("0") && (digitos.length === 11 || digitos.length === 12)) {
    digitos = digitos.slice(1);
  }

  return digitos;
}

// Valida e devolve no formato +55DDNNNNNNNNN, ou null se não for um telefone válido.
// Celular precisa do 9 na frente (11 dígitos); 10 dígitos é fixo ou celular antigo.
function normalizarTelefone(valor) {
  const nacional = digitosNacionais(valor);

  if (nacional.length !== 10 && nacional.length !== 11) {
    return null;
  }

  if (!DDDS.has(Number(nacional.slice(0, 2)))) {
    return null;
  }

  if (nacional.length === 11 && nacional[2] !== "9") {
    return null;
  }

  if (/^(\d)\1+$/.test(nacional.slice(2))) {
    return null; // 99999-9999, 00000000...
  }

  return `+55${nacional}`;
}

// Chave de comparação: DDD + últimos 8 dígitos. Assim o mesmo celular bate
// com e sem o 9 da frente (cadastros antigos às vezes estão sem ele).
function chaveTelefone(valor) {
  const nacional = digitosNacionais(valor);

  if (nacional.length !== 10 && nacional.length !== 11) {
    return null;
  }

  return `${nacional.slice(0, 2)}${nacional.slice(-8)}`;
}

// O mesmo celular com e sem o 9 da frente (+55DD9XXXXXXXX e +55DDXXXXXXXX). Contas
// antigas do WhatsApp às vezes ficam registradas sem o 9; serve para achar o contato.
function variantesTelefone(valor) {
  const e164 = normalizarTelefone(valor);

  if (!e164) {
    return [];
  }

  const nacional = e164.slice(3);
  const ddd = nacional.slice(0, 2);
  const numero = nacional.slice(2);

  if (numero.length === 9 && numero[0] === "9") {
    return [e164, `+55${ddd}${numero.slice(1)}`];
  }

  if (numero.length === 8 && /[6-9]/.test(numero[0])) {
    return [e164, `+55${ddd}9${numero}`];
  }

  return [e164];
}

// +5511912345678 -> +55 11 91234-5678 (para mensagens da equipe).
function formatarTelefone(valor) {
  const nacional = digitosNacionais(valor);

  if (nacional.length === 11) {
    return `+55 ${nacional.slice(0, 2)} ${nacional.slice(2, 7)}-${nacional.slice(7)}`;
  }

  if (nacional.length === 10) {
    return `+55 ${nacional.slice(0, 2)} ${nacional.slice(2, 6)}-${nacional.slice(6)}`;
  }

  return String(valor || "");
}

module.exports = {
  chaveTelefone,
  formatarTelefone,
  normalizarTelefone,
  variantesTelefone,
};
