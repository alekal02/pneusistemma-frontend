/**
 * Dashboard executivo do presidente. Só desenha o que a API devolve.
 * Não recalcula sulco, validade nem situação.
 */

const CORES = {
  ok: '#15803d',
  atencao: '#a16207',
  critico: '#b91c1c',
  cinza: '#64748b',
  neutro: '#1b5e2a',
  verde: '#15803d',
  amarelo: '#a16207',
  vermelho: '#b91c1c',
};

const state = {
  painel: 'visao',
  filtros: {
    filial_id: '',
    tipo: '',
    situacao: '',
    periodo: '30',
    de: '',
    ate: '',
    incluir_matriz: false,
  },
  resumo: null,
  diagnostico: null,
  evolucao: null,
  erroResumo: '',
  erroEvolucao: '',
  carregando: false,
  carregandoEvolucao: false,
  detalhe: null,
  filialAberta: null,
  foco: '',
  pagina: 1,
  ponto: null,
};

let deps = null;
let seq = 0;
let shellPronto = false;

export function initPresidente(opcoes) {
  deps = opcoes;
}

export function abrirPainelPresidente(painel) {
  if (!deps?.podeVer?.()) return;
  state.painel = painel || 'visao';
  if (state.painel === 'visao') {
    state.filialAberta = null;
    state.foco = '';
    state.ponto = null;
  }
  garantirShell();
  renderConteudo();
  if (!state.resumo && !state.carregando) carregar();
  else if (precisaLista()) carregarDetalhe();
}

function root() {
  return document.getElementById('px-root');
}

function garantirShell() {
  const el = root();
  if (!el || shellPronto) return;
  el.innerHTML = `
    <div class="px-top">
      <div>
        <h2>Visão executiva</h2>
        <p class="px-sub">Situação atual da operação</p>
      </div>
      <div class="px-top-acoes">
        <button type="button" class="btn btn-ghost btn-sm" id="px-limpar">Limpar filtros</button>
        <button type="button" class="btn btn-primary btn-sm" id="px-pdf">Exportar PDF</button>
      </div>
    </div>
    <form class="px-filtros" id="px-filtros">
      <label>Filial
        <select name="filial_id" id="px-filial"><option value="">Todas</option></select>
      </label>
      <label>Tipo
        <select name="tipo" id="px-tipo"><option value="">Todos</option></select>
      </label>
      <label>Situação
        <select name="situacao" id="px-situacao">
          <option value="">Todas</option>
          <option value="ok">OK</option>
          <option value="monitorar">Monitoramento</option>
          <option value="critico">Crítico</option>
          <option value="sem_medicao">Sem medição</option>
        </select>
      </label>
      <label>Período
        <select name="periodo" id="px-periodo">
          <option value="7">7 dias</option>
          <option value="30" selected>30 dias</option>
          <option value="90">90 dias</option>
          <option value="custom">Personalizado</option>
        </select>
      </label>
      <label class="px-datas hidden" id="px-de-wrap">De <input type="date" id="px-de"></label>
      <label class="px-datas hidden" id="px-ate-wrap">Até <input type="date" id="px-ate"></label>
      <label class="px-check"><input type="checkbox" id="px-matriz"> Incluir Matriz</label>
    </form>
    <div id="px-conteudo"></div>
    <div id="px-tip" class="px-tip hidden" role="tooltip"></div>
  `;
  el.querySelector('#px-filtros').addEventListener('change', aoFiltrar);
  el.querySelector('#px-limpar').addEventListener('click', limpar);
  el.querySelector('#px-pdf').addEventListener('click', baixarPdf);
  el.querySelector('#px-conteudo').addEventListener('click', aoClicar);
  el.addEventListener('mousemove', aoMover);
  el.addEventListener('mouseleave', () => esconderTip());
  shellPronto = true;
}

