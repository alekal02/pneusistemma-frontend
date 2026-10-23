/**
 * Ordem da abertura do Início: indicadores e resumo não esperam os desenhos.
 * Falha parcial nos desenhos conserva o que já foi pintado.
 */
import assert from 'node:assert/strict';
import {
  filaPorChave,
  filaUnica,
  pintarSemBloquearDesenhos,
  planoAbertura,
} from '../src/abertura-tela.js';

const filial = planoAbertura('filial');
assert.equal(filial.tela, 'dashboard');
assert.deepEqual(filial.paralelas, ['configuracoes', 'veiculos/meta', 'dashboard/resumo']);
assert.deepEqual(filial.depois, ['dashboard/desenhos']);
assert.equal(filial.paralelas.includes('dashboard/desenhos'), false);

const admin = planoAbertura('admin');
assert.equal(admin.tela, 'relatorios');
assert.equal(admin.paralelas.includes('dashboard/resumo'), false);
assert.equal(admin.paralelas.includes('relatorios/diretoria'), true);

const gerente = planoAbertura('gerente');
assert.equal(gerente.tela, 'filiais');
assert.equal(gerente.paralelas.includes('dashboard/resumo'), false);

const presidente = planoAbertura('presidente');
assert.equal(presidente.tela, 'presidente');
assert.deepEqual(presidente.paralelas, []);
assert.equal(presidente.paralelas.includes('configuracoes'), false);

const ordem = [];
const inicio = Date.now();
let indicadoresEm = 0;
const resultado = await pintarSemBloquearDesenhos({
  pintar() {
    ordem.push('indicadores');
    ordem.push('resumo');
    indicadoresEm = Date.now() - inicio;
  },
  desenhos() {
    ordem.push('pedido-desenhos');
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('desenhos indisponíveis')), 40);
    });
  },
});
assert.deepEqual(ordem, ['indicadores', 'resumo', 'pedido-desenhos']);
assert.equal(resultado.indicadores, true);
assert.equal(resultado.resumo, true);
assert.equal(resultado.desenhos, false);
assert.equal(resultado.erroDesenhos, 'desenhos indisponíveis');
assert.ok(indicadoresEm < 30, `indicadores esperaram os desenhos (${indicadoresEm} ms)`);

let execucoes = 0;
const unica = filaUnica();
const [a, b] = await Promise.all([
  unica(async () => {
    execucoes += 1;
    await new Promise((r) => setTimeout(r, 20));
    return 'config';
  }),
  unica(async () => {
    execucoes += 1;
    return 'outra';
  }),
]);
assert.equal(a, 'config');
assert.equal(b, 'config');
assert.equal(execucoes, 1);

const porChave = filaPorChave();
let resumos = 0;
await Promise.all([
  porChave('dashboard:', async () => {
    resumos += 1;
    return 1;
  }),
  porChave('dashboard:', async () => {
    resumos += 1;
    return 2;
  }),
  porChave('dashboard:truck', async () => {
    resumos += 1;
    return 3;
  }),
]);
assert.equal(resumos, 2);

console.log('abertura-tela ok');
