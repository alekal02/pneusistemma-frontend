/**
 * Painel executivo do presidente.
 * Só organiza o que GET /api/relatorios/saude-desgaste já devolve.
 * Não calcula preço, não cria estoque e não substitui o relatório.
 */

const ABAS = [
  { id: 'visao', label: 'Visão Geral' },
  { id: 'filiais', label: 'Filiais' },
  { id: 'qualidade', label: 'Qualidade' },
  { id: 'decisoes', label: 'Decisões de Compra' },
];

const DECISOES = [
  { id: 'comprar', label: 'Compra recomendada' },
  { id: 'transferir', label: 'Transferência recomendada' },
  { id: 'nao_comprar', label: 'Estoque suficiente' },
  { id: 'dados_insuficientes', label: 'Aguardando validação' },
  { id: 'estimativa', label: 'Estimativa' },
];

const ORDEM_DECISAO = {
  comprar: 0,
  transferir: 1,
  nao_comprar: 2,
  dados_insuficientes: 3,
  estimativa: 4,
};

let acoes = {
  aoSair() {},
  aoAtualizar() {},
  aoPdf() {},
};

let estado = {
  aba: 'visao',
  filialId: null,
  comparar: new Set(),
  filtro: 'todas',
  filtroQualidade: 'todas',
  analiseDetalhada: false,
  relatorio: null,
  modelo: null,
  erro: '',
  carregando: false,
};

function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function numero(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function inteiro(valor) {
  const n = numero(valor);
  if (n == null || !Number.isInteger(n)) return null;
  return n;
}

function idFilial(valor) {
  const n = numero(valor);
  return Number.isInteger(n) ? n : null;
}

function textoMedida(medida) {
  const t = String(medida || '').trim();
  return t || 'Sem medida';
}

function chaveMedida(medida) {
  const t = String(medida || '').trim().replace(/\s+/g, '').replace(/,/g, '.').toLowerCase();
  return t || null;
}

export function unidadeForaDoPainel(item) {
  const codigo = String(item?.codigo || item?.filial_codigo || '').trim().toUpperCase();
  const nome = String(item?.filial || item?.nome || item?.filial_nome || '').trim().toUpperCase();
  if (codigo === 'MATRIZ' || nome === 'MATRIZ') return true;
  if (codigo.startsWith('E2E') || nome.includes('E2E')) return true;
  return false;
}

function nomeDa(id, nomes, fallback) {
  return nomes.get(id) || fallback || `Unidade ${id}`;
}

function somarFaixa(unidades, ...chaves) {
  return unidades.reduce((total, unidade) => {
    const faixas = unidade.faixas || {};
    return total + chaves.reduce((s, chave) => s + (inteiro(faixas[chave]) || 0), 0);
  }, 0);
}

function rotuloPapel(papel) {
  if (papel === 'direcional') return 'Dianteira';
  if (papel === 'tracao') return 'Tração';
  if (!papel) return 'Posição não informada';
  return String(papel);
}

function classificarPosicao(pneu) {
  if (pneu.status_pneu !== 'montado') return null;
  const medida = chaveMedida(pneu.medida);
  const faixa = pneu.faixa;
  const dianteira = pneu.papel === 'direcional';
  if (!medida || faixa === 'sem_medicao' || faixa === 'sem_regua') {
    return { leitura: 'dados_insuficientes' };
  }
  if (dianteira && (faixa === 'critico' || faixa === 'programar_recapagem' || faixa === 'critico_equipamento')) {
    return { leitura: 'pneu_novo' };
  }
  if (faixa === 'critico_equipamento') return { leitura: 'pneu_novo' };
  if (faixa === 'programar_recapagem') {
    if (pneu.papel === 'tracao' && pneu.elegibilidade?.candidato_programacao === true) {
      return { leitura: 'recapagem' };
    }
    if (!pneu.papel) {
      return {
        leitura: 'dados_insuficientes',
        motivo: 'Posição não identificada. Sem confirmar que não é dianteira, recapagem não é recomendada.',
      };
    }
    const bloqueio = pneu.elegibilidade?.bloqueios?.find(Boolean) || pneu.elegibilidade?.motivo;
    return {
      leitura: 'dados_insuficientes',
      motivo: bloqueio
        ? `Recapagem não recomendada. ${bloqueio}`
        : 'Recapagem não recomendada: o relatório não marcou o pneu como candidato.',
    };
  }
  if (faixa === 'critico') return { leitura: 'avaliacao_urgente' };
  return null;
}

function motivoPosicao(leitura, papel, motivoPronto) {
  if (motivoPronto) return motivoPronto;
  if (leitura === 'pneu_novo' && papel === 'direcional') {
    return 'Dianteira em faixa crítica ou de programar recapagem. Entra como pneu novo. Recapado não se aplica a esta posição.';
  }
  if (leitura === 'pneu_novo') {
    return 'Equipamento em faixa crítica. Entra como pneu novo na conta já feita pelo relatório.';
  }
  if (leitura === 'recapagem') {
    return 'Tração na faixa de programar recapagem e marcada como candidata no relatório. É alternativa de recapagem, não compra de pneu novo e não usa estoque recapado como cobertura de dianteira.';
  }
  if (leitura === 'avaliacao_urgente') {
    return 'Crítico fora da dianteira: retirada e avaliação urgente. O relatório não converte isso em quantidade de compra nem em recapagem.';
  }
  return 'Sem medida ou sem medição de banda. A quantidade desta posição ainda não está confirmada.';
}

export function necessidadesPorPosicao(pneus = []) {
  const grupos = new Map();
  for (const pneu of pneus) {
    const classe = classificarPosicao(pneu);
    if (!classe) continue;
    const leitura = classe.leitura;
    const medida = chaveMedida(pneu.medida);
    const papel = pneu.papel || '';
    const chave = [pneu.filial_id, medida || 'sem-medida', papel || 'sem', leitura].join('|');
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        filial_id: pneu.filial_id,
        filial: pneu.filial || '',
        medida: medida ? String(pneu.medida || '').trim() : null,
        papel,
        posicao: rotuloPapel(papel),
        leitura,
        pneus: 0,
        posicoes: new Set(),
        situacao: pneu.faixa_label || pneu.faixa || '',
        motivoPronto: classe.motivo || '',
      });
    }
    const grupo = grupos.get(chave);
    grupo.pneus += 1;
    if (classe.motivo) grupo.motivoPronto = classe.motivo;
    if (pneu.posicao) grupo.posicoes.add(String(pneu.posicao));
    if (pneu.faixa === 'critico' || pneu.faixa === 'critico_equipamento') {
      grupo.situacao = pneu.faixa_label || 'Crítico';
    }
  }
  return [...grupos.values()]
    .map((grupo) => ({
      ...grupo,
      posicoes: [...grupo.posicoes].sort((a, b) => a.localeCompare(b, 'pt-BR')),
      motivo: motivoPosicao(grupo.leitura, grupo.papel, grupo.motivoPronto),
    }))
    .sort((a, b) => String(a.filial).localeCompare(String(b.filial), 'pt-BR')
      || String(a.medida || '').localeCompare(String(b.medida || ''), 'pt-BR')
      || String(a.posicao).localeCompare(String(b.posicao), 'pt-BR'));
}

function precisaPneuNovo(pneu) {
  if (pneu.status_pneu !== 'montado') return false;
  if (pneu.papel === 'direcional' && (pneu.faixa === 'critico' || pneu.faixa === 'programar_recapagem')) return true;
  if (pneu.faixa === 'critico_equipamento') return true;
  return false;
}

function motivoInsuficiente(linha, detalhe) {
  if (detalhe) return detalhe;
  if (linha.medida_informada !== true || !chaveMedida(linha.medida)) {
    return linha.observacao
      || 'Medida ausente. O relatório não fecha saldo e esta linha não vira quantidade de compra.';
  }
  const faltam = inteiro(linha.montados_sem_medida);
  if (faltam == null) {
    return 'O relatório não informa quantos pneus montados estão sem medida. A recomendação não é definitiva.';
  }
  if (faltam > 0 || linha.recomendacao_definitiva !== true) {
    return faltam > 0
      ? `${faltam} pneu(s) montado(s) nesta unidade estão sem medida. A recomendação não é definitiva e não aparece como compra.`
      : 'A recomendação desta unidade não está fechada no relatório. Nenhuma quantidade é apresentada como definitiva.';
  }
  return 'A recomendação desta unidade não está fechada no relatório. Nenhuma quantidade é apresentada como definitiva.';
}

function baseDecisao(linha, nomes, extra) {
  return {
    filial_id: linha.filial_id,
    filial: nomeDa(linha.filial_id, nomes, linha.filial),
    medida: chaveMedida(linha.medida) ? String(linha.medida).trim() : null,
    origem: null,
    ...extra,
  };
}

function contagemCoerente(linha) {
  const estoque = inteiro(linha.estoque_novo);
  const necessidade = inteiro(linha.necessidade_pneu_novo);
  const saldo = inteiro(linha.saldo_novo);
  const comprar = inteiro(linha.comprar_novo);
  const recapado = inteiro(linha.estoque_recapado);
  const emRecapagem = inteiro(linha.em_recapagem);
  if (estoque == null || necessidade == null || saldo == null || comprar == null) return null;
  if (estoque < 0 || necessidade < 0 || (recapado != null && recapado < 0) || (emRecapagem != null && emRecapagem < 0)) {
    return null;
  }
  if (saldo !== estoque - necessidade) return null;
  if (comprar !== Math.max(0, necessidade - estoque)) return null;
  return {
    estoque,
    necessidade,
    saldo,
    comprar,
    recapado: recapado || 0,
    emRecapagem: emRecapagem || 0,
  };
}

