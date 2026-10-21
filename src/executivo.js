/**
 * Painel executivo do presidente.
 * Só organiza o que GET /api/relatorios/saude-desgaste já devolve.
 * Não calcula preço, não cria estoque e não grava decisão.
 */
import { normalizarMedida } from './medida.js';

function estadoInicialAprovacao() {
  return { suporte: false };
}

const ABAS = [
  { id: 'situacao', label: 'Situação' },
  { id: 'filial', label: 'Uma filial' },
  { id: 'comparar', label: 'Comparar' },
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
  aba: 'situacao',
  filialId: null,
  comparar: new Set(),
  filtro: 'todas',
  filtroQualidade: 'todas',
  analiseDetalhada: false,
  decisaoIndice: 0,
  relatorio: null,
  modelo: null,
  erro: '',
  carregando: false,
  aprovacao: estadoInicialAprovacao(),
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
  return normalizarMedida(medida);
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
 * Só existe valor quando a própria linha marca o preço como confiável.
 * Custo de pneu já cadastrado não vira preço de compra.
 */
export function valorTotalConfiavel(linha) {
  if (linha?.preco_confiavel !== true) return null;
  const total = numero(linha.valor_total);
  if (total == null || total <= 0) return null;
  return Math.round(total * 100) / 100;
}

function precoDaLinha(linha) {
  const total = valorTotalConfiavel(linha);
  if (total == null) return {};
  return { preco_confiavel: true, valor_total: total };
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
          estoque_confirmado: destino.estoque,
          necessidade_confirmada: destino.necessidade,
          ...precoDaLinha(destino),
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
          identidade: 'projecao-90-dias',
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
        origem: linha.origem || null,
        identidade: linha.leitura || 'preliminar',
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

function filiaisBloqueadasParaDecisao(modelo = {}) {
  const ids = new Set();
  for (const item of modelo.qualidade || []) {
    const filial = idFilial(item?.filial_id);
    if (filial == null) continue;
    const semMedida = inteiro(item.sem_medida);
    if (item.compra_bloqueada === true || (semMedida != null && semMedida > 0)) ids.add(filial);
  }
  return ids;
}

/**
 * Compra pronta é só a linha já confirmada, com quantidade e medida,
 * numa filial que não está em análise. Estimativa, transferência e
 * dado incompleto nunca entram aqui.
 */
export function compraProntaParaDecisao(linha, filiaisBloqueadas = new Set()) {
  if (!linha || linha.tipo !== 'comprar' || linha.confirmada !== true) return false;
  const quantidade = inteiro(linha.quantidade);
  if (quantidade == null || quantidade <= 0) return false;
  if (!chaveMedida(linha.medida)) return false;
  const filial = idFilial(linha.filial_id);
  if (filial != null && filiaisBloqueadas.has(filial)) return false;
  return true;
}

function textoPneusNovos(quantidade) {
  if (quantidade === 0) return 'nenhum pneu novo';
  if (quantidade === 1) return '1 pneu novo';
  return `${quantidade} pneus novos`;
}

function textoEstoqueConfirmado(estoque) {
  if (estoque === 0) return 'Nenhum pneu novo no estoque desta filial.';
  if (estoque === 1) return '1 pneu novo no estoque desta filial.';
  return `${estoque} pneus novos no estoque desta filial.`;
}

function transferenciasDaCompra(decisoes, linha) {
  const medida = chaveMedida(linha.medida);
  const filial = idFilial(linha.filial_id);
  return decisoes.filter((item) => item?.tipo === 'transferir'
    && item.confirmada === true
    && idFilial(item.filial_id) === filial
    && chaveMedida(item.medida) === medida
    && (inteiro(item.quantidade) || 0) > 0);
}

export function descreverCompraPronta(linha, transferencias = []) {
  const quantidade = inteiro(linha.quantidade);
  const medida = String(linha.medida).trim();
  const estoque = inteiro(linha.estoque_confirmado);
  const necessidade = inteiro(linha.necessidade_confirmada);
  const estoqueOk = estoque != null && estoque >= 0;
  const necessidadeOk = necessidade != null && necessidade >= 0;
  const motivo = estoqueOk && necessidadeOk && necessidade > estoque
    ? 'A filial precisa de mais pneus novos do que tem no próprio estoque.'
    : 'A necessidade desta medida já foi conferida.';
  const partesTransferencia = transferencias.map((item) => {
    const qtd = inteiro(item.quantidade);
    const origem = item.origem ? ` de ${item.origem}` : '';
    return `Dá para trazer ${textoPneus(qtd)}${origem}.`;
  });
  const transferencia = partesTransferencia.length
    ? partesTransferencia.join(' ')
    : 'Nenhuma transferência confirmada de outra filial.';
  const justificativa = [];
  if (necessidadeOk && estoqueOk) {
    justificativa.push(`A filial precisa de ${textoPneus(necessidade)} e tem ${textoPneusNovos(estoque)} no estoque.`);
  } else {
    justificativa.push('A quantidade para comprar está confirmada.');
  }
  justificativa.push(transferencia);
  justificativa.push(`A compra recomendada é de ${textoPneus(quantidade)}.`);
  return {
    filial_id: linha.filial_id,
    filial: linha.filial,
    medida,
    quantidade,
    motivo,
    estoque_texto: estoqueOk ? textoEstoqueConfirmado(estoque) : 'Estoque ainda não confirmado.',
    transferencia,
    valor_total: valorTotalConfiavel(linha),
    recomendacao: `Comprar ${textoPneus(quantidade)}.`,
    justificativa: justificativa.join(' '),
  };
}

function textoCadastroIncompleto(quantidade) {
  const nome = quantidade === 1 ? '1 pneu' : `${quantidade} pneus`;
  return `Esta filial precisa completar o cadastro de ${nome} antes de concluir a análise de compra.`;
}

function pendenciaCadastro(quantidade) {
  return {
    cadastro: true,
    identidade: 'cadastro-incompleto',
    texto: textoCadastroIncompleto(quantidade),
    passo: quantidade === 1 ? 'Completar o cadastro desse pneu.' : 'Completar o cadastro desses pneus.',
  };
}

function origemNecessidade(origem) {
  return String(origem || '').trim().toLowerCase();
}

function identidadeNecessidade(linha) {
  if (linha?.identidade) return String(linha.identidade);
  if (linha?.classe === 'Projeção 90 dias') return 'projecao-90-dias';
  const classe = String(linha?.classe || '');
  if (/pneu novo/i.test(classe)) return 'pneu_novo';
  if (/recapagem/i.test(classe)) return 'recapagem';
  if (/avaliação urgente/i.test(classe)) return 'avaliacao_urgente';
  return classe ? `preliminar:${classe}` : 'preliminar';
}

/**
 * A compra confirmada e a estimativa são a mesma necessidade só quando
 * filial, medida, origem e identidade coincidem.
 */
function chaveNecessidade(filialId, linha, identidade) {
  return [
    idFilial(filialId) ?? '',
    chaveMedida(linha?.medida) || '',
    origemNecessidade(linha?.origem),
    identidade,
  ].join('|');
}

function chavesCompraConfirmada(aguardando = []) {
  const chaves = new Set();
  for (const item of aguardando) {
    chaves.add(chaveNecessidade(item?.filial_id, { medida: item?.medida, origem: null }, 'pneu_novo'));
  }
  return chaves;
}

function contarMontadosSemLinha(modelo, filialId) {
  if (Array.isArray(modelo?.pneus)) {
    let montados = 0;
    let semMedida = 0;
    for (const pneu of modelo.pneus) {
      if (idFilial(pneu?.filial_id) !== filialId || pneu?.status_pneu !== 'montado') continue;
      montados += 1;
      if (!chaveMedida(pneu.medida)) semMedida += 1;
    }
    if (montados > 0) return semMedida;
  }
  let pelasPosicoes = 0;
  for (const linha of modelo?.posicoes || []) {
    if (idFilial(linha?.filial_id) !== filialId || chaveMedida(linha?.medida)) continue;
    const quantidade = inteiro(linha?.pneus);
    if (quantidade != null && quantidade > 0) pelasPosicoes += quantidade;
  }
  return pelasPosicoes;
}

/**
 * Pneus montados sem medida entram na conferência mesmo sem linha de compra.
 * Onde já existe decisão e o cadastro informa zero, a conta do relatório prevalece.
 */
function faltamMedidaNaConferencia(modelo, filialId) {
  const cadastro = (modelo?.qualidade || []).find((item) => idFilial(item?.filial_id) === filialId) || null;
  const informado = cadastro ? semMedidaInformada(cadastro) : null;
  const montados = inteiro(cadastro?.montados) ?? inteiro(cadastro?.pneus_montados);
  if (montados === 0) return 0;
  if (informado != null && informado > 0) return informado;
  const temLinha = (modelo?.decisoes || []).some((linha) => idFilial(linha?.filial_id) === filialId);
  if (temLinha && informado === 0) return 0;
  return contarMontadosSemLinha(modelo, filialId);
}

function nomeFilialConferencia(modelo, filialId, preferido) {
  if (preferido) return preferido;
  const fontes = [
    ...(modelo?.qualidade || []),
    ...(modelo?.posicoes || []),
    ...(modelo?.pneus || []),
    ...(modelo?.decisoes || []),
  ];
  const achada = fontes.find((item) => idFilial(item?.filial_id) === filialId && item?.filial);
  return achada?.filial || `Unidade ${filialId}`;
}

function pendenciasConferencia(card, filtro, bloqueada, { faltamMedida = 0, confirmadas = new Set() } = {}) {
  const todas = filtro === 'todas';
  const lista = [];
  const vistas = new Set();
  if (todas || filtro === 'dados_insuficientes') {
    for (const item of card.inconsistencias || []) {
      lista.push({
        texto: item.texto,
        passo: card.passo_inconsistencia || 'Corrigir este ponto antes de qualquer decisão.',
      });
    }
    const faltam = inteiro(faltamMedida) || 0;
    if (faltam > 0) lista.push(pendenciaCadastro(faltam));
  }
  if (todas || filtro === 'estimativa') {
    const estimativas = [...(card.projecoes || []), ...(card.medidas || [])];
    for (const linha of estimativas) {
      if (!linha?.estimativa || linha.confirmada === true) continue;
      const identidade = identidadeNecessidade(linha);
      const chave = chaveNecessidade(card.filial_id, linha, identidade);
      const apresentacao = `${chave}|${linha.classe || ''}|${linha.quantidade}`;
      if (vistas.has(apresentacao)) continue;
      vistas.add(apresentacao);
      if (identidade === 'pneu_novo' && confirmadas.has(chave)) continue;
      const nome = linha.quantidade === 1 ? 'pneu' : 'pneus';
      const detalhe = linha.classe === 'Projeção 90 dias' ? 'Projeção 90 dias' : linha.classe;
      lista.push({
        identidade,
        medida: linha.medida,
        origem: linha.origem || null,
        texto: `${linha.quantidade} ${nome} · ${linha.medida} · ${detalhe} · estimativa`,
        passo: identidade === 'projecao-90-dias'
          ? 'Isto é uma previsão. Não é compra e não entra na decisão.'
          : 'Esta contagem ainda não está confirmada. Não é compra.',
      });
    }
  }
  if ((todas || filtro === 'comprar') && card.compra > 0 && bloqueada) {
    lista.push({
      texto: `Há uma indicação de comprar ${textoPneus(card.compra)}, mas a filial ainda não está pronta.`,
      passo: card.passo_inconsistencia
        || ((inteiro(faltamMedida) || 0) > 0
          ? pendenciaCadastro(faltamMedida).passo
          : 'Validar a medida e o cadastro antes de qualquer decisão.'),
    });
  }
  if (filtro === 'transferir' && card.transferencia > 0) {
    const origem = card.origens?.length ? ` de ${card.origens.join(' e ')}` : '';
    lista.push({
      texto: `Transferência recomendada: ${textoPneus(card.transferencia)}${origem}.`,
      passo: 'Isto não é uma compra para decidir.',
    });
  }
  if (filtro === 'nao_comprar' && card.tem_cobertura) {
    lista.push({
      texto: 'O estoque desta filial cobre a necessidade.',
      passo: 'Não há compra para decidir.',
    });
  }
  return lista;
}

/**
 * Separa o que já pode ser lido pelo presidente do que a filial ainda precisa corrigir.
 * Não recalcula saldo e não cria preço.
 */
export function montarFilaDecisao(modelo = {}, filtro = 'todas') {
  const decisoes = Array.isArray(modelo.decisoes) ? modelo.decisoes : [];
  const bloqueadas = filiaisBloqueadasParaDecisao(modelo);
  const resumo = montarResumoCompra(modelo);
  const aguardando = (filtro === 'todas' || filtro === 'comprar')
    ? decisoes
      .filter((linha) => compraProntaParaDecisao(linha, bloqueadas))
      .map((linha) => descreverCompraPronta(linha, transferenciasDaCompra(decisoes, linha)))
    : [];
  const confirmadas = chavesCompraConfirmada(aguardando);
  const conferencia = [];
  const vistas = new Set();
  const mostraCadastro = filtro === 'todas' || filtro === 'dados_insuficientes';
  for (const card of filtrarCartoesCompra(resumo.filiais, filtro)) {
    const filialId = idFilial(card.filial_id);
    vistas.add(filialId);
    const pendencias = pendenciasConferencia(card, filtro, bloqueadas.has(filialId), {
      faltamMedida: faltamMedidaNaConferencia(modelo, filialId),
      confirmadas,
    });
    if (!pendencias.length) continue;
    conferencia.push({
      filial_id: card.filial_id,
      filial: card.filial,
      pendencias,
    });
  }
  if (mostraCadastro) {
    const candidatas = new Map();
    for (const item of [...(modelo.qualidade || []), ...(modelo.posicoes || []), ...(modelo.pneus || [])]) {
      const filialId = idFilial(item?.filial_id);
      if (filialId == null || vistas.has(filialId) || candidatas.has(filialId)) continue;
      candidatas.set(filialId, item.filial || '');
    }
    for (const [filialId, nome] of candidatas) {
      const faltam = faltamMedidaNaConferencia(modelo, filialId);
      if (faltam <= 0) continue;
      conferencia.push({
        filial_id: filialId,
        filial: nomeFilialConferencia(modelo, filialId, nome),
        pendencias: [pendenciaCadastro(faltam)],
      });
    }
  }
  return { aguardando, conferencia };
}

const ROTULOS_ACAO_COMPRA = ['APROVAR COMPRA', 'REPROVAR COMPRA', 'SOLICITAR REVISÃO'];

function htmlAcoesDecisaoCompra() {
  return `
    <div class="ex-decisao-lado">
      <div class="ex-decisao-acoes" role="group" aria-label="Ações da compra, ainda sem gravação">
        ${ROTULOS_ACAO_COMPRA.map((rotulo) => `
          <button type="button" class="ex-decisao-btn" data-decisao-indisponivel disabled aria-disabled="true">
            <span class="ex-decisao-btn-rotulo">${rotulo}</span>
            <span class="ex-decisao-btn-estado">Indisponível nesta etapa</span>
          </button>`).join('')}
      </div>
      <p class="ex-decisao-aviso">Estes botões ainda não gravam a decisão. A gravação fica para a próxima etapa, quando o sistema puder registrar com segurança.</p>
    </div>`;
}

function htmlValorDecisao(valor) {
  if (valor == null) return 'Ainda não informado.';
  return esc(valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
}

function htmlCartaoDecisao(item, indice, total, atual, aprovacao) {
  const acoesHtml = htmlAcoesDecisaoCompra();
  return `
    <article class="ex-decisao${atual ? ' is-atual' : ''}" aria-label="Decisão ${indice + 1} de ${total}: ${esc(item.filial)}">
      ${total > 1 ? `<p class="ex-decisao-indice">Decisão ${indice + 1} de ${total}</p>` : ''}
      <p class="ex-decisao-filial">Filial solicitante</p>
      <h3>${esc(item.filial)}</h3>
      <p class="ex-decisao-qtd"><strong>${esc(item.coberta_por_autorizacao ? 'Necessidade já autorizada' : (item.bloqueada_por_recusa ? 'Sem nova compra' : `Comprar ${textoPneus(item.quantidade)}`))}</strong> <span>Medida ${esc(item.medida)}</span></p>
      <div class="ex-decisao-miolo">
      <dl class="ex-decisao-fatos">
        <div>
          <dt>Motivo da compra</dt>
          <dd>${esc(item.motivo)}</dd>
        </div>
        <div>
          <dt>Estoque</dt>
          <dd>${esc(item.estoque_texto)}</dd>
        </div>
        <div>
          <dt>Transferência</dt>
          <dd>${esc(item.transferencia)}</dd>
        </div>
        <div>
          <dt>Valor total</dt>
          <dd>${htmlValorDecisao(item.valor_total)}</dd>
        </div>
        <div>
          <dt>Recomendação do sistema</dt>
          <dd>${esc(item.recomendacao)} ${esc(item.justificativa)}</dd>
        </div>
      </dl>
      ${acoesHtml}
      </div>
    </article>`;
}

function htmlAguardandoDecisao(lista, indice = 0, aprovacao = null) {
  if (!lista.length) {
    return '<p class="ex-vazio">Nenhuma compra confirmada para decidir neste filtro.</p>';
  }
  const atual = Math.min(Math.max(indice, 0), lista.length - 1);
  const nav = lista.length > 1 ? `
    <div class="ex-decisao-nav">
      <button type="button" data-decisao-nav="anterior"${atual === 0 ? ' disabled' : ''}>Decisão anterior</button>
      <button type="button" data-decisao-nav="proxima"${atual === lista.length - 1 ? ' disabled' : ''}>Próxima decisão</button>
    </div>` : '';
  return `
    <div class="ex-decisoes-fila" id="ex-decisoes-fila">
      ${lista.map((item, posicao) => htmlCartaoDecisao(item, posicao, lista.length, posicao === atual, aprovacao)).join('')}
    </div>
    ${nav}`;
}

function htmlConferencia(grupos) {
  if (!grupos.length) {
    return '<p class="ex-vazio">Nada pendente de conferência neste filtro.</p>';
  }
  return grupos.map((grupo) => `
    <article class="ex-conferencia">
      <h3>${esc(grupo.filial)}</h3>
      <p class="ex-conferencia-aviso">Sem decisão nesta lista. A filial ainda precisa corrigir o que está abaixo.</p>
      <ul>
        ${grupo.pendencias.map((item) => `
          <li class="${item.cadastro ? 'ex-conferencia-cadastro' : ''}">
            <p>${esc(item.texto)}</p>
            <p class="ex-conferencia-passo"><strong>A filial precisa:</strong> ${esc(item.passo)}</p>
          </li>`).join('')}
      </ul>
    </article>`).join('');
}

export function htmlPainelDecisoes(modelo = {}, filtro = 'todas', { analiseAberta = false, decisaoIndice = 0, aprovacao = null } = {}) {
  const decisoes = Array.isArray(modelo.decisoes) ? modelo.decisoes : [];
  const posicoes = Array.isArray(modelo.posicoes) ? modelo.posicoes : [];
  const limitacoes = Array.isArray(modelo.limitacoes) ? modelo.limitacoes : [];
  const contagem = Object.fromEntries(DECISOES.map((item) => [item.id, 0]));
  for (const linha of decisoes) contagem[linha.tipo] = (contagem[linha.tipo] || 0) + 1;
  const lista = filtro === 'todas' ? decisoes : decisoes.filter((linha) => linha.tipo === filtro);
  const fila = montarFilaDecisao(modelo, filtro);
  const compras = fila.aguardando;
  const intro = 'Aqui o senhor vê as compras de pneus já conferidas. O que ainda está incompleto fica separado, sem aprovação e sem reprovação. Nesta etapa, nenhum botão grava a decisão.';
  return `
    <div class="ex-decisoes">
      <p class="ex-decisoes-intro">${intro}</p>
      <div class="ex-filtros" role="tablist" aria-label="Tipo de decisão">
        <button type="button" class="ex-chip ${filtro === 'todas' ? 'is-ativa' : ''}" data-filtro="todas">Todas <span>${decisoes.length}</span></button>
        ${DECISOES.map((item) => `
          <button type="button" class="ex-chip ${filtro === item.id ? 'is-ativa' : ''}" data-filtro="${item.id}">
            ${esc(item.label)} <span>${contagem[item.id] || 0}</span>
          </button>`).join('')}
      </div>
      <section class="ex-aguardando" id="ex-aguardando-decisao" aria-labelledby="ex-aguardando-titulo">
        <h2 id="ex-aguardando-titulo">Aguardando a sua decisão</h2>
        <p>Só entram compras com quantidade e medida já confirmadas.</p>
        ${htmlAguardandoDecisao(compras, decisaoIndice, null)}
      </section>
      <section class="ex-conferencias" id="ex-precisam-conferencia" aria-labelledby="ex-conferencia-titulo">
        <h2 id="ex-conferencia-titulo">Precisam de conferência</h2>
        <p>Cadastro incompleto e previsão ainda não confirmada. Nada desta lista é uma compra para decidir.</p>
        ${htmlConferencia(fila.conferencia)}
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
      </section>
    </div>`;
}

function htmlDecisoes(modelo) {
  const total = montarFilaDecisao(modelo, estado.filtro).aguardando.length;
  if (total === 0 || estado.decisaoIndice < 0 || estado.decisaoIndice >= total) estado.decisaoIndice = 0;
  return htmlPainelDecisoes(modelo, estado.filtro, {
    analiseAberta: estado.analiseDetalhada,
    decisaoIndice: estado.decisaoIndice,
    aprovacao: estado.aprovacao,
  });
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

const TEXTO_MES = {
  no_ciclo: 'Medição dos sulcos feita neste mês',
  ciclo_anterior: 'Medição do mês anterior, ainda no prazo',
  vencida: 'Medição mensal vencida',
  parcial: 'Medição mensal em parte da frota',
  sem_medicao: 'Sem histórico de medição dos sulcos',
  nao_exigivel: 'Primeira medição mensal ainda não exigível',
  sem_pneu: 'Sem pneu montado',
};

const NOTA_MES = {
  no_ciclo: 'A profundidade dos sulcos foi registrada no ciclo mensal vigente.',
  ciclo_anterior: 'A última medição é do ciclo anterior e ainda está dentro de um mês. Isso não é atraso de semana.',
  vencida: 'A medição mensal venceu. O sulco já registrado continua valendo e pede reavaliação.',
  parcial: 'Só parte dos pneus montados tem a medição mensal utilizável.',
  sem_medicao: 'Não há histórico de profundidade dos sulcos. Isso não é medição antiga nem falta de dimensão comercial.',
  nao_exigivel: 'O pneu entrou em operação há pouco. A primeira medição mensal ainda não é exigível e nenhuma leitura foi inventada.',
  sem_pneu: 'Não há pneu montado para acompanhar.',
};

function inteiroPositivo(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** Mesmas conclusões do relatório. Quantidade só com estoque compatível conferido. */
export function montarParecerExecutivo({
  bom = 0,
  atencao = 0,
  criticos = 0,
  montados = 0,
  necessidade = 0,
  estoqueNovo = 0,
  comprarNovo = 0,
  estoqueConferido = false,
  candidatos = 0,
  vencidas = 0,
  semHistorico = 0,
  parciais = 0,
  veiculosSemCobertura = 0,
} = {}) {
  const condicao = {
    bom: inteiroPositivo(bom),
    atencao: inteiroPositivo(atencao),
    criticos: inteiroPositivo(criticos),
  };
  const necessidadeTecnica = inteiroPositivo(necessidade);
  const estoque = inteiroPositivo(estoqueNovo);
  const aComprar = inteiroPositivo(comprarNovo);
  const recap = inteiroPositivo(candidatos);
  const medicaoVencida = inteiroPositivo(vencidas);
  const semLeitura = inteiroPositivo(semHistorico);
  const leituraParcial = inteiroPositivo(parciais);
  const conferido = estoqueConferido === true;
  const descobertos = inteiroPositivo(veiculosSemCobertura);
  const coberturaInsuficiente = descobertos > 0;
  const compraRecomendada = conferido && necessidadeTecnica > 0 && aComprar > 0;
  const dadosSuficientes = conferido && semLeitura === 0 && leituraParcial === 0;
  const fechariaComoDesnecessaria = dadosSuficientes && aComprar === 0 && !compraRecomendada;
  const compraDesnecessaria = fechariaComoDesnecessaria && !coberturaInsuficiente;
  const recomendacoes = [];
  if (coberturaInsuficiente) recomendacoes.push('DADOS INSUFICIENTES PARA DECISÃO');
  if (compraRecomendada) recomendacoes.push('COMPRA RECOMENDADA');
  if (compraDesnecessaria) recomendacoes.push('COMPRA NÃO NECESSÁRIA NO MOMENTO');
  if (recap > 0) recomendacoes.push('AVALIAR RECAPAGEM');
  if (condicao.criticos > 0 || medicaoVencida > 0) recomendacoes.push('AVALIAÇÃO PRIORITÁRIA');

  let prioridade = 'Acompanhamento';
  if (condicao.criticos > 0 || medicaoVencida > 0) prioridade = 'Alta';
  else if (compraRecomendada || recap > 0 || coberturaInsuficiente || (necessidadeTecnica > 0 && !dadosSuficientes)) prioridade = 'Média';

  const frota = `Como está a frota: ${condicao.bom} em bom estado, ${condicao.atencao} em atenção e ${condicao.criticos} críticos.`;
  const atencaoTexto = `Precisam de atenção: ${condicao.atencao + condicao.criticos} pneus.`;
  const unidadeNecessidade = necessidadeTecnica === 1 ? 'pneu' : 'pneus';
  let substituicao = necessidadeTecnica > 0
    ? `Há necessidade técnica de substituição em ${necessidadeTecnica} ${unidadeNecessidade}. Ela usa a última medição válida. Não é estimativa.`
    : 'Não há necessidade técnica de substituição na última medição válida.';
  if (medicaoVencida > 0 && necessidadeTecnica > 0) {
    substituicao += ' A medição mensal vencida pede reavaliação e não apaga essa necessidade.';
  } else if (medicaoVencida > 0) {
    substituicao += ' A medição mensal vencida pede reavaliação da última leitura.';
  }

  const textoCobertura = descobertos === 1
    ? '1 veículo ativo não tem pneu montado no cadastro atual.'
    : `${descobertos} veículos ativos não têm pneu montado no cadastro atual.`;
  let compra;
  if (compraRecomendada) {
    compra = `Precisa comprar pneus novos. O estoque compatível (${estoque}) não cobre a necessidade. Quantidade conferida: ${aComprar}.`;
  } else if (compraDesnecessaria) {
    compra = 'Não precisa comprar pneus novos no momento.';
  } else if (coberturaInsuficiente && fechariaComoDesnecessaria) {
    compra = `DADOS INSUFICIENTES PARA DECISÃO. ${textoCobertura} Não dá para afirmar que a unidade não precisa comprar pneus.`;
  } else if (necessidadeTecnica > 0) {
    compra = 'Há necessidade técnica, mas a quantidade de compra não está fechada: o estoque compatível ainda não foi conferido.';
  } else {
    compra = 'Ainda não dá para fechar a compra: faltam dados para conferir o estoque compatível.';
  }
  if (coberturaInsuficiente && !fechariaComoDesnecessaria && !compraRecomendada) {
    compra += ` DADOS INSUFICIENTES PARA DECISÃO. ${textoCobertura} Não se afirma que a unidade não precisa comprar pneus.`;
  }

  const recapagem = recap > 0
    ? `Vale encaminhar ${recap} ${recap === 1 ? 'pneu' : 'pneus'} para avaliação de recapagem. A aprovação depende da inspeção técnica da carcaça.`
    : 'Não há candidato para encaminhar à avaliação de recapagem.';

  let motivoPrioridade = 'O acompanhamento mensal segue sem urgência de compra ou de retirada.';
  if (condicao.criticos > 0 && medicaoVencida > 0) {
    motivoPrioridade = 'Há pneus críticos e medição mensal vencida. A operação não pode parar por falta de pneu.';
  } else if (condicao.criticos > 0) {
    motivoPrioridade = 'Há pneus críticos. A retirada e a reavaliação vêm antes de fechar quantidade de compra.';
  } else if (medicaoVencida > 0) {
    motivoPrioridade = 'A medição mensal venceu. É preciso medir de novo antes de tratar o número como fechado.';
  } else if (compraRecomendada) {
    motivoPrioridade = 'A necessidade técnica está comprovada e o estoque compatível não cobre.';
  } else if (recap > 0) {
    motivoPrioridade = 'Há carcaças para inspeção de recapagem, sem aprovação automática.';
  } else if (necessidadeTecnica > 0) {
    motivoPrioridade = 'A necessidade técnica existe e a quantidade de compra ainda depende do estoque.';
  } else if (coberturaInsuficiente) {
    motivoPrioridade = 'A frota ativa cadastrada não está coberta por pneus montados. A decisão de compra permanece aberta.';
  }

  return {
    bom: condicao.bom,
    atencao: condicao.atencao,
    criticos: condicao.criticos,
    precisam_atencao: condicao.atencao + condicao.criticos,
    montados: inteiroPositivo(montados),
    necessidade: necessidadeTecnica,
    estoque_novo: estoque,
    quantidade_compra: compraRecomendada ? aComprar : null,
    candidatos: recap,
    recomendacoes,
    prioridade,
    frota,
    atencao_texto: atencaoTexto,
    substituicao,
    compra,
    recapagem,
    prioridade_texto: `Prioridade operacional: ${prioridade}. ${motivoPrioridade}`,
  };
}

function formatarDia(iso) {
  const dia = String(iso || '').slice(0, 10);
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!partes) return 'não há';
  return `${partes[3]}/${partes[2]}/${partes[1]}`;
}

function identPneu(pneu) {
  const fogo = pneu.numero_fogo ? `Fogo ${pneu.numero_fogo}` : 'Pneu sem número de fogo';
  return [fogo, pneu.placa || pneu.apelido || '', pneu.posicao || ''].filter(Boolean).join(' · ');
}

function resumoPneu(pneu) {
  const partes = [
    pneu.faixa_label || pneu.faixa || '',
    pneu.menor_sulco == null ? '' : `${pneu.menor_sulco} mm`,
    pneu.elegibilidade?.motivo || pneu.ciclo_motivo || '',
    pneu.data_medicao ? `medição ${formatarDia(pneu.data_medicao)}` : 'sem data de medição',
  ].filter(Boolean);
  return { texto: identPneu(pneu), detalhe: partes.join(' · ') };
}

function montadoIncompletoConsulta(pneu) {
  if (pneu?.status_pneu !== 'montado') return false;
  if (!chaveMedida(pneu.medida)) return true;
  if (pneu.faixa === 'sem_medicao' || pneu.faixa === 'sem_regua') return true;
  if (pneu.ciclo_confiavel === false) return true;
  return false;
}

function leituraMedida(linha, montados) {
  const chave = chaveMedida(linha.medida);
  const doGrupo = montados.filter((pneu) => chaveMedida(pneu.medida) === chave);
  const novos = doGrupo.filter((pneu) => precisaPneuNovo(pneu));
  const semMedidaUnidade = inteiro(linha.montados_sem_medida);
  const definitiva = linha.recomendacao_definitiva === true
    && linha.medida_informada === true
    && semMedidaUnidade === 0;
  const necessidade = inteiro(linha.necessidade_pneu_novo) || 0;
  const faltam = inteiro(linha.comprar_novo) || 0;
  const estoque = inteiro(linha.estoque_novo) || 0;
  const recapado = inteiro(linha.estoque_recapado) || 0;
  const emRecapagem = inteiro(linha.em_recapagem) || 0;
  let selo = 'NECESSIDADE TÉCNICA';
  const textoAberto = linha.medida_informada === true
    ? 'A necessidade técnica permanece. A quantidade desta medida só fecha com o estoque compatível conferido e com a dimensão comercial de todos os pneus da filial.'
    : 'A necessidade técnica permanece. A quantidade de compra não é definitiva sem a dimensão comercial e o estoque dessa dimensão.';
  let texto = definitiva ? '' : textoAberto;
  let faltamExibir = null;
  if (!definitiva) {
    selo = necessidade > 0 ? 'NECESSIDADE TÉCNICA' : 'DADOS INSUFICIENTES';
    faltamExibir = null;
    if (necessidade > 0) {
      texto = `${fraseContagem(necessidade, 'pneu tem necessidade técnica de pneu novo.', 'pneus têm necessidade técnica de pneu novo.')} ${texto}`;
    }
  } else if (definitiva && faltam > 0) {
    selo = 'COMPROVADO';
    faltamExibir = faltam;
    texto = `${faltam === 1 ? 'Falta 1 pneu novo' : `Faltam ${faltam} pneus novos`}. Necessidade ${necessidade}. Estoque novo ${estoque}.`;
  } else if (definitiva && necessidade > 0) {
    selo = 'COMPROVADO';
    faltamExibir = 0;
    texto = `O estoque novo (${estoque}) cobre a necessidade (${necessidade}).`;
  } else if (definitiva) {
    selo = 'COMPROVADO';
    faltamExibir = 0;
    texto = 'Nenhum pneu novo exigido nesta medida agora.';
  }
  const justificativas = novos.map((pneu) => {
    const sulco = pneu.menor_sulco == null ? 'sem sulco de banda' : `menor sulco ${pneu.menor_sulco} mm`;
    return `${identPneu(pneu)}: ${rotuloPapel(pneu.papel)}, ${pneu.faixa_label || pneu.faixa}, ${sulco}.`;
  });
  if (recapado > 0) {
    justificativas.push(`${fraseContagem(recapado, 'recapado em estoque não cobre dianteira e não entra na conta de pneu novo.', 'recapados em estoque não cobrem dianteira e não entram na conta de pneu novo.')}`);
  }
  if (emRecapagem > 0) {
    justificativas.push(`${fraseContagem(emRecapagem, 'pneu em recapagem não é estoque disponível.', 'pneus em recapagem não são estoque disponível.')}`);
  }
  return {
    medida: linha.medida_informada ? String(linha.medida).trim() : 'Dimensão comercial não cadastrada',
    selo,
    faltam: faltamExibir,
    texto,
    estoque_novo: estoque,
    estoque_recapado: recapado,
    em_recapagem: emRecapagem,
    estimativa_novo_90d: inteiro(linha.previsao_novo_90d) || 0,
    estimativa_recap_90d: inteiro(linha.previsao_recap_90d) || 0,
    justificativas,
  };
}

function leituraNecessidade(definitiva, necessidade, faltam, estoqueNovo) {
  if (!definitiva) {
    return {
      selo: 'DADOS INSUFICIENTES',
      faltam: null,
      necessidade,
      texto: 'Ainda não dá para afirmar quantos pneus novos faltam.',
      detalhe: necessidade > 0
        ? `${fraseContagem(necessidade, 'pneu entra na conta de pneu novo, mas o cadastro desta filial ainda não fecha.', 'pneus entram na conta de pneu novo, mas o cadastro desta filial ainda não fecha.')}`
        : 'Há pendência de cadastro ou de medição. Zero aqui não significa situação regular.',
    };
  }
  if (faltam > 0) {
    return {
      selo: 'COMPROVADO',
      faltam,
      necessidade,
      texto: 'Pneus novos que faltam agora.',
      detalhe: `Necessidade ${necessidade}. Estoque novo ${estoqueNovo}. Faltam ${faltam}. A estimativa de 90 dias não entra neste número.`,
    };
  }
  if (necessidade > 0) {
    return {
      selo: 'COMPROVADO',
      faltam: 0,
      necessidade,
      texto: 'O estoque novo cobre a necessidade.',
      detalhe: `Necessidade ${necessidade}. Estoque novo ${estoqueNovo}. Não falta pneu novo agora.`,
    };
  }
  return {
    selo: 'COMPROVADO',
    faltam: 0,
    necessidade: 0,
    texto: 'Nenhum pneu novo exigido agora.',
    detalhe: 'A conta fecha e não há pneu na regra de pneu novo.',
  };
}

function leituraOperacional({ necessidade, criticos, semDimensao, semHistorico, situacao }) {
  let selo = 'ACOMPANHAMENTO';
  let numero = null;
  let texto = 'A régua de sulco não aponta pneu novo agora.';
  if (criticos > 0) {
    selo = 'URGÊNCIA';
    numero = criticos;
    texto = `${fraseContagem(criticos, 'pneu crítico pela última medição dos sulcos.', 'pneus críticos pela última medição dos sulcos.')} A urgência usa esse sulco registrado. Não é estimativa.`;
  } else if (necessidade > 0) {
    selo = 'NECESSIDADE TÉCNICA';
    numero = necessidade;
    texto = `${fraseContagem(necessidade, 'pneu entra na necessidade técnica de pneu novo.', 'pneus entram na necessidade técnica de pneu novo.')} A estimativa de 90 dias não entra neste número.`;
  } else if (semHistorico > 0) {
    selo = 'DADOS INSUFICIENTES';
    numero = semHistorico;
    texto = 'Há pneu montado sem histórico de sulco. Isso não é medição antiga nem falta de dimensão comercial.';
  }
  if (necessidade > 0 && criticos > 0) {
    texto += ` ${fraseContagem(necessidade, 'pneu tem necessidade técnica de pneu novo pela posição.', 'pneus têm necessidade técnica de pneu novo pela posição.')}`;
  }
  if (semDimensao > 0) {
    texto += ` ${fraseContagem(semDimensao, 'pneu está sem dimensão comercial, então a compra não tem quantidade definitiva e o estoque compatível não foi conferido.', 'pneus estão sem dimensão comercial, então a compra não tem quantidade definitiva e o estoque compatível não foi conferido.')}`;
  }
  if (situacao === 'vencida') {
    texto += ' A medição mensal está vencida. O sulco já registrado não foi apagado e pede reavaliação.';
  }
  return {
    selo,
    faltam: null,
    numero,
    necessidade,
    texto,
    detalhe: texto,
  };
}

export function montarConsulta(relatorio) {
  const unidades = (relatorio?.por_unidade || []).filter((unidade) => !unidadeForaDoPainel(unidade));
  const ids = new Set(unidades.map((unidade) => idFilial(unidade.filial_id)).filter((id) => id != null));
  const pneus = (relatorio?.pneus || []).filter((pneu) => ids.has(idFilial(pneu.filial_id)) && !unidadeForaDoPainel(pneu));
  const medidas = (relatorio?.compras_por_medida || []).filter((linha) => ids.has(idFilial(linha.filial_id)));
  const comprasFilial = relatorio?.compras_por_filial || [];
  const descartes = relatorio?.descartes || [];
  const ciclo = relatorio?.ciclo || null;
  const filiais = unidades.map((unidade) => {
    const filialId = idFilial(unidade.filial_id);
    const montados = pneus.filter((pneu) => idFilial(pneu.filial_id) === filialId && pneu.status_pneu === 'montado');
    const linhas = medidas.filter((linha) => idFilial(linha.filial_id) === filialId);
    const resumo = comprasFilial.find((linha) => idFilial(linha.filial_id) === filialId);
    const descarte = descartes.find((item) => idFilial(item.filial_id) === filialId) || { quantidade: 0, itens: [] };
    const semMedida = inteiro(unidade.sem_dimensao_comercial)
      ?? inteiro(resumo?.montados_sem_medida)
      ?? montados.filter((pneu) => !chaveMedida(pneu.medida)).length;
    const definitiva = resumo
      ? resumo.recomendacao_definitiva === true
      : semMedida === 0 && linhas.every((linha) => linha.recomendacao_definitiva === true);
    const necessidade = linhas.reduce((soma, linha) => soma + (inteiro(linha.necessidade_pneu_novo) || 0), 0);
    const faltam = linhas.filter((linha) => (
      linha.recomendacao_definitiva === true
      && linha.medida_informada === true
      && inteiro(linha.montados_sem_medida) === 0
    )).reduce((soma, linha) => soma + (inteiro(linha.comprar_novo) || 0), 0);
    const estoqueNovo = linhas.reduce((soma, linha) => soma + (inteiro(linha.estoque_novo) || 0), 0);
    const candidatos = inteiro(unidade.candidatos_recap)
      ?? montados.filter((pneu) => pneu.elegibilidade?.candidato_programacao === true).length;
    const leituraSulcoFilial = unidade.leitura_sulco || {};
    const incompletos = inteiro(leituraSulcoFilial.sem_historico) != null && unidade.leitura_sulco
      ? (inteiro(leituraSulcoFilial.sem_historico) || 0) + (inteiro(leituraSulcoFilial.invalida) || 0) + (inteiro(leituraSulcoFilial.parcial) || 0)
      : (inteiro(unidade.incompletos) ?? montados.filter(montadoIncompletoConsulta).length);
    const situacao = TEXTO_MES[unidade.situacao_mes] ? unidade.situacao_mes : 'sem_medicao';
    const leituraBloqueia = situacao === 'sem_medicao' || situacao === 'sem_pneu';
    const fechada = definitiva && incompletos === 0 && semMedida === 0 && !leituraBloqueia;
    const criticos = somarFaixa([unidade], 'critico', 'critico_equipamento');
    const atencao = somarFaixa([unidade], 'monitoramento_preventivo', 'monitoramento_equipamento', 'programar_recapagem');
    const bom = somarFaixa([unidade], 'acompanhamento_normal', 'acompanhamento_equipamento');
    const vencidas = inteiro(leituraSulcoFilial.vencida)
      ?? montados.filter((pneu) => pneu.leitura_sulco === 'vencida').length;
    const semHistorico = inteiro(leituraSulcoFilial.sem_historico) || 0;
    const parciais = (inteiro(leituraSulcoFilial.parcial) || 0) + (inteiro(leituraSulcoFilial.invalida) || 0);
    const leitura = fechada
      ? leituraNecessidade(true, necessidade, faltam, estoqueNovo)
      : leituraOperacional({
        necessidade,
        criticos,
        semDimensao: semMedida,
        semHistorico: semHistorico || incompletos,
        situacao,
      });
    if (fechada && (situacao === 'vencida' || situacao === 'parcial' || situacao === 'ciclo_anterior')) {
      leitura.detalhe = `${leitura.detalhe} A medição mensal não está toda no ciclo vigente. O sulco já registrado permanece.`;
    }
    const cadastrados = inteiro(unidade.veiculos_cadastrados);
    const comPneu = inteiro(unidade.veiculos) || 0;
    const veiculosSemCobertura = cadastrados == null ? 0 : Math.max(0, cadastrados - comPneu);
    const parecerCalculado = montarParecerExecutivo({
      bom,
      atencao,
      criticos,
      montados: inteiro(unidade.pneus_montados) ?? montados.length,
      necessidade,
      estoqueNovo,
      comprarNovo: definitiva ? faltam : 0,
      estoqueConferido: definitiva,
      candidatos,
      veiculosSemCobertura,
      vencidas: vencidas || 0,
      semHistorico,
      parciais,
    });
    const parecer = Array.isArray(unidade.parecer?.recomendacoes) ? unidade.parecer : parecerCalculado;
    return {
      filial_id: filialId,
      filial: unidade.filial || `Unidade ${filialId}`,
      codigo: unidade.codigo || '',
      pneus_montados: inteiro(unidade.pneus_montados) ?? montados.length,
      veiculos_cadastrados: unidade.veiculos_cadastrados == null ? null : (inteiro(unidade.veiculos_cadastrados) || 0),
      veiculos: inteiro(unidade.veiculos) || 0,
      ultima_medicao: unidade.ultima_medicao || null,
      situacao_mes: situacao,
      medidos_no_ciclo: inteiro(unidade.medidos_no_ciclo) || inteiro(leituraSulcoFilial.no_ciclo) || 0,
      bom,
      atencao,
      criticos,
      parecer,
      evolucao_mensal: unidade.evolucao_mensal || null,
      preventivo: somarFaixa([unidade], 'monitoramento_preventivo', 'monitoramento_equipamento'),
      candidatos_recap: candidatos,
      faixa_programar: inteiro(unidade.programar_recapagem) || somarFaixa([unidade], 'programar_recapagem'),
      incompletos,
      sem_medida: semMedida,
      sem_dimensao_comercial: semMedida,
      leitura_sulco: unidade.leitura_sulco || null,
      necessidade: leitura,
      estimativa_novo_90d: linhas.reduce((soma, linha) => soma + (inteiro(linha.previsao_novo_90d) || 0), 0),
      estimativa_recap_90d: linhas.reduce((soma, linha) => soma + (inteiro(linha.previsao_recap_90d) || 0), 0),
      estoque_novo: estoqueNovo,
      estoque_recapado: linhas.reduce((soma, linha) => soma + (inteiro(linha.estoque_recapado) || 0), 0),
      em_recapagem: linhas.reduce((soma, linha) => soma + (inteiro(linha.em_recapagem) || 0), 0),
      medidas: linhas
        .slice()
        .sort((a, b) => String(a.medida || '').localeCompare(String(b.medida || ''), 'pt-BR'))
        .map((linha) => leituraMedida(linha, montados)),
      criticos_lista: montados
        .filter((pneu) => pneu.faixa === 'critico' || pneu.faixa === 'critico_equipamento')
        .map(resumoPneu),
      candidatos_lista: montados
        .filter((pneu) => pneu.elegibilidade?.candidato_programacao === true)
        .map(resumoPneu),
      pendencias: {
        sem_medida: montados.filter((pneu) => !chaveMedida(pneu.medida)).map(resumoPneu),
        sem_medicao: montados.filter((pneu) => pneu.leitura_sulco === 'sem_historico' || (pneu.leitura_sulco == null && pneu.faixa === 'sem_medicao')).map(resumoPneu),
        parcial: montados.filter((pneu) => pneu.leitura_sulco === 'parcial' || pneu.leitura_sulco === 'invalida').map(resumoPneu),
        vencida: montados.filter((pneu) => pneu.leitura_sulco === 'vencida' || pneu.reavaliar === true).map(resumoPneu),
        ciclo_anterior: montados.filter((pneu) => pneu.leitura_sulco === 'ciclo_anterior').map(resumoPneu),
        nao_exigivel: montados.filter((pneu) => pneu.leitura_sulco === 'nao_exigivel').map(resumoPneu),
        ciclo: montados.filter((pneu) => pneu.ciclo_confiavel === false).map(resumoPneu),
      },
      descartes: {
        quantidade: inteiro(descarte.quantidade) || (Array.isArray(descarte.itens) ? descarte.itens.length : 0),
        itens: Array.isArray(descarte.itens) ? descarte.itens : [],
      },
    };
  });
  const ordem = { vencida: 0, sem_medicao: 1, parcial: 2, ciclo_anterior: 3, nao_exigivel: 4, no_ciclo: 5, sem_pneu: 6 };
  filiais.sort((a, b) => (ordem[a.situacao_mes] ?? 9) - (ordem[b.situacao_mes] ?? 9)
    || (b.parecer?.quantidade_compra || 0) - (a.parecer?.quantidade_compra || 0)
    || b.criticos - a.criticos
    || String(a.filial).localeCompare(String(b.filial), 'pt-BR'));
  return { gerado_em: relatorio?.gerado_em || null, ciclo, filiais };
}

function htmlSelo(nome) {
  const tom = nome === 'COMPROVADO' || nome === 'COMPRA NÃO NECESSÁRIA NO MOMENTO' ? 'comprovado'
    : nome === 'ESTIMATIVA' ? 'estimativa'
      : nome === 'URGÊNCIA' || nome === 'AVALIAÇÃO PRIORITÁRIA' || nome === 'COMPRA RECOMENDADA' ? 'urgencia'
        : nome === 'NECESSIDADE TÉCNICA' ? 'tecnica'
          : nome === 'DIMENSÃO PENDENTE' ? 'dimensao'
            : nome === 'AVALIAR RECAPAGEM' ? 'candidato'
              : 'insuficiente';
  return `<span class="ex-selo ex-selo-${tom}">${esc(nome)}</span>`;
}

function htmlVeiculos(filial) {
  const comPneu = fraseContagem(filial.veiculos, 'veículo com pneu montado', 'veículos com pneu montado');
  if (filial.veiculos_cadastrados == null) return comPneu;
  return `${fraseContagem(filial.veiculos_cadastrados, 'veículo cadastrado', 'veículos cadastrados')} · ${comPneu}`;
}

function htmlCiclo(filial) {
  const situacao = TEXTO_MES[filial.situacao_mes] ? filial.situacao_mes : 'sem_medicao';
  const leitura = filial.leitura_sulco;
  const contagem = leitura
    ? `<p class="ex-semana-nota">Sulco: ${leitura.sem_historico || 0} sem histórico · ${leitura.ciclo_anterior || 0} do mês anterior no prazo · ${leitura.no_ciclo || 0} neste mês · ${leitura.vencida || 0} com medição vencida · ${(leitura.parcial || 0) + (leitura.invalida || 0)} parcial ou inválido · ${leitura.nao_exigivel || 0} ainda não exigível.</p>`
    : '';
  return `
    <p class="ex-semana ex-semana-${situacao}">${esc(TEXTO_MES[situacao])}</p>
    <p class="ex-ultima">Última medição dos sulcos: ${esc(formatarDia(filial.ultima_medicao))}</p>
    <p class="ex-semana-nota">${esc(NOTA_MES[situacao])}</p>
    ${contagem}`;
}

function htmlParecer(filial) {
  const parecer = filial.parecer;
  if (!parecer) return '';
  const quantidade = parecer.quantidade_compra == null
    ? 'Quantidade de compra não fechada'
    : `Quantidade conferida: ${parecer.quantidade_compra}`;
  const recomendacoes = Array.isArray(parecer.recomendacoes) ? parecer.recomendacoes : [];
  const selos = recomendacoes.map((nome) => htmlSelo(nome)).join(' ');
  return `
    <div class="ex-recomendacoes">${selos || '<span class="ex-selo ex-selo-insuficiente">Sem recomendação fechada</span>'}</div>
    <dl class="ex-parecer">
      <div><dt>Como está a frota?</dt><dd>${esc(parecer.frota)}</dd></div>
      <div><dt>Quantos pneus precisam de atenção?</dt><dd>${esc(parecer.atencao_texto)}</dd></div>
      <div><dt>Há necessidade de substituição?</dt><dd>${esc(parecer.substituicao)}</dd></div>
      <div><dt>Precisa comprar pneus novos?</dt><dd>${esc(parecer.compra)} ${esc(quantidade)}.</dd></div>
      <div><dt>Vale encaminhar para avaliação de recapagem?</dt><dd>${esc(parecer.recapagem)} Não é aprovação.</dd></div>
      <div><dt>Qual a prioridade operacional?</dt><dd>${esc(parecer.prioridade_texto)}</dd></div>
    </dl>`;
}

function htmlNumero(valor) {
  return valor == null ? '—' : esc(valor);
}

function fraseContagem(quantidade, um, varios) {
  const n = Number(quantidade) || 0;
  return n === 1 ? `1 ${um}` : `${n} ${varios}`;
}

function htmlListaPneus(lista, vazio) {
  if (!lista?.length) return `<p class="ex-vazio">${esc(vazio)}</p>`;
  return `<ul class="ex-lista">${lista.map((item) => `
    <li><strong>${esc(item.texto)}</strong><span>${esc(item.detalhe || '')}</span></li>`).join('')}</ul>`;
}

function htmlCartaoFilial(filial, { botao = true } = {}) {
  const parecer = filial.parecer || {};
  const recapNota = filial.faixa_programar > filial.candidatos_recap
    ? 'Há pneus na faixa de sulco que não são candidatos. Sulco sozinho não aprova recapagem.'
    : 'Candidato à inspeção da carcaça. O envio não está aprovado.';
  return `
    <article class="ex-filial-card is-${esc(filial.situacao_mes || 'sem_medicao')}">
      <header class="ex-filial-head">
        <h3>${esc(filial.filial)}</h3>
        ${htmlCiclo(filial)}
      </header>
      <p class="ex-acompanhados">${esc(htmlVeiculos(filial))} · ${filial.pneus_montados} pneus acompanhados</p>
      <div class="ex-numeros">
        <div>
          <span class="ex-selo ex-selo-comprovado">Bom estado</span>
          <strong>${filial.bom || 0}</strong>
          <p>Acompanhamento normal pela última medição válida.</p>
        </div>
        <div>
          <span class="ex-selo ex-selo-tecnica">Atenção</span>
          <strong>${filial.atencao || 0}</strong>
          <p>Monitoramento ou faixa de recapagem. Não é aprovação.</p>
        </div>
        <div>
          <span class="ex-selo ex-selo-urgencia">Críticos</span>
          <strong>${filial.criticos || 0}</strong>
          <p>Retirada e reavaliação. A medição vencida não apaga este número.</p>
        </div>
      </div>
      <div class="ex-numeros">
        <div>
          <span class="ex-selo ex-selo-tecnica">Substituição</span>
          <strong>${parecer.necessidade || 0}</strong>
          <p>Necessidade técnica de pneu novo pela última medição válida.</p>
        </div>
        <div>
          <span class="ex-selo ex-selo-candidato">Recapagem</span>
          <strong>${filial.candidatos_recap}</strong>
          <p>Candidatos à inspeção. Não é aprovação.</p>
        </div>
        <div>
          <span class="ex-selo ex-selo-comprovado">Estoque novo</span>
          <strong>${filial.estoque_novo || 0}</strong>
          <p>Disponível na filial. Recapado não cobre dianteira.</p>
        </div>
      </div>
      ${htmlParecer(filial)}
      <p class="ex-recap-nota">${esc(recapNota)}</p>
      ${botao ? `<button type="button" class="ex-btn ex-btn-largo" data-abrir-filial="${filial.filial_id}">Ver ${esc(filial.filial)}</button>` : ''}
    </article>`;
}

function htmlCartaoFilialSeguro(filial) {
  try {
    return htmlCartaoFilial(filial);
  } catch (erro) {
    console.error('Cartão da filial', filial?.filial_id, erro);
    const nome = esc(filial?.filial || 'Filial');
    const id = esc(filial?.filial_id ?? '');
    return `
      <article class="ex-filial-card">
        <h3>${nome}</h3>
        <p class="ex-semana-nota">O cartão completo desta filial não pôde ser montado.</p>
        <button type="button" class="ex-btn ex-btn-largo" data-abrir-filial="${id}">Ver ${nome}</button>
      </article>`;
  }
}

function htmlConsultaSituacao(consulta) {
  const filiais = Array.isArray(consulta?.filiais) ? consulta.filiais : [];
  if (!filiais.length) {
    return '<p class="ex-estado">Nenhuma filial operacional neste relatório.</p>';
  }
  return `
    <div class="ex-consulta">
      <p class="ex-consulta-intro">Cada filial mostra a condição dos pneus, a necessidade de substituição, os candidatos à recapagem, o estoque e a recomendação. A medição dos sulcos é mensal.</p>
      <div class="ex-filial-lista">
        ${filiais.map(htmlCartaoFilialSeguro).join('')}
      </div>
    </div>`;
}

function htmlMedidas(filial) {
  if (!filial.medidas.length) {
    return '<p class="ex-vazio">Nenhuma medida com estoque ou necessidade neste relatório.</p>';
  }
  return filial.medidas.map((linha) => `
    <article class="ex-medida">
      <h4>${esc(linha.medida)}</h4>
      <p>${htmlSelo(linha.selo)} <strong>${linha.selo === 'COMPROVADO'
        ? (linha.faltam === 1 ? 'Falta 1 pneu novo' : linha.faltam === 0 ? 'Não falta pneu novo' : `Faltam ${linha.faltam} pneus novos`)
        : 'Quantidade em aberto'}</strong></p>
      <p>${esc(linha.texto)}</p>
      <ul class="ex-estoque">
        <li>Estoque novo: <strong>${linha.estoque_novo}</strong></li>
        <li>Estoque recapado: <strong>${linha.estoque_recapado}</strong></li>
        <li>Em recapagem: <strong>${linha.em_recapagem}</strong></li>
      </ul>
      ${linha.justificativas.length ? `<ul class="ex-lista">${linha.justificativas.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
    </article>`).join('');
}

function htmlConsultaFilial(consulta) {
  const filial = consulta.filiais.find((item) => item.filial_id === estado.filialId);
  if (!filial) {
    return `
      <div class="ex-consulta">
        <p class="ex-consulta-intro">Escolha a filial para ver medida, estoque e pendências.</p>
        <div class="ex-escolha">
          ${consulta.filiais.map((item) => `
            <button type="button" class="ex-btn ex-btn-largo" data-abrir-filial="${item.filial_id}">${esc(item.filial)}</button>`).join('')}
        </div>
      </div>`;
  }
  const pendencias = filial.pendencias;
  return `
    <div class="ex-consulta ex-filial-detalhe">
      <button type="button" class="ex-btn ex-btn-voltar" data-voltar-situacao>Voltar às filiais</button>
      ${htmlCartaoFilial(filial, { botao: false })}
      <section class="ex-bloco">
        <h3>Necessidade por medida</h3>
        <p>Estoque novo, recapado e em recapagem ficam separados. Recapado não cobre dianteira.</p>
        ${htmlMedidas(filial)}
      </section>
      <section class="ex-bloco">
        <h3>Pneus críticos</h3>
        <p>Crítico pede retirada e avaliação. Não é aprovação de recapagem.</p>
        ${htmlListaPneus(filial.criticos_lista, 'Nenhum pneu crítico nesta filial.')}
      </section>
      <section class="ex-bloco">
        <h3>Possível recapagem</h3>
        <p>Candidatos à avaliação humana. O sistema não aprova o envio.</p>
        ${htmlListaPneus(filial.candidatos_lista, 'Nenhum candidato à avaliação de recapagem.')}
      </section>
      <section class="ex-bloco">
        <h3>Descartes registrados</h3>
        <p>${esc(fraseContagem(filial.descartes.quantidade, 'pneu em descarte. Ele fica fora da régua de sulco.', 'pneus em descarte. Eles ficam fora da régua de sulco.'))}</p>
        ${filial.descartes.itens.length ? `<ul class="ex-lista">${filial.descartes.itens.map((item) => `
          <li><strong>${esc(item.numero_fogo ? `Fogo ${item.numero_fogo}` : 'Pneu sem número de fogo')}</strong>
          <span>${esc([item.medida, item.data ? formatarDia(item.data) : '', item.motivo || ''].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>` : '<p class="ex-vazio">Nenhum descarte registrado nesta filial.</p>'}
        ${filial.descartes.quantidade > filial.descartes.itens.length ? `<p class="ex-semana-nota">A lista mostra ${filial.descartes.itens.length} de ${filial.descartes.quantidade}.</p>` : ''}
      </section>
      <section class="ex-bloco">
        <h3>Diagnóstico técnico secundário</h3>
        <p>${filial.evolucao_mensal
          ? `${filial.evolucao_mensal.com_historico || 0} pneu(s) com evolução mensal observada. ${filial.evolucao_mensal.insuficientes || 0} sem histórico mensal suficiente: não há prazo de substituição.`
          : 'A evolução do desgaste só aparece com pelo menos dois meses medidos no mesmo ciclo. Sem isso, não há prazo de substituição.'}</p>
        <h4>Dimensão comercial não cadastrada</h4>
        ${htmlListaPneus(pendencias.sem_medida, 'Nenhum pneu montado sem dimensão comercial.')}
        <h4>Sem histórico de medição dos sulcos</h4>
        ${htmlListaPneus(pendencias.sem_medicao, 'Nenhum pneu montado sem histórico de sulco.')}
        <h4>Medição parcial ou inválida</h4>
        ${htmlListaPneus(pendencias.parcial, 'Nenhuma medição parcial ou inválida.')}
        <h4>Medição mensal vencida</h4>
        ${htmlListaPneus(pendencias.vencida, 'Nenhum pneu com medição mensal vencida.')}
        <h4>Mês anterior, ainda no prazo</h4>
        ${htmlListaPneus(pendencias.ciclo_anterior, 'Nenhum pneu apenas com a medição do mês anterior.')}
        <h4>Primeira medição ainda não exigível</h4>
        ${htmlListaPneus(pendencias.nao_exigivel, 'Nenhum pneu novo aguardando a primeira medição.')}
        <h4>Ciclo de recapagem não separado</h4>
        ${htmlListaPneus(pendencias.ciclo, 'Nenhum ciclo pendente de separação.')}
      </section>
    </div>`;
}

function htmlColunaComparar(filial) {
  return htmlCartaoFilial(filial, { botao: false });
}

function htmlConsultaComparar(consulta) {
  const escolhidas = consulta.filiais.filter((filial) => estado.comparar.has(filial.filial_id));
  return `
    <div class="ex-consulta">
      <p class="ex-consulta-intro">Escolha duas ou três filiais. O parecer usa a última medição válida e o estoque compatível. A medição é mensal.</p>
      ${estado.avisoComparar ? '<p class="ex-semana ex-semana-parcial">Dá para comparar até 3 filiais. Solte uma para incluir outra.</p>' : ''}
      <div class="ex-escolha">
        ${consulta.filiais.map((filial) => {
          const ativa = estado.comparar.has(filial.filial_id);
          return `<button type="button" class="ex-btn ex-btn-largo ${ativa ? 'is-ativa' : ''}" data-comparar-filial="${filial.filial_id}" aria-pressed="${ativa ? 'true' : 'false'}">${ativa ? 'Tirar' : 'Incluir'} ${esc(filial.filial)}</button>`;
        }).join('')}
      </div>
      ${escolhidas.length < 2
        ? '<p class="ex-semana-nota">Marque pelo menos duas filiais para ver a comparação.</p>'
        : `<div class="ex-comparar-grade">${escolhidas.map(htmlColunaComparar).join('')}</div>`}
    </div>`;
}

export function htmlsConsulta(relatorio, { filialId = null, comparar = [] } = {}) {
  const consulta = montarConsulta(relatorio);
  const salvo = {
    filialId: estado.filialId,
    comparar: estado.comparar,
    avisoComparar: estado.avisoComparar,
  };
  estado.filialId = filialId;
  estado.comparar = new Set(comparar);
  estado.avisoComparar = false;
  const saida = {
    consulta,
    situacao: htmlConsultaSituacao(consulta),
    filial: htmlConsultaFilial(consulta),
    comparar: htmlConsultaComparar(consulta),
  };
  estado.filialId = salvo.filialId;
  estado.comparar = salvo.comparar;
  estado.avisoComparar = salvo.avisoComparar;
  return saida;
}

function htmlConteudo() {
  if (estado.carregando && !estado.consulta) {
    return '<p class="ex-estado">Carregando as filiais operacionais…</p>';
  }
  if (estado.erro && !estado.consulta) {
    return `<p class="ex-estado ex-estado-erro">${esc(estado.erro)}</p>`;
  }
  if (!estado.consulta) return '<p class="ex-estado">Nenhum relatório carregado.</p>';
  if (estado.aba === 'filial') return htmlConsultaFilial(estado.consulta);
  if (estado.aba === 'comparar') return htmlConsultaComparar(estado.consulta);
  return htmlConsultaSituacao(estado.consulta);
}

function tituloAba() {
  if (estado.aba === 'filial') return 'Uma filial';
  if (estado.aba === 'comparar') return 'Comparar filiais';
  return 'Situação das filiais';
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
    const hora = formatarQuando(estado.consulta?.gerado_em || estado.modelo?.gerado_em);
    quando.textContent = hora ? `Atualizado em ${hora}` : '';
  }
  const conteudo = document.getElementById('exec-conteudo');
  if (conteudo) {
    try {
      conteudo.innerHTML = htmlConteudo();
    } catch (erro) {
      console.error(erro);
      estado.aba = 'situacao';
      estado.filialId = null;
      conteudo.innerHTML = htmlConsultaSituacao(estado.consulta);
    }
    conteudo.querySelector('[data-voltar-situacao]')?.addEventListener('click', (evento) => {
      evento.preventDefault();
      evento.stopPropagation();
      voltarAsFiliais();
    });
  }
  root.querySelector('.exec-nav .is-ativa')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  const usuario = document.getElementById('exec-usuario');
  if (usuario && !usuario.textContent) usuario.textContent = 'Presidente';
}

function abrirFilial(id) {
  estado.aba = 'filial';
  estado.filialId = id;
  pintar();
  document.getElementById('exec-conteudo')?.querySelector('.ex-filial-detalhe')?.scrollIntoView({ block: 'start' });
}

function alvoClique(evento) {
  const alvo = evento.target;
  if (alvo && typeof alvo.closest === 'function') return alvo;
  return alvo?.parentElement || null;
}

function voltarAsFiliais() {
  estado.aba = 'situacao';
  estado.filialId = null;
  pintar();
  document.getElementById('exec-conteudo')?.scrollIntoView?.({ block: 'start' });
}

function comandoDecisao(evento) {
  const cancelar = evento.target.closest('[data-decisao-cancelar]');
  if (cancelar) return { tipo: 'cancelar' };
  const efetivar = evento.target.closest('[data-confirma-efetivar]');
  if (efetivar) return { tipo: 'efetivar' };
  const parecer = evento.target.closest('[data-parecer-seguir]');
  if (parecer) {
    return { tipo: 'parecer', parecer: document.getElementById('ex-parecer')?.value || '' };
  }
  const acao = evento.target.closest('[data-decisao-acao]');
  if (acao && !acao.disabled) {
    return { tipo: 'iniciar', acao: acao.dataset.decisaoAcao, solicitacaoId: acao.dataset.solicitacaoId };
  }
  const atualizar = evento.target.closest('[data-atualizar-solicitacao]');
  if (atualizar && !atualizar.disabled) {
    return { tipo: 'atualizar', solicitacaoId: atualizar.dataset.solicitacaoId };
  }
  const registrar = evento.target.closest('[data-registrar-compra]');
  if (registrar && !registrar.disabled) {
    return { tipo: 'registrar', filialId: registrar.dataset.filialId, medida: registrar.dataset.medida };
  }
  return null;
}

function dispararDecisao() {
  if (estado.aba === 'situacao' || estado.aba === 'filial' || estado.aba === 'comparar') return false;
  return false;
}

function onClick(evento) {
  const alvo = alvoClique(evento);
  if (!alvo) return;
  if (alvo.closest('[data-voltar-situacao]')) {
    evento.preventDefault?.();
    voltarAsFiliais();
    return;
  }
  const aba = alvo.closest('[data-aba]');
  if (aba) {
    estado.aba = aba.dataset.aba;
    if (estado.aba !== 'filial') estado.filialId = null;
    pintar();
    return;
  }
  const filtroQualidade = alvo.closest('[data-filtro-qualidade]');
  if (filtroQualidade) {
    estado.filtroQualidade = filtroQualidade.dataset.filtroQualidade;
    pintar();
    return;
  }
  const filtro = alvo.closest('[data-filtro]');
  if (filtro) {
    estado.filtro = filtro.dataset.filtro;
    estado.decisaoIndice = 0;
    if (estado.aprovacao?.etapa) {
      estado.aprovacao = {
        ...estado.aprovacao,
        etapa: null,
        confirmacaoId: null,
        resumo: null,
        acao: null,
        solicitacaoId: null,
      };
    }
    pintar();
    return;
  }
  if (alvo.closest('[data-decisao-indisponivel]')) return;
  const compararFilial = alvo.closest('[data-comparar-filial]');
  if (compararFilial) {
    const id = Number(compararFilial.dataset.compararFilial);
    if (estado.comparar.has(id)) {
      estado.comparar.delete(id);
      estado.avisoComparar = false;
    } else if (estado.comparar.size >= 3) {
      estado.avisoComparar = true;
    } else {
      estado.comparar.add(id);
      estado.avisoComparar = false;
    }
    estado.aba = 'comparar';
    pintar();
    return;
  }
  const navegacao = alvo.closest('[data-decisao-nav]');
  if (navegacao) {
    estado.decisaoIndice += navegacao.dataset.decisaoNav === 'proxima' ? 1 : -1;
    pintar();
    return;
  }
  if (alvo.closest('[data-analise-detalhada]')) {
    estado.analiseDetalhada = !estado.analiseDetalhada;
    pintar();
    return;
  }
  const abrir = alvo.closest('[data-abrir-filial]');
  if (abrir) {
    abrirFilial(Number(abrir.dataset.abrirFilial));
    return;
  }
  const linha = alvo.closest('tr[data-filial]');
  if (linha && !alvo.closest('input, button, a')) {
    abrirFilial(Number(linha.dataset.filial));
    return;
  }
  if (alvo.closest('[data-fechar-filial]')) {
    estado.filialId = null;
    estado.aba = 'situacao';
    pintar();
    return;
  }
  if (alvo.closest('[data-exec-atualizar]')) {
    acoes.aoAtualizar();
    return;
  }
  if (alvo.closest('[data-exec-pdf]')) {
    acoes.aoPdf(estado.filialId);
    return;
  }
  if (alvo.closest('[data-exec-sair]')) acoes.aoSair();
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
  window.matchMedia?.('(max-width: 720px)')?.addEventListener?.('change', sincronizarDecisaoMovel);
}

function sincronizarDecisaoMovel() {
  const fila = document.getElementById('ex-decisoes-fila');
  if (!fila || !window.matchMedia) return;
  const estreita = window.matchMedia('(max-width: 720px)').matches;
  fila.querySelectorAll('.ex-decisao').forEach((cartao) => {
    const atual = cartao.classList.contains('is-atual');
    if (estreita && !atual) cartao.setAttribute('aria-hidden', 'true');
    else cartao.removeAttribute('aria-hidden');
  });
}

export function exibirExecutivo({ relatorio = null, erro = '', carregando = false, usuario = '', aprovacao = null } = {}) {
  estado.carregando = carregando;
  if (carregando) estado.erro = '';
  if (relatorio) {
    estado.relatorio = relatorio;
    estado.modelo = prepararPainel(relatorio);
    estado.consulta = montarConsulta(relatorio);
    estado.erro = '';
    if (estado.filialId != null && !estado.consulta.filiais.some((item) => item.filial_id === estado.filialId)) {
      estado.filialId = null;
    }
    for (const id of [...estado.comparar]) {
      if (!estado.consulta.filiais.some((item) => item.filial_id === id)) estado.comparar.delete(id);
    }
  }
  if (aprovacao) estado.aprovacao = estadoInicialAprovacao();
  if (erro) estado.erro = erro;
  if (!carregando && erro && !relatorio) estado.carregando = false;
  const nome = document.getElementById('exec-usuario');
  if (nome && usuario) nome.textContent = usuario;
  pintar();
}

export function abaExecutivaAtual() {
  return estado.aba;
}