function aoFiltrar(ev) {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.id === 'px-filial') state.filtros.filial_id = t.value;
  if (t.id === 'px-tipo') state.filtros.tipo = t.value;
  if (t.id === 'px-situacao') state.filtros.situacao = t.value;
  if (t.id === 'px-periodo') state.filtros.periodo = t.value;
  if (t.id === 'px-de') state.filtros.de = t.value;
  if (t.id === 'px-ate') state.filtros.ate = t.value;
  if (t.id === 'px-matriz') state.filtros.incluir_matriz = t.checked;
  document.getElementById('px-de-wrap')?.classList.toggle('hidden', state.filtros.periodo !== 'custom');
  document.getElementById('px-ate-wrap')?.classList.toggle('hidden', state.filtros.periodo !== 'custom');
  if (state.filtros.periodo === 'custom' && (!state.filtros.de || !state.filtros.ate)) return;
  state.filialAberta = null;
  state.pagina = 1;
  carregar();
}

function limpar() {
  state.filtros = {
    filial_id: '', tipo: '', situacao: '', periodo: '30', de: '', ate: '', incluir_matriz: false,
  };
  state.filialAberta = null;
  state.foco = '';
  state.pagina = 1;
  const form = document.getElementById('px-filtros');
  if (form) {
    form.querySelector('#px-filial').value = '';
    form.querySelector('#px-tipo').value = '';
    form.querySelector('#px-situacao').value = '';
    form.querySelector('#px-periodo').value = '30';
    form.querySelector('#px-de').value = '';
    form.querySelector('#px-ate').value = '';
    form.querySelector('#px-matriz').checked = false;
  }
  document.getElementById('px-de-wrap')?.classList.add('hidden');
  document.getElementById('px-ate-wrap')?.classList.add('hidden');
  deps.navegar('visao');
  carregar();
}

function query() {
  const f = state.filtros;
  const q = new URLSearchParams();
  if (f.filial_id) q.set('filial_id', f.filial_id);
  if (f.tipo) q.set('tipo', f.tipo);
  if (f.situacao) q.set('situacao', f.situacao);
  q.set('periodo', f.periodo || '30');
  if (f.periodo === 'custom') {
    if (f.de) q.set('de', f.de);
    if (f.ate) q.set('ate', f.ate);
  }
  if (f.incluir_matriz) q.set('incluir_matriz', '1');
  return q.toString();
}

async function carregar() {
  const id = ++seq;
  state.carregando = true;
  state.carregandoEvolucao = true;
  state.erroResumo = '';
  state.evolucao = null;
  state.diagnostico = null;
  state.erroEvolucao = '';
  renderConteudo();
  try {
    const [resumo, diagnostico] = await Promise.all([
      deps.fetchJSON(`${deps.api}/presidente/visao?${query()}`),
      deps.fetchJSON(`${deps.api}/presidente/diagnostico-filiais?${query()}`).catch(() => null),
    ]);
    if (id !== seq) return;
    state.resumo = resumo;
    state.diagnostico = diagnostico;
    state.carregando = false;
    preencherOpcoes(resumo.opcoes);
    renderConteudo();
    carregarEvolucao(id);
    if (precisaLista()) carregarDetalhe();
  } catch (err) {
    if (id !== seq) return;
    state.carregando = false;
    state.resumo = null;
    state.diagnostico = null;
    state.erroResumo = err.message || 'Falha ao carregar a visão.';
    renderConteudo();
  }
}

async function carregarEvolucao(id) {
  state.carregandoEvolucao = true;
  pintarEvolucao();
  try {
    const data = await deps.fetchJSON(`${deps.api}/presidente/evolucao?${query()}`);
    if (id !== seq) return;
    state.evolucao = data.evolucao;
    state.erroEvolucao = data.evolucao?.erro || '';
  } catch (err) {
    if (id !== seq) return;
    state.evolucao = null;
    state.erroEvolucao = err.message || 'Falha ao carregar a evolução.';
  } finally {
    if (id === seq) {
      state.carregandoEvolucao = false;
      pintarEvolucao();
    }
  }
}

function precisaLista() {
  return ['frota', 'pneus', 'alertas', 'filial'].includes(state.painel);
}