function confereListaPneus(linha, contagem, pneus) {
  if (!Array.isArray(pneus)) return true;
  const medida = chaveMedida(linha.medida);
  const filial = idFilial(linha.filial_id);
  const grupo = pneus.filter((pneu) => idFilial(pneu.filial_id) === filial && chaveMedida(pneu.medida) === medida);
  const estoqueNovo = grupo.filter((pneu) => pneu.status_pneu === 'estoque' && pneu.condicao === 'novo').length;
  const estoqueRecapado = grupo.filter((pneu) => pneu.status_pneu === 'estoque' && pneu.condicao !== 'novo').length;
  const emRecapagem = grupo.filter((pneu) => pneu.status_pneu === 'recapagem').length;
  const necessidade = grupo.filter((pneu) => precisaPneuNovo(pneu)).length;
  if (estoqueNovo !== contagem.estoque || necessidade !== contagem.necessidade) return false;
  if (inteiro(linha.estoque_recapado) != null && estoqueRecapado !== contagem.recapado) return false;
  if (inteiro(linha.em_recapagem) != null && emRecapagem !== contagem.emRecapagem) return false;
  return true;
}

function motivoNaoComprar(linha, cedido) {
  const partes = [
    `Decisão confirmada. Estoque novo ${linha.estoque} da medida ${linha.medida} na própria unidade cobre a necessidade ${linha.necessidade}.`,
  ];
  if (cedido > 0) {
    partes.push(`O excedente transferido é ${cedido}. Permanecem ${linha.estoque - cedido} pneu(s) novo(s), ainda suficientes para a necessidade local.`);
  }
  if (linha.recapado > 0) {
    partes.push(`${linha.recapado} recapado(s) em estoque não entram na cobertura e não servem para dianteira.`);
  }
  if (linha.emRecapagem > 0) {
    partes.push(`${linha.emRecapagem} pneu(s) em recapagem não são estoque disponível.`);
  }
  return partes.join(' ');
}

function motivoComprar(linha, quantidade, transferido) {
  return `Decisão confirmada. Necessidade ${linha.necessidade}, estoque novo na unidade ${linha.estoque}`
    + `, transferência recebida de saldo excedente ${transferido}.`
    + ` Ficam ${quantidade} pneu(s) novo(s) para comprar.`
    + ' Recapado não entra nesta conta e pneu em recapagem não foi somado ao estoque.';
}

function motivoTransferir(destino, fonte, quantidade, restanteOrigem) {
  return `Decisão confirmada. ${fonte.filial} tem estoque novo ${fonte.estoque} e necessidade ${fonte.necessidade}`
    + ` da medida ${destino.medida}. O excedente transferido nesta linha é ${quantidade}.`
    + ` Depois da saída a origem fica com ${restanteOrigem} pneu(s) novo(s), quantidade que ainda cobre a necessidade local.`
    + ` Destino ${destino.filial}: necessidade ${destino.necessidade}, estoque novo próprio ${destino.estoque}.`
    + ' Recapado e pneu em recapagem não compõem esse saldo.';
}

function previsoesDa(linha) {
  const novo = inteiro(linha.previsao_novo_90d);
  const recap = inteiro(linha.previsao_recap_90d);
  return {
    novo: novo != null && novo > 0 ? novo : 0,
    recap: recap != null && recap > 0 ? recap : 0,
  };
}

/**
 * Classifica o bloco compras_por_medida do relatório de saúde e desgaste.
 * Só confirma número inteiro que fecha estoque novo − necessidade na mesma filial e medida.
 * Recapado e recapagem pendente não viram saldo. Projeção de 90 dias fica como estimativa.
 */
export function classificarDecisoes(compras = [], nomes = new Map(), { pneus = null } = {}) {
  const decisoes = [];
  const definitivas = [];
  const repetidas = new Map();

  for (const linha of compras) {
    const filial = idFilial(linha.filial_id);
    const medida = chaveMedida(linha.medida);
    if (filial == null || !medida) continue;
    const chave = `${filial}|${medida}`;
    repetidas.set(chave, (repetidas.get(chave) || 0) + 1);
  }

  for (const linha of compras) {
    const filial = idFilial(linha.filial_id);
    const medida = chaveMedida(linha.medida);
    const chave = filial != null && medida ? `${filial}|${medida}` : '';
    if (chave && repetidas.get(chave) > 1) {
      decisoes.push(baseDecisao(linha, nomes, {
        tipo: 'dados_insuficientes',
        confirmada: false,
        quantidade: null,
        motivo: `A medida ${linha.medida} aparece mais de uma vez na filial. As quantidades não foram somadas nem viraram compra ou transferência.`,
      }));
      continue;
    }

    const contagem = contagemCoerente(linha);
    const fechada = linha.medida_informada === true
      && Boolean(medida)
      && linha.recomendacao_definitiva === true
      && inteiro(linha.montados_sem_medida) === 0
      && contagem
      && (filial != null)
      && confereListaPneus(linha, contagem, pneus);

    if (!fechada) {
      const pareceFechada = linha.medida_informada === true
        && Boolean(medida)
        && linha.recomendacao_definitiva === true
        && inteiro(linha.montados_sem_medida) === 0;
      const detalhe = !pareceFechada
        ? ''
        : (contagem
          ? 'A lista de pneus do relatório não confirma o estoque novo, a necessidade, o recapado ou a recapagem pendente nesta filial e medida. Nenhuma quantidade foi confirmada.'
          : 'O saldo de compra não confere com o estoque novo menos a necessidade desta filial e medida. Nenhuma quantidade foi confirmada.');
      decisoes.push(baseDecisao(linha, nomes, {
        tipo: 'dados_insuficientes',
        confirmada: false,
        quantidade: null,
        motivo: motivoInsuficiente(linha, detalhe),
      }));
      continue;
    }

    definitivas.push({
      ...linha,
      ...contagem,
      filial_id: filial,
      medida: String(linha.medida).trim(),
    });
  }

  const porMedida = new Map();
  for (const linha of definitivas) {
    const chave = chaveMedida(linha.medida);
    if (!porMedida.has(chave)) porMedida.set(chave, []);
    porMedida.get(chave).push(linha);
  }

  const cedido = new Map();
  const recebido = new Map();
  for (const grupo of porMedida.values()) {
    const fontes = grupo
      .filter((linha) => linha.saldo > 0)
      .map((linha) => ({ ...linha, restante: linha.saldo, filial: nomeDa(linha.filial_id, nomes, linha.filial) }))
      .sort((a, b) => b.restante - a.restante || a.filial_id - b.filial_id);
    const destinos = grupo
      .filter((linha) => linha.comprar > 0)
      .map((linha) => ({ ...linha, restante: linha.comprar, filial: nomeDa(linha.filial_id, nomes, linha.filial) }))
      .sort((a, b) => b.restante - a.restante || a.filial_id - b.filial_id);

    for (const destino of destinos) {
      for (const fonte of fontes) {
        if (fonte.filial_id === destino.filial_id) continue;
        if (fonte.restante <= 0 || destino.restante <= 0) continue;
        const quantidade = Math.min(fonte.restante, destino.restante);
        const restanteOrigem = fonte.estoque - (fonte.saldo - fonte.restante) - quantidade;
        if (quantidade <= 0 || restanteOrigem < fonte.necessidade) continue;
        fonte.restante -= quantidade;
        destino.restante -= quantidade;
        const chaveCedido = `${fonte.filial_id}|${chaveMedida(fonte.medida)}`;
        cedido.set(chaveCedido, (cedido.get(chaveCedido) || 0) + quantidade);
        const chaveRecebido = `${destino.filial_id}|${chaveMedida(destino.medida)}`;
        recebido.set(chaveRecebido, (recebido.get(chaveRecebido) || 0) + quantidade);
        decisoes.push(baseDecisao(destino, nomes, {
          tipo: 'transferir',
          confirmada: true,
          quantidade,
          origem: fonte.filial,
          origem_id: fonte.filial_id,
          motivo: motivoTransferir(destino, fonte, quantidade, restanteOrigem),
        }));
      }
      if (destino.restante > 0) {
        const chaveRecebido = `${destino.filial_id}|${chaveMedida(destino.medida)}`;
        decisoes.push(baseDecisao(destino, nomes, {
          tipo: 'comprar',
          confirmada: true,
          quantidade: destino.restante,
          motivo: motivoComprar(destino, destino.restante, recebido.get(chaveRecebido) || 0),
        }));
      }
    }
  }

  for (const linha of definitivas) {
    const chave = `${linha.filial_id}|${chaveMedida(linha.medida)}`;
    const saida = cedido.get(chave) || 0;
    if (linha.necessidade > 0 && linha.estoque - saida >= linha.necessidade && linha.comprar === 0) {
      decisoes.push(baseDecisao(linha, nomes, {
        tipo: 'nao_comprar',
        confirmada: true,
        quantidade: 0,
        motivo: motivoNaoComprar(linha, saida),
      }));
    }
    const previsao = previsoesDa(linha);
    if (previsao.novo > 0) {
      decisoes.push(baseDecisao(linha, nomes, {
        tipo: 'estimativa',
        confirmada: false,
        quantidade: previsao.novo,
        motivo: `Estimativa, não é decisão confirmada. O relatório projeta ${previsao.novo} pneu(s) novo(s) em até 90 dias na medida ${linha.medida}. Esse número não entra na compra nem na transferência.`,
      }));
    }
    if (previsao.recap > 0) {
      decisoes.push(baseDecisao(linha, nomes, {
        tipo: 'estimativa',
        confirmada: false,
        quantidade: previsao.recap,
        motivo: `Estimativa, não é decisão confirmada. O relatório projeta ${previsao.recap} recapagem(ns) em até 90 dias na medida ${linha.medida}, só para tração elegível. Não é estoque disponível nem compra.`,
      }));
    }
  }

  return decisoes.sort((a, b) => (ORDEM_DECISAO[a.tipo] ?? 9) - (ORDEM_DECISAO[b.tipo] ?? 9)
    || String(a.filial).localeCompare(String(b.filial), 'pt-BR')
    || String(a.medida || '').localeCompare(String(b.medida || ''), 'pt-BR'));
}

