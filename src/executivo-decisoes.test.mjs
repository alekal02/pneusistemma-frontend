import assert from 'node:assert/strict';
import {
  classificarDecisoes,
  compraProntaParaDecisao,
  filtrarCartoesCompra,
  htmlPainelDecisoes,
  montarFilaDecisao,
  montarResumoCompra,
  qualidadePorFilial,
  valorTotalConfiavel,
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

function trecho(html, inicio, fim) {
  const i = html.indexOf(inicio);
  assert.notEqual(i, -1, inicio);
  const j = fim ? html.indexOf(fim, i) : html.length;
  return html.slice(i, j === -1 ? html.length : j);
}

const html = htmlPainelDecisoes(modeloCompra, 'todas');
const aguardando = trecho(html, 'id="ex-aguardando-decisao"', 'id="ex-precisam-conferencia"');
const conferencia = trecho(html, 'id="ex-precisam-conferencia"', 'id="ex-analise-detalhada"');
assert.match(aguardando, /<strong>Comprar 4 pneus<\/strong>/);
assert.match(aguardando, /Medida 275\/80R22\.5/);
assert.match(aguardando, /1 pneu novo no estoque desta filial/);
assert.match(aguardando, /Nenhuma transferência confirmada/);
assert.match(aguardando, /Ainda não informado/);
assert.match(aguardando, /disabled aria-disabled="true"/);
assert.match(aguardando, /APROVAR COMPRA/);
assert.match(aguardando, /REPROVAR COMPRA/);
assert.match(aguardando, /SOLICITAR REVISÃO/);
assert.match(aguardando, /Indisponível nesta etapa/);
assert.doesNotMatch(aguardando, /<strong>Comprar (?:9|7|5) pneus<\/strong>/);
assert.equal(conferencia.includes('APROVAR COMPRA'), false);
assert.equal(conferencia.includes('REPROVAR COMPRA'), false);
assert.equal(conferencia.includes('SOLICITAR REVISÃO'), false);
assert.equal(conferencia.includes('Dianteira · Pneu novo · estimativa'), false);
assert.equal(aguardando.includes('Esta contagem ainda não está confirmada'), false);
assert.match(conferencia, /Projeção 90 dias · estimativa/);
assert.match(conferencia, /295\/80R22\.5 · Tração · leitura não confirmada/);
assert.match(conferencia, /A filial precisa:/);
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
assert.match(htmlFiltro, /<strong>Comprar 2 pneus<\/strong>/);
assert.match(detalhe, /Compra recomendada/);
assert.equal(detalhe.includes('Estoque suficiente'), false);
assert.match(htmlFiltro, /data-filtro="todas"/);
assert.match(htmlFiltro, new RegExp(`Todas <span>${misto.length}</span>`));

const htmlBloqueado = htmlPainelDecisoes(modeloBloqueado, 'todas');
assert.equal(htmlBloqueado.includes('APROVAR COMPRA'), false);
assert.equal(htmlBloqueado.includes('REPROVAR COMPRA'), false);
assert.equal(htmlBloqueado.includes('SOLICITAR REVISÃO'), false);
assert.equal(htmlBloqueado.includes('Compra confirmada'), false);
assert.match(htmlBloqueado, /Esta filial precisa completar o cadastro de 4 pneus antes de concluir a análise de compra/);
assert.match(htmlBloqueado, /Completar o cadastro desses pneus/);

const htmlSemCadastro = htmlPainelDecisoes({ decisoes: semCadastro, qualidade: [], posicoes: [] });
assert.match(htmlSemCadastro, /<strong>Comprar 1 pneu<\/strong>/);
assert.match(htmlSemCadastro, /disabled aria-disabled="true"/);
assert.match(htmlSemCadastro, /Ainda não informado/);
assert.equal(htmlSemCadastro.includes('<dd>0'), false);
assert.equal(htmlSemCadastro.includes('R$'), false);

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

const htmlCompraEMedida = htmlPainelDecisoes({
  decisoes: compraEMedida,
  qualidade: [cadastro(1, 'Aparecida', 8, 1, compraEMedida)],
  posicoes: [],
});
assert.equal(htmlCompraEMedida.includes('APROVAR COMPRA'), false);
assert.equal(htmlCompraEMedida.includes('REPROVAR COMPRA'), false);
assert.equal(htmlCompraEMedida.includes('SOLICITAR REVISÃO'), false);
assert.match(htmlCompraEMedida, /Esta filial precisa completar o cadastro de 1 pneu antes de concluir a análise de compra/);
assert.match(htmlCompraEMedida, /ainda não está pronta/);

assert.equal(compraProntaParaDecisao({ tipo: 'dados_insuficientes', confirmada: false, quantidade: 4, medida: '275/80R22.5', filial_id: 1 }), false);
assert.equal(compraProntaParaDecisao({ tipo: 'estimativa', confirmada: false, quantidade: 3, medida: '275/80R22.5', filial_id: 1 }), false);
assert.equal(compraProntaParaDecisao({ tipo: 'comprar', confirmada: false, quantidade: 4, medida: '275/80R22.5', filial_id: 1 }), false);
assert.equal(compraProntaParaDecisao({ tipo: 'transferir', confirmada: true, quantidade: 3, medida: '275/80R22.5', filial_id: 1 }), false);
assert.equal(compraProntaParaDecisao({ tipo: 'comprar', confirmada: true, quantidade: 4, medida: '275/80R22.5', filial_id: 1 }, new Set([1])), false);
assert.equal(compraProntaParaDecisao(compraComEstimativa.find((item) => item.tipo === 'comprar')), true);
assert.equal(valorTotalConfiavel({ custo: 800, quantidade: 4 }), null);
assert.equal(valorTotalConfiavel({ valor_total: 800 }), null);
assert.equal(valorTotalConfiavel({ preco_confiavel: false, valor_total: 800 }), null);
assert.equal(valorTotalConfiavel({ preco_confiavel: true, valor_total: 0 }), null);
assert.equal(valorTotalConfiavel({ preco_confiavel: true, valor_total: 1250.5 }), 1250.5);

const filaMista = montarFilaDecisao(modeloMisto, 'todas');
assert.equal(filaMista.aguardando.length, 1);
assert.equal(filaMista.aguardando[0].filial, 'Aparecida');
assert.equal(filaMista.aguardando[0].quantidade, 2);
assert.match(filaMista.aguardando[0].transferencia, /3 pneus de Contagem/);
assert.equal(filaMista.aguardando[0].valor_total, null);
assert.equal(filaMista.conferencia.some((item) => item.filial === 'Contagem'), false);
assert.equal(montarFilaDecisao(modeloBloqueado, 'todas').aguardando.length, 0);

const sabara = {
  decisoes: [],
  qualidade: [{
    filial_id: 4,
    filial: 'Sabará',
    montados: 1,
    sem_medida: 0,
    compra_bloqueada: false,
  }],
  posicoes: [{
    filial_id: 4,
    filial: 'Sabará',
    medida: null,
    posicao: 'Dianteira',
    leitura: 'dados_insuficientes',
    pneus: 1,
    posicoes: ['1E'],
    motivo: 'Sem medida ou sem medição de banda. A quantidade desta posição ainda não está confirmada.',
  }],
  pneus: [{
    filial_id: 4,
    filial: 'Sabará',
    status_pneu: 'montado',
    medida: null,
    posicao: '1E',
  }],
};
const filaSabara = montarFilaDecisao(sabara, 'todas');
const htmlSabara = htmlPainelDecisoes(sabara, 'todas');
assert.equal(filaSabara.aguardando.length, 0);
assert.equal(filaSabara.conferencia.length, 1);
assert.equal(filaSabara.conferencia[0].filial, 'Sabará');
assert.match(filaSabara.conferencia[0].pendencias[0].texto, /completar o cadastro de 1 pneu antes de concluir a análise de compra/);
assert.match(htmlSabara, /id="ex-precisam-conferencia"[\s\S]*Sabará/);
assert.match(htmlSabara, /ex-conferencia-cadastro/);
assert.equal(htmlSabara.includes('APROVAR COMPRA'), false);
assert.equal(trecho(htmlSabara, 'id="ex-precisam-conferencia"', 'id="ex-analise-detalhada"').includes('data-decisao-acao'), false);

const compraDuplicada = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    estoque_novo: 0,
    necessidade_pneu_novo: 2,
    comprar_novo: 2,
    saldo_novo: -2,
    previsao_novo_90d: 1,
  }),
], nomes);
const modeloDuplicado = {
  decisoes: compraDuplicada,
  qualidade: [cadastro(1, 'Aparecida', 4, 0, compraDuplicada)],
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
      medida: '275/80R22.5',
      posicao: 'Dianteira',
      leitura: 'pneu_novo',
      pneus: 2,
      posicoes: ['1E'],
      motivo: 'Dianteira em faixa crítica.',
    },
  ],
};
const htmlDuplicada = htmlPainelDecisoes(modeloDuplicado, 'todas');
const aguardandoDuplicada = trecho(htmlDuplicada, 'id="ex-aguardando-decisao"', 'id="ex-precisam-conferencia"');
const conferenciaDuplicada = trecho(htmlDuplicada, 'id="ex-precisam-conferencia"', 'id="ex-analise-detalhada"');
assert.match(aguardandoDuplicada, /<strong>Comprar 2 pneus<\/strong>/);
assert.equal(aguardandoDuplicada.includes('Esta contagem ainda não está confirmada'), false);
assert.equal(conferenciaDuplicada.includes('Dianteira · Pneu novo · estimativa'), false);
assert.match(conferenciaDuplicada, /Projeção 90 dias · estimativa/);
assert.equal(conferenciaDuplicada.includes('APROVAR COMPRA'), false);