async function carregarDetalhe() {
  if (!precisaLista()) return;
  const q = new URLSearchParams(query());
  const mapa = {
    frota: ['frota', ''],
    pneus: ['pneus', state.foco || 'montados'],
    alertas: ['alertas', state.foco || 'veiculos_criticos'],
    filial: ['frota', ''],
  };
  const [recorte, foco] = mapa[state.painel] || ['pneus', ''];
  q.set('recorte', recorte);
  if (foco) q.set('foco', foco);
  if (state.filialAberta) q.set('filial_foco', String(state.filialAberta));
  q.set('pagina', String(state.pagina || 1));
  q.set('limite', '40');
  try {
    state.detalhe = await deps.fetchJSON(`${deps.api}/presidente/detalhe?${q}`);
  } catch (err) {
    state.detalhe = { erro: err.message || 'Falha ao abrir o detalhe.', itens: [], total: 0 };
  }
  renderConteudo();
}

function preencherOpcoes(opcoes) {
  const filial = document.getElementById('px-filial');
  const tipo = document.getElementById('px-tipo');
  if (!filial || !tipo || !opcoes) return;
  const filialAtual = state.filtros.filial_id;
  const tipoAtual = state.filtros.tipo;
  filial.innerHTML = `<option value="">Todas</option>` + (opcoes.filiais || []).map((f) => (
    `<option value="${f.id}">${esc(f.nome)}${f.teste ? ' (testes)' : ''}</option>`
  )).join('');
  tipo.innerHTML = `<option value="">Todos</option>` + (opcoes.tipos || []).map((t) => (
    `<option value="${esc(t.codigo)}">${esc(t.label)}</option>`
  )).join('');
  filial.value = filialAtual;
  tipo.value = tipoAtual;
}

function renderConteudo() {
  const box = document.getElementById('px-conteudo');
  if (!box) return;
  if (state.carregando && !state.resumo) {
    box.innerHTML = esqueleto();
    return;
  }
  if (state.erroResumo) {
    box.innerHTML = `<div class="px-erro">${esc(state.erroResumo)}</div>`;
    return;
  }
  if (!state.resumo) {
    box.innerHTML = `<div class="px-vazio">Sem dados neste recorte.</div>`;
    return;
  }
  const partes = {
    visao: htmlVisao,
    filiais: htmlFiliais,
    filial: htmlFilial,
    frota: htmlFrota,
    pneus: htmlPneus,
    alertas: htmlAlertas,
    relatorios: htmlRelatorios,
  };
  const fn = partes[state.painel] || htmlVisao;
  box.innerHTML = fn();
  pintarEvolucao();
}

function esqueleto() {
  return `<div class="px-cards">${Array.from({ length: 6 }, () => '<div class="px-card px-skel"></div>').join('')}</div>
    <div class="px-grid"><div class="px-bloco px-skel"></div><div class="px-bloco px-skel"></div></div>`;
}

function htmlVisao() {
  return `
    ${htmlCards()}
    <div class="px-grid">
      <section class="px-bloco">
        <header><h3>Filiais</h3></header>
        ${htmlBarrasFiliais()}
      </section>
      <section class="px-bloco">
        <header><h3>Condição física</h3></header>
        ${htmlDonut(state.resumo.saude?.condicao || [], 'condicao')}
      </section>
    </div>
    <div class="px-grid px-grid-3">
      <section class="px-bloco">
        <header><h3>Validade no mês</h3></header>
        ${htmlBarrasSimples(state.resumo.saude?.atualizacao || [], 'atualizacao')}
      </section>
      <section class="px-bloco">
        <header><h3>Onde estão</h3></header>
        ${htmlBarrasSimples(state.resumo.saude?.localizacao || [], 'local')}
      </section>
      <section class="px-bloco">
        <header><h3>Prioridades</h3><button type="button" class="btn btn-ghost btn-sm" data-ir="alertas">Abrir</button></header>
        ${htmlAlertasCompactos()}
      </section>
    </div>
    <section class="px-bloco" id="px-evolucao-box">
      <header><h3>Evolução</h3></header>
      <div id="px-evolucao">${state.carregandoEvolucao ? '<div class="px-skel px-skel-linha"></div>' : ''}</div>
    </section>
  `;
}

function htmlCards() {
  const cards = state.resumo?.resumo?.cards || [];
  return `<div class="px-cards">${cards.map((c) => `
    <button type="button" class="px-card px-${esc(c.cor)}" data-ir="${esc(c.destino?.painel || 'visao')}" data-foco="${esc(c.destino?.foco || '')}">
      <span class="px-card-rotulo">${esc(c.rotulo)}</span>
      <strong>${c.valor == null ? '—' : esc(c.valor)}</strong>
      ${htmlDelta(c)}
    </button>
  `).join('')}</div>`;
}

