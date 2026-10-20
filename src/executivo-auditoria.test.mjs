import assert from 'node:assert/strict';
import { normalizarMedida } from './medida.js';
import { classificarDecisoes, necessidadesPorPosicao } from './executivo.js';

assert.equal(normalizarMedida('275/80/22.5'), '275/80r22.5');
assert.equal(normalizarMedida('275/80R22.5'), '275/80r22.5');
assert.equal(normalizarMedida('275/80/22.5'), normalizarMedida('275/80R22.5'));
assert.equal(normalizarMedida('  275/80 r22,5 '), '275/80r22.5');
assert.equal(normalizarMedida('12-16-5'), '12-16.5');
assert.equal(normalizarMedida('12-16-5'), normalizarMedida('12-16.5'));
assert.notEqual(normalizarMedida('275/80'), normalizarMedida('275/80R22.5'));
assert.notEqual(normalizarMedida('275/80R22'), normalizarMedida('275/80R22.5'));
assert.notEqual(normalizarMedida('275/80R22.6'), normalizarMedida('275/80R22.5'));

let montarPrevisaoFilial;
try {
  ({ montarPrevisaoFilial } = await import('../../backend/src/services/saude-desgaste.js'));
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  console.log('executivo-auditoria: equivalência de medida ok; a previsão fica no repositório da API');
  process.exit(0);
}

const CAMPOS_API = [
  'filial_id', 'medida', 'medida_informada',
  'estoque_novo', 'estoque_recapado', 'em_recapagem',
  'necessidade_pneu_novo', 'candidatos_recap', 'avaliacao_urgente',
  'previsao_novo_90d', 'previsao_recap_90d',
  'saldo_novo', 'comprar_novo', 'observacao',
];

const nomes = new Map([
  [1, 'Aparecida'],
  [2, 'Contagem'],
  [3, 'Betim'],
]);

