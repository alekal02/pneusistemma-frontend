/**
 * Paginação visual da frota ilustrada, desktop e celular.
 * Não abre navegador: mede quantos desenhos o lote pede para pintar.
 */
import assert from 'node:assert/strict';
import { svgMiniCaminhao } from '../src/truck-diagram.js';
import {
  criarCacheAbas,
  loteIds,
  ordenarIdsDesenho,
  tamanhoLoteDesenho,
  tamanhoPaginaLista,
} from '../src/frota-pagina.js';

const POSICOES = ['1E', '1D', '2EE', '2EI', '2DI', '2DE', '3EE', '3EI', '3DI', '3DE'];
const FROTA = 40;

assert.equal(tamanhoPaginaLista(390), 8);
assert.equal(tamanhoPaginaLista(1280), 16);
assert.equal(tamanhoLoteDesenho(390), 4);
assert.equal(tamanhoLoteDesenho(1280), 8);

const ids = Array.from({ length: FROTA }, (_, i) => i + 1);
const celular = loteIds(ids, 0, tamanhoLoteDesenho(390));
const desktop = loteIds(ids, 0, tamanhoLoteDesenho(1280));
assert.equal(celular.ids.length, 4);
assert.equal(desktop.ids.length, 8);
assert.equal(celular.temMais, true);
const segundo = loteIds(ids, celular.proximo, tamanhoLoteDesenho(390));
assert.deepEqual(segundo.ids, [5, 6, 7, 8]);

const grupos = {
  atrasado: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
  hoje: [{ id: 6 }],
  pendente: [{ id: 7 }],
  cadastro: [],
  medido: [{ id: 8 }, { id: 9 }, { id: 10 }],
};
const primeiraTela = ordenarIdsDesenho(grupos, { prioridade: 4, medidos: 0 });
assert.deepEqual(primeiraTela, [1, 2, 3, 4]);
assert.equal(primeiraTela.includes(8), false);
const comMedidos = ordenarIdsDesenho(grupos, { prioridade: 4, medidos: 2 });
assert.deepEqual(comMedidos, [1, 2, 3, 4, 8, 9]);

function desenhar(idLista) {
  return idLista.map((id) => svgMiniCaminhao({
    layoutId: 'truck_10',
    posicoes: POSICOES,
    pneus: [
      { id: id * 10, posicao: '1E', numero_fogo: `F${id}`, menor_sulco: 2, status_sulco: 'critico' },
      { id: id * 10 + 1, posicao: '1D', numero_fogo: `G${id}`, menor_sulco: 12, status_sulco: 'ok' },
    ],
  })).join('');
}

const antes = desenhar(ids);
const depois = desenhar(celular.ids);
const desenhosAntes = (antes.match(/<svg/g) || []).length;
const desenhosDepois = (depois.match(/<svg/g) || []).length;
const vazios = (depois.match(/slot-vazio/g) || []).length;
assert.equal(desenhosAntes, FROTA);
assert.equal(desenhosDepois, 4);
assert.equal(vazios, 8 * 4);
assert.equal(depois.includes('AAA'), false);

const cache = criarCacheAbas();
let cargas = 0;
function abrirAba(chave) {
  if (cache.pronta(chave)) return;
  cargas += 1;
  cache.marcar(chave);
}
abrirAba('veiculos');
abrirAba('veiculos');
assert.equal(cargas, 1);
cache.invalidar();
abrirAba('veiculos');
assert.equal(cargas, 2);

const relatorio = {
  frota: FROTA,
  celular: { pagina_lista: tamanhoPaginaLista(390), desenhos: desenhosDepois, posicoes_vazias: vazios },
  desktop: { pagina_lista: tamanhoPaginaLista(1280), desenhos: desktop.ids.length },
  antes: { desenhos: desenhosAntes, bytes_svg: Buffer.byteLength(antes) },
  depois: { desenhos: desenhosDepois, bytes_svg: Buffer.byteLength(depois) },
  troca_de_aba: { cargas_sem_invalidar: 1, cargas_depois_de_alteracao: 2 },
};
console.log(JSON.stringify(relatorio, null, 2));
console.log('test:frota-pagina ok');