function htmlDelta(card) {
  const cmp = card.comparacao;
  if (!cmp || cmp.delta == null) return '';
  const sinal = cmp.delta > 0 ? '+' : '';
  return `<span class="px-delta">${sinal}${esc(cmp.delta)}</span>`;
}

const CORES_SITUACAO_EXEC = {
  controlada: 'verde',
  atencao: 'amarelo',
  critica: 'vermelho',
  nao_avaliada: 'cinza',
};

function corSituacaoExec(situacao) {
  return CORES_SITUACAO_EXEC[situacao] || 'cinza';
}

function htmlBarrasFiliais() {
  const filiais = state.diagnostico?.filiais || [];
  if (!filiais.length) return `<p class="px-vazio">Sem filiais neste recorte.</p>`;
  const barras = filiais.map((f) => {
    const pct = f.frota_avaliada_pct;
    const largura = pct == null ? 0 : Math.max(0, Math.min(100, Number(pct)));
    const texto = pct == null ? '—' : fmtPctExec(pct);
    const cor = corSituacaoExec(f.situacao);
    return `
      <button type="button" class="px-barra" data-filial="${f.id}" data-situacao="${esc(f.situacao || '')}" data-tip="${esc(f.nome)} · ${esc(f.situacao_label || '')} · frota avaliada ${texto} · ${f.com_criticos ?? 0} veículos críticos">
        <span class="px-barra-nome">${esc(f.nome)}<small>${esc(f.situacao_label || '')}</small></span>
        <span class="px-trilho"><span class="px-fill px-${cor}" style="width:${largura}%"></span></span>
        <span class="px-barra-pct">${texto}</span>
      </button>`;
  }).join('');
  return `
    <div class="px-barras">${barras}</div>
    <p class="hint">O comprimento da barra é a frota avaliada. A cor é a situação executiva.</p>
    <div class="px-legenda">
      <span class="px-dot verde"></span> Controlada
      <span class="px-dot amarelo"></span> Atenção
      <span class="px-dot vermelho"></span> Crítica
      <span class="px-dot cinza"></span> Não avaliada
    </div>`;
}

function htmlDonut(itens, origem) {
  const valores = itens.map((i) => Number(i.valor) || 0);
  const total = valores.reduce((s, n) => s + n, 0);
  if (!total) return `<p class="px-vazio">Sem pneus neste recorte.</p>`;
  let ang = 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  const arcos = itens.map((item) => {
    const valor = Number(item.valor) || 0;
    const fatia = valor / total;
    const dash = fatia * c;
    const el = `<circle class="px-arco" data-ir="pneus" data-foco="${esc(item.id)}" data-tip="${esc(item.label)} · ${valor}" cx="60" cy="60" r="${r}" fill="none" stroke="${CORES[item.cor] || CORES.neutro}" stroke-width="14" stroke-dasharray="${dash} ${c - dash}" stroke-dashoffset="${-ang * c}" />`;
    ang += fatia;
    return el;
  }).join('');
  return `
    <div class="px-donut-wrap">
      <svg viewBox="0 0 120 120" class="px-donut" role="img">${arcos}</svg>
      <ul class="px-lista-curta">${itens.map((item) => `
        <li><button type="button" data-ir="pneus" data-foco="${esc(item.id)}" data-origem="${esc(origem)}"><i class="px-dot ${esc(item.cor)}"></i>${esc(item.label)} <b>${item.valor}</b></button></li>
      `).join('')}</ul>
    </div>`;
}

