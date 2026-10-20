import assert from 'node:assert/strict';
import {
  filtrarQualidade,
  pendenciasMedida,
  percentual,
  prepararPainel,
  qualidadePorFilial,
} from './executivo.js';

assert.equal(percentual(1, 4), 25);
assert.equal(percentual(3, 4), 75);
assert.equal(percentual(144, 144), 100);
assert.equal(percentual(4, 102), 3.9);
assert.equal(percentual(0, 10), 0);
assert.equal(percentual(1, 0), null);
assert.equal(percentual(5, 4), null);
assert.equal(percentual(null, 4), null);

const unidades = [
  { filial_id: 1, filial: 'Completa', codigo: 'C', pneus_montados: 10, sem_medida: 0 },
  { filial_id: 2, filial: 'Quase', codigo: 'Q', pneus_montados: 4, sem_medida: 1 },
  { filial_id: 3, filial: 'Vazia', codigo: 'V', pneus_montados: 0, sem_medida: 0 },
  { filial_id: 4, filial: 'Cega', codigo: 'G', pneus_montados: 8, sem_medida: 8 },
  { filial_id: 5, filial: 'Travada', codigo: 'T', pneus_montados: 6, sem_medida: 0 },
];
const decisoes = [
  { filial_id: 1, tipo: 'nao_comprar', confirmada: true },
  { filial_id: 2, tipo: 'dados_insuficientes', confirmada: false },
  { filial_id: 4, tipo: 'dados_insuficientes', confirmada: false },
  { filial_id: 5, tipo: 'dados_insuficientes', confirmada: false },
  { filial_id: 5, tipo: 'comprar', confirmada: true },
];

const qualidade = qualidadePorFilial(unidades, { decisoes });
assert.deepEqual(qualidade.map((item) => item.filial), ['Cega', 'Quase', 'Completa', 'Travada', 'Vazia']);

const quase = qualidade.find((item) => item.filial === 'Quase');
assert.equal(quase.montados, 4);
assert.equal(quase.sem_medida, 1);
assert.equal(quase.com_medida, 3);
assert.equal(quase.completude, 75);
assert.equal(quase.incompletos, 25);
assert.equal(quase.compra_bloqueada, true);

const cega = qualidade.find((item) => item.filial === 'Cega');
assert.equal(cega.completude, 0);
assert.equal(cega.incompletos, 100);
assert.equal(cega.compra_bloqueada, true);

const completa = qualidade.find((item) => item.filial === 'Completa');
assert.equal(completa.completude, 100);
assert.equal(completa.incompletos, 0);
assert.equal(completa.compra_bloqueada, false);

const vazia = qualidade.find((item) => item.filial === 'Vazia');
assert.equal(vazia.completude, null);
assert.equal(vazia.incompletos, null);
assert.equal(vazia.compra_bloqueada, false);

const travada = qualidade.find((item) => item.filial === 'Travada');
assert.equal(travada.completude, 100);
assert.equal(travada.compra_bloqueada, true);

const incoerente = qualidadePorFilial([
  { filial_id: 9, filial: 'Estourada', pneus_montados: 2, sem_medida: 5 },
]);
assert.equal(incoerente[0].com_medida, null);
assert.equal(incoerente[0].completude, null);
assert.equal(incoerente[0].incompletos, null);
assert.equal(incoerente[0].compra_bloqueada, true);

assert.deepEqual(filtrarQualidade(qualidade, 'bloqueadas').map((item) => item.filial), ['Cega', 'Quase', 'Travada']);
assert.deepEqual(filtrarQualidade(qualidade, 'sem_medida').map((item) => item.filial), ['Cega', 'Quase']);
assert.deepEqual(filtrarQualidade(qualidade, 'completas').map((item) => item.filial), ['Completa', 'Travada']);
assert.equal(filtrarQualidade(qualidade, 'todas').length, 5);
assert.equal(filtrarQualidade(qualidade, 'desconhecido').length, 5);

const pneus = [
  { filial_id: 2, status_pneu: 'montado', medida: '', placa: 'ABC1D23', posicao: '2D', numero_fogo: '88', marca: 'Não usar' },
  { filial_id: 2, status_pneu: 'montado', medida: '275/80R22.5', placa: 'COM1A23', posicao: '1E', numero_fogo: '10' },
  { filial_id: 2, status_pneu: 'estoque', medida: '', placa: 'EST0A00', posicao: null, numero_fogo: '11' },
  { filial_id: 1, status_pneu: 'montado', medida: null, placa: 'OUT1A00', apelido: 'Outra', posicao: '1D', numero_fogo: '12' },
  { filial_id: 2, status_pneu: 'montado', medida: '   ', apelido: 'Carreta', posicao: null, numero_fogo: null },
];
const pendencias = pendenciasMedida(pneus, 2);
assert.equal(pendencias.length, 2);
assert.deepEqual(Object.keys(pendencias[0]).sort(), ['numero_fogo', 'posicao', 'veiculo']);
assert.equal(pendencias.some((item) => item.veiculo === 'COM1A23' || item.veiculo === 'EST0A00' || item.veiculo === 'OUT1A00'), false);
assert.deepEqual(pendencias[0], { veiculo: 'ABC1D23', posicao: '2D', numero_fogo: '88' });
assert.deepEqual(pendencias[1], { veiculo: 'Carreta', posicao: null, numero_fogo: null });
assert.equal(JSON.stringify(pendencias).includes('Não usar'), false);
assert.equal(pendenciasMedida(null, 2), null);

const painel = prepararPainel({
  por_unidade: [
    { filial_id: 1, filial: 'Aparecida', codigo: 'APA', veiculos: 2, pneus_montados: 4, faixas: {} },
    { filial_id: 8, filial: 'E2E Norte', codigo: 'E2E', veiculos: 1, pneus_montados: 40, faixas: { critico: 9 } },
  ],
  compras_por_filial: [{ filial_id: 1, montados_sem_medida: 1 }],
  compras_por_medida: [],
  pneus: [],
  por_veiculo: [],
});
assert.equal(painel.qualidade.length, 1);
assert.equal(painel.qualidade[0].filial, 'Aparecida');
assert.equal(painel.qualidade[0].sem_medida, 1);
assert.equal(painel.qualidade[0].completude, 75);
assert.equal(painel.qualidade[0].incompletos, 25);
assert.equal(painel.qualidade[0].compra_bloqueada, true);

console.log('executivo-qualidade: ok');