const distintas = classificarDecisoes([
  linha({
    filial_id: 1,
    medida: '275/80R22.5',
    estoque_novo: 0,
    necessidade_pneu_novo: 2,
    comprar_novo: 2,
    saldo_novo: -2,
  }),
], nomes);
const modeloDistinto = {
  decisoes: distintas,
  qualidade: [
    cadastro(1, 'Aparecida', 6, 0, distintas),
    cadastro(2, 'Contagem', 4, 0, []),
  ],
  posicoes: [
    {
      filial_id: 1,
      filial: 'Aparecida',
      medida: '275/80R22.5',
      posicao: 'Dianteira',
      leitura: 'pneu_novo',
      pneus: 2,
      posicoes: ['1E'],
      motivo: 'Mesma compra já confirmada.',
    },
    {
      filial_id: 1,
      filial: 'Aparecida',
      medida: '275/80R22.5',
      posicao: 'Tração',
      leitura: 'recapagem',
      pneus: 1,
      posicoes: ['2D'],
      origem: 'Betim',
      motivo: 'Recapagem de outra origem.',
    },
    {
      filial_id: 1,
      filial: 'Aparecida',
      medida: '295/80R22.5',
      posicao: 'Dianteira',
      leitura: 'pneu_novo',
      pneus: 1,
      posicoes: ['1D'],
      motivo: 'Outra medida.',
    },
    {
      filial_id: 1,
      filial: 'Aparecida',
      medida: '295/80R22.5',
      posicao: 'Dianteira',
      leitura: 'pneu_novo',
      pneus: 1,
      posicoes: ['1D'],
      motivo: 'Outra medida repetida.',
    },
    {
      filial_id: 2,
      filial: 'Contagem',
      medida: '275/80R22.5',
      posicao: 'Dianteira',
      leitura: 'pneu_novo',
      pneus: 1,
      posicoes: ['1E'],
      motivo: 'Outra filial.',
    },
  ],
};
const filaDistinta = montarFilaDecisao(modeloDistinto, 'todas');
const conferenciaAparecida = filaDistinta.conferencia.find((item) => item.filial === 'Aparecida');
const conferenciaContagem = filaDistinta.conferencia.find((item) => item.filial === 'Contagem');
assert.equal(filaDistinta.aguardando[0].medida, '275/80R22.5');
assert.equal(conferenciaAparecida.pendencias.some((item) => item.identidade === 'pneu_novo' && item.medida === '275/80R22.5' && !item.origem), false);
assert.equal(conferenciaAparecida.pendencias.some((item) => item.identidade === 'recapagem' && item.origem === 'Betim'), true);
assert.equal(conferenciaAparecida.pendencias.some((item) => item.identidade === 'pneu_novo' && item.medida === '295/80R22.5'), true);
assert.equal(conferenciaContagem.pendencias.some((item) => item.identidade === 'pneu_novo' && item.medida === '275/80R22.5'), true);
assert.equal(conferenciaAparecida.pendencias.filter((item) => item.identidade === 'pneu_novo' && item.medida === '295/80R22.5').length, 1);
assert.equal(conferenciaAparecida.pendencias.filter((item) => item.identidade === 'recapagem').length, 1);