function daquiDias(dias) {
  const data = new Date();
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

function pneu(parcial) {
  return {
    id: parcial.id,
    filial_id: 1,
    filial: 'Aparecida',
    medida: '275/80R22.5',
    status_pneu: 'montado',
    condicao: 'novo',
    papel: 'direcional',
    posicao: '1E',
    faixa: 'critico',
    regua_recap: true,
    elegibilidade: { candidato_programacao: false, bloqueios: [], encaminhamento: null },
    consumo: { projecao: { alvo_5: null } },
    ...parcial,
  };
}

/** Espelha o fechamento feito em carregarRelatorioSaude, sem banco. */
function fecharComoRelatorio(pneus, compras) {
  const semMedida = new Map();
  for (const item of pneus) {
    if (item.status_pneu !== 'montado' || normalizarMedida(item.medida)) continue;
    semMedida.set(item.filial_id, (semMedida.get(item.filial_id) || 0) + 1);
  }
  return compras.map((linha) => {
    const faltam = semMedida.get(linha.filial_id) || 0;
    return {
      ...linha,
      montados_sem_medida: faltam,
      recomendacao_definitiva: faltam === 0 && linha.medida_informada,
    };
  });
}

function decidir(pneus) {
  const compras = fecharComoRelatorio(pneus, montarPrevisaoFilial(pneus));
  return {
    compras,
    decisoes: classificarDecisoes(compras, nomes, { pneus }),
    posicoes: necessidadesPorPosicao(pneus),
  };
}

function soma(lista, tipo, filtro) {
  return lista
    .filter((item) => item.tipo === tipo && filtro(item))
    .reduce((total, item) => total + (item.quantidade || 0), 0);
}

const contrato = decidir([
  pneu({ id: 1 }),
  pneu({ id: 2, status_pneu: 'estoque', condicao: 'novo', faixa: null, papel: null }),
]);
for (const campo of CAMPOS_API) {
  assert.equal(Object.hasOwn(contrato.compras[0], campo), true, `contrato sem ${campo}`);
}
assert.equal(typeof contrato.compras[0].recomendacao_definitiva, 'boolean');
assert.equal(Number.isInteger(contrato.compras[0].montados_sem_medida), true);

const dianteira = decidir([
  pneu({ id: 1, faixa: 'critico' }),
  pneu({ id: 2, faixa: 'programar_recapagem', elegibilidade: { candidato_programacao: true, bloqueios: [] } }),
  pneu({ id: 3, status_pneu: 'estoque', condicao: 'recapado', papel: null, faixa: null }),
  pneu({ id: 4, status_pneu: 'estoque', condicao: 'recapado', papel: null, faixa: null }),
  pneu({ id: 5, status_pneu: 'recapagem', condicao: 'novo', papel: null, faixa: null }),
]);
assert.equal(dianteira.compras[0].estoque_novo, 0);
assert.equal(dianteira.compras[0].estoque_recapado, 2);
assert.equal(dianteira.compras[0].em_recapagem, 1);
assert.equal(dianteira.compras[0].necessidade_pneu_novo, 2);
assert.equal(dianteira.compras[0].comprar_novo, 2);
const compraDianteira = dianteira.decisoes.filter((item) => item.tipo === 'comprar');
assert.equal(compraDianteira.length, 1);
assert.equal(compraDianteira[0].confirmada, true);
assert.equal(compraDianteira[0].quantidade, 2);
assert.equal(dianteira.decisoes.some((item) => item.tipo === 'transferir'), false);
assert.equal(dianteira.posicoes.some((item) => item.leitura === 'recapagem'), false);
assert.equal(dianteira.posicoes.every((item) => item.papel !== 'direcional' || item.leitura === 'pneu_novo'), true);

const transferencia = decidir([
  pneu({ id: 1, filial_id: 1, filial: 'Aparecida' }),
  pneu({ id: 2, filial_id: 1, filial: 'Aparecida' }),
  pneu({ id: 3, filial_id: 1, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null }),
  pneu({ id: 4, filial_id: 1, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null }),
  pneu({ id: 5, filial_id: 1, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null }),
  pneu({ id: 6, filial_id: 1, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null }),
  pneu({ id: 7, filial_id: 1, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null }),
  pneu({ id: 8, filial_id: 1, status_pneu: 'estoque', condicao: 'recapado', papel: null, faixa: null }),
  pneu({ id: 9, filial_id: 1, status_pneu: 'recapagem', papel: null, faixa: null }),
  pneu({ id: 10, filial_id: 2, filial: 'Contagem' }),
  pneu({ id: 11, filial_id: 2, filial: 'Contagem' }),
  pneu({ id: 12, filial_id: 2, filial: 'Contagem' }),
  pneu({ id: 13, filial_id: 2, filial: 'Contagem' }),
]);
const linhaOrigem = transferencia.compras.find((item) => item.filial_id === 1);
const linhaDestino = transferencia.compras.find((item) => item.filial_id === 2);
assert.equal(linhaOrigem.saldo_novo, 3);
assert.equal(linhaDestino.comprar_novo, 4);
const ida = transferencia.decisoes.find((item) => item.tipo === 'transferir');
assert.equal(ida.quantidade, 3);
assert.equal(ida.origem_id, 1);
assert.equal(ida.filial_id, 2);
assert.equal(ida.confirmada, true);
assert.match(ida.motivo, /necessidade 2/);
assert.match(ida.motivo, /ainda cobre a necessidade local/);
const compraRestante = transferencia.decisoes.find((item) => item.tipo === 'comprar' && item.filial_id === 2);
assert.equal(compraRestante.quantidade, 1);
assert.equal(ida.quantidade + compraRestante.quantidade, linhaDestino.comprar_novo);
assert.equal(
  soma(transferencia.decisoes, 'transferir', (item) => item.origem_id === 1),
  linhaOrigem.saldo_novo,
);
const fica = linhaOrigem.estoque_novo - ida.quantidade;
assert.ok(fica >= linhaOrigem.necessidade_pneu_novo);
const naoCompraOrigem = transferencia.decisoes.find((item) => item.tipo === 'nao_comprar' && item.filial_id === 1);
assert.equal(naoCompraOrigem.confirmada, true);
assert.match(naoCompraOrigem.motivo, /cobre a necessidade/);
assert.match(naoCompraOrigem.motivo, /não são estoque disponível/);

const disputa = decidir([
  ...[1, 2].map((id) => pneu({ id, filial_id: 1 })),
  ...[3, 4, 5, 6, 7].map((id) => pneu({ id, filial_id: 1, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null })),
  ...[8, 9].map((id) => pneu({ id, filial_id: 2, filial: 'Contagem' })),
  ...[10, 11].map((id) => pneu({ id, filial_id: 3, filial: 'Betim' })),
]);
const saidas = disputa.decisoes.filter((item) => item.tipo === 'transferir' && item.origem_id === 1);
assert.equal(saidas.reduce((total, item) => total + item.quantidade, 0), 3);
const cobertoPelosDestinos = disputa.decisoes
  .filter((item) => (item.tipo === 'transferir' || item.tipo === 'comprar') && item.filial_id !== 1)
  .reduce((total, item) => total + item.quantidade, 0);
assert.equal(cobertoPelosDestinos, 4);

const incompleta = decidir([
  pneu({ id: 1, medida: '' }),
  pneu({ id: 2 }),
  pneu({ id: 3, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null }),
]);
assert.equal(incompleta.compras.every((item) => item.recomendacao_definitiva === false), true);
assert.equal(incompleta.decisoes.every((item) => item.tipo === 'dados_insuficientes' && item.quantidade == null && item.confirmada === false), true);
assert.equal(incompleta.decisoes.some((item) => item.tipo === 'comprar' || item.tipo === 'transferir' || item.tipo === 'nao_comprar'), false);

const semFlag = classificarDecisoes([{
  filial_id: 1,
  medida: '275/80R22.5',
  medida_informada: true,
  estoque_novo: 0,
  necessidade_pneu_novo: 2,
  saldo_novo: -2,
  comprar_novo: 2,
  estoque_recapado: 0,
  em_recapagem: 0,
  montados_sem_medida: 0,
}], nomes);
assert.equal(semFlag[0].tipo, 'dados_insuficientes');
assert.equal(semFlag[0].quantidade, null);

const saldoMentiroso = classificarDecisoes([{
  filial_id: 2,
  medida: '275/80R22.5',
  medida_informada: true,
  recomendacao_definitiva: true,
  montados_sem_medida: 0,
  estoque_novo: 1,
  necessidade_pneu_novo: 1,
  saldo_novo: 8,
  comprar_novo: 0,
  estoque_recapado: 0,
  em_recapagem: 0,
}], nomes);
assert.equal(saldoMentiroso[0].tipo, 'dados_insuficientes');
assert.equal(saldoMentiroso.some((item) => item.tipo === 'transferir'), false);

const duplicada = classificarDecisoes([
  {
    filial_id: 1, medida: '275/80R22.5', medida_informada: true, recomendacao_definitiva: true,
    montados_sem_medida: 0, estoque_novo: 4, necessidade_pneu_novo: 0, saldo_novo: 4, comprar_novo: 0,
    estoque_recapado: 0, em_recapagem: 0,
  },
  {
    filial_id: 1, medida: '275/80 r22,5', medida_informada: true, recomendacao_definitiva: true,
    montados_sem_medida: 0, estoque_novo: 4, necessidade_pneu_novo: 0, saldo_novo: 4, comprar_novo: 0,
    estoque_recapado: 0, em_recapagem: 0,
  },
], nomes);
assert.equal(duplicada.every((item) => item.tipo === 'dados_insuficientes' && item.quantidade == null), true);

const soPrevisao = decidir([
  pneu({
    id: 1,
    papel: 'tracao',
    posicao: '2EE',
    faixa: 'acompanhamento_normal',
    elegibilidade: { candidato_programacao: false, bloqueios: [] },
    consumo: { projecao: { alvo_5: { data: daquiDias(20), ja_atingido: false } } },
  }),
]);
assert.equal(soPrevisao.compras[0].necessidade_pneu_novo, 0);
assert.equal(soPrevisao.compras[0].previsao_recap_90d, 1);
assert.equal(soPrevisao.decisoes.some((item) => item.tipo === 'nao_comprar'), false);
assert.equal(soPrevisao.decisoes.some((item) => item.tipo === 'comprar'), false);
const estimativa = soPrevisao.decisoes.find((item) => item.tipo === 'estimativa');
assert.equal(estimativa.confirmada, false);
assert.equal(estimativa.quantidade, 1);
assert.match(estimativa.motivo, /não é decisão confirmada/);

const semNecessidade = decidir([
  pneu({
    id: 1,
    papel: 'tracao',
    posicao: '2EE',
    faixa: 'programar_recapagem',
    elegibilidade: {
      candidato_programacao: true,
      bloqueios: [],
      encaminhamento: 'programar_avaliacao_envio',
    },
  }),
  pneu({ id: 2, status_pneu: 'estoque', condicao: 'recapado', papel: null, faixa: null }),
]);
assert.equal(semNecessidade.compras[0].necessidade_pneu_novo, 0);
assert.equal(semNecessidade.compras[0].candidatos_recap, 1);
assert.equal(semNecessidade.decisoes.some((item) => item.tipo === 'nao_comprar' || item.tipo === 'comprar' || item.tipo === 'transferir'), false);
assert.equal(semNecessidade.posicoes.some((item) => item.leitura === 'recapagem'), true);

const posicaoOculta = necessidadesPorPosicao([
  pneu({ id: 1, papel: null, posicao: null, faixa: 'programar_recapagem' }),
]);
assert.equal(posicaoOculta[0].leitura, 'dados_insuficientes');
assert.match(posicaoOculta[0].motivo, /não é dianteira|Recapagem não é recomendada|não é recomendada/i);

const bloqueada = necessidadesPorPosicao([
  pneu({
    id: 1,
    papel: 'tracao',
    posicao: '2EE',
    faixa: 'programar_recapagem',
    elegibilidade: {
      candidato_programacao: false,
      bloqueios: ['Dianteira de caminhão exige pneu novo. Recapagem não é opção nesta posição.'],
    },
  }),
]);
assert.notEqual(bloqueada[0].leitura, 'recapagem');
assert.match(bloqueada[0].motivo, /não é opção nesta posição|não recomendada/i);

const medidaTrocada = decidir([
  pneu({ id: 1, filial_id: 1, medida: '275/80 R22,5' }),
  pneu({ id: 2, filial_id: 2, filial: 'Contagem', medida: '295/80R22.5' }),
  pneu({ id: 3, filial_id: 2, status_pneu: 'estoque', condicao: 'novo', medida: '295/80R22.5', papel: null, faixa: null }),
  pneu({ id: 4, filial_id: 2, status_pneu: 'estoque', condicao: 'novo', medida: '295/80R22.5', papel: null, faixa: null }),
]);
assert.equal(medidaTrocada.decisoes.some((item) => item.tipo === 'transferir'), false);
assert.equal(medidaTrocada.decisoes.find((item) => item.filial_id === 1 && item.tipo === 'comprar').quantidade, 1);

const listaDiverge = classificarDecisoes(fecharComoRelatorio(
  [pneu({ id: 1, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null })],
  [{
    filial_id: 1,
    medida: '275/80r22.5',
    medida_informada: true,
    estoque_novo: 5,
    necessidade_pneu_novo: 0,
    saldo_novo: 5,
    comprar_novo: 0,
    estoque_recapado: 0,
    em_recapagem: 0,
    previsao_novo_90d: 0,
    previsao_recap_90d: 0,
  }],
), nomes, {
  pneus: [pneu({ id: 1, status_pneu: 'estoque', condicao: 'novo', papel: null, faixa: null })],
});
assert.equal(listaDiverge[0].tipo, 'dados_insuficientes');
assert.match(listaDiverge[0].motivo, /não confirma/);

for (const item of [...transferencia.decisoes, ...dianteira.decisoes, ...soPrevisao.decisoes]) {
  assert.equal(typeof item.motivo, 'string');
  assert.ok(item.motivo.length > 20);
  if (item.confirmada) assert.match(item.motivo, /Decisão confirmada/);
  else assert.match(item.motivo, /não é definitiva|não foi confirmada|não é decisão confirmada|não foram somadas|não confirma|não confere/i);
}

console.log('executivo-auditoria: ok');