export function percentual(parte, total) {
  if (!Number.isInteger(parte) || !Number.isInteger(total) || total <= 0 || parte < 0 || parte > total) return null;
  return Math.round((parte * 1000) / total) / 10;
}

function textoOuNulo(valor) {
  const texto = String(valor ?? '').trim();
  return texto || null;
}

/**
 * Completude da medida sobre os pneus montados que o relatório já contou.
 * Sem montados, o percentual fica em branco. A compra fica em análise se falta medida
 * ou se alguma decisão da filial não tem quantidade confirmada.
 */
export function qualidadePorFilial(unidades = [], { decisoes = [] } = {}) {
  const lista = unidades.map((unidade) => {
    const montados = inteiro(unidade.pneus_montados) ?? 0;
    const semMedida = inteiro(unidade.sem_medida) ?? 0;
    const comMedida = semMedida <= montados ? montados - semMedida : null;
    const filialId = idFilial(unidade.filial_id);
    const insuficiente = decisoes.some((item) => item.filial_id === filialId && item.tipo === 'dados_insuficientes');
    return {
      filial_id: filialId,
      filial: unidade.filial || '',
      codigo: unidade.codigo || null,
      montados,
      sem_medida: semMedida,
      com_medida: comMedida,
      completude: comMedida == null ? null : percentual(comMedida, montados),
      incompletos: percentual(semMedida, montados),
      compra_bloqueada: semMedida > 0 || insuficiente,
    };
  });
  return lista.sort((a, b) => (b.incompletos ?? -1) - (a.incompletos ?? -1)
    || b.sem_medida - a.sem_medida
    || String(a.filial).localeCompare(String(b.filial), 'pt-BR'));
}

export function filtrarQualidade(lista = [], filtro = 'todas') {
  if (filtro === 'bloqueadas') return lista.filter((item) => item.compra_bloqueada);
  if (filtro === 'sem_medida') return lista.filter((item) => item.sem_medida > 0);
  if (filtro === 'completas') return lista.filter((item) => item.montados > 0 && item.sem_medida === 0);
  return lista;
}

function elegivelRegularizacao(item) {
  return Number.isInteger(item?.montados)
    && item.montados > 0
    && Number.isInteger(item?.sem_medida)
    && item.sem_medida > 0
    && item.sem_medida <= item.montados
    && typeof item.incompletos === 'number'
    && Number.isFinite(item.incompletos);
}

function pontosProblema(item) {
  return Math.round(item.incompletos * 10) * item.sem_medida;
}

function compararProblema(a, b) {
  return pontosProblema(b) - pontosProblema(a)
    || b.sem_medida - a.sem_medida
    || b.incompletos - a.incompletos
    || String(a.filial).localeCompare(String(b.filial), 'pt-BR')
    || (a.filial_id ?? 0) - (b.filial_id ?? 0);
}

function compararEsforco(a, b) {
  return a.sem_medida - b.sem_medida
    || a.incompletos - b.incompletos
    || String(a.filial).localeCompare(String(b.filial), 'pt-BR')
    || (a.filial_id ?? 0) - (b.filial_id ?? 0);
}

function textoCadastrosPendentes(qtd) {
  return qtd === 1 ? '1 cadastro pendente' : `${qtd} cadastros pendentes`;
}

function justificarMaiorProblema(escolhida, elegiveis) {
  const outras = elegiveis.filter((item) => item.filial_id !== escolhida.filial_id);
  if (!outras.length) return 'É a única filial com cadastro de medida pendente.';
  const maiorPercentual = outras.some((item) => item.incompletos > escolhida.incompletos);
  const maiorQuantidade = outras.some((item) => item.sem_medida > escolhida.sem_medida);
  if (!maiorPercentual && !maiorQuantidade) {
    return 'Reúne o maior percentual incompleto e a maior quantidade de pneus sem medida.';
  }
  if (maiorPercentual && !maiorQuantidade) {
    return 'Outra filial tem percentual incompleto maior; a quantidade absoluta de pneus sem medida torna este o maior problema cadastral.';
  }
  if (!maiorPercentual && maiorQuantidade) {
    return 'Outra filial tem mais pneus sem medida; o percentual incompleto torna este o maior problema cadastral.';
  }
  return 'Nem o percentual nem a quantidade são os maiores sozinhos; os dois juntos formam o maior problema cadastral.';
}

function justificarMenorEsforco(escolhida, elegiveis) {
  const outras = elegiveis.filter((item) => item.filial_id !== escolhida.filial_id);
  if (!outras.length) return 'É a única filial com cadastro de medida pendente.';
  const empate = outras.some((item) => item.sem_medida === escolhida.sem_medida);
  if (empate) {
    return 'A quantidade de pneus sem medida empata; o menor percentual incompleto define o menor esforço para completar as medidas.';
  }
  return 'É a menor quantidade de pneus sem medida. O percentual incompleto separa quantidades iguais.';
}

function montarPrioridade(item, motivo) {
  const resumo = `${textoCadastrosPendentes(item.sem_medida)} e ${formatarPercentual(item.incompletos)} dos pneus montados sem medida.`;
  return {
    filial_id: item.filial_id,
    filial: item.filial,
    codigo: item.codigo ?? null,
    montados: item.montados,
    cadastros_pendentes: item.sem_medida,
    incompletos: item.incompletos,
    motivo,
    justificativa: `${resumo} ${motivo}`,
  };
}

/**
 * Duas leituras sobre os indicadores de qualidade já calculados.
 * Só entra filial com pneu montado e medida faltando.
 * Maior problema: percentual incompleto × pneus sem medida.
 * Menor esforço: menos pneus sem medida; o percentual separa empates.
 */
export function prioridadesRegularizacao(lista = []) {
  const elegiveis = (Array.isArray(lista) ? lista : []).filter(elegivelRegularizacao);
  if (!elegiveis.length) return { maior_problema: null, menor_esforco: null };
  const problema = [...elegiveis].sort(compararProblema)[0];
  const esforco = [...elegiveis].sort(compararEsforco)[0];
  return {
    maior_problema: montarPrioridade(problema, justificarMaiorProblema(problema, elegiveis)),
    menor_esforco: montarPrioridade(esforco, justificarMenorEsforco(esforco, elegiveis)),
  };
}

export function pendenciasMedida(pneus, filialId) {
  if (!Array.isArray(pneus)) return null;
  const id = idFilial(filialId);
  return pneus
    .filter((pneu) => pneu?.status_pneu === 'montado' && idFilial(pneu.filial_id) === id && !chaveMedida(pneu.medida))
    .map((pneu) => ({
      veiculo: textoOuNulo(pneu.placa) || textoOuNulo(pneu.apelido),
      posicao: textoOuNulo(pneu.posicao),
      numero_fogo: textoOuNulo(pneu.numero_fogo),
    }))
    .sort((a, b) => String(a.veiculo || '').localeCompare(String(b.veiculo || ''), 'pt-BR')
      || String(a.posicao || '').localeCompare(String(b.posicao || ''), 'pt-BR')
      || String(a.numero_fogo || '').localeCompare(String(b.numero_fogo || ''), 'pt-BR'));
}

