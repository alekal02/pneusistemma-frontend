import assert from 'node:assert/strict';
import {
  classificarDecisoes,
  htmlsConsulta,
  montarConsulta,
  necessidadesPorPosicao,
  prepararPainel,
  proximoPassoApresentacao,
  rotuloApresentacao,
  unidadeForaDoPainel,
} from './executivo.js';

const nomes = new Map([
  [1, 'Aparecida'],
  [2, 'Contagem'],
]);

function linha(parcial) {
  return {
    medida_informada: true,
    recomendacao_definitiva: true,
    montados_sem_medida: 0,
    estoque_novo: 0,
    estoque_recapado: 0,
    necessidade_pneu_novo: 0,
    comprar_novo: 0,
    saldo_novo: 0,
    candidatos_recap: 0,
    avaliacao_urgente: 0,
    observacao: 'Saldo usa só pneu novo da mesma medida. Recapado em estoque não cobre dianteira.',
    ...parcial,
  };
}

const semMedida = classificarDecisoes([
  linha({ filial_id: 1, medida: null, medida_informada: false, comprar_novo: null, saldo_novo: null }),
], nomes);
assert.equal(semMedida.length, 1);
assert.equal(semMedida[0].tipo, 'dados_insuficientes');
assert.equal(semMedida[0].quantidade, null);

const incompleta = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    recomendacao_definitiva: false,
    montados_sem_medida: 4,
    comprar_novo: 3,
    saldo_novo: -3,
    necessidade_pneu_novo: 3,
  }),
], nomes);
assert.equal(incompleta[0].tipo, 'dados_insuficientes');
assert.equal(incompleta[0].quantidade, null);
assert.match(incompleta[0].motivo, /não é definitiva/i);

const comprar = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    estoque_novo: 1,
    necessidade_pneu_novo: 5,
    comprar_novo: 4,
    saldo_novo: -4,
    estoque_recapado: 9,
  }),
], nomes);
assert.equal(comprar.filter((item) => item.tipo === 'comprar').length, 1);
assert.equal(comprar.find((item) => item.tipo === 'comprar').quantidade, 4);
assert.match(comprar.find((item) => item.tipo === 'comprar').motivo, /Recapado não entra/);
assert.equal(comprar.some((item) => item.tipo === 'transferir'), false);

const misto = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    estoque_novo: 0,
    necessidade_pneu_novo: 5,
    comprar_novo: 5,
    saldo_novo: -5,
  }),
  linha({
    filial_id: 2,
    medida: '275/80R22.5',
    estoque_novo: 4,
    necessidade_pneu_novo: 1,
    comprar_novo: 0,
    saldo_novo: 3,
  }),
], nomes);
const transferencias = misto.filter((item) => item.tipo === 'transferir');
const compras = misto.filter((item) => item.tipo === 'comprar');
assert.equal(transferencias.length, 1);
assert.equal(transferencias[0].quantidade, 3);
assert.equal(transferencias[0].filial, 'Aparecida');
assert.equal(transferencias[0].origem, 'Contagem');
assert.equal(compras.length, 1);
assert.equal(compras[0].quantidade, 2);
assert.equal(misto.find((item) => item.tipo === 'nao_comprar' && item.filial === 'Contagem').quantidade, 0);

const coberto = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '295/80R22.5',
    estoque_novo: 2,
    necessidade_pneu_novo: 2,
    comprar_novo: 0,
    saldo_novo: 0,
  }),
], nomes);
assert.equal(coberto[0].tipo, 'nao_comprar');
assert.match(coberto[0].motivo, /cobre a necessidade/);

