import { TireMarker } from './tire-marker.js';
import { TruckDiagram, renderLayoutPreview } from './truck-diagram.js';
import { renderPerfilSulco } from './perfil-sulco.js';

/** Normaliza VITE_API_URL — em prod precisa terminar com /api */
function resolveApiBase() {
  let base = String(import.meta.env.VITE_API_URL || '/api').trim().replace(/\/+$/, '');
  if (!base) base = '/api';
  // Host absoluto do backend sem sufixo /api (erro comum na Vercel)
  if (/^https?:\/\//i.test(base) && !/\/api$/i.test(base)) {
    base = `${base}/api`;
  }
  return base;
}

const API = resolveApiBase();
const AUTH_KEY = 'pneu_auth';

let meta = { posicoes: {}, tipos: [], layouts: [], layout_padrao: 'truck_10' };
let veiculoLayoutId = null;
let veiculoAtual = null;
let pneuSelecionado = null;
let truckDiagram = null;
let truckTireMarker = null;
let autoSaveTimer = null;
let voltarPara = 'dashboard';
let currentUser = null;
let authToken = null;
let slotPosicaoSelecionada = null;
let modoAcessoRapido = false;
let tokenAcessoRapido = null;
let diaMedicaoUnidade = null;
let pneusMedidosSessao = new Set();
let sessaoCampoVeiculoId = null;

const LAYOUT_POR_TIPO = {
  'Truck / Tração': 'truck_10',
  'Toco / Mini': 'toco_6',
};

let veiculosCache = [];
let filiaisCache = [];
let tireMarker = null;
let limitesAtuais = {
  sulco_critico_mm: 3.0,
  sulco_alerta_mm: 8.0,
  sulco_recap_mm: 3.0,
  sulco_novo_mm: 14.0,
  max_recaps: 6,
  prazo_recap_dias: 15,
  diagnostico_tolerancia_mm: 1.0,
  acoes: {
    troca: { label: 'Trocar', instrucao: 'Crítico — retirar e trocar o pneu' },
    recap: { label: 'Recapagem', instrucao: 'Iniciar processo de recap em até 15 dias' },
    monitorar: { label: 'Monitorar', instrucao: 'Programar substituição — iniciar processo de recap em até 15 dias' },
    rodizio: { label: 'Mudar posição', instrucao: 'Rodízio para o lado oposto do eixo (ex.: 1E → 1D) para equalizar o desgaste' },
    ok: { label: 'OK', instrucao: 'Manter em operação — sulco adequado' },
  },
  rodizio_desvio_mm: 4,
  rodizio_similaridade_mm: 2.5,
};

const LIMITES_PADRAO = { ...limitesAtuais };

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveAuth(token, usuario) {
  authToken = token;
  currentUser = usuario;
  localStorage.setItem(AUTH_KEY, JSON.stringify({ token, usuario }));
}

function clearAuth() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem(AUTH_KEY);
}

function isAdmin() {
  return currentUser?.papel === 'admin';
}

function isGerente() {
  return currentUser?.papel === 'gerente';
}

function isGestao() {
  return isAdmin() || isGerente();
}

/** Diagnóstico e orientação de ação: só gerente/admin — filial só registra medição */
function podeVerOrientacaoGestao() {
  return isGestao();
}

function aplicarVisibilidadeOrientacaoGestao() {
  const show = podeVerOrientacaoGestao();
  ['truck-diagnostico', 'truck-acao-instrucao', 'truck-rodizio-sugestao', 'truck-pneu-acao'].forEach((id) => {
    document.getElementById(id)?.classList.toggle('gestao-only-hidden', !show);
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchJSON(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (modoAcessoRapido && tokenAcessoRapido) {
    headers['X-Acesso-Rapido-Token'] = tokenAcessoRapido;
  }

  const resp = await fetch(url, { ...options, headers });
  let data;
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (resp.status === 401) {
    const isLogin = url.includes('/auth/login');
    const isAcessoRapido = url.includes('/acesso-rapido') || modoAcessoRapido;
    // Erros do WuzAPI/WhatsApp nunca devem derrubar a sessão do app
    const isWhatsappProxy = url.includes('/whatsapp/');
    if (!isLogin && !isAcessoRapido && !isWhatsappProxy) {
      clearAuth();
      showLogin();
    }
    throw new Error(data.erro || (isLogin ? 'Login ou senha inválidos' : 'Sessão expirada — faça login novamente'));
  }
  if (!resp.ok) {
    const msg = data.erro || (resp.status === 404
      ? 'Recurso não encontrado — reinicie o backend (npm run dev)'
      : 'Erro na requisição');
    const err = new Error(msg);
    err.data = data;
    throw err;
  }
  return data;
}

async function fetchConfiguracoes() {
  try {
    return await fetchJSON(`${API}/configuracoes`);
  } catch {
    return { ...LIMITES_PADRAO };
  }
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function badge(status) {
  const labels = {
    ok: 'OK',
    alerta: 'Monitorar',
    critico: 'Crítico',
    sem_dado: 'Sem medição',
  };
  return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

function badgeAcao(codigo, label) {
  if (!codigo || codigo === 'ok') return '';
  return `<span class="badge badge-acao badge-acao-${codigo}">${label || codigo}</span>`;
}

function formatDate(d) {
  if (!d) return '-';
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  if (!y || !m || !day) return '-';
  return `${day}/${m}/${y}`;
}

function hojeISOLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DIAS_SEMANA = [
  { id: 1, label: 'Segunda' },
  { id: 2, label: 'Terça' },
  { id: 3, label: 'Quarta' },
  { id: 4, label: 'Quinta' },
  { id: 5, label: 'Sexta' },
  { id: 6, label: 'Sábado' },
  { id: 7, label: 'Domingo' },
];

function labelDiaSemana(n) {
  return DIAS_SEMANA.find((d) => d.id === Number(n))?.label || '';
}

function optionsDiaSemana(selected, { incluirVazio = false, vazioLabel = '— Escolha o dia —' } = {}) {
  const vazio = incluirVazio ? `<option value="">${vazioLabel}</option>` : '';
  return vazio + DIAS_SEMANA.map((d) => (
    `<option value="${d.id}"${Number(selected) === d.id ? ' selected' : ''}>${d.label}</option>`
  )).join('');
}

function semanaMedicaoBrasil(agora = new Date()) {
  const hoje = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
  }).format(agora);
  const isoDia = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd] || 1;
  const [y, m, d] = hoje.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const monday = utc - (isoDia - 1) * 86_400_000;
  const sunday = monday + 6 * 86_400_000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    hoje,
    isoDia,
    inicio: iso(monday),
    fim: iso(sunday),
    diaHojeLabel: labelDiaSemana(isoDia),
  };
}

function medidoNestaSemana(ultima, semana) {
  if (!ultima || !semana?.inicio) return false;
  const d = String(ultima).slice(0, 10);
  return d >= semana.inicio && d <= semana.fim;
}

/** Corrige tipos com acento corrompido vindos do banco */
function normalizarTipoLabel(tipo) {
  if (!tipo) return tipo;
  if (/^Truck\s*\/\s*Tra/i.test(tipo) && tipo !== 'Truck / Tração') return 'Truck / Tração';
  if (tipo.includes('\uFFFD') || tipo.includes('�')) {
    return tipo
      .replace(/Truck\s*\/\s*Tra.+?o/i, 'Truck / Tração')
      .replace(/Caminh.?o/gi, 'Caminhão')
      .replace(/Utilit.?rio/gi, 'Utilitário')
      .replace(/Ve.?culo/gi, 'Veículo');
  }
  return tipo;
}

function numOrNull(id) {
  const v = parseFloat(document.getElementById(id)?.value);
  return Number.isFinite(v) ? v : null;
}

function atualizarPreviewLimites() {
  const critico = parseFloat(document.getElementById('cfg-critico')?.value) || limitesAtuais.sulco_critico_mm;
  const monitorar = parseFloat(document.getElementById('cfg-alerta')?.value) || limitesAtuais.sulco_alerta_mm;
  const prazo = parseInt(document.getElementById('cfg-prazo-recap')?.value, 10) || limitesAtuais.prazo_recap_dias || 15;

  const elCritico = document.getElementById('preview-critico');
  const elAlerta = document.getElementById('preview-alerta');
  const elOk = document.getElementById('preview-ok');
  if (elCritico) elCritico.textContent = `≤ ${critico} mm`;
  if (elAlerta) elAlerta.textContent = `> ${critico} – ${monitorar} mm`;
  if (elOk) elOk.textContent = `> ${monitorar} mm`;

  const hintMon = document.getElementById('hint-faixa-monitorar');
  const hintOk = document.getElementById('hint-faixa-ok');
  if (hintMon) hintMon.textContent = `Acima de ${critico} mm até ${monitorar} mm · recap em até ${prazo} dias`;
  if (hintOk) hintOk.textContent = `Acima de ${monitorar} mm`;

  // Mantém cfg-recap alinhado ao crítico (sem banda intermediária)
  const cfgRecap = document.getElementById('cfg-recap');
  if (cfgRecap) cfgRecap.value = String(critico);

  const trocaL = document.getElementById('cfg-acao-troca-label')?.value?.trim() || 'Trocar';
  const monL = document.getElementById('cfg-acao-monitorar-label')?.value?.trim() || 'Monitorar';
  const okL = document.getElementById('cfg-acao-ok-label')?.value?.trim() || 'OK';
  const trocaI = document.getElementById('cfg-acao-troca-instrucao')?.value?.trim() || '—';
  const monI = document.getElementById('cfg-acao-monitorar-instrucao')?.value?.trim() || '—';
  const okI = document.getElementById('cfg-acao-ok-instrucao')?.value?.trim() || '—';

  const setTxt = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  setTxt('preview-label-troca', trocaL);
  setTxt('preview-label-monitorar', monL);
  setTxt('preview-label-ok', okL);
  setTxt('leg-troca-label', `${trocaL}:`);
  setTxt('leg-monitorar-label', `${monL}:`);
  setTxt('leg-ok-label', `${okL}:`);
  setTxt('leg-troca-instrucao', trocaI);
  setTxt('leg-monitorar-instrucao', monI);
  setTxt('leg-ok-instrucao', okI);
}

function hintLimites() {
  const { sulco_critico_mm: c, sulco_alerta_mm: a, prazo_recap_dias: p, acoes } = limitesAtuais;
  const t = acoes?.troca?.label || 'Trocar';
  const m = acoes?.monitorar?.label || 'Monitorar';
  const o = acoes?.ok?.label || 'OK';
  return `≤ ${c} mm → ${t} · > ${c}–${a} mm → ${m} (recap ${p || 15}d) · > ${a} mm → ${o}`;
}

function mostrarAcaoInstrucao(pneuOuResult) {
  const el = document.getElementById('truck-acao-instrucao');
  if (!el) return;
  if (!podeVerOrientacaoGestao()) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const texto = pneuOuResult?.acao_motivo
    || pneuOuResult?.acao_instrucao
    || limitesAtuais.acoes?.[pneuOuResult?.acao_sugerida]?.instrucao
    || '';
  const codigo = pneuOuResult?.acao_sugerida || 'ok';
  if (!texto) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = texto;
  el.className = 'acao-instrucao';
  if (codigo === 'troca') el.classList.add('critico');
  else if (codigo === 'recap') el.classList.add('recap');
  else if (codigo === 'monitorar') el.classList.add('alerta');
  else if (codigo === 'rodizio') el.classList.add('rodizio');
  el.classList.remove('hidden');
}

function mostrarRodizioSugestao(pneuOuResult) {
  const el = document.getElementById('truck-rodizio-sugestao');
  if (!el) return;
  if (!podeVerOrientacaoGestao()) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const sug = pneuOuResult?.rodizio_sugestao;
  if (!sug || pneuOuResult?.acao_sugerida !== 'rodizio') {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <strong>${sug.slot_vazio ? 'Posição sugerida para rodízio' : 'Par sugerido para rodízio'}</strong>
    ${sug.label || 'Outro pneu'}
    ${sug.motivo ? `<br><span class="hint">${sug.motivo}</span>` : ''}
  `;
  el.classList.remove('hidden');
}

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.add('active');
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === name);
  });
}

function finalizarBootVisual() {
  document.documentElement.classList.add('app-ready');
  document.documentElement.classList.remove('session-pending');
  document.getElementById('app-boot')?.setAttribute('aria-busy', 'false');
}

function showLogin() {
  document.documentElement.classList.remove('session-pending', 'app-ready');
  document.getElementById('app-boot')?.setAttribute('aria-busy', 'false');
  document.getElementById('app-login').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

function showAppShell() {
  document.getElementById('app-login').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  finalizarBootVisual();

  const navFilial = document.getElementById('nav-tabs-filial');
  const navAdmin = document.getElementById('nav-tabs-admin');
  const navGerente = document.getElementById('nav-tabs-gerente');
  const label = document.getElementById('header-user-label');
  const subtitle = document.getElementById('header-subtitle');

  navFilial.classList.add('hidden');
  navAdmin.classList.add('hidden');
  navGerente?.classList.add('hidden');

  if (isAdmin()) {
    navAdmin.classList.remove('hidden');
    label.textContent = `Admin total · ${currentUser.login}`;
    subtitle.textContent = 'Relatórios, acessos e configuração global';
    document.getElementById('btn-salvar-config')?.classList.remove('hidden');
    document.getElementById('btn-nova-filial')?.classList.remove('hidden');
    const tit = document.getElementById('filiais-titulo');
    const hint = document.getElementById('filiais-hint');
    if (tit) tit.textContent = 'Filiais';
    if (hint) hint.textContent = 'Clique numa filial para ver só os dados dela (alertas e frota).';
  } else if (isGerente()) {
    navGerente?.classList.remove('hidden');
    const nome = currentUser.filial?.nome || 'Multiunidade';
    label.textContent = `Gerente · ${nome} · ${currentUser.login}`;
    subtitle.textContent = 'Alertas, compras e acessos da sua unidade';
    document.getElementById('btn-salvar-config')?.classList.add('hidden');
    document.getElementById('btn-nova-filial')?.classList.add('hidden');
    const tit = document.getElementById('filiais-titulo');
    const hint = document.getElementById('filiais-hint');
    if (tit) tit.textContent = 'Minha unidade';
    if (hint) hint.textContent = 'Painel da sua unidade: indicadores, pendências e frota para análise.';
  } else {
    navFilial.classList.remove('hidden');
    const nomeFilial = currentUser.filial?.nome || currentUser.filial?.codigo || 'Filial';
    label.textContent = `${nomeFilial} · ${currentUser.login}`;
    subtitle.textContent = 'Medições semanais e alertas da sua frota';
    document.getElementById('btn-salvar-config')?.classList.add('hidden');
  }

  aplicarVisibilidadeOrientacaoGestao();
}

function syncMarkersLimites() {
  tireMarker?.setLimites?.(limitesAtuais);
  truckTireMarker?.setLimites?.(limitesAtuais);
}

function pontosFromInputs(prefix) {
  if (prefix === 'truck') {
    return {
      externo: numOrNull('truck-sulco-ext'),
      central: numOrNull('truck-sulco-cent'),
      interno: numOrNull('truck-sulco-int'),
      auxiliar: numOrNull('truck-sulco-aux'),
    };
  }
  return {
    externo: numOrNull('med-externo'),
    central: numOrNull('med-central'),
    interno: numOrNull('med-interno'),
    auxiliar: numOrNull('med-auxiliar'),
  };
}

function atualizarPerfilLocal(containerId, pontos, diagnostico = null) {
  renderPerfilSulco(containerId, pontos, limitesAtuais, diagnostico);
}

// ── Navegação ────────────────────────────────────────────

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    showView(view);
    if (view === 'dashboard') loadDashboard();
    if (view === 'veiculos') loadVeiculos();
    if (view === 'pneus') loadPneus();
    if (view === 'medicao') initMedicao();
    if (view === 'alertas') loadAlertas();
    if (view === 'acoes') loadAcoes();
    if (view === 'chatbot') {
      if (!isGerente()) {
        toast('Chatbot WhatsApp: só o gerente da unidade', 'error');
        showView(isAdmin() ? 'relatorios' : isGestao() ? 'filiais' : 'dashboard');
        return;
      }
      loadChatbotGerente();
    }
    if (view === 'configuracoes') {
      if (!isAdmin()) {
        toast('Limites são definidos pelo administrador total', 'error');
        showView(isGerente() ? 'filiais' : 'dashboard');
        if (isGerente()) loadFiliais();
        else loadDashboard();
        return;
      }
      loadConfiguracoes();
    }
    if (view === 'filiais') {
      if (!isGestao()) {
        toast('Acesso restrito a gerentes e admin', 'error');
        return;
      }
      loadFiliais();
    }
    if (view === 'usuarios') {
      if (!isGestao()) return toast('Acesso restrito', 'error');
      loadUsuarios();
    }
    if (view === 'relatorios') {
      if (!isAdmin()) return toast('Relatórios da diretoria: só admin total', 'error');
      loadRelatorioDiretoria();
    }
  });
});

document.getElementById('btn-logout')?.addEventListener('click', () => {
  clearAuth();
  showLogin();
  toast('Sessão encerrada');
});

document.getElementById('form-login')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const erro = document.getElementById('login-erro');
  erro.classList.add('hidden');
  try {
    const data = await fetchJSON(`${API}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({
        login: document.getElementById('login-user').value,
        senha: document.getElementById('login-senha').value,
      }),
    });
    saveAuth(data.token, data.usuario);
    document.getElementById('login-senha').value = '';
    await bootApp();
  } catch (err) {
    erro.textContent = err.message;
    erro.classList.remove('hidden');
  }
});

document.getElementById('btn-voltar-dashboard').addEventListener('click', () => {
  showView(voltarPara);
  if (voltarPara === 'dashboard') loadDashboard();
  else if (voltarPara === 'acoes') loadAcoes();
  else loadVeiculos();
});

async function fetchDashboardResumo() {
  try {
    return await fetchJSON(`${API}/dashboard/resumo`);
  } catch {
    const veiculos = await fetchJSON(`${API}/veiculos`);
    return {
      veiculos_ativos: veiculos.length,
      pneus_ok: 0,
      pneus_alerta: 0,
      pneus_critico: 0,
      acoes: { troca: 0, recap: 0, monitorar: 0 },
      limites: limitesAtuais,
    };
  }
}

// ── Dashboard ──────────────────────────────────────────

async function loadDashboard() {
  try {
    const [resumo, veiculos] = await Promise.all([
      fetchDashboardResumo(),
      fetchJSON(`${API}/veiculos`),
    ]);
    veiculosCache = veiculos;
    limitesAtuais = { ...limitesAtuais, ...resumo.limites };
    syncMarkersLimites();

    document.getElementById('stat-veiculos').textContent = resumo.veiculos_ativos;
    document.getElementById('stat-ok').textContent = resumo.pneus_ok;
    document.getElementById('stat-alerta').textContent = resumo.pneus_alerta;
    document.getElementById('stat-critico').textContent = resumo.pneus_critico;
    document.getElementById('stat-troca').textContent = resumo.acoes?.troca ?? 0;
    document.getElementById('stat-recap').textContent = resumo.acoes?.monitorar ?? 0;
    document.getElementById('stat-monitorar').textContent = resumo.acoes?.rodizio ?? 0;

    const hint = document.getElementById('dashboard-limites-hint');
    if (hint) hint.textContent = hintLimites();

    const lista = document.getElementById('dashboard-lista');
    const chips = document.getElementById('dashboard-frota-chips');
    const selDia = document.getElementById('dash-dia-medicao');
    const hojeEl = document.getElementById('dash-dia-hoje');
    const semana = resumo.semana
      ? {
        hoje: resumo.semana.hoje,
        isoDia: resumo.semana.iso_dia,
        inicio: resumo.semana.inicio,
        fim: resumo.semana.fim,
        diaHojeLabel: resumo.semana.dia_hoje_label,
      }
      : semanaMedicaoBrasil();
    const diaUnidade = Number(resumo.dia_medicao) || null;
    diaMedicaoUnidade = diaUnidade;
    if (selDia) {
      if (!selDia.dataset.ready) {
        selDia.innerHTML = optionsDiaSemana(diaUnidade, { incluirVazio: true });
        selDia.dataset.ready = '1';
      } else {
        selDia.value = diaUnidade ? String(diaUnidade) : '';
      }
    }
    if (hojeEl) {
      hojeEl.textContent = diaUnidade
        ? `Hoje é ${semana.diaHojeLabel}. Meta da frota: ${labelDiaSemana(diaUnidade)}.`
        : `Hoje é ${semana.diaHojeLabel}. Escolha o dia para conferir a semana.`;
    }
    if (!veiculos.length) {
      if (chips) chips.innerHTML = '';
      lista.innerHTML = '<div class="empty-state"><h3>Nenhum veículo cadastrado</h3><p>Cadastre seu primeiro veículo na aba Veículos</p></div>';
      return;
    }

    const tsAtualizacao = (v) => {
      const raw = v.ultima_atualizacao || v.ultima_medicao;
      const t = raw ? Date.parse(raw) : 0;
      return Number.isFinite(t) ? t : 0;
    };
    const diaDoVeiculo = (v) => Number(v.dia_medicao) || diaUnidade || null;
    const naSemana = (v) => medidoNestaSemana(v.ultima_medicao, semana);
    const medidos = veiculos
      .filter((v) => naSemana(v))
      .sort((a, b) => tsAtualizacao(b) - tsAtualizacao(a));
    const pendentes = veiculos
      .filter((v) => !naSemana(v))
      .sort((a, b) => {
        const atrasoA = diaDoVeiculo(a) && semana.isoDia > diaDoVeiculo(a) ? 0 : 1;
        const atrasoB = diaDoVeiculo(b) && semana.isoDia > diaDoVeiculo(b) ? 0 : 1;
        if (atrasoA !== atrasoB) return atrasoA - atrasoB;
        return String(a.apelido || a.placa).localeCompare(String(b.apelido || b.placa), 'pt-BR');
      });

    if (chips) {
      chips.innerHTML = `
        <span class="dash-chip dash-chip-ok"><strong>${medidos.length}</strong> medidos nesta semana</span>
        <span class="dash-chip dash-chip-pendente"><strong>${pendentes.length}</strong> pendentes nesta semana</span>
      `;
    }

    const renderCard = (v, pendente) => {
      const diaV = diaDoVeiculo(v);
      const dataMed = v.ultima_medicao
        ? `Última medição: ${formatDate(v.ultima_medicao)}`
        : 'Ainda sem medição';
      const nMed = Number(v.pneus_medidos) || 0;
      const nTot = Number(v.total_pneus) || 0;
      const posTxt = nTot ? `${nMed}/${nTot} posições medidas` : 'Sem pneus montados';
      const atrasado = pendente && diaV && semana.isoDia > diaV;
      const eHoje = pendente && diaV && semana.isoDia === diaV;
      const statusSemana = !pendente
        ? '<span class="badge badge-ok">Nesta semana</span>'
        : (atrasado
          ? '<span class="badge badge-critico">Atrasado</span>'
          : (eHoje
            ? '<span class="badge badge-alerta">Medir hoje</span>'
            : '<span class="badge badge-sem_dado">Pendente</span>'));
      const diaTxt = diaV ? `Dia: ${labelDiaSemana(diaV)}` : 'Sem dia definido';
      return `
        <div class="veiculo-card${pendente ? ' veiculo-card-pendente' : ''}${atrasado ? ' veiculo-card-atrasado' : ''}" data-id="${v.id}">
          <div class="veiculo-info">
            <h4>${escapeHtml(v.apelido || v.placa)}</h4>
            <p>${escapeHtml(v.placa)} · ${escapeHtml(normalizarTipoLabel(v.tipo) || '')} · ${(v.km_atual || 0).toLocaleString('pt-BR')} km</p>
            <p class="dash-medicao-data">${escapeHtml(diaTxt)} · ${escapeHtml(dataMed)} · ${escapeHtml(posTxt)}</p>
          </div>
          <div class="veiculo-meta">
            ${v.menor_sulco != null ? `<span style="font-weight:600">${v.menor_sulco} mm</span>` : ''}
            ${badge(v.status_sulco)}
            ${statusSemana}
            ${pendente ? `<button type="button" class="btn btn-sm btn-primary btn-dash-medir" data-id="${v.id}">Medir</button>` : ''}
          </div>
        </div>
      `;
    };

    lista.innerHTML = `
      <section class="dash-frota-sec">
        <h3>Medidos nesta semana <span>${medidos.length}</span></h3>
        <p class="hint">${medidos.length ? `${semana.inicio.split('-').reverse().join('/')} a ${semana.fim.split('-').reverse().join('/')} — mais recentes primeiro.` : 'Nenhum caminhão medido nesta semana ainda.'}</p>
        ${medidos.map((v) => renderCard(v, false)).join('')}
      </section>
      <section class="dash-frota-sec">
        <h3>Pendentes nesta semana <span>${pendentes.length}</span></h3>
        <p class="hint">${pendentes.length ? (diaUnidade ? `Faltam medir até ${labelDiaSemana(diaUnidade)} (ou nesta semana).` : 'Ativos sem medição nesta semana.') : 'Toda a frota já foi medida nesta semana.'}</p>
        ${pendentes.map((v) => renderCard(v, true)).join('')}
      </section>
    `;

    lista.querySelectorAll('.veiculo-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-dash-medir')) return;
        openVeiculoDetalhe(card.dataset.id, 'dashboard');
      });
    });
    lista.querySelectorAll('.btn-dash-medir').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openVeiculoDetalhe(btn.dataset.id, 'dashboard');
      });
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('dash-dia-medicao')?.addEventListener('change', async (e) => {
  const raw = e.target.value;
  const dia = raw ? Number(raw) : null;
  try {
    const data = await fetchJSON(`${API}/dashboard/dia-medicao`, {
      method: 'PUT',
      body: JSON.stringify({ dia_medicao: dia }),
    });
    toast(data.mensagem || 'Dia da frota salvo', 'success');
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Veículos ───────────────────────────────────────────

async function loadVeiculos() {
  try {
    const veiculos = await fetchJSON(`${API}/veiculos`);
    veiculosCache = veiculos;
    const lista = document.getElementById('veiculos-lista');

    if (!veiculos.length) {
      lista.innerHTML = '<div class="empty-state"><h3>Nenhum veículo</h3><p>Clique em "+ Novo Veículo" para começar</p></div>';
      return;
    }

    lista.innerHTML = veiculos.map((v) => `
      <div class="veiculo-card" data-id="${v.id}">
        <div class="veiculo-info">
          <h4>${v.apelido || v.placa}</h4>
          <p>${v.placa} · ${v.tipo} · ${v.total_pneus} pneus · ${v.km_atual?.toLocaleString('pt-BR') || 0} km</p>
        </div>
        <div class="veiculo-meta">
          ${badge(v.status_sulco)}
          <button class="btn btn-sm btn-primary btn-medir" data-id="${v.id}">Medir</button>
        </div>
      </div>
    `).join('');

    lista.querySelectorAll('.veiculo-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-medir')) return;
        openVeiculoDetalhe(card.dataset.id, 'veiculos');
      });
    });

    lista.querySelectorAll('.btn-medir').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openVeiculoDetalhe(btn.dataset.id, 'veiculos');
      });
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function garantirSessaoCampo(veiculoId) {
  const id = Number(veiculoId);
  if (sessaoCampoVeiculoId !== id) {
    sessaoCampoVeiculoId = id;
    pneusMedidosSessao = new Set();
  }
}