function htmlBarrasSimples(itens, origem) {
  const max = Math.max(1, ...itens.map((i) => Number(i.valor) || 0));
  if (!itens.length) return `<p class="px-vazio">Sem dados.</p>`;
  const focoDe = {
    atualizada: 'atualizada',
    atrasada: 'atrasadas',
    montado: 'montados',
    estoque: 'estoque',
    recapagem: 'recapagem',
  };
  return `<div class="px-barras px-barras-curtas">${itens.map((item) => {
    const valor = Number(item.valor) || 0;
    const largura = max ? (valor / max) * 100 : 0;
    return `
      <button type="button" class="px-barra" data-ir="pneus" data-foco="${esc(focoDe[item.id] || item.id)}" data-origem="${esc(origem)}" data-tip="${esc(item.label)} · ${valor}">
        <span class="px-barra-nome">${esc(item.label)}</span>
        <span class="px-trilho"><span class="px-fill px-${esc(item.cor)}" style="width:${largura}%"></span></span>
        <span class="px-barra-pct">${valor}</span>
      </button>`;
  }).join('')}</div>`;
}

function htmlAlertasCompactos() {
  const grupos = (state.resumo?.alertas?.grupos || []).filter((g) => g.total > 0).slice(0, 4);
  if (!grupos.length) return `<p class="px-vazio">Nenhuma prioridade neste recorte.</p>`;
  return `<div class="px-alertas">${grupos.map((g) => `
    <button type="button" class="px-alerta px-${esc(g.prioridade)}" data-ir="alertas" data-foco="${esc(g.id)}">
      <b>${g.total}</b>
      <span>${esc(g.titulo)}</span>
    </button>
  `).join('')}</div>`;
}

function pintarEvolucao() {
  const box = document.getElementById('px-evolucao');
  if (!box) return;
  if (state.carregandoEvolucao) {
    box.innerHTML = '<div class="px-skel px-skel-linha"></div>';
    return;
  }
  if (state.erroEvolucao) {
    box.innerHTML = `<p class="px-erro">${esc(state.erroEvolucao)}</p>`;
    return;
  }
  const series = state.evolucao?.series;
  if (!series) {
    box.innerHTML = `<p class="px-vazio">${esc(state.evolucao?.erro || 'Histórico indisponível')}</p>`;
    return;
  }
  const blocos = [
    ['medicoes', 'Medições'],
    ['criticos', 'Críticos'],
    ['filiais', 'Filiais com medição'],
    ['recapagens', 'Recapagens'],
    ['descartes', 'Descartes'],
    ['conformidade', 'Conformidade'],
  ];
  box.innerHTML = `<div class="px-series">${blocos.map(([id, nome]) => htmlSerie(nome, series[id], id)).join('')}</div>`;
}

function htmlSerie(nome, serie, id) {
  if (!serie?.disponivel) {
    return `<article class="px-serie"><h4>${esc(nome)}</h4><p class="px-indisponivel">${esc(serie?.motivo || 'Histórico indisponível')}</p></article>`;
  }
  const pontos = serie.pontos || [];
  const nums = pontos.map((p) => (p.valor == null ? null : Number(p.valor)));
  const max = Math.max(1, ...nums.filter((n) => n != null));
  return `
    <article class="px-serie">
      <h4>${esc(nome)}</h4>
      <div class="px-cols">${pontos.map((p) => {
        if (p.valor == null) {
          return `<button type="button" class="px-col px-col-vazio" data-serie="${esc(id)}" data-chave="${esc(p.chave)}" data-tip="${esc(p.label)} · sem dado"></button>`;
        }
        const h = Math.max(4, (Number(p.valor) / max) * 72);
        return `<button type="button" class="px-col" data-serie="${esc(id)}" data-chave="${esc(p.chave)}" data-tip="${esc(p.label)} · ${p.valor}" style="height:${h}px"></button>`;
      }).join('')}</div>
    </article>`;
}

