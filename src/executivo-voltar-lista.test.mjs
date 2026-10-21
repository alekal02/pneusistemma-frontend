import assert from 'node:assert/strict';

const ouvintes = [];
let ouvinteDireto = null;
const conteudo = {
  innerHTML: '',
  scrollIntoView() {},
  querySelector(sel) {
    if (sel === '[data-voltar-situacao]' && this.innerHTML.includes('data-voltar-situacao')) {
      return {
        addEventListener(_tipo, fn) { ouvinteDireto = fn; },
      };
    }
    if (sel === '.ex-filial-detalhe' && this.innerHTML.includes('ex-filial-detalhe')) {
      return { scrollIntoView() {} };
    }
    return null;
  },
};
const root = {
  dataset: {},
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener(tipo, fn) { ouvintes.push([tipo, fn]); },
};
globalThis.document = {
  getElementById(id) {
    if (id === 'exec-app') return root;
    if (id === 'exec-conteudo') return conteudo;
    if (id === 'exec-titulo' || id === 'exec-quando' || id === 'exec-usuario') return { textContent: '' };
    return null;
  },
};
globalThis.window = {
  scrollTo() {},
  matchMedia() { return { matches: false, addEventListener() {} }; },
};

const { iniciarExecutivo, exibirExecutivo } = await import('./executivo.js');
iniciarExecutivo();

const relatorio = {
  gerado_em: '2026-10-19T12:00:00.000Z',
  por_unidade: [
    {
      filial_id: 1,
      filial: 'Aparecida',
      codigo: 'APA',
      veiculos: 2,
      veiculos_cadastrados: 2,
      pneus_montados: 2,
      situacao_mes: 'no_ciclo',
      faixas: { acompanhamento_normal: 2 },
      parecer: { recomendacoes: { invalido: true } },
    },
    {
      filial_id: 2,
      filial: 'Contagem',
      codigo: 'CNT',
      veiculos: 1,
      veiculos_cadastrados: 1,
      pneus_montados: 1,
      situacao_mes: 'no_ciclo',
      faixas: { acompanhamento_normal: 1 },
    },
  ],
  pneus: [
    { filial_id: 1, status_pneu: 'montado', medida: '275/80R22.5', posicao: '1E', faixa: 'acompanhamento_normal', menor_sulco: 10 },
    { filial_id: 2, status_pneu: 'montado', medida: '275/80R22.5', posicao: '1D', faixa: 'acompanhamento_normal', menor_sulco: 9 },
  ],
  por_veiculo: [],
  compras_por_medida: [],
  compras_por_filial: [],
};

function disparar(attrs, targetExtra = {}) {
  const target = {
    closest(sel) {
      if (sel === '[data-abrir-filial]' && attrs.abrir != null) return { dataset: { abrirFilial: String(attrs.abrir) } };
      if (sel === '[data-voltar-situacao]' && attrs.voltar) return this;
      return null;
    },
    ...targetExtra,
  };
  for (const [nome, fn] of ouvintes) {
    if (nome === 'click') fn({ target, preventDefault() {} });
  }
}

exibirExecutivo({ relatorio });
assert.match(conteudo.innerHTML, /ex-filial-lista/);
assert.match(conteudo.innerHTML, /data-abrir-filial="1"/);
assert.match(conteudo.innerHTML, /data-abrir-filial="2"/);
assert.equal(conteudo.innerHTML.includes('Voltar às filiais'), false);

disparar({ abrir: 1 });
assert.match(conteudo.innerHTML, /Voltar às filiais/);
assert.match(conteudo.innerHTML, /ex-filial-detalhe/);
assert.equal(typeof ouvinteDireto, 'function');

ouvinteDireto({ preventDefault() {}, stopPropagation() {} });
assert.equal(conteudo.innerHTML.includes('Voltar às filiais'), false);
assert.equal(conteudo.innerHTML.includes('ex-filial-detalhe'), false);
assert.match(conteudo.innerHTML, /ex-filial-lista/);
assert.match(conteudo.innerHTML, /Aparecida/);
assert.match(conteudo.innerHTML, /Contagem/);

disparar({ abrir: 2 });
assert.match(conteudo.innerHTML, /ex-filial-detalhe/);
const botao = {
  closest(sel) { return sel === '[data-voltar-situacao]' ? this : null; },
};
disparar({}, { closest: undefined, parentElement: botao });
assert.match(conteudo.innerHTML, /ex-filial-lista/);
assert.match(conteudo.innerHTML, /data-abrir-filial="1"/);
assert.match(conteudo.innerHTML, /data-abrir-filial="2"/);