function resumoSessaoCampo() {
  const total = veiculoAtual?.pneus?.length || 0;
  if (!total) return '';
  const feitos = pneusMedidosSessao.size;
  const falta = Math.max(0, total - feitos);
  if (!feitos) return `${total} pneu(s) para medir`;
  if (!falta) return `Todos os ${total} pneus desta visita já foram medidos`;
  return `${feitos} de ${total} medidos nesta visita · faltam ${falta}`;
}

function atualizarProgressoCampo() {
  const texto = resumoSessaoCampo();
  const nav = document.getElementById('truck-campo-progresso');
  if (nav) nav.textContent = texto;
  const resumo = document.getElementById('truck-campo-resumo');
  if (resumo) resumo.textContent = texto;
}

function marcarPneusMedidosSessao() {
  truckDiagram?.container?.querySelectorAll('.pneu-click').forEach((g) => {
    g.classList.toggle('pneu-sessao-ok', pneusMedidosSessao.has(Number(g.dataset.pneuId)));
  });
  truckDiagram?.container?.querySelectorAll('.tire-pick').forEach((btn) => {
    btn.classList.toggle('is-sessao-ok', pneusMedidosSessao.has(Number(btn.dataset.pneuId)));
  });
  atualizarProgressoCampo();
}

function entrarMedicaoCampo() {
  if (!modoAcessoRapido) {
    document.getElementById('truck-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  document.getElementById('view-veiculo-detalhe')?.classList.add('campo-medindo');
  document.getElementById('truck-campo-nav')?.classList.remove('hidden');
  atualizarProgressoCampo();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const primeiroVazio = ['truck-sulco-ext', 'truck-sulco-cent', 'truck-sulco-int', 'truck-sulco-aux']
    .map((id) => document.getElementById(id))
    .find((el) => el && String(el.value).trim() === '');
  setTimeout(() => {
    (primeiroVazio || document.getElementById('truck-sulco-ext'))?.focus({ preventScroll: true });
  }, 200);
}

function voltarDesenhoCampo({ toastProx = false } = {}) {
  document.getElementById('view-veiculo-detalhe')?.classList.remove('campo-medindo');
  document.getElementById('truck-campo-nav')?.classList.add('hidden');
  document.getElementById('truck-panel-form')?.classList.add('hidden');
  document.querySelector('.truck-panel-empty')?.classList.remove('hidden');
  pneuSelecionado = null;
  slotPosicaoSelecionada = null;
  truckDiagram?.setAtivo(null);
  marcarPneusMedidosSessao();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (toastProx) {
    const falta = (veiculoAtual?.pneus || []).filter((p) => !pneusMedidosSessao.has(p.id)).length;
    toast(
      falta
        ? `Medição salva. Toque no próximo pneu (${falta} restante${falta > 1 ? 's' : ''}).`
        : 'Todos os pneus desta visita foram medidos.',
      'success'
    );
  }
}

async function openVeiculoDetalhe(id, origem = 'dashboard', dadosPreload = null) {
  voltarPara = origem;
  try {
    const v = dadosPreload || await fetchJSON(`${API}/veiculos/${id}`);
    veiculoAtual = v;
    veiculoLayoutId = v.id;
    garantirSessaoCampo(v.id);
    document.getElementById('view-veiculo-detalhe')?.classList.remove('campo-medindo');
    document.getElementById('truck-campo-nav')?.classList.add('hidden');

    if (v.posicoes) meta = { ...meta, posicoes: v.posicoes };
    if (v.limites) {
      limitesAtuais = { ...limitesAtuais, ...v.limites };
      syncMarkersLimites();
    }

    const layoutInfo = getLayoutById(v.layout_pneus);
    const nPos = v.posicoes_layout?.length || v.layout?.posicoes?.length || v.pneus.length;
    document.getElementById('truck-header').innerHTML = `
      <h2>${v.apelido || v.placa}</h2>
      <p class="hint">${v.placa} · ${normalizarTipoLabel(v.tipo)} · ${v.km_atual?.toLocaleString('pt-BR') || 0} km
        ${v.hr_atual ? ` · ${v.hr_atual} h` : ''}
        · ${layoutInfo?.nome || 'Personalizado'}
        · ${v.pneus.length}/${nPos} pneus montados</p>
    `;

    const barRapido = document.getElementById('acesso-rapido-bar');
    if (barRapido) barRapido.classList.toggle('hidden', !modoAcessoRapido);

    const btnVoltar = document.getElementById('btn-voltar-dashboard');
    if (btnVoltar) btnVoltar.classList.toggle('hidden', modoAcessoRapido);

    const banner = document.getElementById('truck-fluxo-banner');
    if (banner) {
      if (modoAcessoRapido) {
        banner.classList.remove('hidden');
        banner.innerHTML = `
          <strong>Modo campo (WhatsApp)</strong>
          <span>Toque no pneu para medir · ao concluir, volta ao desenho para o próximo</span>
          <span id="truck-campo-resumo">${resumoSessaoCampo()}</span>`;
      } else if (v.pneus.length === 0) {
        banner.classList.remove('hidden');
        banner.innerHTML = `
          <strong>Clique em uma posição vazia para colocar o pneu</strong>
          Não precisa ir na aba Pneus: no slot (+) você cria e monta na hora.
          Se já tiver pneu no estoque, use a aba “Do estoque”.`;
      } else if (v.pneus.length < nPos) {
        banner.classList.remove('hidden');
        banner.innerHTML = `
          <strong>${v.pneus.length} de ${nPos} posições com pneu</strong>
          Clique em um slot vazio (+) para colocar o próximo.`;
      } else {
        banner.classList.add('hidden');
        banner.innerHTML = '';
      }
    }

    document.getElementById('historico-pneu').innerHTML = '';
    document.getElementById('truck-panel-form').classList.add('hidden');
    document.querySelector('.truck-panel-empty').classList.remove('hidden');
    pneuSelecionado = null;
    slotPosicaoSelecionada = null;

    const posicoesLayout = v.posicoes_layout?.length
      ? v.posicoes_layout.map((p) => p.codigo)
      : (v.layout?.posicoes || v.pneus.map((p) => p.posicao));

    if (!truckDiagram) {
      truckDiagram = new TruckDiagram('truck-diagram-container', {
        onPneuClick: (pneu) => selecionarPneuTruck(pneu),
        onSlotClick: (posicao) => selecionarSlotVazio(posicao),
      });
    }
    truckDiagram.pickerHint = modoAcessoRapido
      ? 'Toque no pneu para abrir a medição. Ao concluir, volta para o próximo.'
      : 'Clique no pneu para medir ou no slot vazio para montar:';
    truckDiagram.render(v.pneus, meta.posicoes, posicoesLayout);
    marcarPneusMedidosSessao();

    document.getElementById('truck-km').value = v.km_atual || '';
    document.getElementById('truck-hr').value = v.hr_atual || '';
    document.getElementById('btn-truck-config').onclick = () => {
      if (modoAcessoRapido) return toast('Indisponível no acesso rápido', 'error');
      if (!isGestao()) return toast('Só o gerente configura o layout do veículo', 'error');
      abrirConfigLayout(
        v.id,
        v.apelido || v.placa,
        v.layout_pneus,
        posicoesLayout
      );
    };

    const btnWa = document.getElementById('btn-truck-whatsapp');
    if (btnWa) {
      btnWa.onclick = () => {
        if (!isGestao()) return toast('Só o gerente compartilha o link WhatsApp', 'error');
        gerarLinkWhatsApp(v.id, v.placa);
      };
    }

    aplicarVisibilidadeAcessoRapido();
    showView('veiculo-detalhe');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function labelPadraoPneu(codigo) {
  const map = {
    direcional: 'Direcional',
    misto: 'Misto (tração)',
    borrachudo: 'Borrachudo',
  };
  return map[codigo] || codigo || '—';
}

function formatUltimaMedicaoSulco(pneu) {
  const u = pneu.ultima_medicao;
  const menor = pneu.menor_sulco ?? u?.menor_sulco;
  const data = u?.data || pneu.ult_medicao;
  if (menor == null && !data) return 'Sem medição';
  const pts = [
    u?.sulco_externo ?? pneu.ult_sulco_ext,
    u?.sulco_central ?? pneu.ult_sulco_cent,
    u?.sulco_interno ?? pneu.ult_sulco_int,
    u?.sulco_auxiliar ?? pneu.ult_sulco_aux,
  ].map((v) => (v != null ? `${v}` : '—')).join(' · ');
  const dataTxt = data ? formatDate(data) : '—';
  return `${menor != null ? `${menor} mm` : '—'} (${pts}) · ${dataTxt}`;
}

function atualizarResumoPneuTruck(pneu) {
  const partes = [];
  if (pneu.numero_fogo) partes.push(`Fogo ${pneu.numero_fogo}`);
  if (pneu.marca) partes.push(pneu.marca);
  if (pneu.dot) partes.push(`DOT ${pneu.dot}`);
  document.getElementById('truck-pneu-resumo').textContent = partes.length
    ? partes.join(' · ')
    : 'Pneu montado nesta posição';

  const elPadrao = document.getElementById('truck-pneu-padrao');
  const elCond = document.getElementById('truck-pneu-condicao-label');
  const elSulco = document.getElementById('truck-pneu-ultima-sulco');
  if (elPadrao) elPadrao.textContent = pneu.padrao_label || labelPadraoPneu(pneu.tipo_pneu);
  if (elCond) elCond.textContent = pneu.vida_label || (pneu.condicao === 'recapado' ? 'Recapado' : 'Novo');
  if (elSulco) elSulco.textContent = formatUltimaMedicaoSulco(pneu);
}

function aplicarVisibilidadeAcessoRapido() {
  const idsOps = [
    'btn-truck-desmontar',
    'btn-truck-reposicionar',
    'btn-truck-recap',
    'btn-truck-troca',
  ];
  idsOps.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', modoAcessoRapido);
  });
  // Gestão (layout / histórico / WhatsApp): só gerente/admin — operador não vê
  const gestao = document.getElementById('truck-panel-acoes-gestao');
  if (gestao) {
    gestao.classList.toggle('gestao-only-hidden', !isGestao() || modoAcessoRapido);
  }
  const btnWa = document.getElementById('btn-truck-whatsapp');
  if (btnWa) btnWa.classList.toggle('hidden', modoAcessoRapido || !isGestao());
  // No acesso rápido permite montar pneu novo; estoque fica oculto
  const tabEstoque = document.querySelector('.montar-tab[data-montar-tab="estoque"]');
  if (tabEstoque) tabEstoque.classList.toggle('hidden', modoAcessoRapido);
  const avancado = document.querySelector('#truck-montar-novo .form-avancado');
  if (avancado && modoAcessoRapido) avancado.classList.add('hidden');
  const custo = document.getElementById('truck-novo-custo')?.closest('.form-group');
  const nota = document.getElementById('truck-novo-nota')?.closest('.form-group');
  if (custo) custo.classList.toggle('hidden', modoAcessoRapido);
  if (nota) nota.classList.toggle('hidden', modoAcessoRapido);
  const btnSulco = document.getElementById('btn-truck-salvar-sulco');
  if (btnSulco) {
    btnSulco.textContent = modoAcessoRapido ? 'Concluir medição e voltar' : 'Salvar medição de sulco';
  }
  const empty = document.querySelector('.truck-panel-empty');
  if (empty) {
    empty.innerHTML = modoAcessoRapido
      ? '<p>Toque em um pneu no desenho</p><p class="hint">Abre a medição na hora. Ao concluir, volta para o próximo.</p>'
      : '<p>Clique em uma posição</p><p class="hint">Slot vazio (+) = colocar pneu · Pneu montado = medir sulco</p>';
  }
  const bar = document.getElementById('acesso-rapido-bar');
  if (bar && modoAcessoRapido) {
    bar.innerHTML = `
      <span><strong>Modo campo</strong> — meça sulcos ou informe pneu novo · link 24h</span>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-rapido-recarregar">Atualizar</button>`;
    document.getElementById('btn-rapido-recarregar')?.addEventListener('click', () => recarregarAcessoRapido());
  }
}

async function recarregarAcessoRapido() {
  if (!tokenAcessoRapido) return;
  try {
    const data = await fetchJSON(`${API}/veiculos/acesso-rapido?token=${encodeURIComponent(tokenAcessoRapido)}`);
    tokenAcessoRapido = data.token_acesso || tokenAcessoRapido;
    await openVeiculoDetalhe(data.id, 'acesso-rapido', data);
    toast('Veículo atualizado', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function gerarLinkWhatsApp(veiculoId, placa) {
  try {
    const data = await fetchJSON(`${API}/veiculos/${veiculoId}/link-whatsapp`);
    const texto = `🚛 *${data.placa || placa}*\n👉 ${data.link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank');
    toast('Link gerado — abrindo WhatsApp', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function selecionarPneuTruck(pneu) {
  pneuSelecionado = pneu;
  slotPosicaoSelecionada = null;
  document.querySelector('.truck-panel-empty').classList.add('hidden');
  document.getElementById('truck-panel-form').classList.remove('hidden');
  document.getElementById('truck-montar-box').classList.add('hidden');
  document.getElementById('truck-medicao-box').classList.remove('hidden');

  const nome = meta.posicoes[pneu.posicao] || pneu.posicao_label || pneu.posicao;
  document.getElementById('truck-pneu-nome').textContent =
    `${nome}${pneu.numero_fogo ? ` · Fogo ${pneu.numero_fogo}` : ''}`;
  document.getElementById('truck-pneu-status').innerHTML = badge(pneu.status_sulco);
  document.getElementById('truck-pneu-acao').innerHTML = podeVerOrientacaoGestao()
    ? badgeAcao(pneu.acao_sugerida, pneu.acao_label)
    : '';
  document.getElementById('truck-pneu-vida').innerHTML = pneu.vida_label
    ? `<span class="badge badge-vida">${pneu.vida_label}${pneu.vida_util_pct != null ? ` · ${pneu.vida_util_pct}%` : ''}</span>`
    : '';

  atualizarResumoPneuTruck(pneu);

  document.getElementById('truck-sulco-ext').value = pneu.ult_sulco_ext ?? '';
  document.getElementById('truck-sulco-cent').value = pneu.ult_sulco_cent ?? '';
  document.getElementById('truck-sulco-int').value = pneu.ult_sulco_int ?? '';
  document.getElementById('truck-sulco-aux').value = pneu.ult_sulco_aux ?? '';
  document.getElementById('truck-pressao').value = '';
  document.getElementById('truck-save-status').textContent = 'Preencha os sulcos — salva automaticamente';
  document.getElementById('truck-save-status').className = 'hint save-status';

  const diagEl = document.getElementById('truck-diagnostico');
  if (podeVerOrientacaoGestao()) {
    diagEl.textContent = pneu.diagnostico_label
      ? `Diagnóstico: ${pneu.diagnostico_label}`
      : '';
    diagEl.classList.remove('gestao-only-hidden');
  } else {
    diagEl.textContent = '';
    diagEl.classList.add('gestao-only-hidden');
  }
  mostrarAcaoInstrucao(pneu);
  mostrarRodizioSugestao(pneu);

  const pontos = {
    externo: pneu.ult_sulco_ext,
    central: pneu.ult_sulco_cent,
    interno: pneu.ult_sulco_int,
    auxiliar: pneu.ult_sulco_aux,
  };
  atualizarPerfilLocal('truck-perfil', pontos, podeVerOrientacaoGestao()
    ? { label: pneu.diagnostico_label, desc: pneu.acao_motivo }
    : null);

  if (!truckTireMarker) {
    truckTireMarker = new TireMarker('truck-mini-marker', {
      limites: limitesAtuais,
      onSulcoClick: (sulco) => {
        const map = {
          externo: 'truck-sulco-ext',
          central: 'truck-sulco-cent',
          interno: 'truck-sulco-int',
          auxiliar: 'truck-sulco-aux',
        };
        const input = document.getElementById(map[sulco]);
        if (!input) return;
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        input.focus({ preventScroll: true });
        input.select();
      },
    });
  }
  truckTireMarker.setLimites(limitesAtuais);
  truckTireMarker.setValores(
    pneu.ult_sulco_ext,
    pneu.ult_sulco_cent,
    pneu.ult_sulco_int,
    pneu.ult_sulco_aux
  );

  document.getElementById('btn-truck-historico').onclick = () => abrirHistoricoPneu(pneu.id);
  document.getElementById('btn-truck-desmontar').onclick = () => desmontarPneuTruck();
  document.getElementById('btn-truck-reposicionar').onclick = () => reposicionarPneuTruck();
  document.getElementById('btn-truck-recap').onclick = () => {
    if (!pneuSelecionado) return;
    abrirModalEnviarRecap({
      id: pneuSelecionado.id,
      fogo: pneuSelecionado.numero_fogo,
      origem: 'truck',
    });
  };
  document.getElementById('btn-truck-troca').onclick = () => registrarEventoPneu('descarte');
  aplicarVisibilidadeAcessoRapido();

  // Prazo de recap (15 dias) quando em monitorar
  let elPrazo = document.getElementById('truck-prazo-recap');
  if (!elPrazo) {
    elPrazo = document.createElement('p');
    elPrazo.id = 'truck-prazo-recap';
    elPrazo.className = 'hint';
    document.getElementById('truck-medicao-box')?.prepend(elPrazo);
  }
  if (pneu.status_sulco === 'alerta' && pneu.data_limite_recap) {
    const dias = pneu.dias_restantes_recap;
    const urg = dias != null && dias <= 3 ? ' text-critico' : '';
    elPrazo.className = `hint${urg}`;
    elPrazo.textContent = dias != null && dias < 0
      ? `Prazo de recap vencido desde ${formatDate(pneu.data_limite_recap)}`
      : `Iniciar processo de recap até ${formatDate(pneu.data_limite_recap)}${dias != null ? ` (${dias} dia(s))` : ''}`;
    elPrazo.classList.remove('hidden');
  } else {
    elPrazo.textContent = '';
    elPrazo.classList.add('hidden');
  }
  entrarMedicaoCampo();
}

async function selecionarSlotVazio(posicao) {
  pneuSelecionado = null;
  slotPosicaoSelecionada = posicao;
  document.querySelector('.truck-panel-empty').classList.add('hidden');
  document.getElementById('truck-panel-form').classList.remove('hidden');
  document.getElementById('truck-montar-box').classList.remove('hidden');
  document.getElementById('truck-medicao-box').classList.add('hidden');

  const nome = meta.posicoes[posicao] || posicao;
  document.getElementById('truck-pneu-nome').textContent = modoAcessoRapido
    ? `${nome} — informar pneu novo`
    : `${nome} — vazio`;
  document.getElementById('truck-pneu-status').innerHTML = '';
  document.getElementById('truck-pneu-acao').innerHTML = '';
  document.getElementById('truck-pneu-vida').innerHTML = '';

  resetFormMontarNovo();
  setMontarTab('novo');
  aplicarVisibilidadeAcessoRapido();
  if (!modoAcessoRapido) {
    await carregarSelectEstoque();
  }
  const hint = document.getElementById('truck-montar-hint');
  if (hint) {
    hint.textContent = modoAcessoRapido
      ? 'Preencha fogo, padrão e modelo e toque em “Criar e montar”.'
      : 'Posição vazia — coloque um pneu aqui.';
  }
  entrarMedicaoCampo();
}

function resetFormMontarNovo() {
  const fogo = document.getElementById('truck-novo-fogo');
  if (fogo) fogo.value = '';
  const tipo = document.getElementById('truck-novo-tipo');
  if (tipo) tipo.value = 'misto';
  const cond = document.getElementById('truck-novo-condicao');
  if (cond) cond.value = 'novo';
  const marca = document.getElementById('truck-novo-marca');
  if (marca) marca.value = '';
  const modelo = document.getElementById('truck-novo-modelo');
  if (modelo) modelo.value = '';
  const custo = document.getElementById('truck-novo-custo');
  if (custo) custo.value = '';
  const nota = document.getElementById('truck-novo-nota');
  if (nota) nota.value = '';
  const dot = document.getElementById('truck-novo-dot');
  if (dot) dot.value = '';
  const vida = document.getElementById('truck-novo-vida');
  if (vida) vida.value = '0';
  const sulco = document.getElementById('truck-novo-sulco');
  if (sulco) sulco.value = '';
  const avancado = document.querySelector('#truck-montar-novo .form-avancado');
  if (avancado) avancado.open = false;
}

function setMontarTab(tab) {
  document.querySelectorAll('.montar-tab').forEach((btn) => {
    btn.classList.toggle('ativo', btn.dataset.montarTab === tab);
  });
  document.getElementById('truck-montar-novo')?.classList.toggle('hidden', tab !== 'novo');
  document.getElementById('truck-montar-estoque')?.classList.toggle('hidden', tab !== 'estoque');
}

async function criarEMontarPneuTruck() {
  if (!veiculoAtual || !slotPosicaoSelecionada) return;
  const fogo = document.getElementById('truck-novo-fogo')?.value?.trim();
  if (!fogo) return toast('Informe o nº de fogo', 'error');
  const modelo = document.getElementById('truck-novo-modelo')?.value?.trim();
  if (!modelo) return toast('Informe o modelo do pneu', 'error');

  const btn = document.getElementById('btn-truck-criar-montar');
  if (btn) btn.disabled = true;
  try {
    if (modoAcessoRapido) {
      if (!tokenAcessoRapido) throw new Error('Token de acesso rápido ausente');
      const result = await fetchJSON(`${API}/veiculos/acesso-rapido/montar-novo`, {
        method: 'POST',
        body: JSON.stringify({
          token: tokenAcessoRapido,
          posicao: slotPosicaoSelecionada,
          numero_fogo: fogo,
          tipo_pneu: document.getElementById('truck-novo-tipo')?.value || 'misto',
          condicao: document.getElementById('truck-novo-condicao')?.value || 'novo',
          marca: document.getElementById('truck-novo-marca')?.value || null,
          modelo,
          sulco_inicial_mm: numOrNull('truck-novo-sulco'),
          km_veiculo: numOrNull('truck-km') ?? veiculoAtual.km_atual,
          hr_veiculo: numOrNull('truck-hr') ?? veiculoAtual.hr_atual,
        }),
      });
      toast(result.mensagem || 'Pneu montado', 'success');
      const pos = slotPosicaoSelecionada;
      tokenAcessoRapido = result.token_acesso || tokenAcessoRapido;
      await openVeiculoDetalhe(result.veiculo?.id || veiculoAtual.id, 'acesso-rapido', result.veiculo);
      const montado = veiculoAtual?.pneus?.find((p) => p.posicao === pos);
      if (montado) {
        truckDiagram?.setAtivo(montado.id);
        selecionarPneuTruck(montado);
        toast('Agora informe os sulcos deste pneu', 'success');
      }
      return;
    }

    const criado = await fetchJSON(`${API}/pneus`, {
      method: 'POST',
      body: JSON.stringify({
        numero_fogo: fogo,
        tipo_pneu: document.getElementById('truck-novo-tipo')?.value || 'misto',
        condicao: document.getElementById('truck-novo-condicao')?.value || 'novo',
        marca: document.getElementById('truck-novo-marca')?.value || null,
        modelo,
        custo: numOrNull('truck-novo-custo'),
        nota_fiscal: document.getElementById('truck-novo-nota')?.value?.trim() || null,
        dot: document.getElementById('truck-novo-dot')?.value || null,
        vida_recap: parseInt(document.getElementById('truck-novo-vida')?.value || '0', 10),
        sulco_inicial_mm: numOrNull('truck-novo-sulco'),
      }),
    });
    const pneuId = criado.pneu?.id || criado.id;
    if (!pneuId) throw new Error('Pneu criado sem id');

    await fetchJSON(`${API}/pneus/${pneuId}/montar`, {
      method: 'POST',
      body: JSON.stringify({
        veiculo_id: veiculoAtual.id,
        posicao: slotPosicaoSelecionada,
        km_veiculo: numOrNull('truck-km') ?? veiculoAtual.km_atual,
        hr_veiculo: numOrNull('truck-hr') ?? veiculoAtual.hr_atual,
      }),
    });
    toast('Pneu criado e montado');
    const pos = slotPosicaoSelecionada;
    await openVeiculoDetalhe(veiculoAtual.id, voltarPara);
    const montado = veiculoAtual.pneus.find((p) => p.posicao === pos);
    if (montado) {
      truckDiagram?.setAtivo(montado.id);
      selecionarPneuTruck(montado);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function carregarSelectEstoque() {
  const select = document.getElementById('truck-estoque-select');
  try {
    const lista = await fetchJSON(`${API}/pneus?status=estoque`);
    if (!lista.length) {
      select.innerHTML = '<option value="">Nenhum pneu no estoque</option>';
      return;
    }
    select.innerHTML = '<option value="">Selecione...</option>' + lista.map((p) => {
      const label = [
        p.numero_fogo ? `Fogo ${p.numero_fogo}` : `#${p.id}`,
        p.marca,
        p.condicao === 'recapado' ? (p.vida_label || 'Recap') : 'Novo',
        p.padrao_label || labelPadraoPneu(p.tipo_pneu),
      ].filter(Boolean).join(' · ');
      return `<option value="${p.id}">${label}</option>`;
    }).join('');
  } catch (err) {
    select.innerHTML = `<option value="">Erro: ${err.message}</option>`;
  }
}

async function montarPneuDoEstoque() {
  if (!veiculoAtual || !slotPosicaoSelecionada) return;
  const pneuId = parseInt(document.getElementById('truck-estoque-select').value, 10);
  if (!pneuId) return toast('Selecione um pneu do estoque', 'error');

  try {
    await fetchJSON(`${API}/pneus/${pneuId}/montar`, {
      method: 'POST',
      body: JSON.stringify({
        veiculo_id: veiculoAtual.id,
        posicao: slotPosicaoSelecionada,
        km_veiculo: numOrNull('truck-km') ?? veiculoAtual.km_atual,
        hr_veiculo: numOrNull('truck-hr') ?? veiculoAtual.hr_atual,
      }),
    });
    toast('Pneu montado');
    const pos = slotPosicaoSelecionada;
    await openVeiculoDetalhe(veiculoAtual.id, voltarPara);
    const montado = veiculoAtual.pneus.find((p) => p.posicao === pos);
    if (montado) {
      truckDiagram?.setAtivo(montado.id);
      selecionarPneuTruck(montado);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function desmontarPneuTruck() {
  if (!pneuSelecionado || !veiculoAtual) return;
  if (!confirm('Retirar este pneu do caminhão e enviar ao estoque?')) return;
  try {
    await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/desmontar`, {
      method: 'POST',
      body: JSON.stringify({
        km_veiculo: numOrNull('truck-km') ?? veiculoAtual.km_atual,
        hr_veiculo: numOrNull('truck-hr') ?? veiculoAtual.hr_atual,
      }),
    });
    toast('Pneu retirado → estoque');
    await openVeiculoDetalhe(veiculoAtual.id, voltarPara);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function reposicionarPneuTruck() {
  if (!pneuSelecionado || !veiculoAtual) return;
  const posicoes = veiculoAtual.layout?.posicoes || Object.keys(meta.posicoes || {});
  const ocupadas = new Set((veiculoAtual.pneus || []).map((p) => p.posicao));
  const livres = posicoes.filter((p) => p !== pneuSelecionado.posicao && !ocupadas.has(p));
  if (!livres.length) {
    return toast('Não há posição livre neste caminhão', 'error');
  }
  const opcoes = livres.map((p) => `${p} = ${meta.posicoes[p] || p}`).join('\n');
  const nova = prompt(`Nova posição (código):\n${opcoes}`, livres[0]);
  if (!nova) return;
  const codigo = nova.trim().toUpperCase();
  if (!posicoes.includes(codigo) && !posicoes.includes(nova.trim())) {
    return toast('Posição inválida', 'error');
  }
  const posFinal = posicoes.includes(codigo) ? codigo : nova.trim();
  try {
    await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/reposicionar`, {
      method: 'POST',
      body: JSON.stringify({
        posicao: posFinal,
        km_veiculo: numOrNull('truck-km') ?? veiculoAtual.km_atual,
        hr_veiculo: numOrNull('truck-hr') ?? veiculoAtual.hr_atual,
      }),
    });
    toast(`Posição alterada para ${meta.posicoes[posFinal] || posFinal}`);
    await openVeiculoDetalhe(veiculoAtual.id, voltarPara);
    const movido = veiculoAtual.pneus.find((p) => p.id === pneuSelecionado.id);
    if (movido) {
      truckDiagram?.setAtivo(movido.id);
      selecionarPneuTruck(movido);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function syncTruckMarkerFromInputs() {
  if (!truckTireMarker) return;
  const p = pontosFromInputs('truck');
  truckTireMarker.setValores(p.externo, p.central, p.interno, p.auxiliar);
  atualizarPerfilLocal('truck-perfil', p);
}

function agendarAutoSave() {
  clearTimeout(autoSaveTimer);
  const status = document.getElementById('truck-save-status');
  status.textContent = 'Salvando...';
  status.className = 'hint save-status salvando';
  autoSaveTimer = setTimeout(salvarMedicaoTruck, 700);
}

async function salvarMedicaoTruck({ concluir = false } = {}) {
  if (!pneuSelecionado || !veiculoAtual) return;

  const pontos = pontosFromInputs('truck');
  const pressao = numOrNull('truck-pressao');
  const km = parseInt(document.getElementById('truck-km').value, 10);
  const hr = numOrNull('truck-hr');

  if (pontos.externo == null && pontos.central == null && pontos.interno == null && pontos.auxiliar == null) {
    document.getElementById('truck-save-status').textContent = 'Informe ao menos um sulco';
    document.getElementById('truck-save-status').className = 'hint save-status';
    return;
  }

  const status = document.getElementById('truck-save-status');
  try {
    const result = await fetchJSON(`${API}/medicoes`, {
      method: 'POST',
      body: JSON.stringify({
        pneu_id: pneuSelecionado.id,
        data_medicao: new Date().toISOString().split('T')[0],
        km_veiculo: Number.isFinite(km) ? km : (veiculoAtual.km_atual || null),
        hr_veiculo: hr,
        sulco_externo: pontos.externo,
        sulco_central: pontos.central,
        sulco_interno: pontos.interno,
        sulco_auxiliar: pontos.auxiliar,
        pressao_psi: pressao,
        marcacao_json: truckTireMarker?.getValores(),
        ...(modoAcessoRapido && tokenAcessoRapido
          ? { token_acesso: tokenAcessoRapido }
          : {}),
      }),
    });

    pneuSelecionado = {
      ...pneuSelecionado,
      ult_sulco_ext: pontos.externo,
      ult_sulco_cent: pontos.central,
      ult_sulco_int: pontos.interno,
      ult_sulco_aux: pontos.auxiliar,
      menor_sulco: result.menor_sulco,
      status_sulco: result.status_sulco,
      diagnostico: result.diagnostico,
      diagnostico_label: result.diagnostico_label,
      acao_sugerida: result.acao_sugerida,
      acao_label: result.acao_label,
      acao_motivo: result.acao_motivo,
      desvio_mm: result.desvio_mm,
      rodizio_sugestao: result.rodizio_sugestao || null,
      ultima_medicao: {
        data: new Date().toISOString().split('T')[0],
        sulco_externo: pontos.externo,
        sulco_central: pontos.central,
        sulco_interno: pontos.interno,
        sulco_auxiliar: pontos.auxiliar,
        menor_sulco: result.menor_sulco,
      },
    };

    const idx = veiculoAtual.pneus.findIndex((p) => p.id === pneuSelecionado.id);
    if (idx >= 0) veiculoAtual.pneus[idx] = { ...veiculoAtual.pneus[idx], ...pneuSelecionado };

    truckDiagram.atualizarPneu(pneuSelecionado, meta.posicoes);
    document.getElementById('truck-pneu-status').innerHTML = badge(result.status_sulco);
    document.getElementById('truck-pneu-acao').innerHTML = podeVerOrientacaoGestao()
      ? badgeAcao(result.acao_sugerida, result.acao_label)
      : '';
    if (podeVerOrientacaoGestao()) {
      document.getElementById('truck-diagnostico').textContent =
        result.diagnostico_label ? `Diagnóstico: ${result.diagnostico_label}` : '';
      document.getElementById('truck-diagnostico').classList.remove('gestao-only-hidden');
    } else {
      document.getElementById('truck-diagnostico').textContent = '';
      document.getElementById('truck-diagnostico').classList.add('gestao-only-hidden');
    }
    mostrarAcaoInstrucao({
      acao_sugerida: result.acao_sugerida,
      acao_motivo: result.acao_motivo,
      rodizio_sugestao: result.rodizio_sugestao,
    });
    mostrarRodizioSugestao({
      acao_sugerida: result.acao_sugerida,
      rodizio_sugestao: result.rodizio_sugestao,
    });
    atualizarResumoPneuTruck(pneuSelecionado);
    atualizarPerfilLocal('truck-perfil', pontos, podeVerOrientacaoGestao()
      ? { label: result.diagnostico_label, desc: result.acao_motivo }
      : null);

    const acaoTxt = (podeVerOrientacaoGestao() && result.acao_sugerida !== 'ok')
      ? ` · ${result.acao_label}`
      : '';
    status.textContent = result.status_sulco === 'critico'
      ? `Salvo! Crítico — ${result.menor_sulco} mm${acaoTxt}`
      : `Salvo — menor sulco: ${result.menor_sulco ?? '-'} mm${acaoTxt}`;
    status.className = `hint save-status ${result.status_sulco === 'critico' ? 'erro' : 'salvo'}`;
    if (modoAcessoRapido && pneuSelecionado?.id) {
      pneusMedidosSessao.add(pneuSelecionado.id);
      atualizarProgressoCampo();
      marcarPneusMedidosSessao();
    }
    if (concluir && modoAcessoRapido) {
      voltarDesenhoCampo({ toastProx: true });
      return;
    }
    if (modoAcessoRapido) {
      toast(`Sulco salvo (${result.menor_sulco ?? '—'} mm)`, 'success');
    }
  } catch (err) {
    status.textContent = err.message;
    status.className = 'hint save-status erro';
    if (modoAcessoRapido) toast(err.message, 'error');
  }
}

async function registrarEventoPneu(tipo) {
  if (!pneuSelecionado || !veiculoAtual) return;
  if (tipo === 'recap') {
    abrirModalEnviarRecap({
      id: pneuSelecionado.id,
      fogo: pneuSelecionado.numero_fogo,
      origem: 'truck',
    });
    return;
  }
  const label = 'descarte (envia ao estoque de descarte para definir o tratamento)';
  if (!confirm(`Registrar ${label} deste pneu?`)) return;

  try {
    const pontos = pontosFromInputs('truck');
    const menor = [pontos.externo, pontos.central, pontos.interno, pontos.auxiliar]
      .filter((v) => v != null);
    const sulco = menor.length ? Math.min(...menor) : pneuSelecionado.menor_sulco;

    const result = await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/evento`, {
      method: 'POST',
      body: JSON.stringify({
        tipo,
        km_veiculo: parseInt(document.getElementById('truck-km').value, 10) || veiculoAtual.km_atual,
        hr_veiculo: numOrNull('truck-hr'),
        sulco_mm: sulco,
        detalhes: `Registrado pelo painel do veículo`,
      }),
    });

    toast(result.mensagem, 'success');
    await openVeiculoDetalhe(veiculoAtual.id, voltarPara);

    if (tipo === 'descarte' && confirm('Abrir o estoque de descarte para definir o tratamento deste pneu?')) {
      showView('pneus');
      const filtro = document.getElementById('pneus-filtro-status');
      if (filtro) filtro.value = 'descarte';
      await loadPneus();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

['truck-sulco-ext', 'truck-sulco-cent', 'truck-sulco-int', 'truck-sulco-aux', 'truck-pressao', 'truck-km', 'truck-hr']
  .forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => {
      syncTruckMarkerFromInputs();
      agendarAutoSave();
    });
  });

document.getElementById('btn-truck-salvar-sulco')?.addEventListener('click', () => {
  clearTimeout(autoSaveTimer);
  salvarMedicaoTruck({ concluir: modoAcessoRapido });
});
document.getElementById('btn-campo-voltar')?.addEventListener('click', () => {
  voltarDesenhoCampo();
});

document.getElementById('btn-truck-montar')?.addEventListener('click', montarPneuDoEstoque);
document.getElementById('btn-truck-criar-montar')?.addEventListener('click', criarEMontarPneuTruck);
document.querySelectorAll('.montar-tab').forEach((btn) => {
  btn.addEventListener('click', () => setMontarTab(btn.dataset.montarTab));
});
document.getElementById('link-ir-pneus')?.addEventListener('click', (e) => {
  e.preventDefault();
  showView('pneus');
  loadPneus();
});

// ── Aba Pneus (estoque) ─────────────────────────────────

async function loadPneus() {
  const status = document.getElementById('pneus-filtro-status')?.value || 'estoque';
  const q = document.getElementById('pneus-busca')?.value?.trim() || '';
  const lista = document.getElementById('pneus-lista');
  try {
    const params = new URLSearchParams({ status });
    if (q) params.set('q', q);
    const pneus = await fetchJSON(`${API}/pneus?${params}`);
    if (!pneus.length) {
      const vazioDescarte = status === 'descarte';
      const vazioRecap = status === 'recapagem';
      lista.innerHTML = `
        <div class="empty-state">
          <h3>Nenhum pneu encontrado</h3>
          <p>${vazioDescarte
            ? 'Ainda não há pneus registrados como descarte nesta filial.'
            : vazioRecap
              ? 'Nenhum pneu enviado para recap nesta filial.'
            : 'Cadastre pneus no estoque e depois monte no caminhão para medir.'}</p>
        </div>`;
      return;
    }
    lista.innerHTML = pneus.map((p) => {
      const onde = p.status_pneu === 'montado'
        ? `${p.veiculo_placa || 'Veículo'}${p.posicao ? ` · ${p.posicao}` : ''}`
        : p.status_pneu === 'descarte'
          ? 'Descarte'
          : p.status_pneu === 'recapagem'
            ? 'Recapagem'
            : 'Estoque';
      const labelStatus = p.status_pneu === 'descarte' ? 'descarte'
        : p.status_pneu === 'recapagem' ? 'recapagem'
          : p.status_pneu;
      const tratamento = p.status_pneu === 'descarte'
        ? (p.tratamento_descarte_label || 'Aguardando destino')
        : null;
      const recapInfo = p.status_pneu === 'recapagem' && p.recap_fornecedor
        ? `${escapeHtml(p.recap_fornecedor)}${p.recap_enviado_em ? ` · ${formatDate(p.recap_enviado_em)}` : ''}`
        : null;
      const tratamentoPendente = p.status_pneu === 'descarte'
        && (!p.tratamento_descarte || p.tratamento_descarte === 'pendente');
      return `
        <article class="pneu-card card${p.status_pneu === 'descarte' ? ' pneu-card-descarte' : ''}">
          <div class="pneu-card-main">
            <h3>Fogo ${p.numero_fogo || '—'}</h3>
            <p class="hint">${[p.marca, p.dot ? `DOT ${p.dot}` : null, p.vida_label].filter(Boolean).join(' · ')}</p>
            <p class="hint">${onde} · ${p.padrao_label || labelPadraoPneu(p.tipo_pneu)}
              ${p.menor_sulco != null ? ` · sulco ${p.menor_sulco} mm` : ' · sem medição'}
              ${p.ultima_medicao?.data ? ` · ${formatDate(p.ultima_medicao.data)}` : ''}</p>
            ${tratamento
              ? `<p class="hint"><strong>Tratamento:</strong> ${escapeHtml(tratamento)}${
                p.tratamento_descarte_obs ? ` — ${escapeHtml(p.tratamento_descarte_obs)}` : ''
              }</p>`
              : ''}
            ${recapInfo
              ? `<p class="hint"><strong>Enviado para recap:</strong> ${recapInfo}</p>`
              : ''}
          </div>
          <div class="pneu-card-actions">
            ${p.status_pneu === 'descarte' ? '' : badge(p.status_sulco)}
            <span class="badge ${p.status_pneu === 'descarte' ? 'badge-critico' : 'badge-vida'}">${labelStatus}</span>
            ${tratamentoPendente
              ? '<span class="badge badge-alerta">aguardando destino</span>'
              : ''}
            ${p.status_pneu === 'estoque'
              ? `<button type="button" class="btn btn-primary btn-sm" data-montar-pneu="${p.id}" data-fogo="${p.numero_fogo || ''}">Montar</button>
                 <button type="button" class="btn btn-ghost btn-sm" data-enviar-recap="${p.id}" data-fogo="${escapeHtml(p.numero_fogo || '')}">Enviar para recap</button>`
              : ''}
            ${p.status_pneu === 'recapagem'
              ? `<button type="button" class="btn btn-primary btn-sm" data-receber-recap="${p.id}"
                   data-fogo="${escapeHtml(p.numero_fogo || '')}"
                   data-fornecedor="${escapeHtml(p.recap_fornecedor || '')}">Receber recap</button>`
              : ''}
            ${p.status_pneu === 'montado'
              ? `<button type="button" class="btn btn-ghost btn-sm" data-enviar-recap="${p.id}" data-fogo="${escapeHtml(p.numero_fogo || '')}">Enviar para recap</button>`
              : ''}
            ${p.status_pneu === 'descarte'
              ? `<button type="button" class="btn btn-primary btn-sm" data-tratamento-descarte="${p.id}"
                   data-fogo="${escapeHtml(p.numero_fogo || '')}"
                   data-tratamento="${escapeHtml(p.tratamento_descarte || 'pendente')}"
                   data-obs="${escapeHtml(p.tratamento_descarte_obs || '')}">Definir tratamento</button>`
              : ''}
            ${p.status_pneu !== 'descarte'
              ? `<button type="button" class="btn btn-ghost btn-sm" data-edit-pneu="${p.id}">Editar</button>`
              : ''}
            ${p.status_pneu === 'montado'
              ? `<button type="button" class="btn btn-ghost btn-sm" data-desmontar-pneu="${p.id}">Desmontar</button>`
              : ''}
            <button type="button" class="btn btn-ghost btn-sm" data-hist-pneu="${p.id}">Histórico</button>
          </div>
        </article>`;
    }).join('');

    lista.querySelectorAll('[data-montar-pneu]').forEach((btn) => {
      btn.addEventListener('click', () => {
        abrirModalMontar(parseInt(btn.dataset.montarPneu, 10), btn.dataset.fogo || '');
      });
    });
    lista.querySelectorAll('[data-tratamento-descarte]').forEach((btn) => {
      btn.addEventListener('click', () => {
        abrirModalTratamentoDescarte({
          id: parseInt(btn.dataset.tratamentoDescarte, 10),
          fogo: btn.dataset.fogo || '',
          tratamento: btn.dataset.tratamento || 'pendente',
          obs: btn.dataset.obs || '',
        });
      });
    });
    lista.querySelectorAll('[data-enviar-recap]').forEach((btn) => {
      btn.addEventListener('click', () => {
        abrirModalEnviarRecap({
          id: parseInt(btn.dataset.enviarRecap, 10),
          fogo: btn.dataset.fogo || '',
          origem: 'lista',
        });
      });
    });
    lista.querySelectorAll('[data-receber-recap]').forEach((btn) => {
      btn.addEventListener('click', () => {
        receberRecapDoPainel({
          id: parseInt(btn.dataset.receberRecap, 10),
          fogo: btn.dataset.fogo || '',
          fornecedor: btn.dataset.fornecedor || '',
        });
      });
    });
    lista.querySelectorAll('[data-edit-pneu]').forEach((btn) => {
      btn.addEventListener('click', () => abrirModalPneu(parseInt(btn.dataset.editPneu, 10)));
    });
    lista.querySelectorAll('[data-desmontar-pneu]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Desmontar e enviar ao estoque?')) return;
        try {
          await fetchJSON(`${API}/pneus/${btn.dataset.desmontarPneu}/desmontar`, { method: 'POST', body: '{}' });
          toast('Pneu no estoque');
          loadPneus();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    lista.querySelectorAll('[data-hist-pneu]').forEach((btn) => {
      btn.addEventListener('click', () => abrirHistoricoPneu(parseInt(btn.dataset.histPneu, 10)));
    });
  } catch (err) {
    lista.innerHTML = `<p class="hint erro">${err.message}</p>`;
  }
}

function abrirModalEnviarRecap({ id, fogo, origem = 'truck' }) {
  const modal = document.getElementById('modal-enviar-recap');
  if (!modal || !id) return;
  document.getElementById('enviar-recap-pneu-id').value = String(id);
  document.getElementById('enviar-recap-origem').value = origem;
  document.getElementById('enviar-recap-label').textContent = fogo
    ? `Pneu fogo ${fogo} — informe o fornecedor e a data do envio.`
    : 'Informe o fornecedor e a data do envio.';
  const forn = document.getElementById('enviar-recap-fornecedor');
  const obs = document.getElementById('enviar-recap-obs');
  const data = document.getElementById('enviar-recap-data');
  if (forn) forn.value = '';
  if (obs) obs.value = '';
  if (data) data.value = hojeISOLocal();
  modal.showModal();
  forn?.focus();
}

async function receberRecapDoPainel({ id, fogo, fornecedor }) {
  const forn = fornecedor ? ` (${fornecedor})` : '';
  if (!confirm(`Registrar retorno da recap do fogo ${fogo || id}${forn}? O pneu volta ao estoque.`)) {
    return;
  }
  try {
    const result = await fetchJSON(`${API}/pneus/${id}/evento`, {
      method: 'POST',
      body: JSON.stringify({ tipo: 'recap', detalhes: 'Recebido pelo painel' }),
    });
    toast(result.mensagem, 'success');
    await loadPneus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function abrirModalTratamentoDescarte({ id, fogo, tratamento, obs }) {
  const modal = document.getElementById('modal-tratamento-descarte');
  if (!modal) return;
  document.getElementById('tratamento-descarte-pneu-id').value = String(id);
  document.getElementById('tratamento-descarte-label').textContent = fogo
    ? `Fogo ${fogo} — escolha o destino deste pneu descartado.`
    : 'Escolha o destino deste pneu descartado.';
  document.getElementById('tratamento-descarte-tipo').value = tratamento || 'pendente';
  document.getElementById('tratamento-descarte-obs').value = obs || '';
  modal.showModal();
}

function setTipoCondicaoEditaveis(editavel) {
  const tipo = document.getElementById('pneu-tipo');
  const cond = document.getElementById('pneu-condicao');
  if (tipo) tipo.disabled = !editavel;
  if (cond) cond.disabled = !editavel;
  const hintTipo = document.getElementById('pneu-tipo-hint');
  const hintCond = document.getElementById('pneu-condicao-hint');
  if (hintTipo) {
    hintTipo.textContent = editavel
      ? 'Direcional = dianteira · Misto/Borrachudo = tração'
      : 'Padrão fixo (não pode alterar)';
  }
  if (hintCond) {
    hintCond.textContent = editavel
      ? 'Não muda depois (exceto via Registrar recap)'
      : 'Condição fixa — use Registrar recap';
  }
}

function abrirModalPneuNovo() {
  document.getElementById('modal-pneu-titulo').textContent = 'Novo pneu no estoque';
  document.getElementById('pneu-edit-id').value = '';
  document.getElementById('form-pneu').reset();
  document.getElementById('pneu-tipo').value = 'misto';
  document.getElementById('pneu-condicao').value = 'novo';
  document.getElementById('pneu-vida').value = '0';
  const avancado = document.getElementById('pneu-avancado');
  if (avancado) avancado.open = false;
  setTipoCondicaoEditaveis(true);
  document.getElementById('modal-pneu').showModal();
}

async function abrirModalPneu(id) {
  try {
    const p = await fetchJSON(`${API}/pneus/${id}`);
    document.getElementById('modal-pneu-titulo').textContent = 'Editar pneu';
    document.getElementById('pneu-edit-id').value = String(p.id);
    document.getElementById('pneu-fogo').value = p.numero_fogo || '';
    document.getElementById('pneu-dot').value = p.dot || '';
    document.getElementById('pneu-marca').value = p.marca || '';
    document.getElementById('pneu-modelo').value = p.modelo || '';
    document.getElementById('pneu-custo').value = p.custo ?? '';
    document.getElementById('pneu-nota').value = p.nota_fiscal || '';
    document.getElementById('pneu-medida').value = p.medida || '';
    document.getElementById('pneu-tipo').value = p.tipo_pneu || 'misto';
    document.getElementById('pneu-condicao').value = p.condicao || 'novo';
    document.getElementById('pneu-vida').value = String(p.vida_recap ?? 0);
    document.getElementById('pneu-sulco-inicial').value = p.sulco_inicial_mm ?? '';
    const avancado = document.getElementById('pneu-avancado');
    if (avancado) {
      avancado.open = !!(p.dot || p.medida || p.sulco_inicial_mm || (p.vida_recap > 0));
    }
    setTipoCondicaoEditaveis(false);
    document.getElementById('modal-pneu').showModal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('btn-novo-pneu')?.addEventListener('click', abrirModalPneuNovo);
document.getElementById('btn-cancelar-pneu')?.addEventListener('click', () => {
  document.getElementById('modal-pneu').close();
});
document.getElementById('pneus-filtro-status')?.addEventListener('change', loadPneus);
let pneusBuscaTimer;
document.getElementById('pneus-busca')?.addEventListener('input', () => {
  clearTimeout(pneusBuscaTimer);
  pneusBuscaTimer = setTimeout(loadPneus, 300);
});

document.getElementById('form-pneu')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('pneu-edit-id').value;
  const payload = {
    numero_fogo: document.getElementById('pneu-fogo').value,
    dot: document.getElementById('pneu-dot').value,
    marca: document.getElementById('pneu-marca').value,
    modelo: document.getElementById('pneu-modelo').value,
    medida: document.getElementById('pneu-medida')?.value || null,
    custo: numOrNull('pneu-custo'),
    nota_fiscal: document.getElementById('pneu-nota').value || null,
    vida_recap: parseInt(document.getElementById('pneu-vida').value, 10),
    sulco_inicial_mm: numOrNull('pneu-sulco-inicial'),
  };
  if (!payload.modelo?.trim()) {
    return toast('Informe o modelo do pneu', 'error');
  }
  if (!id) {
    payload.tipo_pneu = document.getElementById('pneu-tipo').value;
    payload.condicao = document.getElementById('pneu-condicao').value;
  }
  try {
    if (id) {
      await fetchJSON(`${API}/pneus/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Pneu atualizado');
      document.getElementById('modal-pneu').close();
      loadPneus();
    } else {
      const result = await fetchJSON(`${API}/pneus`, { method: 'POST', body: JSON.stringify(payload) });
      document.getElementById('modal-pneu').close();
      document.getElementById('pneus-filtro-status').value = 'estoque';
      await loadPneus();
      const pneuId = result.pneu?.id;
      const fogo = result.pneu?.numero_fogo || payload.numero_fogo;
      if (pneuId) {
        abrirModalPneuPosCriar(pneuId, fogo);
      } else {
        toast('Pneu no estoque', 'success');
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

function abrirModalPneuPosCriar(pneuId, fogo = '') {
  document.getElementById('pneu-pos-id').value = String(pneuId);
  document.getElementById('pneu-pos-fogo').value = fogo || '';
  document.getElementById('pneu-pos-label').textContent = fogo
    ? `Fogo ${fogo} está no estoque. Quer montar agora em um veículo?`
    : 'O pneu está no estoque. Quer montar agora em um veículo?';
  document.getElementById('modal-pneu-pos').showModal();
}

document.getElementById('btn-pos-montar')?.addEventListener('click', () => {
  const id = parseInt(document.getElementById('pneu-pos-id').value, 10);
  const fogo = document.getElementById('pneu-pos-fogo').value;
  document.getElementById('modal-pneu-pos').close();
  if (id) abrirModalMontar(id, fogo);
});

document.getElementById('btn-pos-estoque')?.addEventListener('click', () => {
  document.getElementById('modal-pneu-pos').close();
  toast('Pneu ficou no estoque', 'success');
});

async function abrirModalMontar(pneuId, fogo = '') {
  document.getElementById('montar-pneu-id').value = String(pneuId);
  document.getElementById('montar-pneu-label').textContent =
    fogo ? `Pneu fogo ${fogo}` : `Pneu #${pneuId}`;
  const selV = document.getElementById('montar-veiculo');
  const selP = document.getElementById('montar-posicao');
  selP.innerHTML = '<option value="">Selecione o veículo primeiro</option>';
  selP.disabled = true;
  try {
    const veiculos = veiculosCache.length ? veiculosCache : await fetchJSON(`${API}/veiculos`);
    veiculosCache = veiculos;
    selV.innerHTML = '<option value="">Selecione...</option>' +
      veiculos.map((v) =>
        `<option value="${v.id}">${v.apelido || v.placa} (${v.placa}) · ${v.total_pneus || 0} montados</option>`
      ).join('');
    if (veiculoAtual?.id) selV.value = String(veiculoAtual.id);
    document.getElementById('modal-montar').showModal();
    if (selV.value) selV.dispatchEvent(new Event('change'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('btn-cancelar-montar')?.addEventListener('click', () => {
  document.getElementById('modal-montar').close();
});

document.getElementById('btn-cancelar-enviar-recap')?.addEventListener('click', () => {
  document.getElementById('modal-enviar-recap')?.close();
});

document.getElementById('form-enviar-recap')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pneuId = parseInt(document.getElementById('enviar-recap-pneu-id').value, 10);
  const origem = document.getElementById('enviar-recap-origem')?.value || 'truck';
  const fornecedor = document.getElementById('enviar-recap-fornecedor')?.value?.trim();
  const dataEvento = document.getElementById('enviar-recap-data')?.value;
  const obs = document.getElementById('enviar-recap-obs')?.value?.trim();
  if (!pneuId || !fornecedor || !dataEvento) {
    return toast('Informe o fornecedor e a data', 'error');
  }
  const body = {
    tipo: 'enviar_recap',
    fornecedor,
    data_evento: dataEvento,
    detalhes: obs || 'Registrado pelo painel',
  };
  if (origem === 'truck' && veiculoAtual) {
    body.km_veiculo = parseInt(document.getElementById('truck-km').value, 10) || veiculoAtual.km_atual;
    body.hr_veiculo = numOrNull('truck-hr');
  }
  try {
    const result = await fetchJSON(`${API}/pneus/${pneuId}/evento`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    document.getElementById('modal-enviar-recap')?.close();
    toast(result.mensagem, 'success');
    if (origem === 'truck' && veiculoAtual) {
      await openVeiculoDetalhe(veiculoAtual.id, voltarPara);
    } else {
      await loadPneus();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('btn-cancelar-tratamento-descarte')?.addEventListener('click', () => {
  document.getElementById('modal-tratamento-descarte')?.close();
});

document.getElementById('form-tratamento-descarte')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pneuId = parseInt(document.getElementById('tratamento-descarte-pneu-id').value, 10);
  const tratamento = document.getElementById('tratamento-descarte-tipo').value;
  const observacoes = document.getElementById('tratamento-descarte-obs').value?.trim() || null;
  if (!pneuId || !tratamento) return toast('Informe o destino', 'error');
  try {
    const result = await fetchJSON(`${API}/pneus/${pneuId}/tratamento-descarte`, {
      method: 'PUT',
      body: JSON.stringify({ tratamento, observacoes }),
    });
    document.getElementById('modal-tratamento-descarte')?.close();
    toast(result.mensagem || 'Tratamento salvo', 'success');
    loadPneus();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('montar-veiculo')?.addEventListener('change', async (e) => {
  const veiculoId = e.target.value;
  const selP = document.getElementById('montar-posicao');
  if (!veiculoId) {
    selP.innerHTML = '<option value="">Selecione o veículo primeiro</option>';
    selP.disabled = true;
    return;
  }
  try {
    const v = await fetchJSON(`${API}/veiculos/${veiculoId}`);
    const vazias = (v.posicoes_layout || []).filter((p) => !p.montado);
    if (!vazias.length) {
      selP.innerHTML = '<option value="">Todas as posições já têm pneu</option>';
      selP.disabled = true;
      return;
    }
    selP.disabled = false;
    selP.innerHTML = '<option value="">Selecione...</option>' +
      vazias.map((p) =>
        `<option value="${p.codigo}">${p.codigo} — ${p.label || meta.posicoes[p.codigo] || p.codigo}</option>`
      ).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('form-montar')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pneuId = parseInt(document.getElementById('montar-pneu-id').value, 10);
  const veiculoId = parseInt(document.getElementById('montar-veiculo').value, 10);
  const posicao = document.getElementById('montar-posicao').value;
  if (!pneuId || !veiculoId || !posicao) {
    return toast('Informe veículo e posição', 'error');
  }
  try {
    const result = await fetchJSON(`${API}/pneus/${pneuId}/montar`, {
      method: 'POST',
      body: JSON.stringify({ veiculo_id: veiculoId, posicao }),
    });
    document.getElementById('modal-montar').close();
    toast(result.mensagem || 'Pneu montado', 'success');
    await openVeiculoDetalhe(veiculoId, 'pneus');
    const montado = veiculoAtual?.pneus?.find((p) => p.posicao === posicao);
    if (montado) {
      truckDiagram?.setAtivo(montado.id);
      selecionarPneuTruck(montado);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});
async function abrirHistoricoPneu(pneuId) {
  try {
    let data;
    if (modoAcessoRapido) {
      const pneu = veiculoAtual?.pneus?.find((p) => Number(p.id) === Number(pneuId));
      const medicoes = (veiculoAtual?.medicoes || [])
        .filter((m) => Number(m.pneu_id) === Number(pneuId))
        .map((m) => ({
          ...m,
          menor_sulco: [m.sulco_externo, m.sulco_central, m.sulco_interno, m.sulco_auxiliar]
            .filter((v) => v != null)
            .reduce((min, v) => (min == null || v < min ? v : min), null),
          status_sulco: 'sem_dado',
        }));
      data = {
        id: pneuId,
        numero_fogo: pneu?.numero_fogo,
        posicao: pneu?.posicao,
        medicoes,
        movimentacoes: [],
      };
    } else {
      data = await fetchJSON(`${API}/pneus/${pneuId}`);
    }
    const viewPneus = document.getElementById('view-pneus')?.classList.contains('active');
    const el = viewPneus
      ? document.getElementById('pneu-historico-panel')
      : document.getElementById('historico-pneu');
    if (viewPneus && el) el.classList.remove('hidden');

    const placaTitulo = data.veiculo_placa ? ` · Placa ${data.veiculo_placa}` : '';
    const custoTitulo = data.custo != null
      ? ` · R$ ${Number(data.custo).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
      : '';
    const notaTitulo = data.nota_fiscal ? ` · NF ${data.nota_fiscal}` : '';
    const modeloTitulo = data.modelo ? ` · ${data.modelo}` : '';
    const titulo = `Histórico — ${data.numero_fogo ? `Fogo ${data.numero_fogo}` : `#${data.id}`}${modeloTitulo}${placaTitulo}${data.posicao ? ` · ${meta.posicoes[data.posicao] || data.posicao}` : ' · estoque'}${custoTitulo}${notaTitulo}${data.padrao_label || data.tipo_pneu ? ` · ${data.padrao_label || labelPadraoPneu(data.tipo_pneu)}` : ''}`;

    if (!data.medicoes.length && !data.movimentacoes?.length) {
      el.innerHTML = `<div class="card"><h3>${titulo}</h3><p class="hint">Nenhuma medição ou movimentação registrada.</p></div>`;
      return;
    }

    el.innerHTML = `
      <div class="card">
      <h3>${titulo}</h3>
      ${data.medicoes.length ? `
      <table class="historico-table">
        <thead>
          <tr>
            <th>Data</th><th>Placa</th><th>1ª</th><th>2ª</th><th>3ª</th><th>4ª</th>
            <th>Menor</th><th>Status</th><th>Diagnóstico</th><th>KM</th><th>Hr</th><th>mm/km</th>
          </tr>
        </thead>
        <tbody>
          ${data.medicoes.map((m) => `
            <tr>
              <td>${formatDate(m.data_medicao)}</td>
              <td><strong>${m.veiculo_placa || data.veiculo_placa || '-'}</strong></td>
              <td>${m.sulco_externo ?? '-'}</td>
              <td>${m.sulco_central ?? '-'}</td>
              <td>${m.sulco_interno ?? '-'}</td>
              <td>${m.sulco_auxiliar ?? '-'}</td>
              <td><strong>${m.menor_sulco ?? '-'}</strong></td>
              <td>${badge(m.status_sulco)}</td>
              <td>${m.diagnostico_label || m.diagnostico || '-'}</td>
              <td>${m.km_veiculo?.toLocaleString('pt-BR') || '-'}</td>
              <td>${m.hr_veiculo != null ? m.hr_veiculo : '-'}</td>
              <td>${m.desgaste_mm_km != null ? m.desgaste_mm_km : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : '<p class="hint">Sem medições.</p>'}
      ${data.movimentacoes?.length ? `
        <h4 style="margin-top:1rem">Movimentações (colocar / retirar / recap / posição)</h4>
        <table class="historico-table">
          <thead><tr><th>Data</th><th>Tipo</th><th>Placa</th><th>Posição</th><th>KM</th><th>Hr</th><th>Km rodados</th><th>Detalhes</th></tr></thead>
          <tbody>
            ${data.movimentacoes.map((m) => `
              <tr>
                <td>${formatDate(m.data_evento)}</td>
                <td>${m.tipo_label || m.tipo}</td>
                <td><strong>${m.veiculo_placa || '-'}</strong></td>
                <td>${m.posicao_anterior ? `${meta.posicoes[m.posicao_anterior] || m.posicao_anterior} → ` : ''}${meta.posicoes[m.posicao] || m.posicao || '-'}</td>
                <td>${m.km_veiculo?.toLocaleString('pt-BR') || '-'}</td>
                <td>${m.hr_veiculo != null ? m.hr_veiculo : '-'}</td>
                <td>${m.km_rodado != null ? m.km_rodado.toLocaleString('pt-BR') : '-'}</td>
                <td>${m.detalhes || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : ''}
      </div>`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

window.abrirHistoricoPneu = abrirHistoricoPneu;

// ── Layout de pneus ────────────────────────────────────

function getLayoutById(id) {
  return meta.layouts?.find((l) => l.id === id);
}

function renderLayoutTags(posicoes, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = posicoes.map((p) =>
    `<span class="layout-tag">${meta.posicoes[p] || p}</span>`
  ).join('');
}

function layoutsParaTipo(tipo) {
  if (tipo === 'Toco / Mini') return ['toco_6'];
  // Truck / Tração: eixos com 2 ou 4 pneus
  return ['truck_10', 'truck_8', 'truck_8_b'];
}

function preencherSelectLayouts(selectId, selectedId, { soTruckToco = false, tipo = null } = {}) {
  const sel = document.getElementById(selectId);
  if (!sel || !meta.layouts) return;
  let lista = meta.layouts;
  if (soTruckToco) {
    const ids = layoutsParaTipo(tipo || document.getElementById('v-tipo')?.value || 'Truck / Tração');
    lista = meta.layouts.filter((l) => ids.includes(l.id));
    if (!lista.length) lista = meta.layouts.filter((l) =>
      l.id === 'truck_10' || l.id === 'truck_8' || l.id === 'truck_8_b' || l.id === 'toco_6'
    );
  }
  sel.innerHTML = lista.map((l) =>
    `<option value="${l.id}">${l.nome}</option>`
  ).join('');
  const preferido = selectedId && lista.some((l) => l.id === selectedId)
    ? selectedId
    : (soTruckToco ? (lista[0]?.id || meta.layout_padrao) : (selectedId || meta.layout_padrao));
  sel.value = preferido;
  sel.dispatchEvent(new Event('change'));
}

function onLayoutSelectChange(selectId, descId, previewId, diagramId = null) {
  const sel = document.getElementById(selectId);
  const layout = getLayoutById(sel.value);
  if (!layout) return;
  const desc = document.getElementById(descId);
  if (desc) desc.textContent = layout.descricao;
  if (previewId) renderLayoutTags(layout.posicoes, previewId);
  if (diagramId) {
    renderLayoutPreview(document.getElementById(diagramId), {
      posicoes: layout.posicoes,
      labels: meta.posicoes || {},
      papeis: meta.papeis || {},
    });
  }
}

function preencherCheckboxesPosicoes(containerId, selecionadas = []) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = Object.entries(meta.posicoes).map(([cod, label]) => `
    <label>
      <input type="checkbox" name="posicao-custom" value="${cod}" ${selecionadas.includes(cod) ? 'checked' : ''}>
      ${label}
    </label>
  `).join('');
}

function abrirConfigLayout(veiculoId, veiculoNome, layoutAtual, posicoesAtuais) {
  veiculoLayoutId = veiculoId;
  document.getElementById('layout-veiculo-nome').textContent = veiculoNome;
  preencherSelectLayouts('layout-select', layoutAtual || meta.layout_padrao);
  preencherCheckboxesPosicoes('layout-custom-checkboxes', posicoesAtuais || []);
  document.getElementById('modal-layout').showModal();
}

window.abrirConfigLayout = abrirConfigLayout;

// ── Importação CSV (veículos / pneus) ───────────────────

async function baixarModeloCsv(url, filename) {
  try {
    const headers = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      let msg = 'Falha ao baixar planilha';
      try {
        const data = await resp.json();
        msg = data.erro || msg;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function mostrarResultadoImport(elId, result) {
  const el = document.getElementById(elId);
  if (!el) return;
  const erros = result.erros || [];
  const avisos = result.avisos || [];
  el.classList.remove('hidden');
  el.innerHTML = `
    <strong>${result.mensagem || 'Importação concluída'}</strong>
    <p class="hint" style="margin:.35rem 0 0">
      ${result.veiculos != null ? `Veículos: <strong>${result.veiculos}</strong> · ` : ''}
      ${result.pneus_montados != null ? `Montados: <strong>${result.pneus_montados}</strong> · ` : ''}
      ${result.pneus_estoque != null ? `Estoque: <strong>${result.pneus_estoque}</strong> · ` : ''}
      ${result.inseridos != null ? `Inseridos: <strong>${result.inseridos}</strong>` : ''}
      ${erros.length ? ` · Erros: <strong>${erros.length}</strong>` : ''}
      ${avisos.length ? ` · Avisos: <strong>${avisos.length}</strong>` : ''}
    </p>
    ${erros.length
      ? `<ul class="import-erros">${erros.slice(0, 12).map((e) =>
          `<li>Linha ${e.linha}${e.placa || e.numero_fogo ? ` (${e.placa || e.numero_fogo})` : ''}: ${e.erro}</li>`
        ).join('')}${erros.length > 12 ? `<li>… e mais ${erros.length - 12}</li>` : ''}</ul>`
      : ''}
    ${avisos.length
      ? `<ul class="import-avisos">${avisos.slice(0, 8).map((a) =>
          `<li>Linha ${a.linha}${a.numero_fogo ? ` (${a.numero_fogo})` : ''}: ${a.aviso}</li>`
        ).join('')}</ul>`
      : ''}
  `;
}

async function importarCsvArquivo(file, endpoint, resultadoId, onOk) {
  if (!file) return;
  try {
    const csv = await file.text();
    if (!csv.trim()) throw new Error('Arquivo vazio');
    const result = await fetchJSON(endpoint, {
      method: 'POST',
      body: JSON.stringify({ csv }),
    });
    mostrarResultadoImport(resultadoId, result);
    toast(result.mensagem || 'Importação concluída', 'success');
    onOk?.(result);
  } catch (err) {
    const data = err.data;
    if (data?.erros) {
      mostrarResultadoImport(resultadoId, data);
    }
    toast(err.message, 'error');
  }
}

document.getElementById('btn-modelo-veiculos')?.addEventListener('click', (e) => {
  e.preventDefault();
  baixarModeloCsv(`${API}/veiculos/import/modelo`, 'modelo-veiculos.csv');
});
document.getElementById('file-import-veiculos')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  await importarCsvArquivo(file, `${API}/veiculos/import`, 'import-resultado-veiculos', () => loadVeiculos());
});

document.getElementById('btn-modelo-frota')?.addEventListener('click', (e) => {
  e.preventDefault();
  baixarModeloCsv(`${API}/frota/import/modelo`, 'modelo-carga-frota.csv');
});
document.getElementById('file-import-frota')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  await importarCsvArquivo(file, `${API}/frota/import`, 'import-resultado-frota', () => {
    loadVeiculos();
  });
});

document.getElementById('btn-modelo-pneus')?.addEventListener('click', (e) => {
  e.preventDefault();
  baixarModeloCsv(`${API}/pneus/import/modelo`, 'modelo-pneus.csv');
});
document.getElementById('file-import-pneus')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  await importarCsvArquivo(file, `${API}/pneus/import`, 'import-resultado-pneus', () => loadPneus());
});

// ── Modal Veículo ──────────────────────────────────────

const modalVeiculo = document.getElementById('modal-veiculo');

document.getElementById('btn-novo-veiculo').addEventListener('click', () => {
  document.getElementById('form-veiculo').reset();
  document.getElementById('modal-veiculo-titulo').textContent = 'Novo Veículo';
  preencherSelectLayouts('v-layout', meta.layout_padrao, {
    soTruckToco: true,
    tipo: document.getElementById('v-tipo')?.value || 'Truck / Tração',
  });
  const tipo = document.getElementById('v-tipo');
  if (tipo?.value) {
    const sugestao = LAYOUT_POR_TIPO[tipo.value];
    if (sugestao) {
      document.getElementById('v-layout').value = sugestao;
    }
  }
  onLayoutSelectChange('v-layout', 'v-layout-desc', 'v-layout-preview', 'v-layout-diagram');
  const selDiaV = document.getElementById('v-dia-medicao');
  if (selDiaV) {
    selDiaV.innerHTML = optionsDiaSemana(diaMedicaoUnidade, { incluirVazio: true, vazioLabel: '— Usar dia da frota —' });
  }
  modalVeiculo.showModal();
});

document.getElementById('v-layout')?.addEventListener('change', () => {
  onLayoutSelectChange('v-layout', 'v-layout-desc', 'v-layout-preview', 'v-layout-diagram');
});

document.getElementById('v-tipo')?.addEventListener('change', (e) => {
  const tipo = e.target.value;
  const sugestao = LAYOUT_POR_TIPO[tipo] || (tipo === 'Toco / Mini' ? 'toco_6' : 'truck_10');
  preencherSelectLayouts('v-layout', sugestao, { soTruckToco: true, tipo });
});

document.getElementById('layout-select')?.addEventListener('change', () => {
  const layout = getLayoutById(document.getElementById('layout-select').value);
  onLayoutSelectChange('layout-select', 'layout-select-desc', 'layout-posicoes-preview');
  if (layout) preencherCheckboxesPosicoes('layout-custom-checkboxes', layout.posicoes);
});

document.getElementById('btn-cancelar-veiculo').addEventListener('click', () => modalVeiculo.close());

document.getElementById('form-veiculo').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const result = await fetchJSON(`${API}/veiculos`, {
      method: 'POST',
      body: JSON.stringify({
        placa: document.getElementById('v-placa').value,
        apelido: document.getElementById('v-apelido').value,
        tipo: document.getElementById('v-tipo').value,
        marca: document.getElementById('v-marca').value,
        modelo: document.getElementById('v-modelo').value,
        ano: parseInt(document.getElementById('v-ano').value) || null,
        km_atual: parseInt(document.getElementById('v-km').value) || 0,
        hr_atual: parseFloat(document.getElementById('v-hr').value) || 0,
        layout_pneus: document.getElementById('v-layout').value,
        dia_medicao: document.getElementById('v-dia-medicao')?.value
          ? Number(document.getElementById('v-dia-medicao').value)
          : null,
      }),
    });
    modalVeiculo.close();
    toast('Veículo pronto — clique nas posições vazias para colocar os pneus', 'success');
    await openVeiculoDetalhe(result.id, 'veiculos');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('btn-cancelar-layout')?.addEventListener('click', () => {
  document.getElementById('modal-layout').close();
});

document.getElementById('form-layout')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!veiculoLayoutId) return;

  const custom = [...document.querySelectorAll('input[name="posicao-custom"]:checked')].map((c) => c.value);
  const layoutId = document.getElementById('layout-select').value;
  const layout = getLayoutById(layoutId);
  const posicoesLayout = layout?.posicoes || [];
  const iguais = custom.length === posicoesLayout.length && custom.every((p) => posicoesLayout.includes(p));

  const payload = iguais
    ? { layout_pneus: layoutId }
    : { layout_pneus: 'personalizado', posicoes_custom: custom };

  if (!custom.length) return toast('Selecione ao menos uma posição de pneu', 'error');

  try {
    const result = await fetchJSON(`${API}/veiculos/${veiculoLayoutId}/layout`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    document.getElementById('modal-layout').close();
    toast(result.mensagem, 'success');
    if (
      inspecaoFilialIdAberto
      && Number(inspecaoVeiculoIdAberto) === Number(veiculoLayoutId)
    ) {
      await abrirInspecaoVeiculoFilial(inspecaoFilialIdAberto, veiculoLayoutId);
    } else if (!isGestao()) {
      openVeiculoDetalhe(veiculoLayoutId, voltarPara);
      loadVeiculos();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Medição ────────────────────────────────────────────

const sulcoInputs = {
  externo: document.getElementById('med-externo'),
  central: document.getElementById('med-central'),
  interno: document.getElementById('med-interno'),
  auxiliar: document.getElementById('med-auxiliar'),
};

function syncTireFromInputs() {
  if (!tireMarker) return;
  const p = pontosFromInputs('med');
  tireMarker.setValores(p.externo, p.central, p.interno, p.auxiliar);
  atualizarPerfilLocal('med-perfil', p);
}

Object.values(sulcoInputs).forEach((input) => {
  input?.addEventListener('input', syncTireFromInputs);
});

async function initMedicao() {
  document.getElementById('med-data').value = new Date().toISOString().split('T')[0];

  if (!tireMarker) {
    tireMarker = new TireMarker('tire-marker-container', {
      limites: limitesAtuais,
      onSulcoClick: (sulco) => {
        const map = { externo: 'med-externo', central: 'med-central', interno: 'med-interno', auxiliar: 'med-auxiliar' };
        const input = document.getElementById(map[sulco]);
        if (input) {
          input.focus();
          input.select();
        }
      },
    });
  } else {
    tireMarker.setLimites(limitesAtuais);
    tireMarker.reset();
  }

  try {
    const veiculos = veiculosCache.length ? veiculosCache : await fetchJSON(`${API}/veiculos`);
    const select = document.getElementById('med-veiculo');
    select.innerHTML = '<option value="">Selecione...</option>' +
      veiculos.map((v) => `<option value="${v.id}">${v.apelido || v.placa} (${v.placa})</option>`).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('med-veiculo').addEventListener('change', async (e) => {
  const veiculoId = e.target.value;
  const selectPneu = document.getElementById('med-pneu');

  if (!veiculoId) {
    selectPneu.innerHTML = '<option value="">Selecione o veículo primeiro</option>';
    selectPneu.disabled = true;
    return;
  }

  try {
    const v = await fetchJSON(`${API}/veiculos/${veiculoId}`);
    selectPneu.disabled = false;
    if (!v.pneus.length) {
      selectPneu.innerHTML = '<option value="">Nenhum pneu montado — monte na aba Veículos</option>';
      selectPneu.disabled = true;
      return;
    }
    selectPneu.innerHTML = v.pneus.map((p) =>
      `<option value="${p.id}">${meta.posicoes[p.posicao] || p.posicao}${p.numero_fogo ? ` · ${p.numero_fogo}` : ''}</option>`
    ).join('');
    document.getElementById('med-km').value = v.km_atual || '';
    document.getElementById('med-hr').value = v.hr_atual || '';
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('btn-salvar-medicao').addEventListener('click', async () => {
  const pneuId = document.getElementById('med-pneu').value;
  if (!pneuId) return toast('Selecione o pneu', 'error');

  const pontos = pontosFromInputs('med');
  const payload = {
    pneu_id: parseInt(pneuId, 10),
    data_medicao: document.getElementById('med-data').value,
    km_veiculo: parseInt(document.getElementById('med-km').value, 10) || null,
    hr_veiculo: numOrNull('med-hr'),
    sulco_externo: pontos.externo,
    sulco_central: pontos.central,
    sulco_interno: pontos.interno,
    sulco_auxiliar: pontos.auxiliar,
    pressao_psi: numOrNull('med-pressao'),
    responsavel: document.getElementById('med-responsavel').value,
    observacoes: document.getElementById('med-obs').value,
    marcacao_json: tireMarker?.getValores(),
  };

  if (payload.sulco_externo == null && payload.sulco_central == null
    && payload.sulco_interno == null && payload.sulco_auxiliar == null) {
    return toast('Informe ao menos um valor de sulco', 'error');
  }

  try {
    const result = await fetchJSON(`${API}/medicoes`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const msg = result.acao_sugerida === 'troca'
      ? `Medição salva! TROCA sugerida (${result.menor_sulco} mm) — ${result.diagnostico_label}`
      : result.acao_sugerida === 'recap'
        ? `Medição salva! RECAP sugerida (${result.menor_sulco} mm)`
        : `Medição salva! ${result.menor_sulco} mm · ${result.diagnostico_label}`;

    toast(msg, result.acao_sugerida === 'troca' ? 'error' : 'success');

    ['med-externo', 'med-central', 'med-interno', 'med-auxiliar', 'med-pressao', 'med-obs']
      .forEach((id) => { document.getElementById(id).value = ''; });
    tireMarker?.reset();
    document.getElementById('med-perfil').innerHTML = '';
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Alertas ────────────────────────────────────────────

async function loadAlertas() {
  try {
    const [alertas, vagas, config] = await Promise.all([
      fetchJSON(`${API}/medicoes/alertas`),
      fetchJSON(`${API}/pneus/alertas-vaga`).catch(() => []),
      fetchConfiguracoes(),
    ]);
    limitesAtuais = { ...limitesAtuais, ...config };

    const hint = document.getElementById('alertas-limites-hint');
    if (hint) {
      const nVaga = Array.isArray(vagas) ? vagas.length : 0;
      hint.textContent = nVaga
        ? `${nVaga} posição(ões) vaga(s) esperando pneu novo. ${hintLimites()}`
        : hintLimites();
    }

    const lista = document.getElementById('alertas-lista');
    const sulco = Array.isArray(alertas) ? alertas : [];
    const posVagas = Array.isArray(vagas) ? vagas : [];

    if (!sulco.length && !posVagas.length) {
      lista.innerHTML = '<div class="empty-state"><h3>Nenhum alerta</h3><p>Todos os pneus estão dentro do limite e não há posição vaga.</p></div>';
      return;
    }

    const cardsVaga = posVagas.map((a) => `
      <div class="alerta-card vaga">
        <div>
          <strong>Informe um pneu novo</strong> — ${escapeHtml(a.apelido || a.placa)} · ${escapeHtml(a.posicao_label || a.posicao || '')}
          <p class="hint">${escapeHtml(a.placa)} · Fogo ${escapeHtml(a.numero_fogo || '—')} ${escapeHtml(a.motivo_label || '')}</p>
        </div>
        <div class="veiculo-meta">
          <span class="badge badge-alerta">posição vaga</span>
          <button type="button" class="btn btn-sm btn-primary" data-veiculo-vaga="${a.veiculo_id}">Abrir caminhão</button>
        </div>
      </div>
    `).join('');

    const cardsSulco = sulco.map((a) => `
      <div class="alerta-card ${a.status_sulco}">
        <div>
          <strong>${a.apelido || a.placa}</strong> — ${meta.posicoes[a.posicao] || a.posicao}
          <p class="hint">${a.placa} · ${a.diagnostico_label || ''} · ${a.acao_motivo || ''} · ${formatDate(a.data_medicao)}</p>
        </div>
        <div class="veiculo-meta">
          <span style="font-size:1.25rem;font-weight:700">${a.menor_sulco} mm</span>
          ${badge(a.status_sulco)}
          ${badgeAcao(a.acao_sugerida, a.acao_label)}
        </div>
      </div>
    `).join('');

    lista.innerHTML = cardsVaga + cardsSulco;
    lista.querySelectorAll('[data-veiculo-vaga]').forEach((btn) => {
      btn.addEventListener('click', () => openVeiculoDetalhe(btn.dataset.veiculoVaga, 'alertas'));
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Ações ──────────────────────────────────────────────

async function loadAcoes() {
  try {
    const data = await fetchJSON(`${API}/medicoes/acoes`);
    const resumo = document.getElementById('acoes-resumo');
    resumo.innerHTML = `
      <div class="stat-card stat-troca"><span class="stat-value">${data.troca}</span><span class="stat-label">Troca</span></div>
      <div class="stat-card stat-recap"><span class="stat-value">${data.recap}</span><span class="stat-label">Recapagem</span></div>
      <div class="stat-card stat-monitorar"><span class="stat-value">${data.monitorar}</span><span class="stat-label">Monitorar</span></div>
    `;

    const lista = document.getElementById('acoes-lista');
    if (!data.itens.length) {
      lista.innerHTML = '<div class="empty-state"><h3>Nenhuma ação pendente</h3><p>A frota está dentro dos parâmetros</p></div>';
      return;
    }

    lista.innerHTML = data.itens.map((a) => `
      <div class="alerta-card ${a.acao_sugerida === 'troca' ? 'critico' : a.acao_sugerida === 'recap' ? 'alerta' : ''}">
        <div>
          <strong>${a.apelido || a.placa}</strong> — ${meta.posicoes[a.posicao] || a.posicao}
          <p class="hint">${a.acao_motivo || ''} · Vida: ${a.vida_recap || 0}ª recap</p>
        </div>
        <div class="veiculo-meta">
          <span style="font-weight:700">${a.menor_sulco ?? '—'} mm</span>
          ${badgeAcao(a.acao_sugerida, a.acao_label)}
          <button class="btn btn-sm btn-primary" data-veiculo="${a.veiculo_id}">Abrir</button>
        </div>
      </div>
    `).join('');

    lista.querySelectorAll('button[data-veiculo]').forEach((btn) => {
      btn.addEventListener('click', () => openVeiculoDetalhe(btn.dataset.veiculo, 'acoes'));
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Configurações ──────────────────────────────────────

async function loadConfiguracoes() {
  if (!isAdmin()) return;
  try {
    const config = await fetchConfiguracoes();
    limitesAtuais = { ...limitesAtuais, ...config };

    document.getElementById('cfg-critico').value = config.sulco_critico_mm;
    document.getElementById('cfg-alerta').value = config.sulco_alerta_mm;
    document.getElementById('cfg-recap').value = config.sulco_critico_mm ?? 3;
    document.getElementById('cfg-prazo-recap').value = config.prazo_recap_dias ?? 15;
    document.getElementById('cfg-novo').value = config.sulco_novo_mm ?? 14;
    document.getElementById('cfg-max-recaps').value = config.max_recaps ?? 6;
    document.getElementById('cfg-tolerancia').value = config.diagnostico_tolerancia_mm ?? 1;
    document.getElementById('cfg-rodizio-desvio').value = config.rodizio_desvio_mm ?? 4;
    document.getElementById('cfg-rodizio-similaridade').value = config.rodizio_similaridade_mm ?? 2.5;

    const a = config.acoes || {};
    document.getElementById('cfg-acao-troca-label').value = a.troca?.label || 'Trocar';
    document.getElementById('cfg-acao-troca-instrucao').value = a.troca?.instrucao || '';
    document.getElementById('cfg-acao-recap-label').value = a.recap?.label || 'Recapagem';
    document.getElementById('cfg-acao-recap-instrucao').value = a.recap?.instrucao || '';
    document.getElementById('cfg-acao-monitorar-label').value = a.monitorar?.label || 'Monitorar';
    document.getElementById('cfg-acao-monitorar-instrucao').value = a.monitorar?.instrucao || '';
    document.getElementById('cfg-acao-rodizio-label').value = a.rodizio?.label || 'Mudar posição';
    document.getElementById('cfg-acao-rodizio-instrucao').value = a.rodizio?.instrucao || '';
    document.getElementById('cfg-acao-ok-label').value = a.ok?.label || 'OK';
    document.getElementById('cfg-acao-ok-instrucao').value = a.ok?.instrucao || '';

    atualizarPreviewLimites();
  } catch (err) {
    toast(err.message, 'error');
  }
}

['cfg-critico', 'cfg-alerta', 'cfg-prazo-recap',
  'cfg-acao-troca-label', 'cfg-acao-troca-instrucao',
  'cfg-acao-monitorar-label', 'cfg-acao-monitorar-instrucao',
  'cfg-acao-rodizio-label', 'cfg-acao-rodizio-instrucao',
  'cfg-acao-ok-label', 'cfg-acao-ok-instrucao',
  'cfg-rodizio-desvio', 'cfg-rodizio-similaridade',
].forEach((id) => {
  document.getElementById(id)?.addEventListener('input', atualizarPreviewLimites);
});

document.getElementById('btn-salvar-config')?.addEventListener('click', async () => {
  const critico = parseFloat(document.getElementById('cfg-critico').value);
  const payload = {
    sulco_critico_mm: critico,
    sulco_alerta_mm: parseFloat(document.getElementById('cfg-alerta').value),
    sulco_recap_mm: critico,
    prazo_recap_dias: parseInt(document.getElementById('cfg-prazo-recap').value, 10),
    sulco_novo_mm: parseFloat(document.getElementById('cfg-novo').value),
    max_recaps: parseInt(document.getElementById('cfg-max-recaps').value, 10),
    diagnostico_tolerancia_mm: parseFloat(document.getElementById('cfg-tolerancia').value),
    rodizio_desvio_mm: parseFloat(document.getElementById('cfg-rodizio-desvio').value),
    rodizio_similaridade_mm: parseFloat(document.getElementById('cfg-rodizio-similaridade').value),
    acoes: {
      troca: {
        label: document.getElementById('cfg-acao-troca-label').value,
        instrucao: document.getElementById('cfg-acao-troca-instrucao').value,
      },
      recap: {
        label: document.getElementById('cfg-acao-recap-label').value,
        instrucao: document.getElementById('cfg-acao-recap-instrucao').value,
      },
      monitorar: {
        label: document.getElementById('cfg-acao-monitorar-label').value,
        instrucao: document.getElementById('cfg-acao-monitorar-instrucao').value,
      },
      rodizio: {
        label: document.getElementById('cfg-acao-rodizio-label').value,
        instrucao: document.getElementById('cfg-acao-rodizio-instrucao').value,
      },
      ok: {
        label: document.getElementById('cfg-acao-ok-label').value,
        instrucao: document.getElementById('cfg-acao-ok-instrucao').value,
      },
    },
  };

  if (!Number.isFinite(payload.sulco_critico_mm) || !Number.isFinite(payload.sulco_alerta_mm)) {
    return toast('Informe valores válidos em mm', 'error');
  }

  try {
    const result = await fetchJSON(`${API}/configuracoes`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    limitesAtuais = { ...limitesAtuais, ...result };
    syncMarkersLimites();
    atualizarPreviewLimites();
    toast('Limites e ações salvos! Medições usam as novas regras.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── WhatsApp chatbot (dentro do perfil da filial) ──────

let waPollTimer = null;
let waPollFilialId = null;

function stopWaPoll() {
  if (waPollTimer) {
    clearInterval(waPollTimer);
    waPollTimer = null;
  }
  waPollFilialId = null;
}

function painelQrEls() {
  return {
    wrap: document.getElementById('fc-qr-wrap') || document.getElementById('wa-qr-wrap'),
    img: document.getElementById('fc-qr-img') || document.getElementById('wa-qr-img'),
    titulo: document.getElementById('fc-qr-titulo') || document.getElementById('wa-qr-titulo'),
    status: document.getElementById('fc-qr-status'),
  };
}

function abrirPainelQr(mensagem, nomeFilial) {
  const { wrap, img, titulo, status } = painelQrEls();
  if (titulo) titulo.textContent = `Escaneie com o chip da unidade${nomeFilial ? ` (${nomeFilial})` : ''}`;
  if (status) {
    status.textContent = mensagem || 'Gerando QR Code…';
    status.classList.remove('login-erro', 'hidden');
  }
  img?.classList.add('hidden');
  wrap?.classList.remove('hidden');
  wrap?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function mostrarQrFilial(data, nomeFilial) {
  const { wrap, img, titulo, status } = painelQrEls();
  if (titulo) titulo.textContent = `Escaneie com o chip da unidade${nomeFilial ? ` (${nomeFilial})` : ''}`;

  if (data?.loggedIn) {
    wrap?.classList.add('hidden');
    stopWaPoll();
    return;
  }

  if (data?.qrcode && img) {
    img.src = data.qrcode;
    img.classList.remove('hidden');
    if (status) {
      status.textContent = 'QR pronto — escaneie no celular do chip.';
      status.classList.remove('login-erro');
    }
    wrap?.classList.remove('hidden');
    wrap?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  if (data?.qr_erro && status) {
    wrap?.classList.remove('hidden');
    img?.classList.add('hidden');
    status.textContent = data.qr_erro;
    status.classList.add('login-erro');
  }
}

function startWaPollFilial(filialId, nome) {
  stopWaPoll();
  waPollFilialId = filialId;
  waPollTimer = setInterval(async () => {
    try {
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/status`);
      if (data.qrcode || data.qr_erro) mostrarQrFilial(data, nome);
      if (data.loggedIn) {
        toast(`Chatbot ${nome} conectado!`, 'success');
        document.getElementById('fc-qr-wrap')?.classList.add('hidden');
        document.getElementById('wa-qr-wrap')?.classList.add('hidden');
        stopWaPoll();
        const statusEl = document.getElementById('fc-status');
        if (statusEl) {
          statusEl.className = 'badge badge-ok';
          statusEl.textContent = 'Online';
        }
        const detail = document.getElementById('fc-status-detail');
        if (detail) detail.textContent = 'Chatbot conectado — escolha o grupo abaixo.';
        document.getElementById('fc-step-connect')?.classList.add('is-done');
        document.getElementById('fc-step-group')?.classList.add('is-active');
        const phone = String(data.phone || '').replace(/\D/g, '');
        const chipInput = document.getElementById('fc-whatsapp');
        if (phone.length >= 10 && chipInput) {
          chipInput.value = phone;
          fetchJSON(`${API}/whatsapp/filiais-chatbot/${filialId}`, {
            method: 'PUT',
            body: JSON.stringify({ whatsapp: phone }),
          }).catch(() => {});
        }
      }
    } catch {
      // ignore
    }
  }, 1500);
}

document.getElementById('btn-wa-qr-fechar')?.addEventListener('click', () => {
  document.getElementById('wa-qr-wrap')?.classList.add('hidden');
  stopWaPoll();
});

// ── Filiais (admin total + gerente de unidade) ──────────

function setModoListaFiliais(listaVisivel) {
  const lista = document.getElementById('filiais-lista');
  const banner = document.getElementById('compras-consolidado');
  const detalhe = document.getElementById('filial-detalhe');
  const btnNova = document.getElementById('btn-nova-filial');
  const tit = document.getElementById('filiais-titulo');
  const hint = document.getElementById('filiais-hint');
  const view = document.getElementById('view-filiais');

  lista?.classList.toggle('hidden', !listaVisivel);
  banner?.classList.toggle('hidden', !listaVisivel || (isGerente() && !isAdmin()));
  detalhe?.classList.toggle('hidden', listaVisivel);
  btnNova?.classList.toggle('hidden', !listaVisivel || !isAdmin());
  view?.classList.toggle('is-filial-aberta', !listaVisivel);

  if (listaVisivel) {
    if (tit) tit.textContent = isGerente() && !isAdmin() ? 'Minha unidade' : 'Filiais';
    if (hint) {
      hint.textContent = isGerente() && !isAdmin()
        ? 'Painel da sua unidade: indicadores, pendências e frota para análise.'
        : 'Clique numa filial para ver só os dados dela (alertas e frota).';
    }
  }
}

function fecharDetalheFilial() {
  fecharInspecaoVeiculoFilial();
  document.getElementById('wa-qr-wrap')?.classList.add('hidden');
  stopWaPoll();
  setModoListaFiliais(true);
}

async function loadFiliais() {
  if (!isGestao()) return;
  try {
    const [filiais, compras] = await Promise.all([
      fetchJSON(`${API}/filiais`),
      fetchJSON(`${API}/filiais/compras/consolidado`),
    ]);
    filiaisCache = filiais;
    if (isGerente() && !isAdmin() && filiais.length === 1) {
      await abrirDetalheFilial(filiais[0].id);
      return;
    }
    const lista = document.getElementById('filiais-lista');
    setModoListaFiliais(true);

    const banner = document.getElementById('compras-consolidado');
    const t = compras.totais || {};
    banner.innerHTML = `
      <div class="compras-banner-inner">
        <div>
          <h3>Compras e recapagens — consolidado</h3>
          <p class="hint">Baseado nas medições enviadas pelas filiais · clique numa unidade para abrir</p>
        </div>
        <div class="compras-totais">
          <div class="compras-chip compra">
            <strong>${t.pneus_para_comprar ?? 0}</strong>
            <span>Comprar (troca)</span>
          </div>
          <div class="compras-chip recap">
            <strong>${t.pneus_para_recap ?? 0}</strong>
            <span>Recapagem</span>
          </div>
          <div class="compras-chip monitorar">
            <strong>${t.pneus_monitorar ?? 0}</strong>
            <span>Monitorar</span>
          </div>
        </div>
      </div>
      ${compras.filiais?.length ? `
        <div class="compras-por-filial">
          ${compras.filiais.map((f) => `
            <button type="button" class="compras-filial-chip" data-id="${f.filial_id}">
              <strong>${f.codigo}</strong>
              ${f.compras.pneus_para_comprar ? `<span class="chip-troca">${f.compras.pneus_para_comprar} compra</span>` : ''}
              ${f.compras.pneus_para_recap ? `<span class="chip-recap">${f.compras.pneus_para_recap} recap</span>` : ''}
              ${f.compras.pneus_monitorar ? `<span class="chip-mon">${f.compras.pneus_monitorar} mon.</span>` : ''}
            </button>
          `).join('')}
        </div>` : '<p class="hint" style="margin-top:.75rem">Nenhuma pendência de compra no momento</p>'}
    `;
    banner.querySelectorAll('.compras-filial-chip').forEach((btn) => {
      btn.addEventListener('click', () => abrirDetalheFilial(btn.dataset.id));
    });

    if (!filiais.length) {
      lista.innerHTML = '<div class="empty-state"><h3>Nenhuma filial</h3><p>Cadastre a primeira filial para começar</p></div>';
      return;
    }

    lista.innerHTML = filiais.map((f) => {
      const r = f.resumo || {};
      const c = r.compras || {};
      const urgente = (r.pneus_critico || 0) > 0 || (c.pneus_para_comprar || 0) > 0;
      const atrasado = r.precisa_medir_semana;
      return `
        <div class="filial-card ${urgente ? 'is-urgente' : ''} ${atrasado ? 'is-atrasado' : ''}" data-id="${f.id}" role="button" tabindex="0">
          <div class="filial-card-head">
            <h3>${escapeHtml(f.nome)}</h3>
            <span class="badge badge-vida">${escapeHtml(f.codigo)}</span>
          </div>
          <p class="hint">${escapeHtml(f.contrato || 'Sem contrato')} · login: ${escapeHtml(f.login || '—')}</p>
          <p class="hint">
            Chatbot:
            ${f.whatsapp ? `<span class="mono">${escapeHtml(f.whatsapp)}</span>` : '<em>não cadastrado</em>'}
            ${f.whatsapp_grupo ? ` · grupo <span class="mono">${escapeHtml(f.whatsapp_grupo_nome || f.whatsapp_grupo)}</span>` : ''}
            ${f.whatsapp_alerta ? ` · alertas <span class="mono">${escapeHtml(f.whatsapp_alerta)}</span>` : ''}
            ${f.tem_wuzapi_token ? ' · token OK' : ''}
          </p>
          <div class="filial-stats">
            <span><strong>${r.veiculos_ativos ?? 0}</strong> veículos</span>
            <span class="text-critico"><strong>${c.pneus_para_comprar ?? r.acoes?.troca ?? 0}</strong> comprar</span>
            <span class="text-recap"><strong>${c.pneus_para_recap ?? r.acoes?.recap ?? 0}</strong> recap</span>
            <span><strong>${r.pneus_critico ?? 0}</strong> críticos</span>
          </div>
          <p class="hint filial-medicao">
            ${r.ultima_medicao
              ? `Última medição: ${formatDate(r.ultima_medicao)} (${r.dias_sem_medicao ?? 0} dias)`
              : 'Nunca mediu'}
            ${atrasado ? ' · <strong>Medir esta semana</strong>' : ''}
          </p>
          <div class="filial-card-actions">
            <button type="button" class="btn btn-sm btn-primary btn-abrir-filial" data-id="${f.id}">Abrir</button>
            <button type="button" class="btn btn-sm btn-ghost btn-editar-filial" data-id="${f.id}">Editar / senha</button>
            ${isAdmin() ? `<button type="button" class="btn btn-sm btn-ghost btn-limpar-frota-filial" data-id="${f.id}" data-nome="${escapeHtml(f.nome)}">Limpar frota</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    const abrir = (id) => abrirDetalheFilial(id);
    lista.querySelectorAll('.filial-card[data-id]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-editar-filial')) return;
        if (e.target.closest('.btn-limpar-frota-filial')) return;
        abrir(card.dataset.id);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          abrir(card.dataset.id);
        }
      });
    });
    lista.querySelectorAll('.btn-abrir-filial').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        abrir(btn.dataset.id);
      });
    });
    lista.querySelectorAll('.btn-editar-filial').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        abrirModalFilial(btn.dataset.id);
      });
    });
    lista.querySelectorAll('.btn-limpar-frota-filial').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const nome = btn.dataset.nome || 'esta filial';
        if (!confirm(`Apagar TODOS os caminhões, pneus e histórico de ${nome}?\n\nLogin e WhatsApp da unidade ficam. Não dá para desfazer.`)) {
          return;
        }
        try {
          const data = await fetchJSON(`${API}/filiais/${btn.dataset.id}/limpar-frota`, {
            method: 'POST',
            body: '{}',
          });
          toast(data.mensagem || `Frota de ${nome} limpa`, 'success');
          await loadFiliais();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function urgenciaVeiculo(v) {
  if (v.pendencias_troca) return 0;
  if (v.status_sulco === 'critico') return 1;
  if (v.pendencias_recap) return 2;
  if (v.pendencias_monitorar) return 3;
  if (v.status_sulco === 'alerta') return 4;
  if (v.status_sulco === 'sem_dado') return 5;
  return 6;
}

function pctBar(n, total) {
  if (!total) return 0;
  return Math.max(0, Math.round((Number(n || 0) / total) * 100));
}

function setUnidadeTab(tab) {
  const el = document.getElementById('filial-detalhe');
  if (!el) return;
  el.querySelectorAll('[data-unidade-panel]').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.unidadePanel !== tab);
  });
  el.querySelectorAll('.unidade-tab').forEach((b) => {
    b.classList.toggle('ativo', b.dataset.unidadeTab === tab);
  });
}

function filtrarPendenciasUnidade(filtro) {
  const el = document.getElementById('filial-detalhe');
  el?.querySelectorAll('.pendencia-grupo').forEach((g) => {
    const tipo = g.classList.contains('pendencia-troca')
      ? 'troca'
      : g.classList.contains('pendencia-recap')
        ? 'recap'
        : 'monitorar';
    g.classList.toggle('hidden', Boolean(filtro) && tipo !== filtro);
  });
  el?.querySelectorAll('.unidade-chip[data-pend-filtro]').forEach((btn) => {
    const val = btn.dataset.pendFiltro || '';
    btn.classList.toggle('ativo', val === (filtro || ''));
  });
}

function filtrarFrotaUnidade() {
  const busca = (document.getElementById('unidade-frota-busca')?.value || '').trim().toLowerCase();
  const filtro = document.getElementById('unidade-frota-filtro')?.value || 'todos';
  document.querySelectorAll('#unidade-frota-tbody tr.veiculo-item').forEach((row) => {
    const hay = (row.dataset.busca || '');
    const matchBusca = !busca || hay.includes(busca);
    let matchFiltro = true;
    if (filtro === 'critico') matchFiltro = row.dataset.status === 'critico';
    else if (filtro === 'comprar') matchFiltro = Number(row.dataset.troca || 0) > 0;
    else if (filtro === 'recap') matchFiltro = Number(row.dataset.recap || 0) > 0;
    else if (filtro === 'monitorar') matchFiltro = Number(row.dataset.monitorar || 0) > 0;
    else if (filtro === 'sem_dado') matchFiltro = row.dataset.status === 'sem_dado';
    else if (filtro === 'atencao') {
      matchFiltro = Number(row.dataset.troca || 0) > 0
        || Number(row.dataset.recap || 0) > 0
        || Number(row.dataset.monitorar || 0) > 0
        || row.dataset.status === 'critico'
        || row.dataset.status === 'sem_dado';
    }
    row.classList.toggle('hidden', !(matchBusca && matchFiltro));
  });
}

function abrirVeiculoNaUnidade(filialId, veiculoId) {
  setUnidadeTab('frota');
  abrirInspecaoVeiculoFilial(filialId, veiculoId);
}

function renderPendenciaRows(itens, tipo) {
  if (!itens?.length) return '';
  const titulo = tipo === 'troca' ? 'Comprar / Trocar' : tipo === 'recap' ? 'Recapagem' : 'Monitorar';
  return `
    <div class="pendencia-grupo pendencia-${tipo}">
      <h4>${titulo} (${itens.length})</h4>
      <div class="unidade-table-wrap">
      <table class="historico-table unidade-table">
        <thead>
          <tr>
            <th>Veículo</th><th>Posição</th><th>Fogo</th><th>Sulco</th>
            <th>Status</th><th>Diagnóstico</th><th>O que fazer</th><th>Medição</th>
          </tr>
        </thead>
        <tbody>
          ${itens.map((p) => `
            <tr class="unidade-pend-row" data-pend-tipo="${tipo}" data-veiculo-id="${p.veiculo_id}" title="Abrir o veículo para análise">
              <td><strong>${escapeHtml(p.apelido || p.placa)}</strong><br><span class="hint">${escapeHtml(p.placa)}</span></td>
              <td>${escapeHtml(p.posicao_label || p.posicao || '—')}</td>
              <td>${escapeHtml(p.numero_fogo || '—')}</td>
              <td><strong>${p.menor_sulco ?? '—'} mm</strong></td>
              <td>${badge(p.status_sulco)}</td>
              <td>${escapeHtml(p.diagnostico_label || '—')}</td>
              <td class="unidade-td-motivo" title="${escapeHtml(p.acao_motivo || textoOQueFazer(p))}">${escapeHtml(p.acao_motivo || textoOQueFazer(p))}</td>
              <td>${formatDate(p.data_medicao)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    </div>
  `;
}

function renderUnidadeKpis(data) {
  const r = data.resumo || {};
  const c = data.compras || r.compras || {};
  const total = r.pneus_total || 0;
  const w = (n) => `${pctBar(n, total)}%`;
  return `
    <div class="unidade-kpis">
      <button type="button" class="unidade-kpi is-critico" data-unidade-tab="pendencias" data-pend-filtro="troca">
        <strong>${r.pneus_critico ?? 0}</strong>
        <span>Críticos</span>
      </button>
      <button type="button" class="unidade-kpi is-compra" data-unidade-tab="pendencias" data-pend-filtro="troca">
        <strong>${c.pneus_para_comprar ?? 0}</strong>
        <span>Comprar</span>
      </button>
      <button type="button" class="unidade-kpi is-recap" data-unidade-tab="pendencias" data-pend-filtro="recap">
        <strong>${c.pneus_para_recap ?? 0}</strong>
        <span>Recap</span>
      </button>
      <button type="button" class="unidade-kpi is-mon" data-unidade-tab="pendencias" data-pend-filtro="monitorar">
        <strong>${c.pneus_monitorar ?? 0}</strong>
        <span>Monitorar</span>
      </button>
      <button type="button" class="unidade-kpi" data-unidade-tab="frota">
        <strong>${r.pneus_ok ?? 0}</strong>
        <span>OK</span>
      </button>
      <button type="button" class="unidade-kpi" data-unidade-tab="frota" data-frota-filtro="sem_dado">
        <strong>${r.pneus_sem_dado ?? 0}</strong>
        <span>Sem medição</span>
      </button>
      <div class="unidade-kpi is-static">
        <strong>${r.veiculos_ativos ?? 0}</strong>
        <span>Veículos</span>
      </div>
    </div>
    <div class="unidade-health" aria-label="Composição da frota">
      <span class="h-crit" style="width:${w(r.pneus_critico)}"></span>
      <span class="h-alerta" style="width:${w(r.pneus_alerta)}"></span>
      <span class="h-ok" style="width:${w(r.pneus_ok)}"></span>
      <span class="h-sem" style="width:${w(r.pneus_sem_dado)}"></span>
    </div>
    <p class="unidade-health-legend hint">
      <span class="dot-inline critico"></span> Crítico
      <span class="dot-inline alerta"></span> Monitorar
      <span class="dot-inline ok"></span> OK
      · ${total} pneus montados
      ${r.ultima_medicao ? ` · última medição ${formatDate(r.ultima_medicao)}${r.dias_sem_medicao != null ? ` (${r.dias_sem_medicao}d)` : ''}` : ' · nunca mediu'}
      ${r.precisa_medir_semana ? ' · <strong class="text-critico">medir esta semana</strong>' : ''}
    </p>
  `;
}

function renderUnidadeResumo(data) {
  const veiculos = [...(data.veiculos || [])].sort((a, b) => urgenciaVeiculo(a) - urgenciaVeiculo(b)
    || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99));
  const atencao = veiculos.filter((v) => urgenciaVeiculo(v) < 6).slice(0, 8);
  const pend = data.pendencias || {};
  const nPend = pend.todos?.length || 0;
  return `
    <div class="unidade-resumo-grid">
      <div class="unidade-resumo-card">
        <h4>Prioridade agora</h4>
        ${atencao.length ? `
          <ul class="unidade-prio-list">
            ${atencao.map((v) => `
              <li>
                <button type="button" class="unidade-prio-btn" data-veiculo-id="${v.id}">
                  <span>
                    <strong>${escapeHtml(v.apelido || v.placa)}</strong>
                    <span class="hint">${escapeHtml(v.placa)}${v.menor_sulco != null ? ` · ${v.menor_sulco} mm` : ''}</span>
                  </span>
                  <span class="unidade-prio-badges">
                    ${badge(v.status_sulco)}
                    ${v.pendencias_troca ? badgeAcao('troca', `${v.pendencias_troca}`) : ''}
                    ${v.pendencias_recap ? badgeAcao('recap', `${v.pendencias_recap}`) : ''}
                    ${v.pendencias_monitorar ? badgeAcao('monitorar', `${v.pendencias_monitorar}`) : ''}
                  </span>
                </button>
              </li>
            `).join('')}
          </ul>` : '<p class="hint">Nenhum veículo exige ação agora.</p>'}
      </div>
      <div class="unidade-resumo-card">
        <h4>Como ler esta tela</h4>
        <ol class="unidade-howto">
          <li>Os cartões do topo mostram o volume da unidade. Clique para filtrar.</li>
          <li><strong>Pendências</strong> lista cada pneu a comprar, recapar ou acompanhar.</li>
          <li><strong>Frota</strong> abre o desenho do caminhão ao lado da lista para cruzar sulco e diagnóstico.</li>
        </ol>
        <p class="hint" style="margin-top:.75rem">${nPend} pneu(s) com ação pendente nesta unidade.</p>
      </div>
    </div>
  `;
}

function renderUnidadeFrota(data) {
  const veiculos = [...(data.veiculos || [])].sort((a, b) => urgenciaVeiculo(a) - urgenciaVeiculo(b)
    || String(a.apelido || a.placa).localeCompare(String(b.apelido || b.placa), 'pt-BR'));
  if (!veiculos.length) return '<p class="hint">Nenhum veículo nesta unidade.</p>';
  return `
    <div class="unidade-frota-toolbar">
      <input type="search" id="unidade-frota-busca" placeholder="Buscar placa ou apelido…">
      <select id="unidade-frota-filtro">
        <option value="todos">Todos</option>
        <option value="atencao">Só com atenção</option>
        <option value="critico">Críticos</option>
        <option value="comprar">A comprar</option>
        <option value="recap">Recap</option>
        <option value="monitorar">Monitorar</option>
        <option value="sem_dado">Sem medição</option>
      </select>
    </div>
    <div class="unidade-frota-split" id="unidade-frota-split">
      <div class="unidade-table-wrap unidade-frota-lista">
        <table class="historico-table unidade-table">
          <thead>
            <tr>
              <th>Veículo</th><th>KM</th><th>Menor sulco</th><th>Status</th>
              <th>Troca</th><th>Recap</th><th>Mon.</th><th>Última medição</th>
            </tr>
          </thead>
          <tbody id="unidade-frota-tbody">
            ${veiculos.map((v) => `
              <tr class="veiculo-item unidade-veiculo-row" data-id="${v.id}"
                  data-status="${v.status_sulco || ''}"
                  data-troca="${v.pendencias_troca || 0}"
                  data-recap="${v.pendencias_recap || 0}"
                  data-monitorar="${v.pendencias_monitorar || 0}"
                  data-busca="${escapeHtml(`${v.apelido || ''} ${v.placa || ''}`.toLowerCase())}"
                  tabindex="0" role="button">
                <td>
                  <strong>${escapeHtml(v.apelido || v.placa)}</strong>
                  <br><span class="hint">${escapeHtml(v.placa)} · ${escapeHtml(v.tipo || '')} · ${v.total_pneus || 0} pneus</span>
                </td>
                <td>${(v.km_atual || 0).toLocaleString('pt-BR')}</td>
                <td><strong>${v.menor_sulco != null ? `${v.menor_sulco} mm` : '—'}</strong></td>
                <td>${badge(v.status_sulco)}</td>
                <td>${v.pendencias_troca || '—'}</td>
                <td>${v.pendencias_recap || '—'}</td>
                <td>${v.pendencias_monitorar || '—'}</td>
                <td>${v.ultima_medicao ? formatDate(v.ultima_medicao) : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div id="filial-veiculo-inspecao" class="filial-inspecao hidden"></div>
    </div>
  `;
}

function valorCampoWa(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return '';
  return s;
}

function idGrupoCanonicoFront(v) {
  const s = valorCampoWa(v);
  if (!s) return '';
  const gUs = s.match(/^([^@\s]+)@g\.us$/i);
  if (gUs) return gUs[1].replace(/:[0-9]+$/, '');
  if (/@g\.us$/i.test(s)) return s.replace(/@g\.us$/i, '').replace(/[^\d-]/g, '');
  return s.replace(/[^\d-]/g, '') || s;
}

function jidsGrupoIguaisFront(a, b) {
  if (!a || !b) return false;
  if (valorCampoWa(a) === valorCampoWa(b)) return true;
  const idA = idGrupoCanonicoFront(a);
  const idB = idGrupoCanonicoFront(b);
  return Boolean(idA && idB && idA === idB);
}

function rotuloGrupoWhatsapp(jid, nome) {
  const n = valorCampoWa(nome);
  if (n && n !== '(sem nome)' && n !== jid) return n;
  return valorCampoWa(jid) || 'Grupo selecionado';
}

function htmlGrupoAtivoChatbot(jid, nome) {
  if (!jid) {
    return '<p class="hint" style="margin:0">Nenhum grupo selecionado — o chatbot não responde placas em grupos.</p>';
  }
  return `
    <p class="cb-grupo-ativo-line"><strong>${escapeHtml(rotuloGrupoWhatsapp(jid, nome))}</strong></p>
    <p class="hint" style="margin:.35rem 0 0">O chatbot só responde a placa neste grupo.</p>
  `;
}

async function abrirDetalheFilial(id) {
  try {
    const data = await fetchJSON(`${API}/filiais/${id}`);
    filialDetalheCache = data;
    const el = document.getElementById('filial-detalhe');
    const pend = data.pendencias || { troca: [], recap: [], monitorar: [] };
    const tit = document.getElementById('filiais-titulo');
    const hint = document.getElementById('filiais-hint');

    const gerenteUnidade = isGerente() && !isAdmin();
    setModoListaFiliais(false);
    if (tit) tit.textContent = gerenteUnidade ? 'Minha unidade' : (data.nome || 'Filial');
    if (hint) {
      hint.textContent = gerenteUnidade
        ? `${data.codigo || ''} · indicadores, pendências e frota da sua unidade.`
        : `${data.codigo || ''} · só dados desta unidade. Use “Voltar” para ver todas as filiais.`;
    }

    const nPend = pend.todos?.length || 0;
    const nFrota = data.veiculos?.length || 0;

    el.innerHTML = `
      <div class="unidade-shell">
        <div class="unidade-head">
          <div>
            ${gerenteUnidade
              ? ''
              : '<button type="button" class="btn btn-ghost btn-sm" id="btn-fechar-detalhe-filial">← Voltar às filiais</button>'}
            <h3>${escapeHtml(data.nome)} <span class="hint">(${escapeHtml(data.codigo || '')})</span></h3>
            <p class="hint">${escapeHtml(data.contrato || '')}${data.login ? ` · login ${escapeHtml(data.login)}` : ''}
              ${gerenteUnidade ? ' · chatbot na aba WhatsApp' : ''}</p>
          </div>
          <div class="unidade-head-actions" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-start">
            <button type="button" class="btn btn-primary btn-sm" id="btn-pdf-semanal" data-filial-id="${data.id}">
              Baixar PDF semanal
            </button>
            ${isAdmin()
              ? `<button type="button" class="btn btn-ghost btn-sm btn-editar-filial-detalhe" data-id="${data.id}">Editar / senha</button>`
              : ''}
          </div>
        </div>
        ${renderUnidadeKpis(data)}
        <nav class="unidade-tabs" aria-label="Seções da unidade">
          <button type="button" class="unidade-tab ativo" data-unidade-tab="resumo">Visão geral</button>
          <button type="button" class="unidade-tab" data-unidade-tab="pendencias">Pendências (${nPend})</button>
          <button type="button" class="unidade-tab" data-unidade-tab="frota">Frota (${nFrota})</button>
        </nav>
        <div data-unidade-panel="resumo">${renderUnidadeResumo(data)}</div>
        <div data-unidade-panel="pendencias" class="hidden">
          <div class="unidade-pend-filtros">
            <button type="button" class="unidade-chip ativo" data-pend-filtro="">Todas (${nPend})</button>
            <button type="button" class="unidade-chip" data-pend-filtro="troca">Comprar (${pend.troca?.length || 0})</button>
            <button type="button" class="unidade-chip" data-pend-filtro="recap">Recap (${pend.recap?.length || 0})</button>
            <button type="button" class="unidade-chip" data-pend-filtro="monitorar">Monitorar (${pend.monitorar?.length || 0})</button>
          </div>
          ${nPend
            ? `${renderPendenciaRows(pend.troca, 'troca')}
               ${renderPendenciaRows(pend.recap, 'recap')}
               ${renderPendenciaRows(pend.monitorar, 'monitorar')}`
            : '<p class="hint">Nenhum alerta pendente nesta unidade — frota dentro dos parâmetros.</p>'}
        </div>
        <div data-unidade-panel="frota" class="hidden">
          <p class="hint">Clique num veículo para abrir o desenho e o diagnóstico ao lado. Clique de novo para recolher.</p>
          ${renderUnidadeFrota(data)}
        </div>
      </div>
    `;

    document.getElementById('btn-fechar-detalhe-filial')?.addEventListener('click', () => fecharDetalheFilial());
    el.querySelector('.btn-editar-filial-detalhe')?.addEventListener('click', () => abrirModalFilial(id));
    document.getElementById('btn-pdf-semanal')?.addEventListener('click', () => {
      baixarPdfSemanalUnidade(id);
    });

    el.querySelectorAll('[data-unidade-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.unidadeTab;
        setUnidadeTab(tab);
        const pendFiltro = btn.dataset.pendFiltro;
        if (tab === 'pendencias' && pendFiltro != null) filtrarPendenciasUnidade(pendFiltro);
        const frotaFiltro = btn.dataset.frotaFiltro;
        if (tab === 'frota' && frotaFiltro) {
          const sel = document.getElementById('unidade-frota-filtro');
          if (sel) sel.value = frotaFiltro;
          filtrarFrotaUnidade();
        }
      });
    });
    el.querySelectorAll('[data-pend-filtro]').forEach((btn) => {
      if (btn.dataset.unidadeTab) return;
      btn.addEventListener('click', () => filtrarPendenciasUnidade(btn.dataset.pendFiltro || ''));
    });
    document.getElementById('unidade-frota-busca')?.addEventListener('input', filtrarFrotaUnidade);
    document.getElementById('unidade-frota-filtro')?.addEventListener('change', filtrarFrotaUnidade);

    el.querySelectorAll('.unidade-pend-row').forEach((row) => {
      row.addEventListener('click', () => abrirVeiculoNaUnidade(id, row.dataset.veiculoId));
    });
    el.querySelectorAll('.unidade-prio-btn').forEach((btn) => {
      btn.addEventListener('click', () => abrirVeiculoNaUnidade(id, btn.dataset.veiculoId));
    });
    el.querySelectorAll('.veiculo-item[data-id]').forEach((row) => {
      const open = () => abrirInspecaoVeiculoFilial(id, row.dataset.id);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    toast(err.message, 'error');
    setModoListaFiliais(true);
  }
}

function renderChatbotPanelHtml(data) {
  const grupoAtual = valorCampoWa(data.whatsapp_grupo);
  const grupoNome = valorCampoWa(data.whatsapp_grupo_nome);
  const chip = valorCampoWa(data.whatsapp);
  const alerta = valorCampoWa(data.whatsapp_alerta);
  const temGrupo = Boolean(grupoAtual);
  const labelGrupo = rotuloGrupoWhatsapp(grupoAtual, grupoNome);
  return `
    <div class="filial-chatbot-panel cb-setup">
      <header class="cb-hero">
        <div class="cb-hero-text">
          <p class="cb-kicker">Chatbot da unidade</p>
          <h3>${escapeHtml(data.nome || 'Unidade')}${data.codigo ? ` <span class="cb-code">${escapeHtml(data.codigo)}</span>` : ''}</h3>
          <p class="hint cb-hero-hint">Placa no grupo → link de medição. Recap: <code>recap 08251227 Fornecedor 26/08/2026</code>.</p>
        </div>
        <div class="cb-status-card">
          <span id="fc-status" class="badge badge-sem_dado">Status…</span>
          <p class="hint" id="fc-status-detail">Verificando conexão…</p>
          <div class="cb-status-actions">
            <button type="button" class="btn btn-primary" id="btn-fc-conectar">Conectar / QR</button>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-desconectar">Desconectar</button>
          </div>
        </div>
      </header>

      <ol class="cb-steps">
        <li class="cb-step is-active" id="fc-step-connect">
          <div class="cb-step-head">
            <span class="cb-step-num">1</span>
            <div>
              <h4>Conectar o chip</h4>
              <p class="hint">O token é gerado sozinho. Escaneie o QR com o WhatsApp do chip da unidade.</p>
            </div>
          </div>
          <div class="cb-step-body">
            <div class="form-group">
              <label for="fc-whatsapp">Número do chip</label>
              <input type="tel" id="fc-whatsapp" class="mono" value="${escapeHtml(chip)}" placeholder="Com DDI, ex.: 5562999999999" inputmode="tel" autocomplete="tel">
              <small class="field-hint">Salva sozinho ao sair do campo. Se o QR conectar, o número do chip entra sozinho.</small>
            </div>
            <p class="hint" id="fc-wuzapi-hint">Servidor do chatbot precisa estar no ar. Clique em Conectar / QR — o token é criado automaticamente.</p>
            <div class="cb-qr-panel hidden" id="fc-qr-wrap">
              <h4 id="fc-qr-titulo">Escaneie o QR Code</h4>
              <p class="hint">No celular do chip: WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
              <p class="hint" id="fc-qr-status">Gerando QR Code…</p>
              <img id="fc-qr-img" class="wa-qr-img hidden" alt="QR Code WhatsApp">
              <p class="hint">O QR expira em poucos segundos — clique em Conectar de novo se precisar.</p>
              <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-qr-fechar">Fechar QR</button>
            </div>
          </div>
        </li>

        <li class="cb-step${temGrupo ? ' is-done' : ''}" id="fc-step-group">
          <div class="cb-step-head">
            <span class="cb-step-num">2</span>
            <div>
              <h4>Grupo da medição</h4>
              <p class="hint">Grupo onde o borracheiro manda a placa. Só este grupo recebe resposta do chatbot.</p>
            </div>
          </div>
          <div class="cb-step-body">
            <div class="cb-grupo-locked${temGrupo ? '' : ' hidden'}" id="fc-grupo-locked">
              <div class="cb-grupo-ativo" id="fc-grupo-ativo">
                ${htmlGrupoAtivoChatbot(grupoAtual, grupoNome)}
              </div>
              <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-trocar-grupo">Escolher outro grupo</button>
            </div>
            <div class="cb-grupo-picker${temGrupo ? ' hidden' : ''}" id="fc-grupo-picker">
              <div class="form-row" style="align-items:flex-end;gap:.5rem">
                <div class="form-group" style="flex:1;margin:0">
                  <label for="fc-whatsapp-grupo">Grupo WhatsApp</label>
                  <select id="fc-whatsapp-grupo">
                    <option value="">— Selecione o grupo —</option>
                    ${grupoAtual ? `<option value="${escapeHtml(grupoAtual)}" selected data-nome="${escapeHtml(grupoNome)}">${escapeHtml(labelGrupo)}</option>` : ''}
                  </select>
                </div>
                <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-grupos">Atualizar lista</button>
              </div>
              <div class="form-row" style="gap:.5rem;margin-top:.5rem">
                <button type="button" class="btn btn-ghost btn-sm${temGrupo ? '' : ' hidden'}" id="btn-fc-cancelar-grupo">Cancelar</button>
              </div>
              <small class="field-hint">O chip precisa estar no grupo. Conecte primeiro (passo 1), depois escolha o grupo. A lista só abre aqui.</small>
            </div>
            <input type="hidden" id="fc-whatsapp-grupo-jid" value="${escapeHtml(grupoAtual)}">
            <input type="hidden" id="fc-whatsapp-grupo-nome" value="${escapeHtml(grupoNome)}">
          </div>
        </li>
        <li class="cb-step cb-step-muted${alerta ? ' is-done' : ''}" id="fc-step-alerta">
          <div class="cb-step-head">
            <span class="cb-step-num">3</span>
            <div>
              <h4>Quem recebe alertas ${data.alertas_enabled ? '' : '<span class="cb-pill">pausado</span>'}</h4>
              <p class="hint">${data.alertas_enabled
                ? 'Marque usuários ou grupos que recebem alerta depois de medição crítica/monitorar.'
                : 'Alertas depois da medição estão pausados. O chatbot do grupo (placa, limite, relatório) continua respondendo.'}</p>
            </div>
          </div>
          <div class="cb-step-body">
            <div class="form-row" style="align-items:center;gap:.5rem;margin-bottom:.55rem">
              <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-alerta-opcoes">Atualizar lista</button>
              <small class="field-hint" style="margin:0">Usuários com WhatsApp + grupos do chip.</small>
            </div>
            <div class="cb-check-list" id="fc-alerta-lista">
              <p class="hint">Clique em “Atualizar lista” para carregar as opções.</p>
            </div>
            <input type="hidden" id="fc-whatsapp-alerta" value="${escapeHtml(alerta)}">
          </div>
        </li>
      </ol>

      <p class="hint cb-autosave-hint">Número, grupo e alertas salvam automaticamente — não precisa clicar em salvar.</p>

      <div class="wa-envios-panel" id="fc-envios-panel">
        <div class="section-header" style="margin:0 0 .5rem;align-items:center">
          <h4 style="margin:0">Envios recentes</h4>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap">
            <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-envios">Atualizar</button>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-limpar-pendentes">Limpar pendentes</button>
          </div>
        </div>
        <p class="hint" id="fc-envios-hint" style="margin:0 0 .65rem">
          Só o grupo selecionado na etapa 2. Aparecem link de medição, relatório PDF e falha real — sem “aguarde”, placa errada ou conversa.
        </p>
        <div class="compras-resumo-filial" style="margin-bottom:.75rem">
          <div class="compras-chip monitorar"><strong id="fc-env-pendentes">—</strong><span>Pendentes / falha</span></div>
          <div class="compras-chip"><strong id="fc-env-enviados">—</strong><span>Enviados</span></div>
        </div>
        <details class="wa-envios-logs" id="fc-envios-detalhes-wrap">
          <summary>Ver pendentes, enviados e logs</summary>
          <div id="fc-envios-pendentes-list" class="wa-envios-list" style="margin-top:.65rem"></div>
          <div id="fc-envios-enviados-list" class="wa-envios-list" style="margin-top:.5rem"></div>
          <div id="fc-envios-logs" class="wa-envios-logs-body mono" style="margin-top:.75rem"></div>
        </details>
      </div>
    </div>
  `;
}

async function loadChatbotGerente() {
  const box = document.getElementById('chatbot-filial-panel');
  if (!box) return;
  if (!isGerente()) {
    box.innerHTML = `<p class="hint login-erro">Somente o gerente da unidade configura o chatbot WhatsApp.</p>`;
    return;
  }
  let filialId = currentUser?.filial_id;
  // Gerente multiunidade: pega a primeira do escopo
  if (!filialId) {
    try {
      const filiais = await fetchJSON(`${API}/filiais`);
      filialId = filiais[0]?.id || null;
    } catch { /* ignore */ }
  }
  if (!filialId) {
    box.innerHTML = `<p class="hint login-erro">Seu login não está vinculado a uma filial. Abra Minha unidade e peça ao admin para vincular.</p>`;
    return;
  }
  try {
    const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/config`);
    box.innerHTML = renderChatbotPanelHtml(data);
    wireFilialChatbotPanel(filialId, data.nome, { alertasEnabled: Boolean(data.alertas_enabled) });
  } catch (err) {
    box.innerHTML = `<p class="hint login-erro">${escapeHtml(err.message)}</p>`;
  }
}

function wireFilialChatbotPanel(filialId, nomeFilial, { alertasEnabled = false } = {}) {
  const statusEl = document.getElementById('fc-status');
  let salvandoChipAuto = false;

  const lerAlertasSelecionados = () => {
    const todos = [...document.querySelectorAll('#fc-alerta-lista input[type="checkbox"][data-valor]')];
    if (todos.length) {
      return todos.filter((c) => c.checked).map((c) => c.dataset.valor).filter(Boolean);
    }
    const hidden = valorCampoWa(document.getElementById('fc-whatsapp-alerta')?.value);
    return hidden ? hidden.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean) : [];
  };

  const syncHiddenAlertas = () => {
    const hidden = document.getElementById('fc-whatsapp-alerta');
    if (!hidden) return;
    hidden.value = lerAlertasSelecionados().join(',');
  };

  let chipSessaoAplicado = false;

  const aplicarNumeroChip = async (phone, { salvar = true, forcar = false } = {}) => {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return;
    if (digits.length >= 15 && digits.startsWith('120')) return;
    const input = document.getElementById('fc-whatsapp');
    if (!input) return;
    if (!forcar && valorCampoWa(input.value) === digits) return;
    input.value = digits;
    if (!salvar || salvandoChipAuto) return;
    salvandoChipAuto = true;
    try {
      await fetchJSON(`${API}/whatsapp/filiais-chatbot/${filialId}`, {
        method: 'PUT',
        body: JSON.stringify({ whatsapp: digits }),
      });
    } catch {
      // ignore — número já aparece na tela
    } finally {
      salvandoChipAuto = false;
    }
  };

  const salvarNumeroChipDigitado = async () => {
    const input = document.getElementById('fc-whatsapp');
    if (!input) return;
    const digits = String(input.value || '').replace(/\D/g, '');
    if (!digits) {
      await fetchJSON(`${API}/whatsapp/filiais-chatbot/${filialId}`, {
        method: 'PUT',
        body: JSON.stringify({ whatsapp: null }),
      });
      return;
    }
    if (digits.length < 10 || digits.length > 15) {
      toast('Informe o número com DDI (ex.: 5562…), 10 a 15 dígitos', 'error');
      return;
    }
    input.value = digits;
    await fetchJSON(`${API}/whatsapp/filiais-chatbot/${filialId}`, {
      method: 'PUT',
      body: JSON.stringify({ whatsapp: digits }),
    });
    toast('Número do chip salvo', 'success');
  };

  const refreshStatus = async () => {
    if (!statusEl) return;
    const detail = document.getElementById('fc-status-detail');
    const stepConnect = document.getElementById('fc-step-connect');
    const stepGroup = document.getElementById('fc-step-group');
    try {
      const st = await fetchJSON(`${API}/whatsapp/filial/${filialId}/status`);
      if (st.loggedIn && st.phone) {
        const atual = String(document.getElementById('fc-whatsapp')?.value || '').replace(/\D/g, '');
        if (!chipSessaoAplicado || !atual) {
          await aplicarNumeroChip(st.phone, { salvar: true, forcar: true });
          chipSessaoAplicado = true;
        }
      }
      if (st.loggedIn) {
        statusEl.className = 'badge badge-ok';
        statusEl.textContent = 'Online';
        if (detail) detail.textContent = 'Conectado. O chatbot só responde no grupo escolhido abaixo.';
        stepConnect?.classList.add('is-done');
        stepConnect?.classList.remove('is-active');
        stepGroup?.classList.add('is-active');
        const jidSalvo = valorCampoWa(document.getElementById('fc-whatsapp-grupo-jid')?.value);
        const pickerAberto = !document.getElementById('fc-grupo-picker')?.classList.contains('hidden');
        if (!jidSalvo || pickerAberto) carregarGrupos(true);
      } else if (st.connected) {
        statusEl.className = 'badge badge-alerta';
        statusEl.textContent = 'Aguardando QR';
        if (detail) detail.textContent = 'Escaneie o QR com o WhatsApp do chip.';
        stepConnect?.classList.add('is-active');
      } else if (!st.configurado) {
        statusEl.className = 'badge badge-sem_dado';
        statusEl.textContent = 'Sem token';
        if (detail) detail.textContent = 'Clique em Conectar / QR — o token é gerado automaticamente.';
        stepConnect?.classList.add('is-active');
      } else {
        statusEl.className = 'badge badge-sem_dado';
        statusEl.textContent = 'Desconectado';
        if (detail) detail.textContent = 'Servidor no ar? Clique em Conectar / QR.';
        stepConnect?.classList.add('is-active');
        stepConnect?.classList.remove('is-done');
      }
    } catch (err) {
      statusEl.className = 'badge badge-critico';
      statusEl.textContent = 'Erro status';
      if (detail) detail.textContent = err?.message || 'Falha ao consultar o chatbot.';
      const hint = document.getElementById('fc-wuzapi-hint');
      if (hint && err?.message) {
        hint.textContent = err.message;
        hint.classList.add('login-erro');
      }
    }
  };
  refreshStatus();

  const renderEnvioItem = (item, { reenviar = false } = {}) => `
    <div class="wa-envio-item" data-id="${item.id}">
      <div class="wa-envio-meta">
        <span class="badge ${item.status === 'erro' ? 'badge-critico' : 'badge-ok'}">${escapeHtml(item.status_label)}</span>
        <strong>${escapeHtml(item.tipo_label)}</strong>
        ${item.eh_alerta ? '<span class="cb-pill">alerta</span>' : ''}
        ${item.placa ? `<span class="mono">${escapeHtml(item.placa)}</span>` : ''}
        <span class="hint">${escapeHtml(formatDateTime(item.criado_em))}</span>
      </div>
      <div class="hint">Para: <span class="mono">${escapeHtml(item.destinatario || '—')}</span></div>
      <div class="hint">${escapeHtml(item.preview || '')}${item.erro ? ` · <span class="login-erro">${escapeHtml(item.erro)}</span>` : ''}</div>
      ${reenviar && item.pode_reenviar !== false ? `<button type="button" class="btn btn-ghost btn-sm btn-fc-reenviar" data-id="${item.id}">Reenviar</button>` : ''}
    </div>
  `;

  const carregarEnvios = async (silencioso = false) => {
    const pendEl = document.getElementById('fc-envios-pendentes-list');
    const envEl = document.getElementById('fc-envios-enviados-list');
    const logsEl = document.getElementById('fc-envios-logs');
    if (!pendEl && !envEl) return;
    try {
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/envios`);
      const r = data.resumo || {};
      const pCount = document.getElementById('fc-env-pendentes');
      const eCount = document.getElementById('fc-env-enviados');
      if (pCount) pCount.textContent = String(r.pendentes ?? 0);
      if (eCount) eCount.textContent = String(r.enviados ?? 0);

      if (pendEl) {
        pendEl.innerHTML = data.pendentes?.length
          ? `<h5 style="margin:.25rem 0">Pendentes / falha</h5>${data.pendentes.map((i) => renderEnvioItem(i, { reenviar: true })).join('')}`
          : `<p class="hint">${escapeHtml(data.mensagem || 'Nenhum envio pendente neste grupo.')}</p>`;
      }
      if (envEl) {
        envEl.innerHTML = data.enviados?.length
          ? `<h5 style="margin:.25rem 0">Últimos enviados</h5>${data.enviados.slice(0, 8).map((i) => renderEnvioItem(i)).join('')}`
          : `<p class="hint">${escapeHtml(data.mensagem || 'Nenhum envio neste grupo ainda. Só entra link de medição ou relatório.')}</p>`;
      }
      if (logsEl) {
        logsEl.innerHTML = (data.logs || []).map((i) => `
          <div class="wa-log-line">
            <div><strong>#${i.id}</strong> ${escapeHtml(i.criado_em || '')} · ${escapeHtml(i.status_label)} · ${escapeHtml(i.tipo_label)}
              → <span class="mono">${escapeHtml(i.destinatario || '')}</span>
              ${i.placa ? ` · ${escapeHtml(i.placa)}` : ''}
              ${i.erro ? ` · <span class="login-erro">${escapeHtml(i.erro)}</span>` : ''}
            </div>
            <pre class="wa-log-msg">${escapeHtml(String(i.mensagem || '').slice(0, 280))}${String(i.mensagem || '').length > 280 ? '…' : ''}</pre>
          </div>
        `).join('') || '<p class="hint">Sem logs.</p>';
      }

      pendEl?.querySelectorAll('.btn-fc-reenviar').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          try {
            btn.disabled = true;
            await fetchJSON(`${API}/whatsapp/filial/${filialId}/envios/${id}/reenviar`, {
              method: 'POST',
              body: '{}',
            });
            toast('Reenviado', 'success');
            carregarEnvios(true);
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      if (!silencioso) toast(err.message, 'error');
      if (pendEl) pendEl.innerHTML = `<p class="hint login-erro">${escapeHtml(err.message)}</p>`;
    }
  };

  document.getElementById('btn-fc-envios')?.addEventListener('click', () => carregarEnvios(false));
  document.getElementById('btn-fc-limpar-pendentes')?.addEventListener('click', async () => {
    if (!confirm('Limpar todos os envios pendentes / com falha desta unidade?')) return;
    try {
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/envios/pendentes`, {
        method: 'DELETE',
      });
      toast(data.mensagem || `Removidos: ${data.removidos || 0}`, 'success');
      carregarEnvios(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  carregarEnvios(true);

  const lerGrupoSalvo = () => ({
    jid: valorCampoWa(document.getElementById('fc-whatsapp-grupo-jid')?.value),
    nome: valorCampoWa(document.getElementById('fc-whatsapp-grupo-nome')?.value),
  });

  const gravarGrupoSalvoUi = (jid, nome) => {
    const jidEl = document.getElementById('fc-whatsapp-grupo-jid');
    const nomeEl = document.getElementById('fc-whatsapp-grupo-nome');
    if (jidEl) jidEl.value = jid || '';
    if (nomeEl) nomeEl.value = nome || '';
  };

  const travarGrupoUi = (jid, nome) => {
    gravarGrupoSalvoUi(jid, nome);
    const badge = document.getElementById('fc-grupo-ativo');
    if (badge) badge.innerHTML = htmlGrupoAtivoChatbot(jid, nome);
    document.getElementById('fc-grupo-locked')?.classList.toggle('hidden', !jid);
    document.getElementById('fc-grupo-picker')?.classList.toggle('hidden', Boolean(jid));
    document.getElementById('btn-fc-cancelar-grupo')?.classList.toggle('hidden', !jid);
    document.getElementById('fc-step-group')?.classList.toggle('is-done', Boolean(jid));
  };

  const abrirEscolhaGrupo = () => {
    document.getElementById('fc-grupo-locked')?.classList.add('hidden');
    document.getElementById('fc-grupo-picker')?.classList.remove('hidden');
    const salvo = lerGrupoSalvo();
    document.getElementById('btn-fc-cancelar-grupo')?.classList.toggle('hidden', !salvo.jid);
    carregarGrupos(false);
  };

  const carregarGrupos = async (silencioso = false) => {
    const sel = document.getElementById('fc-whatsapp-grupo');
    if (!sel) return;
    const salvo = lerGrupoSalvo();
    const atual = valorCampoWa(sel.value) || salvo.jid;
    try {
      if (!silencioso) toast('Buscando grupos no WhatsApp…');
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/grupos`);
      const grupos = data.grupos || [];
      const selJid = valorCampoWa(data.selecionado) || atual;
      const selNome = valorCampoWa(data.selecionado_nome) || salvo.nome;
      sel.innerHTML = '<option value="">— Selecione o grupo —</option>';
      let achouAtual = false;
      for (const g of grupos) {
        const id = valorCampoWa(g.jid || g.id);
        if (!id) continue;
        const nome = valorCampoWa(g.nome || g.name);
        const opt = document.createElement('option');
        opt.value = id;
        opt.dataset.nome = nome;
        opt.textContent = (nome && nome !== '(sem nome)') ? nome : 'Grupo sem nome';
        if (selJid && jidsGrupoIguaisFront(selJid, id)) {
          opt.selected = true;
          achouAtual = true;
        }
        sel.appendChild(opt);
      }
      if (selJid && !achouAtual) {
        const opt = document.createElement('option');
        opt.value = selJid;
        opt.dataset.nome = selNome;
        opt.selected = true;
        opt.textContent = rotuloGrupoWhatsapp(selJid, selNome);
        sel.appendChild(opt);
      }
      if (selNome && selJid) gravarGrupoSalvoUi(selJid, selNome);
      if (!silencioso) {
        toast(grupos.length ? `${grupos.length} grupo(s) encontrado(s)` : 'Nenhum grupo — entre no grupo com o chip e tente de novo', grupos.length ? 'success' : 'error');
      }
    } catch (err) {
      if (!silencioso) toast(err.message, 'error');
    }
  };

  document.getElementById('btn-fc-grupos')?.addEventListener('click', () => carregarGrupos(false));
  document.getElementById('btn-fc-trocar-grupo')?.addEventListener('click', () => abrirEscolhaGrupo());
  document.getElementById('btn-fc-cancelar-grupo')?.addEventListener('click', () => {
    const salvo = lerGrupoSalvo();
    travarGrupoUi(salvo.jid, salvo.nome);
  });

  const salvarCamposChatbot = async (body, { silencioso = false, mensagem } = {}) => {
    const data = await fetchJSON(`${API}/whatsapp/filiais-chatbot/${filialId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    filiaisCache = [];
    if (!silencioso) toast(mensagem || data.mensagem || 'Salvo', 'success');
    return data;
  };

  const carregarAlertaOpcoes = async (silencioso = false) => {
    const box = document.getElementById('fc-alerta-lista');
    if (!box) return;
    try {
      if (!silencioso) toast('Carregando destinatários de alerta…');
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/alerta-opcoes`);
      const selecionados = new Set((data.selecionados || []).map((s) => String(s)));
      const opcoes = data.opcoes || [];
      if (!opcoes.length) {
        box.innerHTML = '<p class="hint">Nenhuma opção — cadastre WhatsApp nos usuários ou conecte e atualize os grupos.</p>';
        return;
      }
      box.innerHTML = opcoes.map((o) => {
        const valor = valorCampoWa(o.valor);
        const checked = selecionados.has(valor) ? 'checked' : '';
        const tipo = o.tipo === 'grupo' ? 'Grupo' : (o.tipo === 'usuario' ? 'Usuário' : 'Número');
        return `
          <label class="cb-check-item">
            <input type="checkbox" data-valor="${escapeHtml(valor)}" ${checked}>
            <span class="cb-check-main">
              <strong>${escapeHtml(o.nome || valor)}</strong>
              <span class="hint">${escapeHtml(tipo)}${o.detalhe ? ` · ${escapeHtml(o.detalhe)}` : ''} · <span class="mono">${escapeHtml(valor)}</span></span>
            </span>
          </label>
        `;
      }).join('');
      syncHiddenAlertas();
      box.querySelectorAll('input[type="checkbox"]').forEach((el) => {
        el.addEventListener('change', async () => {
          syncHiddenAlertas();
          try {
            await salvarCamposChatbot(
              { whatsapp_alerta: lerAlertasSelecionados() },
              { silencioso: true }
            );
            document.getElementById('fc-step-alerta')?.classList.toggle('is-done', lerAlertasSelecionados().length > 0);
            toast('Destinatários de alerta salvos', 'success');
          } catch (err) {
            toast(err.message || 'Falha ao salvar alertas', 'error');
          }
        });
      });
      if (!silencioso) toast(`${opcoes.length} opção(ões) carregada(s)`, 'success');
    } catch (err) {
      if (!silencioso) toast(err.message, 'error');
      box.innerHTML = `<p class="hint login-erro">${escapeHtml(err.message)}</p>`;
    }
  };

  document.getElementById('fc-whatsapp')?.addEventListener('change', async () => {
    try {
      await salvarNumeroChipDigitado();
    } catch (err) {
      toast(err.message || 'Falha ao salvar o número', 'error');
    }
  });
  document.getElementById('fc-whatsapp')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('fc-whatsapp')?.blur();
    }
  });

  document.getElementById('fc-whatsapp-grupo')?.addEventListener('change', async () => {
    const sel = document.getElementById('fc-whatsapp-grupo');
    const grupo = valorCampoWa(sel?.value) || null;
    const nome = grupo ? valorCampoWa(sel?.selectedOptions?.[0]?.dataset?.nome) : null;
    try {
      toast(grupo ? 'Salvando grupo do chatbot…' : 'Removendo grupo…');
      await salvarCamposChatbot({
        whatsapp_grupo: grupo,
        whatsapp_grupo_nome: nome || null,
      }, { silencioso: true });
      travarGrupoUi(grupo, nome);
      toast(
        grupo
          ? `Grupo salvo: ${rotuloGrupoWhatsapp(grupo, nome)}. O chatbot só responde neste grupo.`
          : 'Grupo removido — o chatbot não responde mais em grupos.',
        'success'
      );
    } catch (err) {
      toast(err.message || 'Falha ao salvar grupo', 'error');
    }
  });

  document.getElementById('btn-fc-alerta-opcoes')?.addEventListener('click', () => carregarAlertaOpcoes(false));
  setTimeout(() => carregarAlertaOpcoes(true), 600);

  document.getElementById('btn-fc-conectar')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-fc-conectar');
    try {
      if (btn) btn.disabled = true;
      abrirPainelQr('Gerando QR Code… isso pode levar alguns segundos.', nomeFilial);
      toast(`Conectando chatbot ${nomeFilial}…`);
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/connect`, {
        method: 'POST',
        body: '{}',
      });
      mostrarQrFilial(data, nomeFilial);
      if (data.phone) {
        chipSessaoAplicado = false;
        await aplicarNumeroChip(data.phone, { salvar: true, forcar: true });
        chipSessaoAplicado = true;
      }
      if (data.loggedIn) {
        toast(data.mensagem || `Chatbot ${nomeFilial} já está conectado`, 'success');
      } else if (data.qrcode) {
        toast('Escaneie o QR com o WhatsApp do chip', 'success');
        startWaPollFilial(filialId, nomeFilial);
      } else {
        toast(data.mensagem || 'Não foi possível gerar o QR', 'error');
        startWaPollFilial(filialId, nomeFilial);
      }
      refreshStatus();
      const jidSalvo = valorCampoWa(document.getElementById('fc-whatsapp-grupo-jid')?.value);
      if (data.loggedIn && !jidSalvo) setTimeout(() => carregarGrupos(true), 1200);
    } catch (err) {
      abrirPainelQr(err.message || 'Falha ao gerar o QR', nomeFilial);
      const { status } = painelQrEls();
      status?.classList.add('login-erro');
      toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById('btn-fc-desconectar')?.addEventListener('click', async () => {
    if (!confirm('Desconectar o chip, apagar número e grupo salvos, e deixar limpo para conectar outro celular?')) return;
    const btn = document.getElementById('btn-fc-desconectar');
    try {
      if (btn) btn.disabled = true;
      stopWaPoll();
      const chip = document.getElementById('fc-whatsapp');
      if (chip) chip.value = '';
      const sel = document.getElementById('fc-whatsapp-grupo');
      if (sel) sel.innerHTML = '<option value="">— Selecione o grupo —</option>';
      const alertaHidden = document.getElementById('fc-whatsapp-alerta');
      if (alertaHidden) alertaHidden.value = '';
      document.getElementById('fc-alerta-lista')?.querySelectorAll('input[type="checkbox"]')
        .forEach((c) => { c.checked = false; });
      document.getElementById('fc-qr-wrap')?.classList.add('hidden');
      document.getElementById('wa-qr-wrap')?.classList.add('hidden');

      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/disconnect`, {
        method: 'POST',
        body: '{}',
      });
      toast(data.mensagem || 'Número e grupo apagados — conecte o próximo chip', 'success');
      if (data.aviso) toast(data.aviso, 'warning');
      filiaisCache = [];
      await loadChatbotGerente();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById('btn-fc-qr-fechar')?.addEventListener('click', () => {
    document.getElementById('fc-qr-wrap')?.classList.add('hidden');
    stopWaPoll();
  });
}

let inspecaoDiagram = null;
let inspecaoVeiculoCache = null;
let inspecaoVeiculoIdAberto = null;
let inspecaoFilialIdAberto = null;
let filialDetalheCache = null;

function textoOQueFazer(p) {
  const acao = (p.acao_sugerida || 'ok').toLowerCase();
  if (acao === 'troca') {
    return 'Trocar o pneu. Retire da posição, descarte ou encaminhe conforme política da frota e monte um pneu do estoque.';
  }
  if (acao === 'recap') {
    return 'Enviar para recapagem. Desmonte, registre a recap e remonte (ou use outro pneu) na posição.';
  }
  if (acao === 'monitorar') {
    return 'Programar substituição — iniciar processo de recap em até 15 dias e acompanhar o sulco.';
  }
  if (acao === 'rodizio') {
    const sug = p.rodizio_sugestao;
    if (sug?.posicao_destino) {
      return sug.slot_vazio
        ? `Rodízio: mover para ${sug.posicao_label || sug.posicao_destino} (lado oposto do eixo).`
        : `Rodízio: trocar com ${sug.label || sug.posicao_destino} no lado oposto do eixo.`;
    }
    return 'Rodízio para o lado oposto do eixo para equalizar o desgaste.';
  }
  if (p.diagnostico === 'desgaste_progressivo') {
    return 'Desgaste progressivo do ombro externo para o interno — consumo esperado conforme o lado do caminhão (esquerdo: esq→dir; direito: dir→esq). Acompanhar; não fazer rodízio só por esse padrão. Retirar quando algum ponto atingir o crítico.';
  }
  if (p.diagnostico && p.diagnostico !== 'ok' && p.diagnostico !== 'sem_dado') {
    return p.diagnostico_desc || `Corrigir causa: ${p.diagnostico_label}.`;
  }
  if (p.status_sulco === 'sem_dado') {
    return 'Realizar medição dos 4 pontos de sulco para avaliar o pneu.';
  }
  return 'Nenhuma ação urgente — manter medição periódica.';
}

function renderPainelPneuInspecao(p) {
  if (!p) {
    return `<div class="inspecao-empty">
      <p>Clique em um pneu no desenho (ou na lista) para ver o diagnóstico e a ação recomendada.</p>
    </div>`;
  }
  const med = p.ultima_medicao;
  const medId = med?.id || p.ult_medicao_id;
  const sulcos = [
    p.ult_sulco_ext ?? med?.sulco_externo,
    p.ult_sulco_cent ?? med?.sulco_central,
    p.ult_sulco_int ?? med?.sulco_interno,
    p.ult_sulco_aux ?? med?.sulco_auxiliar,
  ].map((v) => (v != null ? `${v} mm` : '—')).join(' · ');

  return `
    <div class="inspecao-pneu-detalhe">
      <div class="inspecao-pneu-head">
        <h4>${p.posicao_label || p.posicao}${p.numero_fogo ? ` · Fogo ${p.numero_fogo}` : ''}</h4>
        <div class="inspecao-badges">
          ${badge(p.status_sulco)}
          ${badgeAcao(p.acao_sugerida, p.acao_label)}
        </div>
      </div>
      <p class="hint">${p.marca || '—'} · ${p.modelo || ''}${p.modelo ? ' · ' : ''}${p.vida_label || ''}${p.ult_medicao || med?.data ? ` · medido em ${formatDate(p.ult_medicao || med?.data)}` : ''}</p>
      <dl class="inspecao-dl">
        <div><dt>Menor sulco</dt><dd><strong>${p.menor_sulco != null ? `${p.menor_sulco} mm` : '—'}</strong></dd></div>
        <div><dt>4 pontos</dt><dd>${sulcos}</dd></div>
        <div><dt>Desvio</dt><dd>${p.desvio_mm != null ? `<strong>${p.desvio_mm} mm</strong>` : '—'}</dd></div>
        <div><dt>Diagnóstico</dt><dd>${p.diagnostico_label || '—'}${p.diagnostico_desc ? `<br><span class="hint">${p.diagnostico_desc}</span>` : ''}</dd></div>
        <div><dt>Motivo</dt><dd>${p.acao_motivo || '—'}</dd></div>
        ${p.rodizio_sugestao ? `<div><dt>Posição sugerida</dt><dd><strong>${escapeHtml(p.rodizio_sugestao.label || p.rodizio_sugestao.posicao_label || '—')}</strong>${p.rodizio_sugestao.motivo ? `<br><span class="hint">${escapeHtml(p.rodizio_sugestao.motivo)}</span>` : ''}</dd></div>` : ''}
      </dl>
      <div class="inspecao-acao-box inspecao-acao-${p.acao_sugerida || 'ok'}">
        <strong>O que fazer</strong>
        <p>${textoOQueFazer(p)}</p>
      </div>
      ${medId ? `
      <details class="form-avancado inspecao-corrigir">
        <summary>Corrigir medição (admin)</summary>
        <p class="hint">Use se o colaborador digitou sulco errado.</p>
        <div class="form-row form-row-4">
          <div class="form-group">
            <label>1ª MED</label>
            <input type="number" id="insp-sulco-ext" step="0.1" min="0" max="30" value="${med?.sulco_externo ?? p.ult_sulco_ext ?? ''}">
          </div>
          <div class="form-group">
            <label>2ª MED</label>
            <input type="number" id="insp-sulco-cent" step="0.1" min="0" max="30" value="${med?.sulco_central ?? p.ult_sulco_cent ?? ''}">
          </div>
          <div class="form-group">
            <label>3ª MED</label>
            <input type="number" id="insp-sulco-int" step="0.1" min="0" max="30" value="${med?.sulco_interno ?? p.ult_sulco_int ?? ''}">
          </div>
          <div class="form-group">
            <label>4ª MED</label>
            <input type="number" id="insp-sulco-aux" step="0.1" min="0" max="30" value="${med?.sulco_auxiliar ?? p.ult_sulco_aux ?? ''}">
          </div>
        </div>
        <div class="form-group">
          <label for="insp-med-data">Data da medição</label>
          <input type="date" id="insp-med-data" value="${med?.data || p.ult_medicao || ''}">
        </div>
        <div class="wa-actions" style="margin-top:.5rem">
          <button type="button" class="btn btn-primary btn-sm" id="btn-insp-salvar-medicao" data-medicao-id="${medId}" data-pneu-id="${p.id}">Salvar correção</button>
          <button type="button" class="btn btn-ghost btn-sm btn-danger-text" id="btn-insp-apagar-medicao" data-medicao-id="${medId}">Apagar medição</button>
        </div>
      </details>` : `
      <p class="hint">Sem medição registrada neste pneu — nada a corrigir.</p>`}
    </div>`;
}

function wirePainelInspecaoEdicao() {
  document.getElementById('btn-insp-salvar-medicao')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const medicaoId = btn.dataset.medicaoId;
    const filialId = inspecaoFilialIdAberto;
    const veiculoId = inspecaoVeiculoIdAberto;
    if (!filialId || !medicaoId) return;
    const payload = {
      sulco_externo: numOrNull('insp-sulco-ext'),
      sulco_central: numOrNull('insp-sulco-cent'),
      sulco_interno: numOrNull('insp-sulco-int'),
      sulco_auxiliar: numOrNull('insp-sulco-aux'),
      data_medicao: document.getElementById('insp-med-data')?.value || null,
    };
    if ([payload.sulco_externo, payload.sulco_central, payload.sulco_interno, payload.sulco_auxiliar].every((v) => v == null)) {
      return toast('Informe ao menos um sulco', 'error');
    }
    btn.disabled = true;
    try {
      await fetchJSON(`${API}/filiais/${filialId}/medicoes/${medicaoId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      toast('Medição corrigida', 'success');
      await recarregarInspecaoVeiculoFilial(filialId, veiculoId, Number(btn.dataset.pneuId));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-insp-apagar-medicao')?.addEventListener('click', async (e) => {
    const medicaoId = e.currentTarget.dataset.medicaoId;
    const filialId = inspecaoFilialIdAberto;
    const veiculoId = inspecaoVeiculoIdAberto;
    if (!filialId || !medicaoId) return;
    if (!confirm('Apagar esta medição? O pneu voltará a usar a medição anterior (se houver).')) return;
    try {
      await fetchJSON(`${API}/filiais/${filialId}/medicoes/${medicaoId}`, { method: 'DELETE' });
      toast('Medição apagada', 'success');
      await recarregarInspecaoVeiculoFilial(filialId, veiculoId);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function wireEdicaoVeiculoInspecao() {
  document.getElementById('btn-insp-salvar-veiculo')?.addEventListener('click', async () => {
    const filialId = inspecaoFilialIdAberto;
    const veiculoId = inspecaoVeiculoIdAberto;
    if (!filialId || !veiculoId) return;
    const placa = document.getElementById('insp-v-placa')?.value?.trim();
    if (!placa) return toast('Placa é obrigatória', 'error');
    try {
      await fetchJSON(`${API}/filiais/${filialId}/veiculos/${veiculoId}`, {
        method: 'PUT',
        body: JSON.stringify({
          placa,
          apelido: document.getElementById('insp-v-apelido')?.value || '',
          tipo: document.getElementById('insp-v-tipo')?.value || null,
          km_atual: numOrNull('insp-v-km'),
          hr_atual: numOrNull('insp-v-hr'),
          marca: document.getElementById('insp-v-marca')?.value || '',
          modelo: document.getElementById('insp-v-modelo')?.value || '',
          dia_medicao: document.getElementById('insp-v-dia')?.value
            ? Number(document.getElementById('insp-v-dia').value)
            : null,
        }),
      });
      toast('Veículo atualizado', 'success');
      await recarregarInspecaoVeiculoFilial(filialId, veiculoId);
      const card = document.querySelector(`#filial-detalhe .veiculo-item[data-id="${veiculoId}"]`);
      if (card) {
        const apelido = document.getElementById('insp-v-apelido')?.value?.trim()
          || document.getElementById('insp-v-placa')?.value?.trim()
          || '';
        const placa = document.getElementById('insp-v-placa')?.value?.trim()?.toUpperCase() || '';
        const tipo = document.getElementById('insp-v-tipo')?.value || '';
        const km = document.getElementById('insp-v-km')?.value || '0';
        const strong = card.querySelector('td strong');
        const hintEl = card.querySelector('td .hint');
        if (strong) strong.textContent = apelido || placa;
        if (hintEl) {
          const totalMatch = hintEl.textContent.match(/(\d+)\s*pneus/);
          const total = totalMatch ? totalMatch[1] : '—';
          hintEl.textContent = `${placa} · ${tipo} · ${total} pneus`;
        }
        const kmCell = card.children[1];
        if (kmCell) kmCell.textContent = Number(km).toLocaleString('pt-BR');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function recarregarInspecaoVeiculoFilial(filialId, veiculoId, pneuIdSelecionado = null) {
  const keepPneu = pneuIdSelecionado;
  inspecaoVeiculoIdAberto = null; // força reopen
  await abrirInspecaoVeiculoFilial(filialId, veiculoId);
  if (keepPneu && inspecaoVeiculoCache?.pneus) {
    const pneu = inspecaoVeiculoCache.pneus.find((p) => p.id === keepPneu);
    if (pneu) {
      inspecaoDiagram?.setAtivo(keepPneu);
      const painel = document.getElementById('filial-inspecao-painel');
      if (painel) {
        painel.innerHTML = renderPainelPneuInspecao(pneu);
        wirePainelInspecaoEdicao();
      }
    }
  }
}

function renderListaAnomalias(anomalias) {
  if (!anomalias?.length) {
    return `<div class="inspecao-ok-banner">
      <strong>Sem anomalias</strong>
      <p>Todos os pneus montados estão dentro dos parâmetros ou sem ação pendente.</p>
    </div>`;
  }
  return `
    <div class="inspecao-anomalias">
      <h4>Pneus com anomalia (${anomalias.length})</h4>
      <div class="inspecao-anomalia-list">
        ${anomalias.map((p) => `
          <button type="button" class="inspecao-anomalia-item" data-pneu-id="${p.id}">
            <span class="inspecao-anomalia-pos">${p.posicao_label || p.posicao}</span>
            <span class="inspecao-anomalia-meta">
              ${badge(p.status_sulco)}
              ${badgeAcao(p.acao_sugerida, p.acao_label)}
              <span class="hint">${p.menor_sulco != null ? `${p.menor_sulco} mm` : 'sem medição'}</span>
            </span>
            <span class="inspecao-anomalia-fazer">${textoOQueFazer(p)}</span>
          </button>
        `).join('')}
      </div>
    </div>`;
}

function fecharInspecaoVeiculoFilial() {
  const box = document.getElementById('filial-veiculo-inspecao');
  if (box) {
    box.classList.add('hidden');
    box.innerHTML = '';
  }
  inspecaoDiagram = null;
  inspecaoVeiculoCache = null;
  inspecaoVeiculoIdAberto = null;
  inspecaoFilialIdAberto = null;
  document.querySelectorAll('#filial-detalhe .veiculo-item.is-aberto').forEach((c) => {
    c.classList.remove('is-aberto');
  });
  document.getElementById('unidade-frota-split')?.classList.remove('has-inspecao');
}

async function abrirInspecaoVeiculoFilial(filialId, veiculoId) {
  const box = document.getElementById('filial-veiculo-inspecao');
  if (!box) return;

  const idNum = Number(veiculoId);
  // Segundo clique no mesmo veículo → recolhe
  if (inspecaoVeiculoIdAberto === idNum && !box.classList.contains('hidden')) {
    fecharInspecaoVeiculoFilial();
    return;
  }

  document.querySelectorAll('#filial-detalhe .veiculo-item').forEach((c) => {
    c.classList.toggle('is-aberto', Number(c.dataset.id) === idNum);
  });
  document.getElementById('unidade-frota-split')?.classList.add('has-inspecao');

  inspecaoFilialIdAberto = Number(filialId);
  inspecaoVeiculoIdAberto = idNum;
  box.classList.remove('hidden');
  box.innerHTML = '<p class="hint">Carregando diagrama e diagnósticos…</p>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const v = await fetchJSON(`${API}/filiais/${filialId}/veiculos/${veiculoId}`);
    if (inspecaoVeiculoIdAberto !== idNum) return;

    inspecaoVeiculoCache = v;
    const labels = v.posicoes_labels || {};
    const posicoes = v.posicoes_layout?.map((p) => p.codigo) || v.layout?.posicoes || [];
    const nAnom = v.anomalias?.length || 0;
    const tiposOpts = (meta.tipos || ['Truck / Tração', 'Toco / Mini']).map((t) =>
      `<option value="${escapeHtml(t)}" ${t === v.tipo ? 'selected' : ''}>${escapeHtml(t)}</option>`
    ).join('');

    box.innerHTML = `
      <div class="inspecao-header">
        <div>
          <h3>${escapeHtml(v.apelido || v.placa)}</h3>
          <p class="hint">${escapeHtml(v.placa)} · ${escapeHtml(v.tipo || '')} · ${(v.km_atual || 0).toLocaleString('pt-BR')} km
            · ${escapeHtml(v.layout?.nome || 'Layout')}
            · Filial ${escapeHtml(v.filial?.nome || '')}</p>
        </div>
        <div class="inspecao-header-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="btn-insp-config-layout">Configurar layout</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-fechar-inspecao">Fechar desenho</button>
        </div>
      </div>
      <details class="form-avancado inspecao-corrigir">
        <summary>Corrigir dados do veículo (admin)</summary>
        <p class="hint">Use se a placa, KM ou identificação foram cadastrados errados.</p>
        <div class="form-row">
          <div class="form-group">
            <label for="insp-v-placa">Placa *</label>
            <input type="text" id="insp-v-placa" value="${escapeHtml(v.placa || '')}" maxlength="8">
          </div>
          <div class="form-group">
            <label for="insp-v-apelido">Apelido</label>
            <input type="text" id="insp-v-apelido" value="${escapeHtml(v.apelido || '')}">
          </div>
          <div class="form-group">
            <label for="insp-v-tipo">Tipo</label>
            <select id="insp-v-tipo">${tiposOpts}</select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="insp-v-km">KM atual</label>
            <input type="number" id="insp-v-km" min="0" value="${v.km_atual ?? 0}">
          </div>
          <div class="form-group">
            <label for="insp-v-hr">Horas</label>
            <input type="number" id="insp-v-hr" min="0" step="0.1" value="${v.hr_atual ?? 0}">
          </div>
          <div class="form-group">
            <label for="insp-v-marca">Marca</label>
            <input type="text" id="insp-v-marca" value="${escapeHtml(v.marca || '')}">
          </div>
          <div class="form-group">
            <label for="insp-v-modelo">Modelo</label>
            <input type="text" id="insp-v-modelo" value="${escapeHtml(v.modelo || '')}">
          </div>
          <div class="form-group">
            <label for="insp-v-dia">Dia da medição</label>
            <select id="insp-v-dia">${optionsDiaSemana(v.dia_medicao, { incluirVazio: true, vazioLabel: '— Usar dia da frota —' })}</select>
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="btn-insp-salvar-veiculo">Salvar veículo</button>
      </details>
      <p class="inspecao-legenda hint">
        Cores no desenho: <span class="dot-inline ok"></span> OK ·
        <span class="dot-inline alerta"></span> Alerta ·
        <span class="dot-inline critico"></span> Crítico ·
        ${nAnom ? `<strong>${nAnom} pneu(s) exigem ação</strong>` : '<strong>Frota OK neste veículo</strong>'}
      </p>
      <div class="inspecao-layout">
        <div class="card truck-diagram-wrap">
          <div id="filial-inspecao-diagram"></div>
        </div>
        <div class="card inspecao-side">
          <div id="filial-inspecao-painel">${renderPainelPneuInspecao(null)}</div>
          ${renderListaAnomalias(v.anomalias)}
        </div>
      </div>`;

    document.getElementById('btn-fechar-inspecao').onclick = () => fecharInspecaoVeiculoFilial();
    document.getElementById('btn-insp-config-layout').onclick = () => {
      abrirConfigLayout(
        v.id,
        v.apelido || v.placa,
        v.layout_pneus,
        posicoes
      );
    };
    wireEdicaoVeiculoInspecao();

    const setPainel = (pneu) => {
      const painel = document.getElementById('filial-inspecao-painel');
      if (!painel) return;
      painel.innerHTML = renderPainelPneuInspecao(pneu);
      wirePainelInspecaoEdicao();
    };

    inspecaoDiagram = new TruckDiagram('filial-inspecao-diagram', {
      pickerHint: 'Clique no pneu colorido para ver a anomalia e o que fazer:',
      onPneuClick: (pneu) => setPainel(pneu),
      onSlotClick: () => {
        const painel = document.getElementById('filial-inspecao-painel');
        if (painel) {
          painel.innerHTML = `<div class="inspecao-empty"><p>Posição vazia — a filial precisa montar um pneu do estoque neste slot.</p></div>`;
        }
      },
    });
    inspecaoDiagram.render(v.pneus, labels, posicoes);

    box.querySelectorAll('.inspecao-anomalia-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.pneuId, 10);
        const pneu = v.pneus.find((p) => p.id === id);
        if (!pneu) return;
        inspecaoDiagram?.setAtivo(id);
        setPainel(pneu);
        document.getElementById('filial-inspecao-painel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    if (v.anomalias?.length) {
      const primeiro = v.anomalias[0];
      inspecaoDiagram.setAtivo(primeiro.id);
      setPainel(primeiro);
    }
  } catch (err) {
    if (inspecaoVeiculoIdAberto === idNum) {
      box.innerHTML = `<p class="hint login-erro">${err.message}</p>`;
    }
    toast(err.message, 'error');
  }
}

async function abrirModalFilial(id = null) {
  const modal = document.getElementById('modal-filial');
  document.getElementById('form-filial').reset();
  document.getElementById('f-id').value = id || '';

  if (id) {
    document.getElementById('modal-filial-titulo').textContent = 'Editar Filial';
    document.getElementById('f-login-row').classList.add('hidden');
    document.getElementById('f-reset-row').classList.remove('hidden');
    document.getElementById('f-login').required = false;
    document.getElementById('f-senha').required = false;

    if (!filiaisCache.length) {
      filiaisCache = await fetchJSON(`${API}/filiais`);
    }
    const f = filiaisCache.find((x) => String(x.id) === String(id))
      || await fetchJSON(`${API}/filiais/${id}`);
    document.getElementById('f-nome').value = f.nome || '';
    document.getElementById('f-codigo').value = f.codigo || '';
    document.getElementById('f-contrato').value = f.contrato || '';
    const fDia = document.getElementById('f-dia-medicao');
    if (fDia) fDia.innerHTML = optionsDiaSemana(f.dia_medicao, { incluirVazio: true });
    document.getElementById('f-whatsapp').value = valorCampoWa(f.whatsapp);
    const alertaEl = document.getElementById('f-whatsapp-alerta');
    if (alertaEl) alertaEl.value = valorCampoWa(f.whatsapp_alerta);
    const tok = document.getElementById('f-wuzapi-token');
    if (tok) {
      tok.value = '';
      tok.placeholder = f.tem_wuzapi_token ? '•••• (deixe em branco para manter)' : 'Token WuzAPI';
    }
  } else {
    document.getElementById('modal-filial-titulo').textContent = 'Nova Filial';
    const fDia = document.getElementById('f-dia-medicao');
    if (fDia) fDia.innerHTML = optionsDiaSemana('', { incluirVazio: true });
    document.getElementById('f-login-row').classList.remove('hidden');
    document.getElementById('f-reset-row').classList.add('hidden');
    document.getElementById('f-login').required = true;
    document.getElementById('f-senha').required = true;
    document.getElementById('f-whatsapp').value = '';
    const alertaEl = document.getElementById('f-whatsapp-alerta');
    if (alertaEl) alertaEl.value = '';
    const tok = document.getElementById('f-wuzapi-token');
    if (tok) {
      tok.value = '';
      tok.placeholder = 'Token WuzAPI';
    }
  }
  document.getElementById('f-wuzapi-token-wrap')?.classList.toggle('hidden', !isAdmin());
  modal.showModal();
}

document.getElementById('btn-nova-filial')?.addEventListener('click', () => abrirModalFilial());
document.getElementById('btn-cancelar-filial')?.addEventListener('click', () => {
  document.getElementById('modal-filial').close();
});

document.getElementById('form-filial')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('f-id').value;
  try {
    if (id) {
      const body = {
        nome: document.getElementById('f-nome').value,
        codigo: document.getElementById('f-codigo').value,
        contrato: document.getElementById('f-contrato').value,
        whatsapp: document.getElementById('f-whatsapp').value || null,
        whatsapp_alerta: document.getElementById('f-whatsapp-alerta')?.value || null,
        dia_medicao: document.getElementById('f-dia-medicao')?.value
          ? Number(document.getElementById('f-dia-medicao').value)
          : null,
      };
      const tok = document.getElementById('f-wuzapi-token')?.value?.trim();
      if (tok) body.wuzapi_token = tok;
      await fetchJSON(`${API}/filiais/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const novaSenha = document.getElementById('f-nova-senha').value;
      if (novaSenha) {
        await fetchJSON(`${API}/filiais/${id}/reset-senha`, {
          method: 'POST',
          body: JSON.stringify({ senha: novaSenha }),
        });
      }
      toast('Filial atualizada', 'success');
    } else {
      const result = await fetchJSON(`${API}/filiais`, {
        method: 'POST',
        body: JSON.stringify({
          nome: document.getElementById('f-nome').value,
          codigo: document.getElementById('f-codigo').value,
          contrato: document.getElementById('f-contrato').value,
          login: document.getElementById('f-login').value,
          senha: document.getElementById('f-senha').value,
          whatsapp: document.getElementById('f-whatsapp').value || null,
          whatsapp_alerta: document.getElementById('f-whatsapp-alerta')?.value || null,
          wuzapi_token: document.getElementById('f-wuzapi-token')?.value?.trim() || null,
        }),
      });
      toast(result.mensagem, 'success');
    }
    document.getElementById('modal-filial').close();
    filiaisCache = [];
    loadFiliais();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Usuários e acessos ─────────────────────────────────

function formatMoney(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
}

function formatDateTime(iso) {
  if (!iso) return 'Nunca';
  const s = String(iso).replace('T', ' ').slice(0, 16);
  const [d, t] = s.split(' ');
  if (!d) return iso;
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}${t ? ` ${t}` : ''}`;
}

async function loadUsuarios() {
  if (!isGestao()) return;
  const el = document.getElementById('usuarios-lista');
  if (!el) return;
  const btnNovo = document.getElementById('btn-novo-usuario');
  if (btnNovo) btnNovo.classList.toggle('hidden', !isAdmin());
  try {
    const data = await fetchJSON(`${API}/usuarios`);
    const rows = data.usuarios || [];
    el.innerHTML = `
      <table class="historico-table">
        <thead>
          <tr>
            <th>Login</th><th>Tipo de acesso</th><th>Filial</th><th>WhatsApp</th>
            <th>Último acesso</th><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((u) => {
            const badgePapel = u.papel === 'gerente'
              ? '<span class="badge badge-alerta">Gerente</span>'
              : u.papel === 'admin'
                ? '<span class="badge badge-ok">Admin</span>'
                : '<span class="badge badge-sem_dado">Operador</span>';
            return `
            <tr>
              <td><strong>${escapeHtml(u.login)}</strong></td>
              <td>${badgePapel}<br><span class="hint">${escapeHtml(u.papel_label || u.papel)}</span></td>
              <td>${escapeHtml(u.filial_nome || u.filial_codigo || '—')}</td>
              <td class="mono">${escapeHtml(u.whatsapp || '—')}</td>
              <td>${formatDateTime(u.ultimo_login)}</td>
              <td>${u.ativo ? '<span class="badge badge-ok">Ativo</span>' : '<span class="badge badge-critico">Inativo</span>'}</td>
              <td>
                ${isAdmin() ? `
                  <button type="button" class="btn btn-ghost btn-sm btn-edit-user"
                    data-id="${u.id}"
                    data-login="${escapeHtml(u.login)}"
                    data-papel="${u.papel}"
                    data-filial="${u.filial_id ?? ''}"
                    data-whatsapp="${escapeHtml(u.whatsapp || '')}">
                    Editar tipo
                  </button>` : ''}
                <button type="button" class="btn btn-ghost btn-sm btn-reset-user" data-id="${u.id}" data-login="${escapeHtml(u.login)}">Redefinir senha</button>
                ${isAdmin() && u.papel !== 'admin' ? `
                  <button type="button" class="btn btn-ghost btn-sm btn-toggle-user" data-id="${u.id}" data-ativo="${u.ativo ? 1 : 0}">
                    ${u.ativo ? 'Desativar' : 'Ativar'}
                  </button>` : ''}
              </td>
            </tr>`;
          }).join('') || '<tr><td colspan="7">Nenhum usuário</td></tr>'}
        </tbody>
      </table>`;

    el.querySelectorAll('.btn-edit-user').forEach((btn) => {
      btn.addEventListener('click', () => abrirModalUsuario({
        id: btn.dataset.id,
        login: btn.dataset.login,
        papel: btn.dataset.papel,
        filial_id: btn.dataset.filial || '',
        whatsapp: btn.dataset.whatsapp || '',
      }));
    });

    el.querySelectorAll('.btn-reset-user').forEach((btn) => {
      btn.addEventListener('click', () => abrirModalResetSenha(btn.dataset.id, btn.dataset.login));
    });

    el.querySelectorAll('.btn-toggle-user').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ativo = btn.dataset.ativo === '1' ? false : true;
        try {
          await fetchJSON(`${API}/usuarios/${btn.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ativo }),
          });
          toast(ativo ? 'Usuário ativado' : 'Usuário desativado');
          loadUsuarios();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    el.innerHTML = `<p class="hint login-erro">${err.message}</p>`;
  }
}

function atualizarHintPapelUsuario() {
  const papel = document.getElementById('u-papel')?.value;
  const hint = document.getElementById('u-papel-hint');
  const filialWrap = document.getElementById('u-filial-wrap');
  if (!hint) return;
  if (papel === 'filial') {
    hint.textContent = 'Operador: Dashboard, veículos, medições e frota da filial.';
    filialWrap?.classList.remove('hidden');
  } else if (papel === 'gerente') {
    hint.textContent = 'Gerente: Minha unidade, alertas/compras e conectar chatbot WhatsApp.';
    filialWrap?.classList.remove('hidden');
  } else {
    hint.textContent = 'Admin total: relatórios, usuários, todas as filiais e limites.';
    filialWrap?.classList.add('hidden');
  }
}

async function preencherSelectFiliaisUsuario(selectedId = '') {
  const sel = document.getElementById('u-filial');
  if (!sel) return;
  try {
    const filiais = await fetchJSON(`${API}/filiais`);
    sel.innerHTML = '<option value="">— (sem vínculo / multiunidade)</option>'
      + filiais.map((f) =>
        `<option value="${f.id}" ${String(selectedId) === String(f.id) ? 'selected' : ''}>${escapeHtml(f.nome)} (${escapeHtml(f.codigo)})</option>`
      ).join('');
  } catch {
    sel.innerHTML = '<option value="">—</option>';
  }
}

async function abrirModalUsuario(usuario = null) {
  if (!isAdmin()) return toast('Só o admin total altera tipo de acesso', 'error');
  const form = document.getElementById('form-usuario');
  form?.reset();
  document.getElementById('u-id').value = usuario?.id || '';
  document.getElementById('u-senha-aviso').textContent = '';
  const senhaWrap = document.getElementById('u-senha-wrap');
  const senhaInput = document.getElementById('u-senha');
  const titulo = document.getElementById('modal-usuario-titulo');
  const btnSalvar = document.getElementById('btn-salvar-usuario');
  const loginInput = document.getElementById('u-login');

  await preencherSelectFiliaisUsuario(usuario?.filial_id || '');

  if (usuario) {
    titulo.textContent = 'Editar tipo de acesso';
    btnSalvar.textContent = 'Salvar';
    loginInput.value = usuario.login || '';
    loginInput.readOnly = true;
    document.getElementById('u-papel').value = usuario.papel || 'filial';
    document.getElementById('u-whatsapp').value = usuario.whatsapp || '';
    senhaWrap?.classList.add('hidden');
    senhaInput.required = false;
    senhaInput.value = '';
  } else {
    titulo.textContent = 'Novo usuário';
    btnSalvar.textContent = 'Criar';
    loginInput.readOnly = false;
    senhaWrap?.classList.remove('hidden');
    senhaInput.required = true;
  }
  atualizarHintPapelUsuario();
  document.getElementById('modal-usuario').showModal();
}

function sugerirSenhaProvisoria() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function abrirModalResetSenha(userId, login) {
  const modal = document.getElementById('modal-reset-senha');
  if (!modal) return toast('Modal de senha não encontrado — recarregue a página', 'error');
  document.getElementById('reset-senha-user-id').value = userId;
  document.getElementById('reset-senha-login-hint').textContent =
    `Nova senha provisória para “${login}”. Anote — ela só aparece agora.`;
  document.getElementById('reset-senha-nova').value = sugerirSenhaProvisoria();
  document.getElementById('reset-senha-nova').readOnly = false;
  document.getElementById('reset-senha-resultado-wrap')?.classList.add('hidden');
  document.getElementById('reset-senha-resultado').value = '';
  document.getElementById('btn-salvar-reset-senha')?.classList.remove('hidden');
  document.getElementById('btn-fechar-reset-senha')?.classList.add('hidden');
  document.getElementById('btn-cancelar-reset-senha')?.classList.remove('hidden');
  modal.showModal();
  document.getElementById('reset-senha-nova')?.focus();
  document.getElementById('reset-senha-nova')?.select();
}

document.getElementById('btn-cancelar-reset-senha')?.addEventListener('click', () => {
  document.getElementById('modal-reset-senha')?.close();
});

document.getElementById('btn-fechar-reset-senha')?.addEventListener('click', () => {
  document.getElementById('modal-reset-senha')?.close();
});

document.getElementById('form-reset-senha')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('reset-senha-user-id').value;
  const senha = document.getElementById('reset-senha-nova').value.trim();
  if (!senha || senha.length < 4) return toast('Senha mínima: 4 caracteres', 'error');
  try {
    const r = await fetchJSON(`${API}/usuarios/${id}/reset-senha`, {
      method: 'POST',
      body: JSON.stringify({ senha }),
    });
    document.getElementById('reset-senha-nova').readOnly = true;
    document.getElementById('reset-senha-resultado-wrap')?.classList.remove('hidden');
    document.getElementById('reset-senha-resultado').value = r.senha_provisoria || senha;
    document.getElementById('btn-salvar-reset-senha')?.classList.add('hidden');
    document.getElementById('btn-cancelar-reset-senha')?.classList.add('hidden');
    document.getElementById('btn-fechar-reset-senha')?.classList.remove('hidden');
    document.getElementById('reset-senha-login-hint').textContent =
      `Senha de “${r.login}” redefinida. Copie agora — não será exibida de novo.`;
    toast(r.mensagem || 'Senha redefinida', 'success');
    try {
      await navigator.clipboard.writeText(r.senha_provisoria || senha);
      toast('Senha copiada para a área de transferência', 'success');
    } catch { /* clipboard pode falhar sem HTTPS */ }
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('btn-novo-usuario')?.addEventListener('click', () => abrirModalUsuario(null));

document.getElementById('u-papel')?.addEventListener('change', atualizarHintPapelUsuario);

document.getElementById('btn-cancelar-usuario')?.addEventListener('click', () => {
  document.getElementById('modal-usuario').close();
});

document.getElementById('form-usuario')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('u-id').value;
  const papel = document.getElementById('u-papel').value;
  const filialId = document.getElementById('u-filial').value || null;

  if (papel === 'filial' && !filialId) {
    return toast('Operador de filial precisa de uma filial', 'error');
  }

  try {
    if (id) {
      await fetchJSON(`${API}/usuarios/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          papel,
          filial_id: papel === 'admin' ? null : filialId,
          whatsapp: document.getElementById('u-whatsapp').value || null,
        }),
      });
      document.getElementById('modal-usuario').close();
      toast('Tipo de acesso atualizado', 'success');
      loadUsuarios();
      return;
    }

    const senha = document.getElementById('u-senha').value;
    if (!senha || senha.length < 4) return toast('Senha mínima: 4 caracteres', 'error');

    const result = await fetchJSON(`${API}/usuarios`, {
      method: 'POST',
      body: JSON.stringify({
        login: document.getElementById('u-login').value,
        senha,
        papel,
        filial_id: papel === 'admin' ? null : filialId,
        whatsapp: document.getElementById('u-whatsapp').value || null,
      }),
    });
    document.getElementById('modal-usuario').close();
    toast(result.mensagem, 'success');
    if (result.senha_provisoria) {
      toast(`Senha provisória de ${result.usuario.login}: ${result.senha_provisoria}`, 'success');
    }
    loadUsuarios();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Relatórios diretoria ───────────────────────────────

async function baixarPdfSemanalUnidade(filialId) {
  if (!isGestao()) return toast('Acesso restrito ao gerente', 'error');
  if (!filialId) return toast('Filial não informada', 'error');
  try {
    toast('Gerando PDF semanal…');
    const resp = await fetch(`${API}/relatorios/unidade/semanal.pdf?filial_id=${encodeURIComponent(filialId)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) {
      let msg = 'Falha ao gerar PDF';
      try {
        const err = await resp.json();
        if (err?.erro) msg = err.erro;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/i);
    const filename = match?.[1] || `relatorio-semanal-${filialId}.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast('PDF semanal baixado', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadRelatorioDiretoria() {
  if (!isAdmin()) return;
  try {
    const rel = await fetchJSON(`${API}/relatorios/diretoria`);
    const c = rel.consolidado || {};
    document.getElementById('relatorio-resumo').innerHTML = `
      <div class="stat-card"><span class="stat-value">${c.filiais_ativas ?? 0}</span><span class="stat-label">Filiais</span></div>
      <div class="stat-card"><span class="stat-value">${c.veiculos ?? 0}</span><span class="stat-label">Veículos</span></div>
      <div class="stat-card stat-ok"><span class="stat-value">${c.sulco_ok ?? 0}</span><span class="stat-label">Pneus OK</span></div>
      <div class="stat-card stat-alerta"><span class="stat-value">${c.sulco_monitorar ?? 0}</span><span class="stat-label">Monitorar</span></div>
      <div class="stat-card stat-critico"><span class="stat-value">${c.sulco_critico ?? 0}</span><span class="stat-label">Críticos</span></div>
      <div class="stat-card stat-troca"><span class="stat-value">${c.acao_trocar ?? 0}</span><span class="stat-label">Trocar</span></div>
      <div class="stat-card"><span class="stat-value" style="font-size:1.1rem">${formatMoney(c.custo_total_pneus)}</span><span class="stat-label">Custo total pneus</span></div>
    `;
    document.getElementById('relatorio-leitura').innerHTML = `
      <div class="compras-banner-inner">
        <div>
          <h3>Leitura para a diretoria</h3>
          <p class="hint">Gerado em ${formatDateTime(rel.gerado_em)}</p>
          <ul style="margin:.5rem 0 0;padding-left:1.1rem">
            ${(rel.leitura_diretoria || []).map((l) => `<li>${l}</li>`).join('')}
          </ul>
        </div>
      </div>`;
    const tbody = document.querySelector('#relatorio-tabela tbody');
    tbody.innerHTML = (rel.por_filial || []).map((r) => `
      <tr>
        <td><strong>${r.filial}</strong> <span class="hint">${r.codigo}</span></td>
        <td>${r.veiculos}</td>
        <td>${r.pneus_montados}</td>
        <td>${r.sulco_ok}</td>
        <td>${r.sulco_monitorar}</td>
        <td>${r.sulco_critico}</td>
        <td>${r.acao_trocar}</td>
        <td>${formatMoney(r.custo_montado)}</td>
        <td>${formatMoney(r.custo_estoque)}</td>
      </tr>
    `).join('') || '<tr><td colspan="9">Sem dados</td></tr>';

    const csv = document.getElementById('btn-relatorio-csv');
    if (csv) {
      csv.href = `${API}/relatorios/diretoria.csv`;
      csv.onclick = async (e) => {
        e.preventDefault();
        try {
          const resp = await fetch(`${API}/relatorios/diretoria.csv`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (!resp.ok) throw new Error('Falha ao baixar CSV');
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'relatorio-diretoria-pneus.csv';
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          toast(err.message, 'error');
        }
      };
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('btn-relatorio-refresh')?.addEventListener('click', () => loadRelatorioDiretoria());

// ── Inicialização ──────────────────────────────────────

function isRotaAcessoRapido() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return path.endsWith('/veiculo-acesso-rapido')
    || window.location.search.includes('token=') && path.includes('acesso-rapido');
}

function mostrarErroToken(msg) {
  document.getElementById('app-login')?.classList.add('hidden');
  document.getElementById('app-shell')?.classList.remove('hidden');
  document.getElementById('nav-tabs-filial')?.classList.add('hidden');
  document.getElementById('nav-tabs-admin')?.classList.add('hidden');
  document.getElementById('nav-tabs-gerente')?.classList.add('hidden');
  document.getElementById('btn-logout')?.classList.add('hidden');
  const label = document.getElementById('header-user-label');
  if (label) label.textContent = 'Acesso rápido';
  const subtitle = document.getElementById('header-subtitle');
  if (subtitle) subtitle.textContent = 'Link WhatsApp';
  const box = document.querySelector('#view-acesso-erro .erro-token-container p');
  if (box && msg) box.textContent = msg;
  showView('acesso-erro');
}

async function bootAcessoRapido(token) {
  modoAcessoRapido = true;
  tokenAcessoRapido = token;
  document.getElementById('app-login')?.classList.add('hidden');
  document.getElementById('app-shell')?.classList.remove('hidden');
  document.getElementById('nav-tabs-filial')?.classList.add('hidden');
  document.getElementById('nav-tabs-admin')?.classList.add('hidden');
  document.getElementById('nav-tabs-gerente')?.classList.add('hidden');
  document.getElementById('btn-logout')?.classList.add('hidden');
  const label = document.getElementById('header-user-label');
  if (label) label.textContent = 'Acesso rápido · WhatsApp';
  const subtitle = document.getElementById('header-subtitle');
  if (subtitle) subtitle.textContent = 'Medição sem login — link temporário';

  try {
    const data = await fetchJSON(`${API}/veiculos/acesso-rapido?token=${encodeURIComponent(token)}`);
    if (data.posicoes) meta = { ...meta, posicoes: data.posicoes };
    if (data.limites) limitesAtuais = { ...limitesAtuais, ...data.limites };
    tokenAcessoRapido = data.token_acesso || token;
    await openVeiculoDetalhe(data.id, 'acesso-rapido', data);
  } catch (err) {
    mostrarErroToken(err.message || 'Link expirado ou inválido');
  }
}

async function bootApp() {
  showAppShell();
  try {
    if (isAdmin()) {
      const config = await fetchConfiguracoes();
      limitesAtuais = { ...limitesAtuais, ...config };
      showView('relatorios');
      loadRelatorioDiretoria();
      return;
    }

    if (isGerente()) {
      const config = await fetchConfiguracoes();
      limitesAtuais = { ...limitesAtuais, ...config };
      showView('filiais');
      loadFiliais();
      return;
    }

    const [config, metaData] = await Promise.all([
      fetchConfiguracoes(),
      fetchJSON(`${API}/veiculos/meta`),
    ]);
    meta = metaData;
    limitesAtuais = { ...limitesAtuais, ...config };
    const selectTipo = document.getElementById('v-tipo');
    if (selectTipo) {
      selectTipo.innerHTML = meta.tipos.map((t) => `<option value="${t}">${t}</option>`).join('');
    }
    preencherSelectLayouts('v-layout', meta.layout_padrao, { soTruckToco: true });
    preencherSelectLayouts('layout-select', meta.layout_padrao);
    preencherCheckboxesPosicoes('layout-custom-checkboxes', getLayoutById(meta.layout_padrao)?.posicoes || []);
    showView('dashboard');
    loadDashboard();
  } catch (err) {
    toast(err.message || 'Erro ao carregar o sistema', 'error');
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const tokenUrl = params.get('token');
  if (isRotaAcessoRapido() || (tokenUrl && window.location.pathname.includes('acesso-rapido'))) {
    if (!tokenUrl) {
      mostrarErroToken('Link inválido — token ausente.');
      return;
    }
    await bootAcessoRapido(tokenUrl);
    return;
  }

  const saved = loadAuth();
  if (saved?.token && saved?.usuario) {
    authToken = saved.token;
    currentUser = saved.usuario;
    // Mostra o app na hora com o usuário em cache — evita flash do login
    showAppShell();
    try {
      const me = await fetchJSON(`${API}/auth/me`);
      currentUser = me;
      saveAuth(authToken, me);
      showAppShell(); // atualiza header/nav com dados frescos
      await bootApp();
      return;
    } catch {
      clearAuth();
    }
  }
  showLogin();
}

init();
