import assert from 'node:assert/strict';
import {
  classificarDecisoes,
  filtrarCartoesCompra,
  htmlPainelDecisoes,
  montarResumoCompra,
  qualidadePorFilial,
} from './executivo.js';

const nomes = new Map([
  [1, 'Aparecida'],
  [2, 'Contagem'],
  [3, 'Betim'],
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

function cadastro(filialId, filial, montados, semMedida, decisoes) {
  return qualidadePorFilial([
    { filial_id: filialId, filial, pneus_montados: montados, sem_medida: semMedida },
  ], { decisoes })[0];
}

const compraComEstimativa = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    estoque_novo: 1,
    necessidade_pneu_novo: 5,
    comprar_novo: 4,
    saldo_novo: -4,
    previsao_novo_90d: 3,
  }),
], nomes);

const modeloCompra = {
  decisoes: compraComEstimativa,
  qualidade: [cadastro(1, 'Aparecida', 10, 0, compraComEstimativa)],
  posicoes: [
    {
      filial_id: 1,
      filial: 'Aparecida',
      medida: '275/80R22.5',
      posicao: 'Dianteira',
      leitura: 'pneu_novo',
      pneus: 2,
      posicoes: ['1E'],
      motivo: 'Dianteira em faixa crítica.',
    },
    {
      filial_id: 1,
      filial: 'Aparecida',
      medida: null,
      posicao: 'Tração',
      leitura: 'dados_insuficientes',
      pneus: 5,
      posicoes: [],
      motivo: 'Sem medida.',
    },
    {
      filial_id: 1,
      filial: 'Aparecida',
      medida: '295/80R22.5',
      posicao: 'Tração',
      leitura: 'dados_insuficientes',
      pneus: 1,
      posicoes: ['2D'],
      motivo: 'Recapagem não recomendada.',
    },
  ],
  limitacoes: ['Dianteira permanece com pneu novo.'],
};

const resumoCompra = montarResumoCompra(modeloCompra);
const aparecida = resumoCompra.filiais.find((card) => card.filial === 'Aparecida');
const projecao = aparecida.projecoes.reduce((total, linha) => total + linha.quantidade, 0);

assert.equal(resumoCompra.indicadores.compra, 4);
assert.equal(resumoCompra.indicadores.transferencia, 0);
assert.equal(aparecida.compra, 4);
assert.equal(aparecida.necessidade_preliminar, 2);
assert.equal(projecao, 3);
assert.notEqual(aparecida.compra, aparecida.compra + aparecida.necessidade_preliminar + projecao);
assert.equal(aparecida.medidas.some((linha) => linha.quantidade === 5), false);
assert.equal(aparecida.medidas.some((linha) => linha.medida === '295/80R22.5' && linha.estimativa === false), false);
assert.equal(aparecida.medidas.find((linha) => linha.classe === 'Compra').estimativa, false);
assert.equal(aparecida.medidas.find((linha) => linha.classe === 'Compra').quantidade, 4);
assert.match(aparecida.medidas.find((linha) => linha.estimativa && linha.medida === '275/80R22.5').classe, /Dianteira/);
assert.match(aparecida.inconsistencias.map((item) => item.texto).join(' '), /295\/80R22\.5/);
assert.equal(aparecida.proxima_acao, 'Comprar 4 pneus.');

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
const modeloMisto = {
  decisoes: misto,
  qualidade: [
    cadastro(1, 'Aparecida', 8, 0, misto),
    cadastro(2, 'Contagem', 6, 0, misto),
  ],
  posicoes: [],
  limitacoes: [],
};
const resumoMisto = montarResumoCompra(modeloMisto);
const destino = resumoMisto.filiais.find((card) => card.filial === 'Aparecida');
const origem = resumoMisto.filiais.find((card) => card.filial === 'Contagem');

