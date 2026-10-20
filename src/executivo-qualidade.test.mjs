import assert from 'node:assert/strict';
import {
  filtrarQualidade,
  pendenciasMedida,
  percentual,
  prepararPainel,
  prioridadesRegularizacao,
  qualidadePorFilial,
  rotuloSituacaoCompra,
  textoSituacaoCompra,
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

assert.equal(rotuloSituacaoCompra(cega), 'Em análise');
assert.match(textoSituacaoCompra(cega), /Compra em análise/);
assert.match(textoSituacaoCompra(cega), /8 pneus montados estão sem medida/);
assert.match(textoSituacaoCompra(cega), /Próximo passo: completar essas medidas/);
assert.equal(rotuloSituacaoCompra(travada), 'Em análise');
assert.match(textoSituacaoCompra(travada), /sem quantidade confirmada/);
assert.equal(textoSituacaoCompra(travada).includes('Estoque suficiente'), false);
assert.equal(rotuloSituacaoCompra(completa), 'Sem pendência');
assert.match(textoSituacaoCompra(completa), /Sem pendência de análise de cadastro/);
assert.equal(textoSituacaoCompra(completa).includes('Estoque suficiente'), false);
assert.equal(rotuloSituacaoCompra(vazia), 'Sem montados');
assert.match(textoSituacaoCompra(vazia), /Sem pneus montados/);
assert.equal(textoSituacaoCompra(vazia).includes('bloquead'), false);
assert.equal(textoSituacaoCompra(cega).includes('bloquead'), false);

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

function semPromessaDeCompra(item) {
  assert.equal(/compra|liber|desbloq/i.test(item.justificativa), false);
  assert.equal(item.justificativa.includes('cadastro'), true);
  assert.equal(item.justificativa.includes('%'), true);
}

const ordemAntes = qualidade.map((item) => item.filial);
const prioridades = prioridadesRegularizacao(qualidade);
assert.deepEqual(qualidade.map((item) => item.filial), ordemAntes);
assert.equal(prioridades.maior_problema.filial, 'Cega');
assert.equal(prioridades.maior_problema.filial_id, 4);
assert.equal(prioridades.maior_problema.cadastros_pendentes, 8);
assert.equal(prioridades.maior_problema.incompletos, 100);
assert.equal(prioridades.maior_problema.montados, 8);
assert.equal(
  prioridades.maior_problema.justificativa,
  '8 cadastros pendentes e 100% dos pneus montados sem medida. Reúne o maior percentual incompleto e a maior quantidade de pneus sem medida.',
);
assert.equal(prioridades.menor_esforco.filial, 'Quase');
assert.equal(prioridades.menor_esforco.cadastros_pendentes, 1);
assert.equal(prioridades.menor_esforco.incompletos, 25);
assert.equal(
  prioridades.menor_esforco.justificativa,
  '1 cadastro pendente e 25% dos pneus montados sem medida. É a menor quantidade de pneus sem medida. O percentual incompleto separa quantidades iguais.',
);
semPromessaDeCompra(prioridades.maior_problema);
semPromessaDeCompra(prioridades.menor_esforco);
assert.equal([prioridades.maior_problema.filial, prioridades.menor_esforco.filial].includes('Vazia'), false);
assert.equal([prioridades.maior_problema.filial, prioridades.menor_esforco.filial].includes('Travada'), false);
assert.equal([prioridades.maior_problema.filial, prioridades.menor_esforco.filial].includes('Completa'), false);

const cruzadas = qualidadePorFilial([
  { filial_id: 1, filial: 'CegaPequena', codigo: 'CP', pneus_montados: 2, sem_medida: 2 },
  { filial_id: 2, filial: 'Volume', codigo: 'VO', pneus_montados: 20, sem_medida: 10 },
  { filial_id: 3, filial: 'Muitos', codigo: 'MU', pneus_montados: 150, sem_medida: 15 },
  { filial_id: 4, filial: 'QuasePronta', codigo: 'QP', pneus_montados: 10, sem_medida: 1 },
  { filial_id: 5, filial: 'UmSoCega', codigo: 'UC', pneus_montados: 1, sem_medida: 1 },
  { filial_id: 6, filial: 'Vazia', codigo: 'VZ', pneus_montados: 0, sem_medida: 0 },
  { filial_id: 7, filial: 'Estourada', codigo: 'ES', pneus_montados: 2, sem_medida: 5 },
  { filial_id: 8, filial: 'Completa', codigo: 'CO', pneus_montados: 8, sem_medida: 0 },
]);
const leituraCruzada = prioridadesRegularizacao(cruzadas);
assert.equal(leituraCruzada.maior_problema.filial, 'Volume');
assert.equal(leituraCruzada.maior_problema.codigo, 'VO');
assert.equal(leituraCruzada.maior_problema.cadastros_pendentes, 10);
assert.equal(leituraCruzada.maior_problema.incompletos, 50);
assert.equal(
  leituraCruzada.maior_problema.justificativa,
  '10 cadastros pendentes e 50% dos pneus montados sem medida. Nem o percentual nem a quantidade são os maiores sozinhos; os dois juntos formam o maior problema cadastral.',
);
assert.equal(leituraCruzada.menor_esforco.filial, 'QuasePronta');
assert.equal(leituraCruzada.menor_esforco.cadastros_pendentes, 1);
assert.equal(leituraCruzada.menor_esforco.incompletos, 10);
assert.equal(
  leituraCruzada.menor_esforco.justificativa,
  '1 cadastro pendente e 10% dos pneus montados sem medida. A quantidade de pneus sem medida empata; o menor percentual incompleto define o menor esforço para completar as medidas.',
);
assert.equal(leituraCruzada.maior_problema.filial === 'Vazia' || leituraCruzada.menor_esforco.filial === 'Vazia', false);
assert.equal(leituraCruzada.maior_problema.filial === 'Estourada' || leituraCruzada.menor_esforco.filial === 'Estourada', false);

const percentualPesaMais = prioridadesRegularizacao(qualidadePorFilial([
  { filial_id: 1, filial: 'Cega', pneus_montados: 8, sem_medida: 8 },
  { filial_id: 2, filial: 'Muitos', pneus_montados: 150, sem_medida: 15 },
]));
assert.equal(percentualPesaMais.maior_problema.filial, 'Cega');
assert.equal(percentualPesaMais.maior_problema.cadastros_pendentes, 8);
assert.equal(
  percentualPesaMais.maior_problema.justificativa,
  '8 cadastros pendentes e 100% dos pneus montados sem medida. Outra filial tem mais pneus sem medida; o percentual incompleto torna este o maior problema cadastral.',
);
assert.equal(percentualPesaMais.menor_esforco.filial, 'Cega');
assert.equal(percentualPesaMais.menor_esforco.cadastros_pendentes, 8);

const quantidadePesaMais = prioridadesRegularizacao(qualidadePorFilial([
  { filial_id: 1, filial: 'Larga', pneus_montados: 102, sem_medida: 40 },
  { filial_id: 2, filial: 'CegaMedia', pneus_montados: 10, sem_medida: 10 },
  { filial_id: 3, filial: 'Pequena', pneus_montados: 8, sem_medida: 1 },
]));
assert.equal(quantidadePesaMais.maior_problema.filial, 'Larga');
assert.equal(quantidadePesaMais.maior_problema.cadastros_pendentes, 40);
assert.equal(quantidadePesaMais.maior_problema.incompletos, 39.2);
assert.equal(
  quantidadePesaMais.maior_problema.justificativa,
  '40 cadastros pendentes e 39,2% dos pneus montados sem medida. Outra filial tem percentual incompleto maior; a quantidade absoluta de pneus sem medida torna este o maior problema cadastral.',
);
assert.equal(quantidadePesaMais.menor_esforco.filial, 'Pequena');
assert.equal(quantidadePesaMais.menor_esforco.cadastros_pendentes, 1);
assert.equal(quantidadePesaMais.menor_esforco.incompletos, 12.5);
assert.equal(
  quantidadePesaMais.menor_esforco.justificativa,
  '1 cadastro pendente e 12,5% dos pneus montados sem medida. É a menor quantidade de pneus sem medida. O percentual incompleto separa quantidades iguais.',
);

const empateProduto = prioridadesRegularizacao(qualidadePorFilial([
  { filial_id: 1, filial: 'Meia', pneus_montados: 10, sem_medida: 5 },
  { filial_id: 2, filial: 'Quarto', pneus_montados: 40, sem_medida: 10 },
]));
assert.equal(empateProduto.maior_problema.filial, 'Quarto');
assert.equal(empateProduto.maior_problema.cadastros_pendentes, 10);
assert.equal(empateProduto.menor_esforco.filial, 'Meia');
assert.equal(empateProduto.menor_esforco.cadastros_pendentes, 5);

const sozinha = prioridadesRegularizacao(qualidadePorFilial([
  { filial_id: 1, filial: 'Vazia', pneus_montados: 0, sem_medida: 0 },
  { filial_id: 2, filial: 'Sozinha', pneus_montados: 4, sem_medida: 1 },
]));
assert.equal(sozinha.maior_problema.filial, 'Sozinha');
assert.equal(sozinha.menor_esforco.filial, 'Sozinha');
assert.equal(sozinha.maior_problema.cadastros_pendentes, 1);
assert.equal(
  sozinha.maior_problema.justificativa,
  '1 cadastro pendente e 25% dos pneus montados sem medida. É a única filial com cadastro de medida pendente.',
);
assert.equal(sozinha.menor_esforco.justificativa, sozinha.maior_problema.justificativa);

const nenhuma = prioridadesRegularizacao(qualidadePorFilial([
  { filial_id: 1, filial: 'Vazia', pneus_montados: 0, sem_medida: 0 },
  { filial_id: 2, filial: 'Fantasma', pneus_montados: 0, sem_medida: 4 },
  { filial_id: 3, filial: 'Estourada', pneus_montados: 2, sem_medida: 5 },
  { filial_id: 4, filial: 'Completa', pneus_montados: 6, sem_medida: 0 },
]));
assert.equal(nenhuma.maior_problema, null);
assert.equal(nenhuma.menor_esforco, null);
assert.equal(prioridadesRegularizacao([
  { filial_id: 9, filial: 'Forjada', montados: 0, sem_medida: 4, incompletos: 100 },
]).maior_problema, null);
assert.equal(prioridadesRegularizacao(null).menor_esforco, null);

const doPainel = prioridadesRegularizacao(painel.qualidade);
assert.equal(doPainel.maior_problema.filial, 'Aparecida');
assert.equal(doPainel.menor_esforco.filial, 'Aparecida');
assert.equal(doPainel.maior_problema.cadastros_pendentes, 1);
assert.equal(doPainel.maior_problema.incompletos, 25);

console.log('executivo-qualidade: ok');
