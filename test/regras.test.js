const test = require("node:test");
const assert = require("node:assert/strict");

const { chaveTelefone, normalizarTelefone } = require("../src/domain/telefone");
const { faixaDoValor, formatarReais, interpretarFaturamento, qualifica } = require("../src/domain/faturamento");

test("telefone: com e sem +55, espaços, parênteses e hífens", () => {
  for (const entrada of [
    "(11) 91234-5678",
    "11912345678",
    "11 91234 5678",
    "+55 11 91234-5678",
    "5511912345678",
    "+55 (11) 9 1234-5678",
    "011 91234-5678",
    "0055 11 91234-5678",
  ]) {
    assert.equal(normalizarTelefone(entrada), "+5511912345678", entrada);
  }
});

test("telefone: inválidos", () => {
  for (const entrada of ["", "91234-5678", "(10) 91234-5678", "(11) 81234-5678", "123", "(11) 99999-9999", "abc", "+1 415 555 0100"]) {
    assert.equal(normalizarTelefone(entrada), null, entrada);
  }
});

test("telefone: mesma chave com e sem o 9 da frente", () => {
  assert.equal(chaveTelefone("+5511912345678"), chaveTelefone("(11) 1234-5678"));
  assert.notEqual(chaveTelefone("+5511912345678"), chaveTelefone("+5521912345678"));
});

test("faturamento: formas de escrever o mesmo valor", () => {
  for (const entrada of ["17 mil", "R$ 17.000", "17000", "17k", "17K", "r$17.000,00", "17mil", "dezessete mil", "uns 17 mil por mês", "17.000 reais"]) {
    assert.deepEqual(interpretarFaturamento(entrada), { tipo: "ok", valor: 17000 }, entrada);
  }

  assert.deepEqual(interpretarFaturamento("17,5 mil"), { tipo: "ok", valor: 17500 });
  assert.deepEqual(interpretarFaturamento("17 mil e 500"), { tipo: "ok", valor: 17500 });
  assert.deepEqual(interpretarFaturamento("vinte e cinco mil"), { tipo: "ok", valor: 25000 });
  assert.deepEqual(interpretarFaturamento("1,2 milhão"), { tipo: "ok", valor: 1200000 });
  assert.deepEqual(interpretarFaturamento("0"), { tipo: "ok", valor: 0 });
});

test("faturamento: ambíguo pede confirmação", () => {
  assert.deepEqual(interpretarFaturamento("17"), { tipo: "confirmar", valor: 17000 });
  assert.deepEqual(interpretarFaturamento("até 10 mil"), { tipo: "confirmar", valor: 10000 });
  assert.equal(interpretarFaturamento("50000000").tipo, "confirmar");
});

test("faturamento: intervalo", () => {
  assert.deepEqual(interpretarFaturamento("entre 13 e 17 mil"), { tipo: "ok", valor: 15000 });
  assert.deepEqual(interpretarFaturamento("de 5 a 15 mil"), { tipo: "pedir_media" });
  assert.deepEqual(interpretarFaturamento("15k-25k"), { tipo: "pedir_media" });
  assert.deepEqual(interpretarFaturamento("13 a 17"), { tipo: "confirmar", valor: 15000 });
});

test("faturamento: não entendido", () => {
  assert.equal(interpretarFaturamento("não sei").tipo, "nao_entendi");
  assert.equal(interpretarFaturamento("").tipo, "nao_entendi");
  assert.equal(interpretarFaturamento("200 mil por ano").tipo, "nao_entendi");
  assert.equal(interpretarFaturamento("5, 10 ou 15 mil").tipo, "nao_entendi");
});

test("faturamento: menos de X fica abaixo do limite", () => {
  const resultado = interpretarFaturamento("menos de 10 mil");
  assert.equal(resultado.tipo, "ok");
  assert.equal(qualifica(resultado.valor), false);
  assert.equal(qualifica(interpretarFaturamento("mais de 10 mil").valor), true);
});

test("faixas: valores exatamente nos limites", () => {
  assert.equal(faixaDoValor(0), "R$ 0 a R$ 10 mil");
  assert.equal(faixaDoValor(9999.99), "R$ 0 a R$ 10 mil");
  assert.equal(faixaDoValor(10000), "R$ 10 mil a R$ 20 mil");
  assert.equal(faixaDoValor(19999), "R$ 10 mil a R$ 20 mil");
  assert.equal(faixaDoValor(20000), "R$ 20 mil a R$ 30 mil");
  assert.equal(faixaDoValor(30000), "Acima de R$ 30 mil");
  assert.equal(qualifica(9999.99), false);
  assert.equal(qualifica(9000), false);
  assert.equal(qualifica(10000), true);
});

test("formatação em reais", () => {
  assert.equal(formatarReais(17000), "R$ 17 mil");
  assert.equal(formatarReais(17500), "R$ 17,5 mil");
  assert.equal(formatarReais(11999), "R$ 11.999");
  assert.equal(formatarReais(1200000), "R$ 1,2 milhão");
});

test("faturamento: aspas e negrito do WhatsApp não atrapalham", () => {
  assert.deepEqual(interpretarFaturamento('uns "20" mil'), { tipo: "ok", valor: 20000 });
  assert.deepEqual(interpretarFaturamento("*17 mil*"), { tipo: "ok", valor: 17000 });
  assert.deepEqual(interpretarFaturamento("R$ *15.000*"), { tipo: "ok", valor: 15000 });
});

test("faturamento: valor absurdo (ex.: CNPJ colado) vira 'não entendi', não quebra o banco", () => {
  assert.deepEqual(interpretarFaturamento("12345678000190"), { tipo: "nao_entendi", motivo: "alto_demais" });
  assert.deepEqual(interpretarFaturamento("2 milhões"), { tipo: "ok", valor: 2000000 });
});
