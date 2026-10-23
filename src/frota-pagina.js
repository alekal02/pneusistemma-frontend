/** Tamanho da página e lote de desenhos. Celular desenha menos caminhões por vez. */

export function tamanhoPaginaLista(largura) {
  return Number(largura) <= 720 ? 8 : 16;
}

export function tamanhoLoteDesenho(largura) {
  return Number(largura) <= 720 ? 4 : 8;
}

export function criarCacheAbas() {
  let geracao = 0;
  const mapa = new Map();
  return {
    pronta(chave) {
      return mapa.get(chave) === geracao;
    },
    marcar(chave) {
      mapa.set(chave, geracao);
    },
    invalidar() {
      geracao += 1;
    },
  };
}

export function loteIds(ids, inicio, limite) {
  const lista = Array.isArray(ids) ? ids : [];
  const start = Math.max(0, Number(inicio) || 0);
  const n = Math.max(1, Number(limite) || 1);
  const fatia = lista.slice(start, start + n);
  return {
    ids: fatia,
    proximo: start + fatia.length,
    total: lista.length,
    temMais: start + fatia.length < lista.length,
  };
}

export function ordenarIdsDesenho(grupos, { prioridade = 0, medidos = 0 } = {}) {
  const base = ['atrasado', 'hoje', 'pendente', 'cadastro']
    .flatMap((chave) => (grupos?.[chave] || []).map((v) => Number(v.id)));
  const jaMedidos = (grupos?.medido || [])
    .map((v) => Number(v.id))
    .slice(0, Math.max(0, medidos));
  return [...base.slice(0, Math.max(0, prioridade)), ...jaMedidos];
}
