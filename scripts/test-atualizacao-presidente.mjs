/**
 * Atualização moderada do Dashboard Presidente.
 * Não abre navegador e não chama a API.
 */
import assert from 'node:assert/strict';
import {
  INTERVALO_ATUALIZACAO_PRESIDENTE_MS,
  assinaturaPainel,
  deveIniciarAtualizacao,
  efeitoFalhaRede,
  podeAtualizarPainel,
  respostaAindaVale,
} from '../src/atualizacao-presidente.js';

assert.equal(INTERVALO_ATUALIZACAO_PRESIDENTE_MS, 30_000);

const aberto = { visivel: true, oculto: false, editando: false, carregando: false, carregandoEvolucao: false };
assert.equal(podeAtualizarPainel(aberto), true);
assert.equal(podeAtualizarPainel({ ...aberto, visivel: false }), false);
assert.equal(podeAtualizarPainel({ ...aberto, oculto: true }), false);
assert.equal(podeAtualizarPainel({ ...aberto, editando: true }), false);
assert.equal(podeAtualizarPainel({ ...aberto, carregando: true }), false);
assert.equal(podeAtualizarPainel({ ...aberto, carregandoEvolucao: true }), false);

assert.equal(deveIniciarAtualizacao({
  pode: true, emAndamento: true, disparoRelogio: true,
}), false);
assert.equal(deveIniciarAtualizacao({
  pode: true, emAndamento: false, disparoRelogio: true,
}), true);
assert.equal(deveIniciarAtualizacao({
  pode: true, desdeUltimaMs: 1000, intervaloMs: 30_000, disparoRelogio: false,
}), false);
assert.equal(deveIniciarAtualizacao({
  pode: true, desdeUltimaMs: 30_000, intervaloMs: 30_000, disparoRelogio: false,
}), true);

const base = {
  seq: 4,
  consulta: 'periodo=30',
  painel: 'visao',
  pagina: 1,
  foco: '',
  filialAberta: null,
};
assert.equal(respostaAindaVale(base, { ...base }), true);
assert.equal(respostaAindaVale(base, { ...base, seq: 5, consulta: 'filial_id=2&periodo=30' }), false);
assert.equal(respostaAindaVale(base, { ...base, painel: 'filiais' }), false);
assert.equal(respostaAindaVale(base, { ...base, pagina: 2 }), false);
assert.equal(respostaAindaVale(base, { ...base, foco: 'critico' }), false);
assert.equal(respostaAindaVale(base, { ...base, filialAberta: 2 }), false);

assert.equal(
  assinaturaPainel({ gerado_em: '2026-10-23T01:00:00.000Z', resumo: { cards: [{ id: 'criticos', valor: 2 }] } }),
  assinaturaPainel({ gerado_em: '2026-10-23T01:00:30.000Z', resumo: { cards: [{ id: 'criticos', valor: 2 }] } }),
);
assert.notEqual(
  assinaturaPainel({ resumo: { cards: [{ id: 'criticos', valor: 2 }] } }),
  assinaturaPainel({ resumo: { cards: [{ id: 'criticos', valor: 3 }] } }),
);

const falha = efeitoFalhaRede({ tinhaResumo: true });
assert.equal(falha.manterTela, true);
assert.match(falha.aviso, /continuam/);
assert.equal(efeitoFalhaRede({ tinhaResumo: false }).manterTela, false);

// Duas sessões: a segunda não dispara enquanto a primeira ainda busca.
const sessaoA = { pode: true, emAndamento: false, disparoRelogio: true };
const sessaoB = { pode: true, emAndamento: true, disparoRelogio: true };
assert.equal(deveIniciarAtualizacao(sessaoA), true);
assert.equal(deveIniciarAtualizacao(sessaoB), false);

// Aba oculta não busca. Ao voltar, só busca se os 30 segundos já passaram.
assert.equal(deveIniciarAtualizacao({
  pode: false, emAndamento: false, disparoRelogio: true,
}), false);
assert.equal(deveIniciarAtualizacao({
  pode: true, desdeUltimaMs: 5_000, intervaloMs: 30_000, disparoRelogio: false,
}), false);
assert.equal(deveIniciarAtualizacao({
  pode: true, desdeUltimaMs: 30_000, intervaloMs: 30_000, disparoRelogio: false,
}), true);

// Troca de página ou de filtro durante a busca descarta a resposta antiga.
const naPagina = { ...base, painel: 'pneus', pagina: 1, foco: 'montados' };
assert.equal(respostaAindaVale(naPagina, { ...naPagina, pagina: 3 }), false);
assert.equal(respostaAindaVale(base, { ...base, consulta: 'periodo=7' }), false);

// Falha de rede conserva a tela que já tinha dados.
assert.equal(efeitoFalhaRede({ tinhaResumo: true }).manterTela, true);

console.log('atualizacao presidente ok');