export function prepararPainel(relatorio) {
  const unidadesBrutas = relatorio?.por_unidade || [];
  const unidades = unidadesBrutas.filter((unidade) => !unidadeForaDoPainel(unidade));
  const ids = new Set(unidades.map((unidade) => unidade.filial_id));
  const nomes = new Map(unidades.map((unidade) => [unidade.filial_id, unidade.filial]));
  const pneusInformados = Array.isArray(relatorio?.pneus);
  const pneus = pneusInformados
    ? relatorio.pneus.filter((pneu) => ids.has(pneu.filial_id) && !unidadeForaDoPainel(pneu))
    : null;
  const compras = (relatorio?.compras_por_medida || []).filter((linha) => ids.has(linha.filial_id));
  const porFilial = (relatorio?.compras_por_filial || []).filter((linha) => ids.has(linha.filial_id));
  const veiculos = (relatorio?.por_veiculo || []).filter((veiculo) => ids.has(veiculo.filial_id));
  const semMedida = porFilial.reduce((total, linha) => total + (inteiro(linha.montados_sem_medida) || 0), 0);

  const indicadores = {
    filiais: unidades.length,
    veiculos: unidades.reduce((total, unidade) => total + (inteiro(unidade.veiculos) || 0), 0),
    pneus: unidades.reduce((total, unidade) => total + (inteiro(unidade.pneus_montados) || 0), 0),
    criticos: somarFaixa(unidades, 'critico', 'critico_equipamento'),
    monitoramento: somarFaixa(unidades, 'monitoramento_preventivo', 'monitoramento_equipamento'),
    recapagem: somarFaixa(unidades, 'programar_recapagem'),
    sem_medicao: somarFaixa(unidades, 'sem_medicao', 'sem_regua'),
    sem_medida: semMedida,
    compra_definitiva: semMedida === 0,
  };

  const ranking = unidades
    .map((unidade) => ({
      ...unidade,
      criticos: somarFaixa([unidade], 'critico', 'critico_equipamento'),
      monitoramento: somarFaixa([unidade], 'monitoramento_preventivo', 'monitoramento_equipamento'),
      recapagem: somarFaixa([unidade], 'programar_recapagem'),
      sem_medicao: somarFaixa([unidade], 'sem_medicao', 'sem_regua'),
      sem_medida: inteiro(porFilial.find((linha) => linha.filial_id === unidade.filial_id)?.montados_sem_medida) || 0,
    }))
    .sort((a, b) => b.criticos - a.criticos
      || b.sem_medicao - a.sem_medicao
      || String(a.filial).localeCompare(String(b.filial), 'pt-BR'));

  const excluidasBrutas = [
    ...(relatorio?.unidades_excluidas || []),
    ...unidadesBrutas.filter((unidade) => unidadeForaDoPainel(unidade)),
  ];
  const vistas = new Set();
  const excluidas = [];
  for (const unidade of excluidasBrutas) {
    const chave = String(unidade.filial_id ?? unidade.id ?? `${unidade.codigo || ''}|${unidade.nome || unidade.filial || ''}`);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    excluidas.push(unidade);
  }

  const decisoes = classificarDecisoes(compras, nomes, { pneus });
  const qualidade = qualidadePorFilial(ranking, { decisoes });

  return {
    gerado_em: relatorio?.gerado_em || null,
    indicadores,
    ranking,
    qualidade,
    veiculos,
    pneus,
    posicoes: necessidadesPorPosicao(pneus || []),
    decisoes,
    excluidas,
    limitacoes: (relatorio?.limitacoes || []).slice(0, 4),
  };
}