assert.equal(rotuloApresentacao(semMedida[0]), 'Aguardando validação');
assert.equal(proximoPassoApresentacao(semMedida[0]), 'Informar a medida dos pneus desta linha.');
assert.equal(rotuloApresentacao(incompleta[0]), 'Aguardando validação');
assert.equal(proximoPassoApresentacao(incompleta[0]), 'Completar a medida dos pneus montados desta filial.');
assert.notEqual(rotuloApresentacao(incompleta[0]), 'Estoque suficiente');
assert.equal(rotuloApresentacao(comprar.find((item) => item.tipo === 'comprar')), 'Compra recomendada');
assert.equal(proximoPassoApresentacao(comprar.find((item) => item.tipo === 'comprar')), null);
assert.equal(rotuloApresentacao(transferencias[0]), 'Transferência recomendada');
assert.equal(rotuloApresentacao(coberto[0]), 'Estoque suficiente');
assert.equal(rotuloApresentacao({ tipo: 'comprar', confirmada: false, motivo: 'sem fechar' }), 'Aguardando validação');
assert.equal(rotuloApresentacao({ tipo: 'nao_comprar', confirmada: false, motivo: 'sem dados' }), 'Aguardando validação');

const comEstimativa = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '295/80R22.5',
    estoque_novo: 2,
    necessidade_pneu_novo: 2,
    comprar_novo: 0,
    saldo_novo: 0,
    previsao_novo_90d: 3,
  }),
], nomes);
const estimativaLinha = comEstimativa.find((item) => item.tipo === 'estimativa');
assert.equal(estimativaLinha.confirmada, false);
assert.equal(estimativaLinha.quantidade, 3);
assert.equal(rotuloApresentacao(estimativaLinha), 'Estimativa');
assert.equal(proximoPassoApresentacao(estimativaLinha), null);
assert.equal(comEstimativa.some((item) => item.tipo === 'nao_comprar' && item.confirmada === true), true);

assert.equal(unidadeForaDoPainel({ codigo: 'MATRIZ', filial: 'Matriz' }), true);
assert.equal(unidadeForaDoPainel({ codigo: 'E2E-01', filial: 'Teste' }), true);
assert.equal(unidadeForaDoPainel({ codigo: 'APA', filial: 'Aparecida' }), false);

const painel = prepararPainel({
  gerado_em: '2026-10-19T12:00:00.000Z',
  unidades_excluidas: [{ id: 9, nome: 'Matriz', codigo: 'MATRIZ' }],
  por_unidade: [
    {
      filial_id: 1,
      filial: 'Aparecida',
      codigo: 'APA',
      veiculos: 2,
      pneus_montados: 4,
      faixas: { critico: 2, monitoramento_preventivo: 1, programar_recapagem: 1 },
    },
    {
      filial_id: 8,
      filial: 'E2E Norte',
      codigo: 'E2E',
      veiculos: 9,
      pneus_montados: 40,
      faixas: { critico: 30 },
    },
  ],
  compras_por_medida: [
    linha({
      filial_id: 8,
      medida: '275/80R22.5',
      comprar_novo: 10,
      saldo_novo: -10,
      necessidade_pneu_novo: 10,
    }),
  ],
  compras_por_filial: [{ filial_id: 1, montados_sem_medida: 1 }],
  pneus: [
    {
      filial_id: 1,
      filial: 'Aparecida',
      status_pneu: 'montado',
      medida: '275/80R22.5',
      papel: 'direcional',
      posicao: '1E',
      faixa: 'critico',
      faixa_label: 'Crítico',
    },
    {
      filial_id: 8,
      filial: 'E2E Norte',
      filial_codigo: 'E2E',
      status_pneu: 'montado',
      medida: '275/80R22.5',
      papel: 'direcional',
      faixa: 'critico',
    },
  ],
  por_veiculo: [],
  limitacoes: ['Dianteira de caminhão permanece com pneu novo.'],
});