assert.equal(resumoMisto.indicadores.compra, 2);
assert.equal(resumoMisto.indicadores.transferencia, 3);
assert.notEqual(resumoMisto.indicadores.compra, 5);
assert.equal(destino.compra, 2);
assert.equal(destino.transferencia, 3);
assert.deepEqual(destino.origens, ['Contagem']);
assert.equal(destino.proxima_acao, 'Comprar 2 pneus e transferir 3 pneus.');
assert.equal(destino.medidas.filter((linha) => linha.estimativa).length, 0);
assert.equal(origem.somente_cobertura, true);
assert.equal(origem.compra, 0);
assert.equal(filtrarCartoesCompra(resumoMisto.filiais, 'todas').some((card) => card.filial === 'Contagem'), false);
assert.equal(filtrarCartoesCompra(resumoMisto.filiais, 'nao_comprar').some((card) => card.filial === 'Contagem'), true);
assert.equal(filtrarCartoesCompra(resumoMisto.filiais, 'comprar').length, 1);

const bloqueada = classificarDecisoes([
  linha({
    filial_id: 3,
    medida: '275/80R22.5',
    recomendacao_definitiva: false,
    montados_sem_medida: 4,
    estoque_novo: 0,
    necessidade_pneu_novo: 3,
    comprar_novo: 3,
    saldo_novo: -3,
  }),
], nomes);
const modeloBloqueado = {
  decisoes: bloqueada,
  qualidade: [cadastro(3, 'Betim', 8, 4, bloqueada)],
  posicoes: [],
  limitacoes: [],
};
const resumoBloqueado = montarResumoCompra(modeloBloqueado);
const betim = resumoBloqueado.filiais[0];

assert.equal(resumoBloqueado.indicadores.compra, 0);
assert.equal(resumoBloqueado.indicadores.em_analise, 1);
assert.equal(betim.compra, 0);
assert.equal(betim.sem_medida, 4);
assert.equal(betim.situacao, 'Em análise');
assert.equal(betim.medidas.length, 0);
assert.match(betim.inconsistencias[0].texto, /quantidade não confirmada/);
assert.equal(betim.proxima_acao, 'Completar a medida de 4 pneus montados.');

const repetida = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    estoque_novo: 0,
    necessidade_pneu_novo: 5,
    comprar_novo: 5,
    saldo_novo: -5,
  }),
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    estoque_novo: 0,
    necessidade_pneu_novo: 5,
    comprar_novo: 5,
    saldo_novo: -5,
  }),
], nomes);
const resumoRepetido = montarResumoCompra({
  decisoes: repetida,
  qualidade: [cadastro(1, 'Aparecida', 6, 0, repetida)],
  posicoes: [],
});
assert.equal(resumoRepetido.indicadores.compra, 0);
assert.equal(resumoRepetido.indicadores.transferencia, 0);
assert.match(resumoRepetido.filiais[0].inconsistencias.map((item) => item.texto).join(' '), /não somadas/);
assert.match(resumoRepetido.filiais[0].proxima_acao, /única linha/);

const semCadastro = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '295/80R22.5',
    estoque_novo: 0,
    necessidade_pneu_novo: 1,
    comprar_novo: 1,
    saldo_novo: -1,
  }),
], nomes);
const cardSemCadastro = montarResumoCompra({
  decisoes: semCadastro,
  qualidade: [],
  posicoes: [],
}).filiais[0];
assert.equal(cardSemCadastro.sem_medida, null);
assert.equal(cardSemCadastro.compra, 1);
assert.equal(cardSemCadastro.situacao, null);