const vazia = {
  decisoes: [],
  qualidade: [{
    filial_id: 9,
    filial: 'Vazia',
    montados: 0,
    sem_medida: 0,
    compra_bloqueada: false,
  }],
  posicoes: [],
  pneus: [{ filial_id: 9, filial: 'Vazia', status_pneu: 'estoque', medida: null }],
};
const htmlVazia = htmlPainelDecisoes(vazia, 'todas');
assert.equal(montarFilaDecisao(vazia, 'todas').conferencia.some((item) => item.filial === 'Vazia'), false);
assert.equal(trecho(htmlVazia, 'id="ex-precisam-conferencia"', 'id="ex-analise-detalhada"').includes('Vazia'), false);
assert.match(htmlVazia, /id="ex-aguardando-decisao"/);
assert.match(htmlVazia, /id="ex-precisam-conferencia"/);
assert.equal(htmlVazia.includes('id="ex-historico-decisoes"'), false);
assert.match(htmlDuplicada, /disabled aria-disabled="true"/);
assert.match(htmlDuplicada, /data-filtro="comprar"/);
assert.match(htmlDuplicada, /data-filtro="estimativa"/);
assert.equal(trecho(htmlDuplicada, 'id="ex-precisam-conferencia"', 'id="ex-analise-detalhada"').includes('data-decisao-acao'), false);

console.log('executivo-decisoes: ok');