assert.equal(painel.indicadores.filiais, 1);
assert.equal(painel.indicadores.criticos, 2);
assert.equal(painel.indicadores.sem_medida, 1);
assert.equal(painel.posicoes.length, 1);
assert.equal(painel.posicoes[0].posicao, 'Dianteira');
assert.match(painel.posicoes[0].motivo, /Recapado não se aplica/);
assert.equal(proximoPassoApresentacao(painel.posicoes[0]), null);
const semMedicao = necessidadesPorPosicao([{
  filial_id: 1,
  filial: 'Aparecida',
  status_pneu: 'montado',
  medida: '',
  faixa: 'sem_medicao',
  papel: 'tracao',
  posicao: '2D',
}]);
assert.equal(semMedicao[0].leitura, 'dados_insuficientes');
assert.match(semMedicao[0].motivo, /ainda não está confirmada/);
assert.equal(semMedicao[0].motivo.includes('Não há quantidade de compra'), false);
assert.equal(proximoPassoApresentacao(semMedicao[0]), 'Informar a medida e a medição de banda para concluir a leitura desta posição.');
assert.equal(painel.decisoes.some((item) => item.filial_id === 8), false);
assert.equal(JSON.stringify(painel).includes('R$'), false);

const consultaIncompleta = montarConsulta({
  por_unidade: [{
    filial_id: 10,
    filial: 'Ariquemes',
    codigo: '0110',
    pneus_montados: 4,
    veiculos: 2,
    veiculos_cadastrados: 5,
    situacao_semana: 'atualizada',
    incompletos: 4,
    ultima_medicao: '2026-10-19',
  }],
  compras_por_filial: [{
    filial_id: 10,
    montados_sem_medida: 4,
    recomendacao_definitiva: false,
    comprar_novo: 2,
  }],
  compras_por_medida: [{
    filial_id: 10,
    medida: '275/80/22.5',
    medida_informada: true,
    recomendacao_definitiva: false,
    montados_sem_medida: 4,
    necessidade_pneu_novo: 2,
    comprar_novo: 2,
    estoque_novo: 0,
    estoque_recapado: 0,
    em_recapagem: 0,
  }],
});
assert.equal(consultaIncompleta.filiais[0].necessidade.selo, 'DADOS INSUFICIENTES');
assert.equal(consultaIncompleta.filiais[0].necessidade.faltam, null);
assert.equal(consultaIncompleta.filiais[0].medidas[0].selo, 'DADOS INSUFICIENTES');
assert.equal(consultaIncompleta.filiais[0].veiculos_cadastrados, 5);
assert.equal(consultaIncompleta.filiais[0].veiculos, 2);
const relatorioIncompleto = {
  por_unidade: [
    {
      filial_id: 10,
      filial: 'Ariquemes',
      codigo: '0110',
      pneus_montados: 4,
      veiculos: 2,
      veiculos_cadastrados: 5,
      situacao_semana: 'atualizada',
      incompletos: 4,
      ultima_medicao: '2026-10-19',
    },
    {
      filial_id: 13,
      filial: 'Porto Velho',
      codigo: '0102',
      pneus_montados: 3,
      veiculos: 1,
      veiculos_cadastrados: 1,
      situacao_semana: 'atrasada',
      incompletos: 3,
      ultima_medicao: '2026-10-17',
    },
  ],
  compras_por_filial: [
    { filial_id: 10, montados_sem_medida: 4, recomendacao_definitiva: false, comprar_novo: 2 },
    { filial_id: 13, montados_sem_medida: 3, recomendacao_definitiva: false, comprar_novo: 10 },
  ],
  compras_por_medida: [{
    filial_id: 10,
    medida: '275/80/22.5',
    medida_informada: true,
    recomendacao_definitiva: false,
    montados_sem_medida: 4,
    necessidade_pneu_novo: 2,
    comprar_novo: 2,
    estoque_novo: 0,
    estoque_recapado: 0,
    em_recapagem: 0,
  }],
};
const telas = htmlsConsulta(relatorioIncompleto, { filialId: 10, comparar: [10, 13] });
assert.match(telas.situacao, /veículos cadastrados/);
assert.match(telas.situacao, /veículos com pneu montado/);
assert.match(telas.situacao, /cadastro incompleto/);
assert.match(telas.situacao, /mesmo com a medição desta semana em dia/);
assert.equal(telas.situacao.includes('Faltam 2'), false);
assert.equal(telas.filial.includes('Faltam 2'), false);
assert.match(telas.filial, /Quantidade em aberto/);
assert.match(telas.comparar, /Necessidade ainda não comprovada/);

console.log('executivo.test: ok');