const html = htmlPainelDecisoes(modeloCompra, 'todas');
assert.match(html, /Compra recomendada<\/p>\s*<strong>4<\/strong>\s*<em>pneus<\/em>/);
assert.match(html, /Transferência recomendada<\/p>\s*<strong>0<\/strong>\s*<em>pneus<\/em>/);
assert.match(html, /Em análise<\/p>\s*<strong>0<\/strong>\s*<em>filiais<\/em>/);
assert.match(html, /Compra confirmada<\/dt>\s*<dd>4/);
assert.match(html, /Necessidade preliminar<\/dt>\s*<dd>2<span class="ex-fatos-estimativa">estimativa<\/span>/);
assert.match(html, /Dianteira · Pneu novo · estimativa/);
assert.match(html, /Projeção 90 dias · estimativa/);
assert.doesNotMatch(html, /Compra confirmada<\/dt>\s*<dd>(?:9|7|5)</);
assert.match(html, /data-filtro="todas"/);
assert.match(html, /data-filtro="comprar"/);
assert.match(html, /data-filtro="transferir"/);
assert.match(html, /data-filtro="estimativa"/);
assert.match(html, /data-filtro="dados_insuficientes"/);
assert.match(html, /Ver análise detalhada/);
assert.match(html, /id="ex-analise-detalhada" class="ex-analise-corpo" hidden/);
assert.match(html, /Decisões a partir dos saldos já calculados/);
assert.match(html, /Necessidade preliminar por medida e posição/);
assert.match(html, /Dianteira permanece com pneu novo/);
assert.match(html, /295\/80R22\.5 · Tração · leitura não confirmada/);
assert.equal(html.includes('R$'), false);

const aberta = htmlPainelDecisoes(modeloCompra, 'todas', { analiseAberta: true });
assert.match(aberta, /aria-expanded="true"/);
assert.match(aberta, /class="ex-analise-corpo">/);
assert.equal(aberta.includes('class="ex-analise-corpo" hidden'), false);

const htmlMisto = htmlPainelDecisoes(modeloMisto, 'todas');
assert.match(htmlMisto, /<h3>Aparecida<\/h3>/);
assert.equal(htmlMisto.includes('<h3>Contagem</h3>'), false);
assert.match(htmlMisto, /Estoque suficiente/);
assert.match(htmlMisto, /Contagem/);

const htmlFiltro = htmlPainelDecisoes(modeloMisto, 'comprar');
const detalhe = htmlFiltro.split('id="ex-analise-detalhada"')[1];
assert.match(htmlFiltro, /Compra recomendada<\/p>\s*<strong>2<\/strong>/);
assert.match(detalhe, /Compra recomendada/);
assert.equal(detalhe.includes('Estoque suficiente'), false);
assert.match(htmlFiltro, /data-filtro="todas"/);
assert.match(htmlFiltro, new RegExp(`Todas <span>${misto.length}</span>`));

const htmlBloqueado = htmlPainelDecisoes(modeloBloqueado, 'todas');
assert.match(htmlBloqueado, /Em análise<\/p>\s*<strong>1<\/strong>/);
assert.equal(htmlBloqueado.includes('Compra confirmada'), false);
assert.match(htmlBloqueado, /Sem medida<\/dt>\s*<dd>4/);
assert.match(htmlBloqueado, /Completar a medida de 4 pneus montados/);

const htmlSemCadastro = htmlPainelDecisoes({ decisoes: semCadastro, qualidade: [], posicoes: [] });
assert.match(htmlSemCadastro, /Sem medida<\/dt>\s*<dd>—/);
assert.equal(htmlSemCadastro.includes('<dd>0'), false);

const compraEMedida = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    estoque_novo: 0,
    necessidade_pneu_novo: 2,
    comprar_novo: 2,
    saldo_novo: -2,
  }),
], nomes);
const cardCompraEMedida = montarResumoCompra({
  decisoes: compraEMedida,
  qualidade: [cadastro(1, 'Aparecida', 8, 1, compraEMedida)],
  posicoes: [],
}).filiais[0];
assert.equal(cardCompraEMedida.compra, 2);
assert.equal(cardCompraEMedida.sem_medida, 1);
assert.equal(cardCompraEMedida.situacao, 'Em análise');
assert.equal(cardCompraEMedida.proxima_acao, 'Comprar 2 pneus. Completar a medida de 1 pneu montado.');
assert.equal(cardCompraEMedida.compra + cardCompraEMedida.sem_medida === cardCompraEMedida.compra, false);

console.log('executivo-decisoes: ok');
