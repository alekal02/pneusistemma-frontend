/**
 * Atualização do Dashboard Presidente enquanto a tela está aberta.
 * O intervalo é moderado. A decisão de pintar fica fora do DOM para o teste.
 */
export const INTERVALO_ATUALIZACAO_PRESIDENTE_MS = 30_000;

const VOLATEIS = new Set(['gerado_em']);

export function assinaturaPainel(valor) {
  return JSON.stringify(valor, (chave, atual) => (VOLATEIS.has(chave) ? undefined : atual));
}

export function podeAtualizarPainel({
  visivel = false,
  oculto = false,
  editando = false,
  carregando = false,
  carregandoEvolucao = false,
} = {}) {
  return Boolean(visivel) && !oculto && !editando && !carregando && !carregandoEvolucao;
}

/**
 * disparoRelogio: o intervalo de 30s já espaçou a chamada.
 * Sem ele (volta da aba), só segue se o intervalo inteiro passou.
 */
export function deveIniciarAtualizacao({
  pode = false,
  emAndamento = false,
  desdeUltimaMs = 0,
  intervaloMs = INTERVALO_ATUALIZACAO_PRESIDENTE_MS,
  disparoRelogio = false,
} = {}) {
  if (!pode || emAndamento) return false;
  if (disparoRelogio) return true;
  return desdeUltimaMs >= intervaloMs;
}

export function respostaAindaVale(capturado, atual) {
  if (!capturado || !atual) return false;
  return capturado.seq === atual.seq
    && capturado.consulta === atual.consulta
    && capturado.painel === atual.painel
    && capturado.pagina === atual.pagina
    && capturado.foco === atual.foco
    && capturado.filialAberta === atual.filialAberta;
}

export function efeitoFalhaRede({ tinhaResumo = false } = {}) {
  if (tinhaResumo) {
    return {
      manterTela: true,
      aviso: 'Não foi possível atualizar agora. Os dados na tela continuam os últimos recebidos.',
    };
  }
  return { manterTela: false, aviso: '' };
}