function formatarQuando(iso) {
  if (!iso) return '';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  return data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function kpi(rotulo, valor, tom, detalhe = '') {
  return `
    <article class="ex-kpi ${tom ? `ex-kpi-${tom}` : ''}">
      <p>${esc(rotulo)}</p>
      <strong>${esc(valor)}</strong>
      ${detalhe ? `<em>${esc(detalhe)}</em>` : ''}
    </article>`;
}

function tabelaFiliais(lista, { selecionar = false, comparar = false } = {}) {
  if (!lista.length) {
    return '<p class="ex-vazio">Nenhuma filial operacional neste relatório.</p>';
  }
  return `
    <div class="ex-tabela-wrap">
      <table class="ex-tabela">
        <caption class="ex-sr">Comparação das filiais operacionais</caption>
        <thead>
          <tr>
            ${comparar ? '<th scope="col"><span class="ex-sr">Comparar</span></th>' : ''}
            <th scope="col">Filial</th>
            <th scope="col">Críticos</th>
            <th scope="col">Monitoramento</th>
            <th scope="col">Recapagem</th>
            <th scope="col">Sem medição</th>
            <th scope="col">Sem medida</th>
            <th scope="col">Veículos</th>
          </tr>
        </thead>
        <tbody>
          ${lista.map((unidade) => `
            <tr class="${estado.filialId === unidade.filial_id ? 'is-ativa' : ''}" data-filial="${unidade.filial_id}">
              ${comparar ? `<td><input type="checkbox" data-comparar="${unidade.filial_id}" ${estado.comparar.has(unidade.filial_id) ? 'checked' : ''} aria-label="Comparar ${esc(unidade.filial)}"></td>` : ''}
              <td>
                ${selecionar
                  ? `<button type="button" class="ex-link" data-abrir-filial="${unidade.filial_id}">${esc(unidade.filial)}</button>`
                  : esc(unidade.filial)}
              </td>
              <td class="${unidade.criticos ? 'ex-num-risco' : ''}">${unidade.criticos}</td>
              <td>${unidade.monitoramento}</td>
              <td>${unidade.recapagem}</td>
              <td>${unidade.sem_medicao}</td>
              <td>${unidade.sem_medida}</td>
              <td>${inteiro(unidade.veiculos) || 0}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function grafico(ranking) {
  const topo = ranking.slice(0, 8);
  const maximo = Math.max(1, ...topo.map((unidade) => unidade.criticos));
  if (!topo.length) return '';
  return `
    <section class="ex-card">
      <header class="ex-card-head">
        <h3>Filiais com pneus críticos</h3>
        <p>Barras só para o risco. O restante fica na tabela.</p>
      </header>
      <div class="ex-barras">
        ${topo.map((unidade) => {
          const largura = Math.round((unidade.criticos / maximo) * 100);
          return `
            <div class="ex-barra-linha">
              <span>${esc(unidade.filial)}</span>
              <div class="ex-barra-trilho" role="img" aria-label="${unidade.criticos} pneus críticos em ${esc(unidade.filial)}">
                <i style="width:${largura}%"></i>
              </div>
              <strong>${unidade.criticos}</strong>
            </div>`;
        }).join('')}
      </div>
    </section>`;
}

function htmlVisao(modelo) {
  const ind = modelo.indicadores;
  const excluidas = modelo.excluidas
    .map((unidade) => unidade.nome || unidade.filial || unidade.codigo)
    .filter(Boolean);
  return `
    <div class="ex-kpis">
      ${kpi('Pneus críticos', ind.criticos, ind.criticos ? 'risco' : '')}
      ${kpi('Monitoramento', ind.monitoramento, ind.monitoramento ? 'atencao' : '')}
      ${kpi('Recapagem', ind.recapagem, '')}
      ${kpi('Sem medição', ind.sem_medicao, ind.sem_medicao ? 'neutro' : '', `${ind.sem_medida} sem medida`)}
    </div>
    <p class="ex-nota">
      ${ind.filiais} filiais operacionais · ${ind.veiculos} veículos · ${ind.pneus} pneus montados.
      Dados incompletos reúnem ${ind.sem_medicao} sem medição de banda e ${ind.sem_medida} sem medida informada.
      ${ind.compra_definitiva ? '' : 'Enquanto houver pneu sem medida, a compra não é definitiva.'}
    </p>
    ${excluidas.length ? `<p class="ex-nota">Fora deste painel: ${esc(excluidas.join(', '))}. O cadastro dessas unidades permanece no sistema.</p>` : '<p class="ex-nota">Matriz de teste e unidades E2E ficam fora dos indicadores.</p>'}
    ${grafico(modelo.ranking)}
    <section class="ex-card">
      <header class="ex-card-head">
        <h3>Onde agir primeiro</h3>
        <p>Toque na filial para abrir o detalhe.</p>
      </header>
      ${tabelaFiliais(modelo.ranking, { selecionar: true })}
    </section>`;
}

function htmlComparacao(modelo) {
  const escolhidas = modelo.ranking.filter((unidade) => estado.comparar.has(unidade.filial_id));
  if (escolhidas.length < 2) {
    return '<p class="ex-nota">Marque duas ou três filiais para comparar os mesmos indicadores lado a lado.</p>';
  }
  return `
    <section class="ex-card">
      <header class="ex-card-head">
        <h3>Comparação</h3>
        <p>${escolhidas.length} filiais no mesmo recorte.</p>
      </header>
      ${tabelaFiliais(escolhidas)}
    </section>`;
}

function htmlDetalheFilial(modelo) {
  const unidade = modelo.ranking.find((item) => item.filial_id === estado.filialId);
  if (!unidade) return '';
  const veiculos = modelo.veiculos
    .filter((veiculo) => veiculo.filial_id === unidade.filial_id)
    .slice(0, 12);
  const posicoes = modelo.posicoes.filter((linha) => linha.filial_id === unidade.filial_id);
  const decisoes = modelo.decisoes.filter((linha) => linha.filial_id === unidade.filial_id);
  return `
    <section class="ex-card ex-detalhe">
      <header class="ex-card-head">
        <div>
          <h3>${esc(unidade.filial)}</h3>
          <p>${unidade.criticos} críticos · ${unidade.monitoramento} em monitoramento · ${unidade.recapagem} para recapagem</p>
        </div>
        <button type="button" class="ex-btn ex-btn-quiet" data-fechar-filial>Fechar</button>
      </header>
      <div class="ex-kpis ex-kpis-compactas">
        ${kpi('Críticos', unidade.criticos, unidade.criticos ? 'risco' : '')}
        ${kpi('Monitoramento', unidade.monitoramento, unidade.monitoramento ? 'atencao' : '')}
        ${kpi('Recapagem', unidade.recapagem, '')}
        ${kpi('Sem medição', unidade.sem_medicao, '', `${unidade.sem_medida} sem medida`)}
      </div>
      <h4>Veículos em pior situação</h4>
      ${veiculos.length ? `
        <div class="ex-tabela-wrap">
          <table class="ex-tabela">
            <thead>
              <tr>
                <th scope="col">Veículo</th>
                <th scope="col">Tipo</th>
                <th scope="col">Pior situação</th>
                <th scope="col">Menor sulco</th>
              </tr>
            </thead>
            <tbody>
              ${veiculos.map((veiculo) => `
                <tr>
                  <td>${esc(veiculo.placa || veiculo.apelido || 'Sem placa')}</td>
                  <td>${esc(veiculo.tipo || '—')}</td>
                  <td>${esc(veiculo.pior_faixa_label || '—')}</td>
                  <td>${veiculo.menor_sulco == null ? '—' : esc(veiculo.menor_sulco)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="ex-vazio">Nenhum veículo montado nesta filial.</p>'}
      <h4>Necessidade por medida e posição</h4>
      ${tabelaPosicoes(posicoes)}
      <h4>Leitura de compra desta filial</h4>
      ${tabelaDecisoes(decisoes)}
    </section>`;
}

function htmlFiliais(modelo) {
  return `
    ${htmlComparacao(modelo)}
    <section class="ex-card">
      <header class="ex-card-head">
        <h3>Filiais operacionais</h3>
        <p>A ordem começa pelos críticos. A comparação usa no máximo três unidades.</p>
      </header>
      ${tabelaFiliais(modelo.ranking, { selecionar: true, comparar: true })}
    </section>
    ${htmlDetalheFilial(modelo)}`;
}

export function rotuloApresentacao(linha) {
  if (linha?.confirmada === true && linha.tipo === 'comprar') return 'Compra recomendada';
  if (linha?.confirmada === true && linha.tipo === 'transferir') return 'Transferência recomendada';
  if (linha?.confirmada === true && linha.tipo === 'nao_comprar') return 'Estoque suficiente';
  if (linha?.tipo === 'estimativa') return 'Estimativa';
  return 'Aguardando validação';
}

export function proximoPassoApresentacao(linha) {
  if (linha?.tipo === 'dados_insuficientes' && linha.confirmada !== true) {
    return proximoPassoAnalise(linha);
  }
  if (linha?.leitura === 'dados_insuficientes') return proximoPassoPosicao(linha.motivo);
  return null;
}

function proximoPassoAnalise(linha) {
  const texto = String(linha?.motivo || '');
  if (/mais de uma vez/i.test(texto)) {
    return 'Deixar uma única linha desta medida na filial para a leitura poder ser concluída.';
  }
  if (/não confirma/i.test(texto)) {
    return 'Conferir a lista de pneus desta medida com o estoque novo e a necessidade informados.';
  }
  if (/não confere/i.test(texto)) {
    return 'Rever o saldo de estoque novo e necessidade desta medida.';
  }
  if (!linha?.medida || /Medida ausente/i.test(texto)) return 'Informar a medida dos pneus desta linha.';
  if (/sem medida/i.test(texto)) return 'Completar a medida dos pneus montados desta filial.';
  return 'Validar o cadastro desta medida para concluir a leitura.';
}

function proximoPassoPosicao(motivo = '') {
  const texto = String(motivo);
  if (/Posição não identificada|não é dianteira/i.test(texto)) {
    return 'Confirmar a posição do pneu. A recapagem só entra se a tração estiver marcada como candidata.';
  }
  if (/não recomendada|candidato/i.test(texto)) {
    return 'Validar a elegibilidade no relatório antes de tratar esta posição como recapagem.';
  }
  return 'Informar a medida e a medição de banda para concluir a leitura desta posição.';
}

export function rotuloSituacaoCompra(item) {
  if ((item?.montados ?? 0) === 0 && (item?.sem_medida ?? 0) === 0) return 'Sem montados';
  if (item?.compra_bloqueada) return 'Em análise';
  return 'Sem pendência';
}

export function textoSituacaoCompra(item) {
  if ((item?.montados ?? 0) === 0 && (item?.sem_medida ?? 0) === 0) {
    return 'Sem pneus montados para leitura de compra.';
  }
  if (item?.compra_bloqueada && (item?.sem_medida ?? 0) > 0) {
    const n = item.sem_medida;
    const pendentes = n === 1 ? '1 pneu montado está sem medida' : `${n} pneus montados estão sem medida`;
    return `Compra em análise. Motivo: ${pendentes}. Próximo passo: completar essas medidas.`;
  }
  if (item?.compra_bloqueada) {
    return 'Compra em análise. Motivo: há leitura desta filial sem quantidade confirmada. Próximo passo: validar a medida e o saldo antes de concluir.';
  }
  return 'Sem pendência de análise de cadastro nesta filial.';
}

function somaConfirmada(decisoes, tipo) {
  return decisoes.reduce((total, linha) => {
    if (linha?.tipo !== tipo || linha.confirmada !== true) return total;
    const quantidade = inteiro(linha.quantidade);
    if (quantidade == null || quantidade < 0) return total;
    return total + quantidade;
  }, 0);
}

function textoPneus(quantidade) {
  return `${quantidade} ${quantidade === 1 ? 'pneu' : 'pneus'}`;
}

function textoInconsistencia(linha) {
  const medida = textoMedida(linha?.medida);
  const motivo = String(linha?.motivo || '');
  if (/mais de uma vez/i.test(motivo)) return `${medida} · medida repetida, quantidades não somadas`;
  if (/não confirma/i.test(motivo)) return `${medida} · a lista de pneus não confirma o saldo`;
  if (/não confere/i.test(motivo)) return `${medida} · o saldo não confere`;
  return `${medida} · quantidade não confirmada`;
}

function semMedidaInformada(item) {
  if (!item || !Object.hasOwn(item, 'sem_medida')) return null;
  return inteiro(item.sem_medida);
}

function compararCartoes(a, b) {
  const peso = (card) => {
    if (card.compra > 0) return 0;
    if (card.transferencia > 0) return 1;
    if (card.situacao === 'Em análise' || card.tem_inconsistencia || card.sem_medida > 0) return 2;
    if (card.necessidade_preliminar > 0 || card.tem_estimativa_decisao) return 3;
    return 4;
  };
  return peso(a) - peso(b)
    || b.compra - a.compra
    || b.transferencia - a.transferencia
    || (b.sem_medida ?? -1) - (a.sem_medida ?? -1)
    || String(a.filial).localeCompare(String(b.filial), 'pt-BR');
}

function proximaAcaoCompra(card) {
  const partes = [];
  if (card.compra > 0 && card.transferencia > 0) {
    partes.push(`Comprar ${textoPneus(card.compra)} e transferir ${textoPneus(card.transferencia)}.`);
  } else if (card.compra > 0) {
    partes.push(`Comprar ${textoPneus(card.compra)}.`);
  } else if (card.transferencia > 0) {
    const origem = card.origens.length === 1 ? ` de ${card.origens[0]}` : '';
    partes.push(`Transferir ${textoPneus(card.transferencia)}${origem}.`);
  }
  if (card.sem_medida > 0) {
    const n = card.sem_medida;
    partes.push(`Completar a medida de ${n} ${n === 1 ? 'pneu montado' : 'pneus montados'}.`);
  } else if (!partes.length && card.tem_inconsistencia) {
    partes.push(card.passo_inconsistencia || 'Validar o cadastro antes de concluir a compra.');
  } else if (!partes.length && card.inconsistencias.length) {
    partes.push(card.passo_inconsistencia || 'Validar a leitura antes de concluir a compra.');
  } else if (!partes.length && (card.necessidade_preliminar > 0 || card.projecoes.length)) {
    partes.push('Validar a estimativa antes de tratar como compra.');
  } else if (!partes.length && card.tem_cobertura) {
    partes.push('Nenhuma compra. O estoque cobre a necessidade.');
  }
  return partes.join(' ') || 'Sem ação de compra nesta filial.';
}

/**
 * Organiza decisões já classificadas para a leitura da presidência.
 * Não recalcula saldo, não soma estimativa em compra e não completa medida ausente.
 */
export function montarResumoCompra(modelo = {}) {
  const decisoes = Array.isArray(modelo.decisoes) ? modelo.decisoes : [];
  const posicoes = Array.isArray(modelo.posicoes) ? modelo.posicoes : [];
  const qualidade = Array.isArray(modelo.qualidade) ? modelo.qualidade : [];
  const indicadores = {
    compra: somaConfirmada(decisoes, 'comprar'),
    transferencia: somaConfirmada(decisoes, 'transferir'),
    em_analise: qualidade.filter((item) => rotuloSituacaoCompra(item) === 'Em análise').length,
  };

  const ids = new Set();
  for (const linha of decisoes) {
    if (linha?.filial_id != null) ids.add(linha.filial_id);
  }
  for (const linha of posicoes) {
    if (linha?.filial_id != null) ids.add(linha.filial_id);
  }
  for (const item of qualidade) {
    if (item?.filial_id == null) continue;
    const semMedida = semMedidaInformada(item);
    if ((semMedida != null && semMedida > 0) || rotuloSituacaoCompra(item) === 'Em análise') {
      ids.add(item.filial_id);
    }
  }

  const filiais = [...ids].map((filialId) => {
    const doGrupo = (lista) => lista.filter((linha) => linha?.filial_id === filialId);
    const linhas = doGrupo(decisoes);
    const grupos = doGrupo(posicoes);
    const cadastro = qualidade.find((item) => item?.filial_id === filialId) || null;
    const medidas = [];
    const projecoes = [];
    const inconsistencias = [];
    const origens = [];
    let passo = '';

    for (const linha of linhas) {
      if (linha.tipo === 'dados_insuficientes' || (linha.confirmada !== true && linha.tipo !== 'estimativa')) {
        inconsistencias.push({ texto: textoInconsistencia(linha) });
        if (!passo) passo = proximoPassoApresentacao(linha) || '';
        continue;
      }
      if (linha.tipo === 'estimativa') {
        const quantidade = inteiro(linha.quantidade);
        if (quantidade == null || quantidade <= 0 || !chaveMedida(linha.medida)) {
          inconsistencias.push({ texto: `${textoMedida(linha.medida)} · projeção sem quantidade confirmada` });
          continue;
        }
        projecoes.push({
          medida: String(linha.medida).trim(),
          quantidade,
          classe: 'Projeção 90 dias',
          origem: null,
          estimativa: true,
        });
        continue;
      }
      if ((linha.tipo === 'comprar' || linha.tipo === 'transferir') && linha.confirmada === true) {
        const quantidade = inteiro(linha.quantidade);
        if (quantidade == null || quantidade <= 0 || !chaveMedida(linha.medida)) {
          const medida = textoMedida(linha.medida);
          inconsistencias.push({
            texto: chaveMedida(linha.medida)
              ? `${medida} · quantidade não confirmada`
              : `${medida} · quantidade sem medida utilizável`,
          });
          continue;
        }
        if (linha.tipo === 'transferir' && linha.origem) origens.push(String(linha.origem));
        medidas.push({
          medida: String(linha.medida).trim(),
          quantidade,
          classe: linha.tipo === 'comprar' ? 'Compra' : 'Transferência',
          origem: linha.tipo === 'transferir' ? (linha.origem || null) : null,
          estimativa: false,
        });
      }
    }

    let preliminar = 0;
    for (const linha of grupos) {
      const quantidade = inteiro(linha.pneus);
      if (linha.leitura === 'dados_insuficientes' || !chaveMedida(linha.medida) || quantidade == null || quantidade <= 0) {
        if (linha.leitura === 'dados_insuficientes' && chaveMedida(linha.medida)) {
          inconsistencias.push({
            texto: `${textoMedida(linha.medida)} · ${linha.posicao || 'posição'} · leitura não confirmada`,
          });
          if (!passo) passo = proximoPassoApresentacao(linha) || '';
        }
        continue;
      }
      preliminar += quantidade;
      medidas.push({
        medida: String(linha.medida).trim(),
        quantidade,
        classe: `${linha.posicao || 'Posição'} · ${rotuloLeitura(linha.leitura)}`,
        origem: null,
        estimativa: true,
      });
    }

    const compra = somaConfirmada(linhas, 'comprar');
    const transferencia = somaConfirmada(linhas, 'transferir');
    const semMedida = semMedidaInformada(cadastro);
    const temInconsistencia = linhas.some((linha) => linha.tipo === 'dados_insuficientes');
    const temCobertura = linhas.some((linha) => linha.tipo === 'nao_comprar' && linha.confirmada === true);
    const temEstimativa = linhas.some((linha) => linha.tipo === 'estimativa');
    const situacao = cadastro
      ? rotuloSituacaoCompra(cadastro)
      : (temInconsistencia ? 'Em análise' : null);
    const card = {
      filial_id: filialId,
      filial: cadastro?.filial || linhas.find((linha) => linha.filial)?.filial || grupos.find((linha) => linha.filial)?.filial || `Unidade ${filialId}`,
      compra,
      transferencia,
      necessidade_preliminar: preliminar,
      sem_medida: semMedida,
      situacao,
      origens: [...new Set(origens)],
      medidas: [...medidas, ...projecoes],
      projecoes,
      inconsistencias,
      passo_inconsistencia: passo,
      tem_cobertura: temCobertura,
      tem_inconsistencia: temInconsistencia,
      tem_estimativa_decisao: temEstimativa,
    };
    const temAcao = compra > 0
      || transferencia > 0
      || preliminar > 0
      || (semMedida != null && semMedida > 0)
      || situacao === 'Em análise'
      || inconsistencias.length > 0
      || projecoes.length > 0
      || temEstimativa;
    card.somente_cobertura = temCobertura && !temAcao;
    card.proxima_acao = proximaAcaoCompra(card);
    return card;
  }).sort(compararCartoes);

  return { indicadores, filiais };
}

export function filtrarCartoesCompra(filiais = [], filtro = 'todas') {
  if (filtro === 'comprar') return filiais.filter((card) => card.compra > 0);
  if (filtro === 'transferir') return filiais.filter((card) => card.transferencia > 0);
  if (filtro === 'nao_comprar') return filiais.filter((card) => card.tem_cobertura);
  if (filtro === 'dados_insuficientes') return filiais.filter((card) => card.tem_inconsistencia);
  if (filtro === 'estimativa') return filiais.filter((card) => card.tem_estimativa_decisao);
  return filiais.filter((card) => !card.somente_cobertura);
}

function tabelaDecisoes(lista) {
  if (!lista.length) return '<p class="ex-vazio">Nenhuma linha nesta leitura.</p>';
  return `
    <div class="ex-tabela-wrap">
      <table class="ex-tabela">
        <caption class="ex-sr">Decisões a partir dos saldos já calculados</caption>
        <thead>
          <tr>
            <th scope="col">Unidade</th>
            <th scope="col">Decisão</th>
            <th scope="col">Medida</th>
            <th scope="col">Quantidade</th>
            <th scope="col">Origem</th>
            <th scope="col">Motivo</th>
          </tr>
        </thead>
        <tbody>
          ${lista.map((linha) => `
            <tr>
              <td>${esc(linha.filial)}</td>
              <td><span class="ex-selo ex-selo-${esc(linha.tipo)}">${esc(rotuloApresentacao(linha))}</span></td>
              <td>${esc(textoMedida(linha.medida))}</td>
              <td>${linha.quantidade == null ? '—' : esc(linha.quantidade)}</td>
              <td>${esc(linha.origem || '—')}</td>
              <td class="ex-motivo">${htmlMotivoDecisao(linha)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function rotuloLeitura(leitura) {
  if (leitura === 'pneu_novo') return 'Pneu novo';
  if (leitura === 'recapagem') return 'Recapagem';
  if (leitura === 'avaliacao_urgente') return 'Avaliação urgente';
  return 'Aguardando validação';
}

function htmlMotivoDecisao(linha) {
  const passo = proximoPassoApresentacao(linha);
  return `${esc(linha.motivo)}${passo ? `<span class="ex-passo">Próximo passo: ${esc(passo)}</span>` : ''}`;
}

function tabelaPosicoes(lista) {
  if (!lista.length) return '<p class="ex-vazio">Nenhuma necessidade preliminar por posição neste recorte.</p>';
  return `
    <div class="ex-tabela-wrap">
      <table class="ex-tabela">
        <caption class="ex-sr">Necessidade preliminar por medida e posição</caption>
        <thead>
          <tr>
            <th scope="col">Unidade</th>
            <th scope="col">Medida</th>
            <th scope="col">Posição</th>
            <th scope="col">Pneus</th>
            <th scope="col">Leitura</th>
            <th scope="col">Motivo</th>
          </tr>
        </thead>
        <tbody>
          ${lista.map((linha) => `
            <tr>
              <td>${esc(linha.filial)}</td>
              <td>${esc(textoMedida(linha.medida))}</td>
              <td>${esc(linha.posicao)}${linha.posicoes.length ? ` <span class="ex-codes">${esc(linha.posicoes.join(', '))}</span>` : ''}</td>
              <td>${linha.pneus}</td>
              <td>${esc(rotuloLeitura(linha.leitura))}<span class="ex-passo">Estimativa não confirmada.</span>${proximoPassoApresentacao(linha) ? `<span class="ex-passo">Próximo passo: ${esc(proximoPassoApresentacao(linha))}</span>` : ''}</td>
              <td class="ex-motivo">${esc(linha.motivo)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function htmlFatosCompra(card) {
  const fatos = [];
  if (card.compra > 0) fatos.push(['Compra confirmada', String(card.compra), '']);
  if (card.transferencia > 0) {
    const origem = card.origens.length === 1 ? `de ${card.origens[0]}` : (card.origens.length > 1 ? card.origens.join(', ') : '');
    fatos.push(['Transferência', String(card.transferencia), origem]);
  }
  if (card.necessidade_preliminar > 0) {
    fatos.push(['Necessidade preliminar', String(card.necessidade_preliminar), 'estimativa']);
  }
  fatos.push(['Sem medida', card.sem_medida == null ? '—' : String(card.sem_medida), '']);
  return `
    <dl class="ex-fatos">
      ${fatos.map(([rotulo, valor, nota]) => `
        <div>
          <dt>${esc(rotulo)}</dt>
          <dd>${esc(valor)}${nota ? `<span class="${nota === 'estimativa' ? 'ex-fatos-estimativa' : 'ex-fatos-nota'}">${esc(nota)}</span>` : ''}</dd>
        </div>`).join('')}
    </dl>`;
}

function htmlMedidasCompra(lista) {
  if (!lista.length) return '';
  return `
    <ul class="ex-medidas">
      ${lista.map((linha) => `
        <li>
          <span>${esc(linha.medida)}</span>
          <span>${esc(linha.classe)}${linha.origem ? ` · ${esc(linha.origem)}` : ''}${linha.estimativa ? ' · estimativa' : ''}</span>
          <strong>${esc(linha.quantidade)}</strong>
        </li>`).join('')}
    </ul>`;
}

function htmlCartaoCompra(card) {
  const tom = card.situacao === 'Em análise'
    ? 'ex-selo-estimativa'
    : (card.situacao === 'Sem pendência' ? 'ex-selo-nao_comprar' : 'ex-selo-dados_insuficientes');
  return `
    <article class="ex-filial-compra">
      <header>
        <h3>${esc(card.filial)}</h3>
        ${card.situacao ? `<span class="ex-selo ${tom}">${esc(card.situacao)}</span>` : ''}
      </header>
      ${htmlFatosCompra(card)}
      ${htmlMedidasCompra(card.medidas)}
      ${card.inconsistencias.length ? `
        <ul class="ex-alertas">
          ${card.inconsistencias.map((item) => `<li>${esc(item.texto)}</li>`).join('')}
        </ul>` : ''}
      <p class="ex-acao"><span>Próxima ação</span> ${esc(card.proxima_acao)}</p>
    </article>`;
}

export function htmlPainelDecisoes(modelo = {}, filtro = 'todas', { analiseAberta = false } = {}) {
  const decisoes = Array.isArray(modelo.decisoes) ? modelo.decisoes : [];
  const posicoes = Array.isArray(modelo.posicoes) ? modelo.posicoes : [];
  const limitacoes = Array.isArray(modelo.limitacoes) ? modelo.limitacoes : [];
  const contagem = Object.fromEntries(DECISOES.map((item) => [item.id, 0]));
  for (const linha of decisoes) contagem[linha.tipo] = (contagem[linha.tipo] || 0) + 1;
  const lista = filtro === 'todas' ? decisoes : decisoes.filter((linha) => linha.tipo === filtro);
  const resumo = montarResumoCompra(modelo);
  const cartoes = filtrarCartoesCompra(resumo.filiais, filtro);
  const { indicadores } = resumo;
  return `
    <div class="ex-kpis ex-kpis-tres">
      ${kpi('Compra recomendada', indicadores.compra, indicadores.compra ? 'risco' : '', 'pneus')}
      ${kpi('Transferência recomendada', indicadores.transferencia, '', 'pneus')}
      ${kpi('Em análise', indicadores.em_analise, indicadores.em_analise ? 'atencao' : '', 'filiais')}
    </div>
    <div class="ex-filtros" role="tablist" aria-label="Tipo de decisão">
      <button type="button" class="ex-chip ${filtro === 'todas' ? 'is-ativa' : ''}" data-filtro="todas">Todas <span>${decisoes.length}</span></button>
      ${DECISOES.map((item) => `
        <button type="button" class="ex-chip ${filtro === item.id ? 'is-ativa' : ''}" data-filtro="${item.id}">
          ${esc(item.label)} <span>${contagem[item.id] || 0}</span>
        </button>`).join('')}
    </div>
    <section class="ex-compra-filiais" aria-labelledby="ex-compra-filiais-titulo">
      <h3 id="ex-compra-filiais-titulo" class="ex-secao-titulo">Por filial</h3>
      ${cartoes.length
        ? `<div class="ex-filiais-compra">${cartoes.map(htmlCartaoCompra).join('')}</div>`
        : '<p class="ex-vazio">Nenhuma filial neste recorte.</p>'}
    </section>
    <section class="ex-analise">
      <button type="button" class="ex-analise-toggle" data-analise-detalhada aria-expanded="${analiseAberta ? 'true' : 'false'}" aria-controls="ex-analise-detalhada">
        Ver análise detalhada
      </button>
      <div id="ex-analise-detalhada" class="ex-analise-corpo"${analiseAberta ? '' : ' hidden'}>
        <p class="ex-nota">Compra recomendada, transferência recomendada e estoque suficiente são decisões confirmadas. Elas usam só estoque novo da mesma filial e da mesma medida, depois de reservar a necessidade da origem. Estimativa é a projeção de 90 dias, permanece não confirmada e não entra nessas quantidades. Aguardando validação mostra o motivo e o próximo passo, sem quantidade confirmada. Recapado e pneu em recapagem não são estoque disponível. Dianteira não usa recapado.</p>
        <section class="ex-card">
          <header class="ex-card-head">
            <h3>Decisões</h3>
            <p>Quantidade só aparece na decisão confirmada. Estimativa e aguardando validação continuam nesta lista.</p>
          </header>
          ${tabelaDecisoes(lista)}
        </section>
        <section class="ex-card">
          <header class="ex-card-head">
            <h3>Necessidades preliminares</h3>
            <p>Contagem por medida e posição. É estimativa não confirmada e não substitui compra recomendada, transferência recomendada nem estoque suficiente.</p>
          </header>
          ${tabelaPosicoes(posicoes)}
        </section>
        ${limitacoes.length ? `
          <section class="ex-card">
            <header class="ex-card-head"><h3>Limites desta leitura</h3></header>
            <ul class="ex-limites">
              ${limitacoes.map((item) => `<li>${esc(item)}</li>`).join('')}
            </ul>
          </section>` : ''}
      </div>
    </section>`;
}

function htmlDecisoes(modelo) {
  return htmlPainelDecisoes(modelo, estado.filtro, { analiseAberta: estado.analiseDetalhada });
}

function formatarPercentual(valor) {
  if (valor == null) return '—';
  const texto = Number.isInteger(valor) ? String(valor) : valor.toFixed(1).replace(/0$/, '').replace(/\.$/, '');
  return `${texto.replace('.', ',')}%`;
}

function seloCompra(item) {
  const rotulo = rotuloSituacaoCompra(item);
  const tom = item.compra_bloqueada && !(item.montados === 0 && item.sem_medida === 0)
    ? 'ex-selo-estimativa'
    : 'ex-selo-dados_insuficientes';
  return `<span class="ex-selo ${tom}">${esc(rotulo)}</span>`;
}

function htmlDetalheQualidade(modelo) {
  const unidade = modelo.qualidade.find((item) => item.filial_id === estado.filialId);
  if (!unidade) return '';
  const pendencias = pendenciasMedida(modelo.pneus, unidade.filial_id);
  const lista = Array.isArray(pendencias) ? pendencias : [];
  const diverge = Array.isArray(pendencias) && lista.length !== unidade.sem_medida;
  let aviso = '';
  if (!Array.isArray(pendencias)) {
    aviso = unidade.sem_medida > 0
      ? `O relatório informa ${unidade.sem_medida} pneu(s) montado(s) sem medida e não trouxe a lista individual.`
      : 'O relatório não trouxe a lista individual de pneus.';
  } else if (diverge) {
    aviso = `A conta da filial informa ${unidade.sem_medida} montado(s) sem medida. A lista do relatório traz ${lista.length}. A tabela mostra só esses registros.`;
  } else if (!lista.length) {
    aviso = 'Nenhum pneu montado sem medida nesta filial.';
  }
  return `
    <section class="ex-card ex-detalhe">
      <header class="ex-card-head">
        <div>
          <h3>${esc(unidade.filial)}</h3>
          <p>${unidade.montados} montados · ${unidade.sem_medida} sem medida · completude ${formatarPercentual(unidade.completude)} · ${esc(textoSituacaoCompra(unidade))}</p>
        </div>
        <button type="button" class="ex-btn ex-btn-quiet" data-fechar-filial>Fechar</button>
      </header>
      <h4>Pneus montados sem medida</h4>
      ${aviso ? `<p class="ex-nota">${esc(aviso)}</p>` : ''}
      ${lista.length ? `
        <div class="ex-tabela-wrap ex-pendencias">
          <table class="ex-tabela">
            <caption class="ex-sr">Pendências de medida informadas no relatório</caption>
            <thead>
              <tr>
                <th scope="col">Veículo</th>
                <th scope="col">Posição</th>
                <th scope="col">Número de fogo</th>
              </tr>
            </thead>
            <tbody>
              ${lista.map((pneu) => `
                <tr>
                  <td>${esc(pneu.veiculo || 'Sem identificação')}</td>
                  <td>${esc(pneu.posicao || '—')}</td>
                  <td>${esc(pneu.numero_fogo || '—')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
    </section>`;
}

function htmlPrioridadesRegularizacao(lista) {
  const prioridades = prioridadesRegularizacao(lista);
  const cards = [
    ['maior_problema', 'Maior problema cadastral'],
    ['menor_esforco', 'Menor esforço estimado'],
  ];
  const grade = cards.map(([chave, rotulo]) => {
    const item = prioridades[chave];
    if (!item) {
      return `
        <article class="ex-prioridade">
          <p class="ex-prioridade-rotulo">${rotulo}</p>
          <p class="ex-nota">Nenhuma filial com pneu montado sem medida.</p>
        </article>`;
    }
    const ativa = estado.filialId === item.filial_id ? ' is-ativa' : '';
    const nome = item.filial_id == null
      ? esc(item.filial)
      : `<button type="button" class="ex-link" data-abrir-filial="${item.filial_id}" aria-label="Abrir detalhe de ${esc(item.filial)}">${esc(item.filial)}</button>`;
    return `
      <article class="ex-prioridade${ativa}">
        <p class="ex-prioridade-rotulo">${rotulo}</p>
        ${nome}
        <strong>${esc(textoCadastrosPendentes(item.cadastros_pendentes))}</strong>
        <p class="ex-prioridade-meta">${formatarPercentual(item.incompletos)} dos montados sem medida</p>
        <p class="ex-nota">${esc(item.motivo)}</p>
      </article>`;
  }).join('');
  return `
    <section class="ex-prioridades" aria-labelledby="ex-prioridades-titulo">
      <header class="ex-prioridades-head">
        <h3 id="ex-prioridades-titulo">Prioridades de regularização</h3>
        <p>Entram filiais com pneu montado e medida faltando. O problema cadastral cruza o percentual incompleto com a quantidade de pneus sem medida. O esforço estimado segue a quantidade de cadastros pendentes; o percentual incompleto separa quantidades iguais. A tabela abaixo segue o filtro.</p>
      </header>
      <div class="ex-prioridades-grade">
        ${grade}
      </div>
    </section>`;
}

function htmlQualidade(modelo) {
  const base = modelo.qualidade || [];
  const lista = filtrarQualidade(base, estado.filtroQualidade);
  const contagem = {
    todas: base.length,
    bloqueadas: base.filter((item) => item.compra_bloqueada).length,
    sem_medida: base.filter((item) => item.sem_medida > 0).length,
    completas: base.filter((item) => item.montados > 0 && item.sem_medida === 0).length,
  };
  const filtros = [
    ['todas', 'Todas'],
    ['bloqueadas', 'Compra em análise'],
    ['sem_medida', 'Sem medida'],
    ['completas', 'Medidas completas'],
  ];
  return `
    <div class="ex-filtros" role="tablist" aria-label="Filtro de qualidade dos dados">
      ${filtros.map(([id, rotulo]) => `
        <button type="button" class="ex-chip ${estado.filtroQualidade === id ? 'is-ativa' : ''}" data-filtro-qualidade="${id}">
          ${rotulo} <span>${contagem[id]}</span>
        </button>`).join('')}
    </div>
    <p class="ex-nota">A completude é a parcela dos pneus montados com medida informada. A ordem começa por quem tem mais dados incompletos. A compra fica em análise quando a filial tem montado sem medida ou alguma decisão sem quantidade confirmada.</p>
    ${htmlPrioridadesRegularizacao(base)}
    <section class="ex-card">
      <header class="ex-card-head">
        <h3>Qualidade dos dados por filial</h3>
        <p>Toque na unidade para ver as pendências que o relatório lista.</p>
      </header>
      ${lista.length ? `
        <div class="ex-tabela-wrap">
          <table class="ex-tabela">
            <caption class="ex-sr">Completude das medidas e situação da análise de compra</caption>
            <thead>
              <tr>
                <th scope="col">Filial</th>
                <th scope="col">Montados</th>
                <th scope="col">Sem medida</th>
                <th scope="col">Completude</th>
                <th scope="col">Incompletos</th>
                <th scope="col">Compra</th>
              </tr>
            </thead>
            <tbody>
              ${lista.map((unidade) => `
                <tr class="${estado.filialId === unidade.filial_id ? 'is-ativa' : ''}" data-filial="${unidade.filial_id}">
                  <td><button type="button" class="ex-link" data-abrir-filial="${unidade.filial_id}">${esc(unidade.filial)}</button></td>
                  <td>${unidade.montados}</td>
                  <td>${unidade.sem_medida}</td>
                  <td>${formatarPercentual(unidade.completude)}</td>
                  <td>${formatarPercentual(unidade.incompletos)}</td>
                  <td>${seloCompra(unidade)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="ex-vazio">Nenhuma filial neste filtro.</p>'}
    </section>
    ${htmlDetalheQualidade(modelo)}`;
}

function htmlConteudo() {
  if (estado.carregando && !estado.modelo) {
    return '<p class="ex-estado">Carregando as filiais operacionais…</p>';
  }
  if (estado.erro && !estado.modelo) {
    return `<p class="ex-estado ex-estado-erro">${esc(estado.erro)}</p>`;
  }
  if (!estado.modelo) return '<p class="ex-estado">Nenhum relatório carregado.</p>';
  if (estado.aba === 'filiais') return htmlFiliais(estado.modelo);
  if (estado.aba === 'qualidade') return htmlQualidade(estado.modelo);
  if (estado.aba === 'decisoes') return htmlDecisoes(estado.modelo);
  return htmlVisao(estado.modelo);
}

function tituloAba() {
  if (estado.aba === 'filiais') return 'Filiais';
  if (estado.aba === 'qualidade') return 'Qualidade dos dados';
  if (estado.aba === 'decisoes') return 'Decisões de compra';
  return 'Visão geral';
}

function pintar() {
  const root = document.getElementById('exec-app');
  if (!root) return;
  root.querySelectorAll('[data-aba]').forEach((botao) => {
    const ativa = botao.dataset.aba === estado.aba;
    botao.classList.toggle('is-ativa', ativa);
    if (ativa) botao.setAttribute('aria-current', 'page');
    else botao.removeAttribute('aria-current');
  });
  const titulo = document.getElementById('exec-titulo');
  const quando = document.getElementById('exec-quando');
  if (titulo) titulo.textContent = tituloAba();
  if (quando) {
    const hora = formatarQuando(estado.modelo?.gerado_em);
    quando.textContent = hora ? `Atualizado em ${hora}` : '';
  }
  const conteudo = document.getElementById('exec-conteudo');
  if (conteudo) conteudo.innerHTML = htmlConteudo();
  const usuario = document.getElementById('exec-usuario');
  if (usuario && !usuario.textContent) usuario.textContent = 'Presidente';
}

function abrirFilial(id) {
  if (estado.aba !== 'qualidade') estado.aba = 'filiais';
  estado.filialId = id;
  pintar();
  document.getElementById('exec-conteudo')?.querySelector('.ex-detalhe')?.scrollIntoView({ block: 'nearest' });
}

function onClick(evento) {
  const aba = evento.target.closest('[data-aba]');
  if (aba) {
    estado.aba = aba.dataset.aba;
    pintar();
    return;
  }
  const filtroQualidade = evento.target.closest('[data-filtro-qualidade]');
  if (filtroQualidade) {
    estado.filtroQualidade = filtroQualidade.dataset.filtroQualidade;
    pintar();
    return;
  }
  const filtro = evento.target.closest('[data-filtro]');
  if (filtro) {
    estado.filtro = filtro.dataset.filtro;
    pintar();
    return;
  }
  if (evento.target.closest('[data-analise-detalhada]')) {
    estado.analiseDetalhada = !estado.analiseDetalhada;
    pintar();
    return;
  }
  const abrir = evento.target.closest('[data-abrir-filial]');
  if (abrir) {
    abrirFilial(Number(abrir.dataset.abrirFilial));
    return;
  }
  const linha = evento.target.closest('tr[data-filial]');
  if (linha && !evento.target.closest('input, button, a')) {
    abrirFilial(Number(linha.dataset.filial));
    return;
  }
  if (evento.target.closest('[data-fechar-filial]')) {
    estado.filialId = null;
    pintar();
    return;
  }
  if (evento.target.closest('[data-exec-atualizar]')) {
    acoes.aoAtualizar();
    return;
  }
  if (evento.target.closest('[data-exec-pdf]')) {
    acoes.aoPdf(estado.filialId);
    return;
  }
  if (evento.target.closest('[data-exec-sair]')) acoes.aoSair();
}

function onChange(evento) {
  const caixa = evento.target.closest('[data-comparar]');
  if (!caixa) return;
  const id = Number(caixa.dataset.comparar);
  if (caixa.checked) {
    if (estado.comparar.size >= 3) {
      caixa.checked = false;
      return;
    }
    estado.comparar.add(id);
  } else {
    estado.comparar.delete(id);
  }
  estado.aba = 'filiais';
  pintar();
}

export function iniciarExecutivo(novasAcoes = {}) {
  acoes = { ...acoes, ...novasAcoes };
  const root = document.getElementById('exec-app');
  if (!root || root.dataset.ligado === '1') return;
  root.dataset.ligado = '1';
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
}

export function exibirExecutivo({ relatorio = null, erro = '', carregando = false, usuario = '' } = {}) {
  estado.carregando = carregando;
  if (carregando) estado.erro = '';
  if (relatorio) {
    estado.relatorio = relatorio;
    estado.modelo = prepararPainel(relatorio);
    estado.erro = '';
    if (estado.filialId != null && !estado.modelo.ranking.some((item) => item.filial_id === estado.filialId)) {
      estado.filialId = null;
    }
    for (const id of [...estado.comparar]) {
      if (!estado.modelo.ranking.some((item) => item.filial_id === id)) estado.comparar.delete(id);
    }
  }
  if (erro) estado.erro = erro;
  if (!carregando && erro && !relatorio) estado.carregando = false;
  const nome = document.getElementById('exec-usuario');
  if (nome && usuario) nome.textContent = usuario;
  pintar();
}

export function abaExecutivaAtual() {
  return estado.aba;
}
