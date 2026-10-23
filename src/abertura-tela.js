/**
 * Abertura da primeira tela depois que login ou /auth/me já validou a sessão.
 * Configurações, metadados e o resumo do Início não dependem entre si.
 * Os desenhos dependem dos ids do resumo e não seguram indicadores nem resumo.
 */

export function planoAbertura(papel) {
  if (papel === 'presidente') {
    return { tela: 'presidente', paralelas: [], depois: [] };
  }
  const paralelas = ['configuracoes', 'veiculos/meta'];
  if (papel === 'admin') {
    return { tela: 'relatorios', paralelas: [...paralelas, 'relatorios/diretoria'], depois: [] };
  }
  if (papel === 'gerente') {
    return { tela: 'filiais', paralelas: [...paralelas, 'filiais'], depois: [] };
  }
  return {
    tela: 'dashboard',
    paralelas: [...paralelas, 'dashboard/resumo'],
    depois: ['dashboard/desenhos'],
  };
}

export function filaUnica() {
  let atual = null;
  return (executar) => {
    if (atual) return atual;
    const promessa = Promise.resolve().then(executar).finally(() => {
      if (atual === promessa) atual = null;
    });
    atual = promessa;
    return promessa;
  };
}

export function filaPorChave() {
  const mapa = new Map();
  return (chave, executar) => {
    if (mapa.has(chave)) return mapa.get(chave);
    const promessa = Promise.resolve().then(() => executar()).finally(() => {
      if (mapa.get(chave) === promessa) mapa.delete(chave);
    });
    mapa.set(chave, promessa);
    return promessa;
  };
}

/**
 * Pinta indicadores e resumo antes de pedir os desenhos.
 * Erro nos desenhos não desfaz o que já foi para a tela.
 */
export async function pintarSemBloquearDesenhos({ pintar, desenhos }) {
  pintar();
  try {
    await desenhos();
    return { indicadores: true, resumo: true, desenhos: true };
  } catch (err) {
    return {
      indicadores: true,
      resumo: true,
      desenhos: false,
      erroDesenhos: err?.message || 'Falha ao carregar os desenhos.',
    };
  }
}
