/** Memória curta da tela Filiais/Compras. Não é fonte de verdade: o selo vem do servidor. */

export const VALIDADE_NAVEGACAO_FILIAIS_MS = 20_000;
const MAX_ENTRADAS = 4;

export function criarMemoriaFiliais(relogio = () => Date.now()) {
  const entradas = new Map();
  return {
    ler(chave, agora = relogio()) {
      const hit = entradas.get(chave);
      if (!hit?.revisao) return null;
      if (agora - hit.em >= VALIDADE_NAVEGACAO_FILIAIS_MS) return null;
      return hit;
    },
    gravar(chave, valor, agora = relogio()) {
      if (!chave || !valor?.revisao) return;
      entradas.set(chave, { ...valor, em: agora });
      if (entradas.size <= MAX_ENTRADAS) return;
      const antigo = [...entradas.entries()].sort((a, b) => a[1].em - b[1].em)[0];
      if (antigo) entradas.delete(antigo[0]);
    },
    invalidar() {
      entradas.clear();
    },
  };
}

/**
 * rede: buscar de novo.
 * reusar: a tela já mostra este selo e ele continua valendo.
 * erro-rede: não pintar memória como se fosse atual.
 */
export function decidirCargaFiliais({
  salvo,
  revisaoAtual = null,
  redeOk = true,
  forcar = false,
  telaPronta = false,
  agora = Date.now(),
  validadeMs = VALIDADE_NAVEGACAO_FILIAIS_MS,
} = {}) {
  if (forcar || !telaPronta || !salvo?.revisao) return 'rede';
  if (!redeOk) return 'erro-rede';
  if (!revisaoAtual || revisaoAtual !== salvo.revisao) return 'rede';
  if (agora - salvo.em >= validadeMs) return 'rede';
  return 'reusar';
}

/** Os três corpos só entram na memória se nasceram do mesmo selo. */
export function seloComum(partes) {
  if (!Array.isArray(partes) || !partes.length) return null;
  if (partes.some((item) => item == null || item === '')) return null;
  const primeiro = partes[0];
  return partes.every((item) => item === primeiro) ? primeiro : null;
}

export function chaveMemoriaFiliais(usuario) {
  const u = usuario || {};
  return [u.id || '', u.papel || '', u.filial_id || '', u.login || ''].join(':');
}

const METODOS_GRAVACAO = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Gravação que muda indicador, frota ou pendência. Reset de senha fica de fora. */
export function gravacaoInvalidaFiliais(url, metodo = 'GET') {
  const verbo = String(metodo || 'GET').toUpperCase();
  if (!METODOS_GRAVACAO.has(verbo)) return false;
  const texto = String(url || '');
  if (/reset-senha/i.test(texto)) return false;
  return /\/(filiais|veiculos|pneus|medicoes|frota|dashboard)(\/|\?|$)/.test(texto);
}