function fmtPctExec(valor) {
  if (valor == null || valor === '') return '—';
  return `${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function dataCurta(valor) {
  const [ano, mes, dia] = String(valor || '').slice(0, 10).split('-');
  if (!ano || !mes || !dia) return '—';
  return `${dia}/${mes}/${ano}`;
}

function diagDaFilial(id) {
  return (state.diagnostico?.filiais || []).find((item) => Number(item.id) === Number(id)) || null;
}

function htmlBlocoExec(diag) {
  if (!diag) return '';
  return `
    <div class="px-exec">
      <span class="exec-sit exec-sit-${esc(diag.situacao || '')}">${esc(diag.situacao_label || '—')}</span>
      <p>${esc(diag.motivo || '')}</p>
      <div class="px-mini">
        <div><b>${diag.veiculos_ativos ?? 0}</b><span>Ativos</span></div>
        <div><b>${diag.sem_risco_critico ?? 0}</b><span>Sem risco</span></div>
        <div><b>${diag.com_monitoramento ?? 0}</b><span>Monitoramento</span></div>
        <div><b>${diag.com_criticos ?? 0}</b><span>Críticos</span></div>
        <div><b>${diag.sem_dados ?? 0}</b><span>Sem dados</span></div>
      </div>
      <p>Frota avaliada ${fmtPctExec(diag.frota_avaliada_pct)} · ${diag.veiculos_medicao_vencida ?? 0} com medição vencida</p>
    </div>`;
}

function htmlPneusExec(veiculo) {
  const pneus = veiculo.pneus || [];
  if (!pneus.length) {
    return `<article class="px-linha px-linha-estatica"><span><b>${esc(veiculo.placa || '—')}</b></span><span>${esc(veiculo.classe_label || 'Sem dados suficientes')}</span></article>`;
  }
  return pneus.map((pneu) => {
    const chip = pneu.kpi === 'critico' ? 'vermelho' : (pneu.kpi === 'monitorar' ? 'amarelo' : 'cinza');
    const rotulo = pneu.kpi === 'critico' ? 'CRÍTICO' : (pneu.kpi === 'monitorar' ? 'MONITORAR' : 'SEM DADO');
    const alertas = (pneu.alertas || []).map((alerta) => `<span class="exec-alerta">${esc(alerta)}</span>`).join('');
    return `
      <article class="px-linha px-linha-estatica">
        <span><b>${esc(veiculo.placa || '—')}</b> ${esc(pneu.posicao_label || pneu.posicao || '')}</span>
        <span>${esc(pneu.numero_fogo || '—')}</span>
        <span>${pneu.menor_sulco == null ? '—' : `${esc(pneu.menor_sulco)} mm`}</span>
        <span>${dataCurta(pneu.data_medicao)}</span>
        <span class="px-chip px-${chip}">${rotulo}</span>${alertas}
      </article>`;
  }).join('');
}

function htmlGrupoExec(titulo, veiculos) {
  if (!veiculos.length) return '';
  return `<section class="px-exec-grupo"><h4>${esc(titulo)} (${veiculos.length})</h4>${veiculos.map(htmlPneusExec).join('')}</section>`;
}

function htmlDetalheExec(diag) {
  if (!diag) return '';
  const lista = diag.justificativa || [];
  const criticos = lista.filter((item) => item.classe === 'critico');
  const monitoramento = lista.filter((item) => item.classe === 'monitoramento');
  const semDados = lista.filter((item) => item.classe === 'sem_dados');
  const outros = lista.filter((item) => !['critico', 'monitoramento', 'sem_dados'].includes(item.classe));
  return `
    <section class="px-bloco" aria-label="Diagnóstico executivo">
      <header><h3>Diagnóstico executivo</h3></header>
      ${htmlBlocoExec(diag)}
      ${htmlGrupoExec('Veículos com pneus críticos', criticos)}
      ${htmlGrupoExec('Veículos com pneus em monitoramento', monitoramento)}
      ${htmlGrupoExec('Veículos sem dados suficientes', semDados)}
      ${htmlGrupoExec('Medição vencida ou sulco incompleto', outros)}
    </section>`;
}

function htmlFiliais() {
  const cards = (state.diagnostico?.filiais || []).map((diag) => `
    <button type="button" class="px-exec-card" data-filial="${diag.id}">
      <strong>${esc(diag.nome || '')}</strong>
      ${htmlBlocoExec(diag)}
    </button>
  `).join('');
  return `
    ${voltar()}
    <section class="px-bloco"><header><h3>Filiais</h3></header>${htmlBarrasFiliais()}</section>
    <section class="px-bloco">
      <header><h3>Diagnóstico executivo</h3></header>
      ${cards || '<p class="px-vazio">Diagnóstico indisponível neste recorte.</p>'}
    </section>
  `;
}

function htmlFilial() {
  const diag = diagDaFilial(state.filialAberta);
  const f = (state.resumo.filiais || []).find((item) => item.id === Number(state.filialAberta));
  if (!diag && !f) return `${voltar()}<p class="px-vazio">Filial fora deste recorte.</p>`;
  const nome = diag?.nome || f?.nome || '';
  const chip = diag
    ? `<span class="px-chip px-${corSituacaoExec(diag.situacao)}" data-situacao="${esc(diag.situacao || '')}">${esc(diag.situacao_label || '—')}</span>`
    : '';
  const operacao = f ? `
      <div class="px-mini">
        <div><b>${f.veiculos}</b><span>Veículos</span></div>
        <div><b>${f.montados}</b><span>Montados</span></div>
        <div><b>${f.criticos}</b><span>Pneus críticos</span></div>
        <div><b>${f.atrasados}</b><span>Fora do mês</span></div>
        <div><b>${f.percentual_atualizado == null ? '—' : `${f.percentual_atualizado}%`}</b><span>No mês</span></div>
      </div>` : '';
  return `
    ${voltar()}
    <section class="px-bloco">
      <header><h3>${esc(nome)}</h3>${chip}</header>
      ${operacao}
    </section>
    ${htmlDetalheExec(diag)}
    ${htmlListaFrota()}
  `;
}

function htmlFrota() {
  return `${voltar()}<section class="px-bloco"><header><h3>Frota</h3></header>${htmlListaFrota()}</section>`;
}

function htmlListaFrota() {
  const d = state.detalhe;
  if (!d) return '<div class="px-skel px-skel-linha"></div>';
  if (d.erro) return `<p class="px-erro">${esc(d.erro)}</p>`;
  if (!d.itens?.length) return '<p class="px-vazio">Nenhum veículo neste recorte.</p>';
  return `${d.itens.map((v) => `
    <button type="button" class="px-linha" data-ir="pneus" data-foco="montados" data-filial="${v.filial_id}">
      <span><b>${esc(v.placa)}</b> ${esc(v.apelido || '')}</span>
      <span>${esc(v.filial || '')}</span>
      <span class="px-chip px-${esc(v.situacao?.cor || 'cinza')}">${esc(v.situacao?.label || '')}</span>
      <span>${v.criticos} críticos</span>
    </button>
  `).join('')}${htmlPaginacao(d)}`;
}

function htmlPneus() {
  const d = state.detalhe;
  return `
    ${voltar()}
    <section class="px-bloco">
      <header><h3>Pneus</h3></header>
      ${!d ? '<div class="px-skel px-skel-linha"></div>' : d.erro ? `<p class="px-erro">${esc(d.erro)}</p>` : !d.itens?.length ? '<p class="px-vazio">Nenhum pneu neste recorte.</p>' : `
        ${d.itens.map((p) => `
          <article class="px-linha px-linha-estatica">
            <span><b>${esc(p.fogo)}</b> ${esc(p.posicao || '')}</span>
            <span>${esc(p.filial)} · ${esc(p.placa || '—')}</span>
            <span class="px-chip">${esc(p.kpi_label || '—')}</span>
            <span>${p.menor_sulco == null ? '—' : `${esc(p.menor_sulco)} mm`}</span>
          </article>
        `).join('')}
        ${htmlPaginacao(d)}
      `}
    </section>`;
}

function htmlAlertas() {
  const grupos = state.resumo?.alertas?.grupos || [];
  const aberto = state.foco;
  return `
    ${voltar()}
    <div class="px-alertas px-alertas-grade">${grupos.map((g) => `
      <button type="button" class="px-alerta px-${esc(g.prioridade)} ${aberto === g.id ? 'is-on' : ''}" data-ir="alertas" data-foco="${esc(g.id)}">
        <b>${g.total}</b><span>${esc(g.titulo)}</span>
      </button>
    `).join('')}</div>
    <section class="px-bloco">${htmlListaAlertas()}</section>
  `;
}

function htmlListaAlertas() {
  const d = state.detalhe;
  if (!state.foco) return '<p class="px-vazio">Escolha uma prioridade.</p>';
  if (!d) return '<div class="px-skel px-skel-linha"></div>';
  if (d.erro) return `<p class="px-erro">${esc(d.erro)}</p>`;
  if (!d.itens?.length) return '<p class="px-vazio">Nenhum item.</p>';
  return d.itens.map((item) => `
    <article class="px-linha px-linha-estatica">
      <span><b>${esc(item.titulo)}</b></span>
      <span>${esc(item.filial || '')}</span>
      <span>${esc(item.tipo || '')}</span>
    </article>
  `).join('') + htmlPaginacao(d);
}

function htmlRelatorios() {
  return `
    ${voltar()}
    <section class="px-bloco">
      <header><h3>Relatórios</h3></header>
      <div class="px-relatorios">
        <button type="button" class="btn btn-primary" id="px-pdf-2">PDF da visão executiva</button>
        ${deps.isAdmin?.() ? '<button type="button" class="btn btn-ghost" data-view="saude">Saúde técnica</button><button type="button" class="btn btn-ghost" data-view="relatorios">Relatório da diretoria</button>' : ''}
      </div>
    </section>
    ${htmlCards()}
  `;
}

function htmlPaginacao(d) {
  const paginas = Math.max(1, Math.ceil((d.total || 0) / (d.limite || 40)));
  if (paginas <= 1) return '';
  return `<div class="px-pag">
    <button type="button" data-pag="${state.pagina - 1}" ${state.pagina <= 1 ? 'disabled' : ''}>Anterior</button>
    <span>${state.pagina} / ${paginas}</span>
    <button type="button" data-pag="${state.pagina + 1}" ${state.pagina >= paginas ? 'disabled' : ''}>Próxima</button>
  </div>`;
}

function voltar() {
  if (state.painel === 'visao') return '';
  return `<button type="button" class="btn btn-ghost btn-sm px-voltar" data-ir="visao">Voltar à visão geral</button>`;
}

function aoClicar(ev) {
  esconderTip();
  const btn = ev.target.closest('button, .px-arco');
  if (!btn) return;
  if (btn.id === 'px-pdf-2') {
    baixarPdf();
    return;
  }
  if (btn.dataset.view) {
    deps.abrirView?.(btn.dataset.view);
    return;
  }
  if (btn.dataset.pag) {
    state.pagina = Number(btn.dataset.pag);
    carregarDetalhe();
    return;
  }
  if (btn.dataset.chave) {
    const serie = state.evolucao?.series?.[btn.dataset.serie];
    state.ponto = (serie?.pontos || []).find((p) => p.chave === btn.dataset.chave) || null;
    if (state.ponto) {
      deps.toast?.(`${state.ponto.label}: ${state.ponto.valor == null ? 'sem dado' : state.ponto.valor}`);
    }
    return;
  }
  if (btn.dataset.filial && !btn.dataset.ir) {
    state.filialAberta = Number(btn.dataset.filial);
    state.pagina = 1;
    state.detalhe = null;
    deps.navegar('filial');
    return;
  }
  if (btn.dataset.ir) {
    state.foco = btn.dataset.foco || '';
    state.pagina = 1;
    state.detalhe = null;
    if (btn.dataset.filial) state.filialAberta = Number(btn.dataset.filial);
    deps.navegar(btn.dataset.ir);
  }
}

function aoMover(ev) {
  const alvo = ev.target.closest('[data-tip]');
  const tip = document.getElementById('px-tip');
  if (!alvo || !tip) {
    esconderTip();
    return;
  }
  tip.textContent = alvo.dataset.tip || '';
  tip.classList.remove('hidden');
  tip.style.left = `${ev.clientX + 12}px`;
  tip.style.top = `${ev.clientY + 16}px`;
}

function esconderTip() {
  document.getElementById('px-tip')?.classList.add('hidden');
}

async function baixarPdf() {
  try {
    const resp = await fetch(`${deps.api}/presidente/visao.pdf?${query()}`, {
      headers: deps.getToken() ? { Authorization: `Bearer ${deps.getToken()}` } : {},
    });
    if (!resp.ok) {
      let msg = 'Não foi possível gerar o PDF.';
      try {
        const data = await resp.json();
        if (data?.erro) msg = data.erro;
      } catch { /* resposta binária */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'visao-executiva.pdf';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    deps.toast?.(err.message || 'Falha no PDF', 'error');
  }
}

function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
