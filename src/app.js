import { TireMarker } from './tire-marker.js';
import { TruckDiagram, renderLayoutPreview, svgMiniCaminhao } from './truck-diagram.js';
import { renderPerfilSulco } from './perfil-sulco.js';
import { initPresidente, abrirPainelPresidente } from './presidente.js';

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

function tipoDoCatalogo(tipo) {
  const lista = meta.tipos_equipamento || [];
  const n = String(tipo || '');
  return lista.find((t) => t.label === n || t.codigo === n) || null;
}

/** `km` | `horas` | null (tipo fora do catálogo: mostra os dois). */
function unidadeCadastro(tipo) {
  const u = tipoDoCatalogo(tipo)?.unidade_uso;
  return u === 'km' || u === 'horas' ? u : null;
}

function aplicarVisibilidadeUnidade(tipo, kmWrapId, hrWrapId) {
  const unidade = unidadeCadastro(tipo);
  document.getElementById(kmWrapId)?.classList.toggle('hidden', unidade === 'horas');
  document.getElementById(hrWrapId)?.classList.toggle('hidden', unidade === 'km');
}

function htmlBotoesTipo(selecionado) {
  const tipos = meta.tipos_equipamento || [];
  const atual = tipoDoCatalogo(selecionado);
  const codigoSel = atual?.codigo || '';
  let html = tipos.map((t) => {
    const ativo = t.codigo === codigoSel || t.label === selecionado || t.codigo === selecionado;
    return `<button type="button" class="tipo-opcao${ativo ? ' is-ativo' : ''}" data-codigo="${escapeHtml(t.codigo)}" aria-pressed="${ativo ? 'true' : 'false'}">${escapeHtml(t.label)}</button>`;
  }).join('');
  if (selecionado && !atual) {
    html += `<button type="button" class="tipo-opcao is-ativo" data-codigo="${escapeHtml(selecionado)}" aria-pressed="true">${escapeHtml(selecionado)}</button>`;
  }
  return html;
}

function marcarBotaoTipo(container, codigo) {
  const atual = tipoDoCatalogo(codigo);
  const chave = atual?.codigo || codigo;
  container?.querySelectorAll('.tipo-opcao').forEach((b) => {
    const ativo = b.dataset.codigo === chave || b.dataset.codigo === codigo;
    b.classList.toggle('is-ativo', ativo);
    b.setAttribute('aria-pressed', ativo ? 'true' : 'false');
  });
}

function renderBotoesTipo(containerId, selecionado, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = htmlBotoesTipo(selecionado);
  el.onclick = (e) => {
    const btn = e.target.closest('.tipo-opcao');
    if (!btn || !el.contains(btn)) return;
    onSelect?.(btn.dataset.codigo);
  };
}

function layoutSugeridoPorTipo(tipo) {
  const cat = tipoDoCatalogo(tipo);
  if (cat?.layout_padrao) return cat.layout_padrao;
  if (meta.layout_padrao_por_tipo?.[tipo]) return meta.layout_padrao_por_tipo[tipo];
  return meta.layout_padrao || 'truck_10';
}

function codigoTipo(tipo) {
  return tipoDoCatalogo(tipo)?.codigo || tipo || '';
}

const FILTRO_TIPO_KEY = 'pneu_filtro_tipo';
const FILTRO_TIPO_IDS = ['dash-frota-tipo', 'veiculos-filtro-tipo', 'relatorio-filtro-tipo', 'unidade-frota-tipo'];
const tiposAvulsos = new Set();

function chaveTipo(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function lerFiltroTipo() {
  return sessionStorage.getItem(FILTRO_TIPO_KEY) || '';
}

function gravarFiltroTipo(valor) {
  const t = String(valor || '');
  if (t) sessionStorage.setItem(FILTRO_TIPO_KEY, t);
  else sessionStorage.removeItem(FILTRO_TIPO_KEY);
}

/** Catálogo por código/rótulo; tipo fora do catálogo só casa com o texto gravado. */
function veiculoCombinaFiltroTipo(veiculo, filtro) {
  const alvo = String(filtro || '').trim();
  if (!alvo) return true;
  const catAlvo = tipoDoCatalogo(alvo);
  const tipo = veiculo?.tipo || '';
  const codigo = veiculo?.tipo_codigo || '';
  const catVeic = tipoDoCatalogo(codigo) || tipoDoCatalogo(tipo) || tipoDoCatalogo(normalizarTipoLabel(tipo));
  if (catAlvo && catVeic) return catAlvo.codigo === catVeic.codigo;
  if (catAlvo) return codigo === catAlvo.codigo || chaveTipo(tipo) === chaveTipo(catAlvo.label);
  return chaveTipo(tipo) === chaveTipo(alvo) || chaveTipo(codigo) === chaveTipo(alvo);
}

let tiposAvulsosColetaIniciada = false;

function registrarTiposAvulsos(veiculos) {
  for (const v of veiculos || []) {
    const bruto = String(v?.tipo || '').trim();
    if (!bruto) continue;
    if (tipoDoCatalogo(bruto) || tipoDoCatalogo(v?.tipo_codigo) || tipoDoCatalogo(normalizarTipoLabel(bruto))) continue;
    tiposAvulsos.add(bruto);
  }
}

async function coletarTiposAvulsosDaFrota() {
  if (tiposAvulsosColetaIniciada || currentUser?.papel !== 'filial') return;
  tiposAvulsosColetaIniciada = true;
  try {
    const lista = await fetchJSON(`${API}/veiculos`);
    registrarTiposAvulsos(lista);
    preencherSelectsTipo();
  } catch {
    tiposAvulsosColetaIniciada = false;
  }
}

function opcoesFiltroTipo(extraValor) {
  const opcoes = [{ value: '', label: 'Todos os equipamentos' }];
  const usados = new Set(['']);
  for (const t of meta.tipos_equipamento || []) {
    if (!t?.codigo || usados.has(t.codigo)) continue;
    usados.add(t.codigo);
    opcoes.push({ value: t.codigo, label: t.label });
  }
  for (const bruto of [...tiposAvulsos].sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
    if (usados.has(bruto) || tipoDoCatalogo(bruto)) continue;
    usados.add(bruto);
    opcoes.push({ value: bruto, label: normalizarTipoLabel(bruto) || bruto });
  }
  if (extraValor && !usados.has(extraValor)) {
    opcoes.push({ value: extraValor, label: normalizarTipoLabel(extraValor) || extraValor });
  }
  return opcoes;
}

function preencherSelectsTipo() {
  const preferido = lerFiltroTipo();
  const html = opcoesFiltroTipo(preferido).map((o) =>
    `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`
  ).join('');
  for (const id of FILTRO_TIPO_IDS) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const atual = sel.value || preferido;
    sel.innerHTML = html;
    const valores = new Set([...sel.options].map((o) => o.value));
    sel.value = valores.has(atual) ? atual : (valores.has(preferido) ? preferido : '');
  }
}

function queryTipo(valor = lerFiltroTipo()) {
  const tipo = String(valor || '').trim();
  return tipo ? `?tipo=${encodeURIComponent(tipo)}` : '';
}

function aoMudarFiltroTipo(e) {
  const valor = e.target.value;
  gravarFiltroTipo(valor);
  for (const id of FILTRO_TIPO_IDS) {
    const sel = document.getElementById(id);
    if (sel && sel !== e.target) sel.value = valor;
  }
  const view = document.querySelector('.view.active')?.id || '';
  if (view === 'view-dashboard') loadDashboard();
  else if (view === 'view-veiculos') filtrarListasFrota('veiculos-busca');
  else if (view === 'view-relatorios') loadRelatorioDiretoria();
  else if (view === 'view-filiais') filtrarFrotaUnidade();
}

let veiculosCache = [];
let filiaisCache = [];
let tireMarker = null;
let limitesPainelBackup = null;
let configuracoesEmSessao = null;
let veiculoDetalheSeq = 0;
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
  configuracoesEmSessao = null;
  localStorage.removeItem(AUTH_KEY);
}

function isPresidente() {
  return currentUser?.papel === 'presidente';
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

/** Conclusão do pré-cadastro: só o operador da unidade (rota /veiculos/:id/concluir). */
function podeConcluirCadastro() {
  return currentUser?.papel === 'filial';
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
  const { timeoutMs, headers: extraHeaders, ...fetchOpts } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(extraHeaders || {}),
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (modoAcessoRapido && tokenAcessoRapido) {
    headers['X-Acesso-Rapido-Token'] = tokenAcessoRapido;
  }

  let timer;
  const ctrl = timeoutMs ? new AbortController() : null;
  if (timeoutMs) timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      ...fetchOpts,
      headers,
      signal: ctrl?.signal || fetchOpts.signal,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e?.name === 'AbortError') {
      throw new Error('O servidor demorou demais. Clique de novo em Gerar QR.');
    }
    if (/Failed to fetch|NetworkError|Load failed|ERR_FAILED/i.test(String(e?.message || e))) {
      throw new Error('O servidor do sistema não respondeu. Aguarde uns segundos e tente de novo.');
    }
    throw e;
  }
  if (timer) clearTimeout(timer);
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
  if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
    throw new Error('O servidor do sistema está reiniciando. Aguarde uns segundos e clique de novo.');
  }
  if (!resp.ok) {
    const msg = data.erro || (resp.status === 404
      ? 'Recurso não encontrado — reinicie o backend (npm run dev)'
      : 'Erro na requisição');
    const err = new Error(msg);
    err.data = data;
    err.status = resp.status;
    throw err;
  }
  return data;
}

function textoHintFogo(info) {
  if (!info?.padrao) {
    return 'Padrão: código da unidade + sequência (ex.: 0110-0001). Vazio gera o próximo.';
  }
  if (info.ultimo) {
    return info.padrao_obrigatorio
      ? `Padrão ${info.padrao}. Último cadastrado: ${info.ultimo} → próximo: ${info.proximo}`
      : `Sugestão ${info.proximo} (último no padrão: ${info.ultimo}). Outros formatos antigos ainda são aceitos.`;
  }
  return info.padrao_obrigatorio
    ? `Nenhum pneu neste padrão. Primeiro número: ${info.proximo}`
    : `Sugestão ${info.proximo}. Outros formatos antigos ainda são aceitos.`;
}

async function fetchProximoFogo(tokenRapido) {
  if (tokenRapido) {
    return fetchJSON(`${API}/acesso-rapido/proximo-fogo?token=${encodeURIComponent(tokenRapido)}`);
  }
  if (modoAcessoRapido && tokenAcessoRapido) {
    return fetchJSON(`${API}/acesso-rapido/proximo-fogo?token=${encodeURIComponent(tokenAcessoRapido)}`);
  }
  return fetchJSON(`${API}/pneus/proximo-fogo`);
}

async function gerarMarcaFogoNoCampo(inputId, hintId, btn, tokenRapido) {
  if (btn?.disabled || btn?.dataset.gerando === '1') return null;
  if (btn) {
    btn.disabled = true;
    btn.dataset.gerando = '1';
  }
  try {
    const dados = await fetchProximoFogo(tokenRapido);
    if (!dados?.proximo) {
      toast('Não foi possível gerar a marca de fogo. Confira o código da filial.', 'error');
      return null;
    }
    const input = document.getElementById(inputId);
    if (input) {
      input.value = dados.proximo;
      input.placeholder = dados.proximo;
      input.focus();
      input.select();
    }
    const hint = document.getElementById(hintId);
    if (hint) hint.textContent = textoHintFogo(dados);
    const detalhe = dados.ultimo
      ? `última cadastrada: ${dados.ultimo}`
      : 'nenhum pneu neste padrão — começa em 0001';
    toast(`Marca gerada: ${dados.proximo} (${detalhe})`, 'success');
    return dados;
  } catch (err) {
    toast(err.message || 'Falha ao gerar marca de fogo', 'error');
    return null;
  } finally {
    if (btn) {
      btn.disabled = false;
      delete btn.dataset.gerando;
    }
  }
}

function mostrarBotaoGerarFogo(visivel) {
  document.getElementById('btn-gerar-fogo')?.classList.toggle('hidden', !visivel);
}

async function fetchConfiguracoes() {
  if (configuracoesEmSessao) return configuracoesEmSessao;
  try {
    configuracoesEmSessao = await fetchJSON(`${API}/configuracoes`);
    return configuracoesEmSessao;
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

function fecharDialog(el) {
  const dialog = typeof el === 'string' ? document.getElementById(el) : el;
  if (dialog?.open) dialog.close();
}

function formDesativar(form) {
  if (!form) return;
  form.dataset.salvando = '1';
  form.querySelectorAll('input, select, textarea, button').forEach((el) => {
    el.disabled = true;
  });
}

function travarSubmit(form, travar, texto = 'Salvando…') {
  const btn = form?.querySelector('button[type="submit"]');
  if (!btn) return;
  if (travar) {
    btn.dataset.labelOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = texto;
    return;
  }
  btn.disabled = false;
  if (btn.textContent === texto && btn.dataset.labelOriginal) {
    btn.textContent = btn.dataset.labelOriginal;
  }
}

function ehCadastroPendente(v) {
  return v != null && (v.cadastro_pendente === true || Number(v.cadastro_completo ?? 1) !== 1);
}

function badge(status) {
  const labels = {
    ok: 'OK',
    alerta: 'Monitorar',
    critico: 'Crítico',
    sem_dado: 'Sem medição',
    cadastro_pendente: 'Cadastro pendente',
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

function pressaoSalvaDoPneu(pneu) {
  const v = pneu?.ultima_medicao?.pressao_psi ?? pneu?.ult_pressao_psi;
  return v != null && v !== '' ? v : '';
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
  const { sulco_critico_mm: c, sulco_alerta_mm: a, prazo_recap_dias: p, acoes, trator } = limitesAtuais;
  const t = acoes?.troca?.label || 'Trocar';
  const m = acoes?.monitorar?.label || 'Monitorar';
  const o = acoes?.ok?.label || 'OK';
  const caminhao = `Caminhões: ≤ ${c} mm → ${t} · > ${c}–${a} mm → ${m} (recap ${p || 15}d) · > ${a} mm → ${o}`;
  if (!trator?.sulco_critico_mm) return caminhao;
  return `${caminhao} · Tratores: ≤ ${trator.sulco_critico_mm} mm / ${trator.sulco_alerta_mm} mm / novo ~${trator.sulco_novo_mm} mm`;
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

let painelPresidente = 'visao';

function showView(name, painel) {
  if (name === 'saude' && !isPresidente()) return;
  if (name !== 'chatbot') stopWaPoll();
  if (name === 'presidente') painelPresidente = painel || painelPresidente || 'visao';
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.add('active');
  const abaPresidente = painelPresidente === 'filial' ? 'filiais' : painelPresidente;
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === 'presidente'
      ? name === 'presidente' && t.dataset.painel === abaPresidente
      : t.dataset.view === name;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  document.querySelector('.container')?.classList.toggle('container-exec', name === 'presidente');
  if (name === 'presidente') abrirPainelPresidente(painelPresidente);
}

function setCabecalho({ unidade, papel, login, subtitle }) {
  const unidadeEl = document.getElementById('header-unidade-nome');
  const papelEl = document.getElementById('header-papel');
  const label = document.getElementById('header-user-label');
  const sub = document.getElementById('header-subtitle');
  if (unidadeEl) unidadeEl.textContent = unidade || 'Pneu Sistemma';
  if (papelEl) {
    papelEl.textContent = papel || '';
    papelEl.classList.toggle('hidden', !papel);
  }
  if (label) {
    label.textContent = login || '';
    label.classList.toggle('hidden', !login);
  }
  if (sub) sub.textContent = subtitle || '';
}

function finalizarBootVisual() {
  document.documentElement.classList.add('app-ready');
  document.documentElement.classList.remove('session-pending');
  document.getElementById('app-boot')?.setAttribute('aria-busy', 'false');
}

function showLogin() {
  document.documentElement.classList.remove('session-pending', 'app-ready', 'perfil-presidente');
  document.getElementById('app-boot')?.setAttribute('aria-busy', 'false');
  document.getElementById('app-login').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('app-shell')?.classList.remove('modo-executivo');
  document.getElementById('exec-app')?.classList.add('hidden');
  document.getElementById('nav-tabs-presidente')?.classList.add('hidden');
  setCabecalho({
    unidade: 'Pneu Sistemma',
    papel: '',
    login: '',
    subtitle: 'Gestão de pneus da frota',
  });
}

function showAppShell() {
  document.getElementById('app-login').classList.add('hidden');
  const shell = document.getElementById('app-shell');
  shell.classList.remove('hidden');
  finalizarBootVisual();

  const navFilial = document.getElementById('nav-tabs-filial');
  const navAdmin = document.getElementById('nav-tabs-admin');
  const navGerente = document.getElementById('nav-tabs-gerente');
  const tituloAcessos = document.getElementById('usuarios-titulo');

  navFilial.classList.add('hidden');
  navAdmin.classList.add('hidden');
  navGerente?.classList.add('hidden');
  document.getElementById('nav-tabs-presidente')?.classList.add('hidden');
  document.getElementById('tab-saude')?.classList.toggle('hidden', !isPresidente());
  shell.classList.remove('modo-executivo');
  document.getElementById('exec-app')?.classList.add('hidden');
  document.documentElement.classList.toggle('perfil-presidente', isPresidente());

  if (isPresidente()) {
    document.getElementById('nav-tabs-presidente')?.classList.remove('hidden');
    setCabecalho({
      unidade: 'Visão executiva',
      papel: 'Presidente',
      login: currentUser.login,
      subtitle: 'Consulta da frota',
    });
    document.getElementById('btn-salvar-config')?.classList.add('hidden');
    document.getElementById('btn-nova-filial')?.classList.add('hidden');
    aplicarVisibilidadeOrientacaoGestao();
    return;
  }

  if (isAdmin()) {
    navAdmin.classList.remove('hidden');
    setCabecalho({
      unidade: 'Todas as unidades',
      papel: isPresidente() ? 'Presidente' : 'Administrador',
      login: currentUser.login,
      subtitle: isPresidente()
        ? 'Diretoria, unidades e visão executiva'
        : 'Diretoria, unidades e configuração',
    });
    if (tituloAcessos) tituloAcessos.textContent = 'Acessos';
    document.getElementById('btn-salvar-config')?.classList.remove('hidden');
    document.getElementById('btn-nova-filial')?.classList.remove('hidden');
    const tit = document.getElementById('filiais-titulo');
    const hint = document.getElementById('filiais-hint');
    if (tit) tit.textContent = 'Unidades';
    if (hint) hint.textContent = 'Clique numa filial para ver a situação da frota, os pneus que a justificam e os dados operacionais.';
  } else if (isGerente()) {
    navGerente?.classList.remove('hidden');
    const nome = currentUser.filial?.nome || 'Multiunidade';
    setCabecalho({
      unidade: nome,
      papel: 'Gerente',
      login: currentUser.login,
      subtitle: 'Indicadores e acessos desta unidade',
    });
    if (tituloAcessos) tituloAcessos.textContent = 'Acessos da unidade';
    document.getElementById('btn-salvar-config')?.classList.add('hidden');
    document.getElementById('btn-nova-filial')?.classList.add('hidden');
    const tit = document.getElementById('filiais-titulo');
    const hint = document.getElementById('filiais-hint');
    if (tit) tit.textContent = 'Minha unidade';
    if (hint) hint.textContent = 'Painel da sua unidade: indicadores, pendências e frota para análise.';
  } else {
    navFilial.classList.remove('hidden');
    const nomeFilial = currentUser.filial?.nome || currentUser.filial?.codigo || 'Filial';
    setCabecalho({
      unidade: nomeFilial,
      papel: 'Operador',
      login: currentUser.login,
      subtitle: 'Medição e frota desta unidade',
    });
    document.getElementById('btn-salvar-config')?.classList.add('hidden');
  }

  aplicarVisibilidadeOrientacaoGestao();
  requestAnimationFrame(atualizarIndicacaoMenuRolavel);
}

function atualizarIndicacaoMenuRolavel() {
  document.querySelectorAll('.nav-tabs').forEach((nav) => {
    const sobra = nav.scrollWidth - nav.clientWidth > 8;
    nav.classList.toggle('nav-mais-esquerda', sobra && nav.scrollLeft > 8);
    nav.classList.toggle('nav-mais-direita', sobra && nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 8);
  });
}

function ligarIndicacaoMenuRolavel() {
  document.querySelectorAll('.nav-tabs').forEach((nav) => {
    if (nav.dataset.rolagemLigada === '1') return;
    nav.dataset.rolagemLigada = '1';
    nav.addEventListener('scroll', atualizarIndicacaoMenuRolavel, { passive: true });
  });
  window.addEventListener('resize', atualizarIndicacaoMenuRolavel);
  atualizarIndicacaoMenuRolavel();
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
    if (view === 'presidente') {
      if (!isPresidente()) {
        toast('Visão executiva: somente o perfil presidente', 'error');
        return;
      }
      showView('presidente', tab.dataset.painel || 'visao');
      return;
    }
    showView(view);
    if (view === 'dashboard') loadDashboard();
    if (view === 'veiculos') loadVeiculos();
    if (view === 'pneus') loadPneus();
    if (view === 'medicao') initMedicao();
    if (view === 'alertas') loadAlertas();
    if (view === 'acoes') loadAcoes();
    if (view === 'chatbot') {
      if (!isAdmin()) {
        toast('Chatbot WhatsApp: só o administrador', 'error');
        showView(isGerente() ? 'filiais' : 'dashboard');
        if (isGerente()) loadFiliais();
        return;
      }
      loadChatbotAdmin();
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
    if (view === 'diagnostico-frota') {
      if (!isGestao()) {
        toast('Diagnóstico da frota: só gerente e administrador', 'error');
        showView(isGerente() ? 'filiais' : 'dashboard');
        return;
      }
      loadDiagnosticoFrota().catch((err) => toast(err.message, 'error'));
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
    if (view === 'saude') {
      if (!isPresidente()) {
        toast('Saúde e desgaste: exclusivo do perfil presidente', 'error');
        const volta = isAdmin() ? 'relatorios' : (isGerente() ? 'filiais' : 'dashboard');
        showView(volta);
        return;
      }
      loadSaudeDesgaste();
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
  if (limitesPainelBackup) {
    limitesAtuais = limitesPainelBackup;
    limitesPainelBackup = null;
    syncMarkersLimites();
  }
  showView(voltarPara);
  if (voltarPara === 'dashboard') loadDashboard();
  else if (voltarPara === 'acoes') loadAcoes();
  else loadVeiculos();
});

function setDashboardEstado(tipo, msg) {
  const el = document.getElementById('dashboard-estado');
  if (!el) return;
  if (!msg) {
    el.textContent = '';
    el.className = 'dash-estado hidden';
    return;
  }
  el.textContent = msg;
  el.className = `dash-estado dash-estado-${tipo || 'aviso'}`;
}

async function fetchDashboardResumo() {
  try {
    return await fetchJSON(`${API}/dashboard/resumo${queryTipo()}`);
  } catch (err) {
    try {
      const veiculos = await fetchJSON(`${API}/veiculos`);
      setDashboardEstado('aviso', 'Indicadores do painel indisponíveis. A fila abaixo usa a lista de veículos.');
      return {
        veiculos,
        veiculos_ativos: veiculos.length,
        pneus_ok: null,
        pneus_alerta: null,
        pneus_critico: null,
        pneus_sem_dado: null,
        acoes: {},
        indicadores_parciais: true,
        limites: limitesAtuais,
      };
    } catch {
      throw err;
    }
  }
}

function textoKpi(valor) {
  return valor == null || Number.isNaN(Number(valor)) ? '—' : String(valor);
}

function renderPainelAcoesDiagnosticos({ acoes = [], diagnosticos = [] } = {}) {
  const ordemAcao = { troca: 0, recap: 1, rodizio: 2, monitorar: 3 };
  const acoesOrd = [...acoes].sort((a, b) =>
    (ordemAcao[a.acao_sugerida] ?? 9) - (ordemAcao[b.acao_sugerida] ?? 9)
    || (a.menor_sulco ?? 99) - (b.menor_sulco ?? 99)
  );
  const itemAcao = (a) => `
    <li class="frota-decisao-item acao-${escapeHtml(a.acao_sugerida || '')}" data-veiculo-id="${a.veiculo_id || ''}">
      <div class="frota-decisao-topo">
        <strong>${escapeHtml(a.apelido || a.placa || '—')}</strong>
        <span class="frota-log-pos">${escapeHtml(a.posicao_label || meta.posicoes?.[a.posicao] || a.posicao || '—')}</span>
        ${a.menor_sulco != null ? `<span class="frota-log-sulco">${a.menor_sulco} mm</span>` : ''}
        ${badgeAcao(a.acao_sugerida, a.acao_label)}
      </div>
      <p>${escapeHtml(a.acao_motivo || 'Ação sugerida a partir da última medição.')}</p>
    </li>
  `;
  const itemDiag = (d) => `
    <li class="frota-decisao-item diag-${escapeHtml(d.diagnostico || '')}" data-veiculo-id="${d.veiculo_id || ''}">
      <div class="frota-decisao-topo">
        <strong>${escapeHtml(d.apelido || d.placa || '—')}</strong>
        <span class="frota-log-pos">${escapeHtml(d.posicao_label || meta.posicoes?.[d.posicao] || d.posicao || '—')}</span>
        ${d.menor_sulco != null ? `<span class="frota-log-sulco">${d.menor_sulco} mm</span>` : ''}
        <span class="badge badge-${d.status_sulco || 'sem_dado'}">${escapeHtml(d.diagnostico_label || d.diagnostico || 'Diagnóstico')}</span>
      </div>
      <p>${escapeHtml(d.diagnostico_desc || d.diagnostico_label || 'Perfil de desgaste identificado na medição.')}</p>
    </li>
  `;
  return `
    <div class="frota-decisao">
      <section class="frota-decisao-card">
        <h3>Ações <span>${acoesOrd.length}</span></h3>
        <p class="hint">O que fazer agora: trocar, recapar, mudar de posição ou acompanhar.</p>
        ${acoesOrd.length
          ? `<ul class="frota-decisao-list">${acoesOrd.map(itemAcao).join('')}</ul>`
          : '<p class="hint">Nenhuma ação pendente nesta unidade.</p>'}
      </section>
      <section class="frota-decisao-card">
        <h3>Diagnósticos <span>${diagnosticos.length}</span></h3>
        <p class="hint">Causa do desgaste: calibragem, perfil irregular ou sulco crítico.</p>
        ${diagnosticos.length
          ? `<ul class="frota-decisao-list">${diagnosticos.map(itemDiag).join('')}</ul>`
          : '<p class="hint">Nenhum diagnóstico irregular nesta unidade.</p>'}
      </section>
    </div>
  `;
}

function horaLog(iso) {
  if (!iso) return '';
  const txt = formatDateTime(iso);
  const partes = String(txt).split(' ');
  return partes.length > 1 ? partes[1].slice(0, 5) : txt;
}

function deduplicarLogsMedicao(logs) {
  const seen = new Set();
  const out = [];
  for (const l of logs || []) {
    const key = `${l.veiculo_id || l.placa || l.apelido || ''}|${l.posicao || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

function renderLogMedicoes(logs) {
  const unicos = deduplicarLogsMedicao(logs);
  if (!unicos.length) {
    return '<p class="hint">Ainda não há medições registradas nesta unidade.</p>';
  }
  const grupos = [];
  const map = new Map();
  for (const l of unicos) {
    const dia = formatDate(l.data_medicao || l.created_at);
    if (!map.has(dia)) {
      const g = { dia, itens: [] };
      map.set(dia, g);
      grupos.push(g);
    }
    map.get(dia).itens.push(l);
  }
  return grupos.map((g) => `
    <div class="frota-log-dia">
      <h4>${escapeHtml(g.dia)}</h4>
      <ul>
        ${g.itens.map((l) => `
          <li class="frota-log-item status-${escapeHtml(l.status_sulco || 'sem_dado')}" data-veiculo-id="${l.veiculo_id || ''}">
            <span class="frota-log-hora">${escapeHtml(horaLog(l.created_at || l.data_medicao))}</span>
            <div class="frota-log-body">
              <div class="frota-log-linha1">
                <span class="frota-log-placa">${escapeHtml(l.apelido || l.placa || '')}</span>
                <span class="frota-log-pos">${escapeHtml(l.posicao || '—')}</span>
              </div>
              <div class="frota-log-linha2">
                <span class="frota-log-sulco">${l.menor_sulco != null ? `${l.menor_sulco} mm` : '—'}</span>
                ${badge(l.status_sulco)}
              </div>
            </div>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('');
}

function renderCardCaminhaoFrota(v, { pendente = false, atrasado = false, eHoje = false, diaTxt = '', dataMed = '', posTxt = '', mostrarMedir = false } = {}) {
  const layout = getLayoutById(v.layout_pneus);
  const posicoes = layout?.posicoes || (v.pneus || []).map((p) => p.posicao);
  const mini = svgMiniCaminhao({
    layoutId: v.layout_pneus,
    posicoes,
    pneus: v.pneus || [],
  });
  const cadastroPendente = ehCadastroPendente(v);
  const statusSemana = cadastroPendente
    ? '<span class="badge badge-cadastro_pendente">Cadastro pendente</span>'
    : (!pendente
      ? '<span class="badge badge-ok">Nesta semana</span>'
      : (atrasado
        ? '<span class="badge badge-critico">Atrasado</span>'
        : (eHoje
          ? '<span class="badge badge-alerta">Medir hoje</span>'
          : '<span class="badge badge-sem_dado">Pendente</span>')));
  return `
    <article class="veiculo-card veiculo-item frota-truck-card${pendente ? ' veiculo-card-pendente' : ''}${atrasado ? ' veiculo-card-atrasado' : ''}"
             data-id="${v.id}"
             data-cadastro-pendente="${cadastroPendente ? '1' : '0'}"
             data-status="${v.status_sulco || ''}"
             data-troca="${v.pendencias_troca || 0}"
             data-recap="${v.pendencias_recap || 0}"
             data-monitorar="${v.pendencias_monitorar || 0}"
             data-ultima="${escapeHtml(v.ultima_medicao || '')}"
             ${attrsBuscaVeiculo(v)}
             tabindex="0" role="button">
      <div class="frota-truck-svg">${mini}</div>
      <div class="frota-truck-meta">
        <h4>${escapeHtml(v.apelido || v.placa)}</h4>
        <p>${escapeHtml(v.placa)}${v.tipo ? ` · ${escapeHtml(normalizarTipoLabel(v.tipo))}` : ''}</p>
        <p class="dash-medicao-data">${escapeHtml(diaTxt)}${diaTxt && dataMed ? ' · ' : ''}${escapeHtml(dataMed)}${posTxt ? ` · ${escapeHtml(posTxt)}` : ''}</p>
        <div class="frota-truck-badges">
          ${!cadastroPendente && v.menor_sulco != null ? `<strong>${v.menor_sulco} mm</strong>` : ''}
          ${cadastroPendente ? '' : badge(v.status_sulco)}
          ${statusSemana}
        </div>
        ${mostrarMedir && !cadastroPendente ? `<button type="button" class="btn btn-sm btn-primary btn-dash-medir" data-id="${v.id}">Medir</button>` : ''}
        ${cadastroPendente && podeConcluirCadastro() ? `<button type="button" class="btn btn-sm btn-primary btn-concluir-cadastro" data-id="${v.id}">Concluir cadastro</button>` : ''}
      </div>
    </article>
  `;
}

// ── Dashboard ──────────────────────────────────────────

let dashResumoAtual = null;
let dashFiltroAtivo = 'prioridade';

function bucketAcaoDashboard(codigo) {
  if (codigo === 'troca' || codigo === 'substituir' || codigo === 'corte' || codigo === 'dano_lateral') return 'troca';
  if (codigo === 'recap') return 'recap';
  if (
    codigo === 'monitorar'
    || codigo === 'reinspecionar'
    || codigo === 'verificar_desgaste'
    || codigo === 'avaliar'
    || codigo === 'desgaste_irregular'
  ) return 'monitorar';
  if (codigo === 'rodizio') return 'rodizio';
  return null;
}

function semanaDoResumo(resumo) {
  if (!resumo?.semana) return semanaMedicaoBrasil();
  return {
    hoje: resumo.semana.hoje,
    isoDia: resumo.semana.iso_dia,
    inicio: resumo.semana.inicio,
    fim: resumo.semana.fim,
    diaHojeLabel: resumo.semana.dia_hoje_label,
  };
}

function classeMedicaoSemana(v, semana, diaUnidade) {
  if (ehCadastroPendente(v)) return 'cadastro';
  if (medidoNestaSemana(v.ultima_medicao, semana)) return 'medido';
  const diaV = Number(v.dia_medicao) || diaUnidade || null;
  if (diaV && semana.isoDia > diaV) return 'atrasado';
  if (diaV && semana.isoDia === diaV) return 'hoje';
  return 'pendente';
}

function ordenarVeiculosSemana(lista, semana, diaUnidade) {
  const ts = (v) => {
    const raw = v.ultima_atualizacao || v.ultima_medicao;
    const t = raw ? Date.parse(raw) : 0;
    return Number.isFinite(t) ? t : 0;
  };
  return [...lista].sort((a, b) => {
    const ca = classeMedicaoSemana(a, semana, diaUnidade);
    const cb = classeMedicaoSemana(b, semana, diaUnidade);
    if (ca === 'medido' && cb === 'medido') return ts(b) - ts(a);
    return String(a.apelido || a.placa).localeCompare(String(b.apelido || b.placa), 'pt-BR');
  });
}

function cardDashboardVeiculo(v, semana, diaUnidade) {
  const classe = classeMedicaoSemana(v, semana, diaUnidade);
  const diaV = Number(v.dia_medicao) || diaUnidade || null;
  const dataMed = v.ultima_medicao
    ? `Última: ${formatDate(v.ultima_medicao)}`
    : 'Ainda sem medição';
  const nMed = Number(v.pneus_medidos) || 0;
  const nTot = Number(v.total_pneus) || 0;
  return renderCardCaminhaoFrota(v, {
    pendente: classe !== 'medido',
    atrasado: classe === 'atrasado',
    eHoje: classe === 'hoje',
    diaTxt: diaV ? labelDiaSemana(diaV) : '',
    dataMed,
    posTxt: nTot ? `${nMed}/${nTot} posições` : 'Sem pneus',
    mostrarMedir: classe !== 'medido' && classe !== 'cadastro',
  });
}

function secaoVeiculosDash(titulo, itens, semana, diaUnidade, extra = '') {
  if (!itens.length) return '';
  return `
    <section class="dash-frota-sec">
      <h3>${escapeHtml(titulo)} <span>${itens.length}</span></h3>
      ${extra}
      <div class="frota-grid-inner">${itens.map((v) => cardDashboardVeiculo(v, semana, diaUnidade)).join('')}</div>
    </section>
  `;
}

function registroDashboard({ id, buscaVeiculo, titulo, detalhe, extra }) {
  return `
    <article class="veiculo-card dash-registro" data-id="${id || ''}" ${buscaVeiculo || ''} tabindex="0" role="button">
      <div class="dash-registro-corpo">
        <strong>${titulo}</strong>
        <p>${detalhe}</p>
      </div>
      <div class="veiculo-meta">${extra || ''}</div>
    </article>
  `;
}

function pintarListaDashboard(resumo, veiculos) {
  const lista = document.getElementById('dashboard-lista');
  if (!lista) return;
  const semana = semanaDoResumo(resumo);
  const diaUnidade = Number(resumo.dia_medicao) || null;
  const grupos = { atrasado: [], hoje: [], pendente: [], medido: [], cadastro: [] };
  for (const v of veiculos) {
    grupos[classeMedicaoSemana(v, semana, diaUnidade)].push(v);
  }
  for (const chave of Object.keys(grupos)) {
    grupos[chave] = ordenarVeiculosSemana(grupos[chave], semana, diaUnidade);
  }
  const setKpi = (id, valor) => {
    const el = document.getElementById(id);
    if (el) el.textContent = textoKpi(valor);
  };
  setKpi('stat-veiculos', resumo.veiculos_ativos ?? veiculos.filter((v) => !ehCadastroPendente(v)).length);
  setKpi('stat-atrasado', grupos.atrasado.length);
  setKpi('stat-hoje', grupos.hoje.length);
  setKpi('stat-pendente', grupos.pendente.length);
  setKpi('stat-medido', grupos.medido.length);
  setKpi('stat-ok', resumo.pneus_ok);
  setKpi('stat-alerta', resumo.pneus_alerta);
  setKpi('stat-critico', resumo.pneus_critico);
  setKpi('stat-sem-dado', resumo.pneus_sem_dado);
  setKpi('stat-troca', resumo.acoes?.troca);
  setKpi('stat-recap', resumo.acoes?.monitorar);
  setKpi('stat-monitorar', resumo.acoes?.rodizio);
  document.querySelectorAll('#dashboard-kpis [data-dash-filtro]').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.dashFiltro === dashFiltroAtivo ? 'true' : 'false');
  });

  const filtro = dashFiltroAtivo;
  const porVeiculo = new Map(veiculos.map((v) => [Number(v.id), v]));
  const tituloFiltro = {
    'semana:atrasado': 'Veículos atrasados',
    'semana:hoje': 'Medir hoje',
    'semana:pendente': 'Pendentes nesta semana',
    'semana:medido': 'Medidos nesta semana',
    'sulco:critico': 'Pneus críticos',
    'sulco:alerta': 'Pneus em alerta',
    'sulco:sem_dado': 'Pneus sem medição',
    'sulco:ok': 'Pneus OK',
    'acao:troca': 'Troca sugerida',
    'acao:monitorar': 'Acompanhar',
    'acao:rodizio': 'Mudar posição',
  }[filtro];

  if (!veiculos.length && !String(filtro).startsWith('acao:')) {
    lista.dataset.contagem = 'veiculo';
    const tipoAtivo = lerFiltroTipo();
    const tipoLabel = tipoDoCatalogo(tipoAtivo)?.label || tipoAtivo;
    lista.innerHTML = tipoAtivo
      ? `<div class="empty-state"><h3>Nenhum veículo deste tipo</h3><p>Não há ${escapeHtml(tipoLabel)} nesta unidade.</p></div>`
      : '<div class="empty-state"><h3>Nenhum veículo cadastrado</h3><p>Cadastre o primeiro veículo em Frota.</p></div>';
    return;
  }

  if (filtro === 'prioridade' || filtro.startsWith('semana:')) {
    lista.dataset.contagem = 'veiculo';
    const chave = filtro.startsWith('semana:') ? filtro.slice(7) : '';
    const blocos = [];
    if (!chave || chave === 'atrasado') {
      blocos.push(secaoVeiculosDash('Atrasados', grupos.atrasado, semana, diaUnidade,
        '<p class="hint">O dia de medição deste veículo já passou nesta semana.</p>'));
    }
    if (!chave || chave === 'hoje') {
      blocos.push(secaoVeiculosDash('Medir hoje', grupos.hoje, semana, diaUnidade));
    }
    if (!chave || chave === 'pendente') {
      blocos.push(secaoVeiculosDash('Pendentes', grupos.pendente, semana, diaUnidade));
    }
    if (!chave) {
      blocos.push(secaoVeiculosDash('Cadastro pendente', grupos.cadastro, semana, diaUnidade));
    }
    const medidosHtml = grupos.medido.length
      ? `<details class="dash-medidos"${chave === 'medido' ? ' open' : ''}>
          <summary>Medidos nesta semana <span>${grupos.medido.length}</span></summary>
          <div class="frota-grid-inner">${grupos.medido.map((v) => cardDashboardVeiculo(v, semana, diaUnidade)).join('')}</div>
        </details>`
      : '';
    const mostrarMedidos = !chave || chave === 'medido';
    const vazio = !blocos.join('') && !(mostrarMedidos && medidosHtml);
    lista.innerHTML = `
      ${tituloFiltro ? `<div class="dash-lista-head"><h3>${escapeHtml(tituloFiltro)}</h3><button type="button" class="btn btn-ghost btn-sm" id="btn-dash-limpar-filtro">Ver prioridade da semana</button></div>` : '<h3 class="dash-lista-titulo">Prioridade da semana</h3>'}
      ${blocos.join('')}
      ${mostrarMedidos ? medidosHtml : ''}
      ${vazio ? '<div class="empty-state"><h3>Nenhum veículo neste filtro</h3><p>A frota completa continua em Frota.</p></div>' : ''}
    `;
    return;
  }

  if (filtro.startsWith('sulco:')) {
    lista.dataset.contagem = 'pneu';
    const status = filtro.slice(6);
    const rows = [];
    for (const v of veiculos) {
      if (ehCadastroPendente(v)) continue;
      for (const p of v.pneus || []) {
        const st = p.status_sulco || 'sem_dado';
        const casa = st === 'monitorar' ? 'alerta' : st;
        if (casa !== status) continue;
        rows.push({ v, p, casa });
      }
    }
    lista.innerHTML = `
      <div class="dash-lista-head">
        <h3>${escapeHtml(tituloFiltro || 'Pneus')} <span>${rows.length}</span></h3>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-dash-limpar-filtro">Ver prioridade da semana</button>
      </div>
      ${rows.length ? `<div class="dash-registros">${rows.map(({ v, p }) => registroDashboard({
        id: v.id,
        buscaVeiculo: attrsBuscaVeiculo(v),
        titulo: escapeHtml(v.apelido || v.placa || '—'),
        detalhe: `${escapeHtml(v.placa || '')} · ${escapeHtml(meta.posicoes?.[p.posicao] || p.posicao || '—')}`,
        extra: `${p.menor_sulco != null ? `<strong>${p.menor_sulco} mm</strong>` : ''}${badge(p.status_sulco)}`,
      })).join('')}</div>` : '<div class="empty-state"><h3>Nenhum pneu neste status</h3><p>O número do cartão vem do resumo da unidade.</p></div>'}
    `;
    return;
  }

  lista.dataset.contagem = 'registro';
  const bucket = filtro.slice(5);
  const itens = (resumo.acoes_itens || []).filter((a) => bucketAcaoDashboard(a.acao_sugerida) === bucket);
  const nota = bucket === 'monitorar'
    ? '<p class="hint">Estes pneus estão montados e a medição pede acompanhamento. Não são pneus enviados à recapagem.</p>'
    : '';
  lista.innerHTML = `
    <div class="dash-lista-head">
      <h3>${escapeHtml(tituloFiltro || 'Ações')} <span>${itens.length}</span></h3>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-dash-limpar-filtro">Ver prioridade da semana</button>
    </div>
    ${nota}
    ${itens.length ? `<div class="dash-registros">${itens.map((a) => {
      const v = porVeiculo.get(Number(a.veiculo_id));
      return registroDashboard({
        id: a.veiculo_id,
        buscaVeiculo: attrsBuscaVeiculo(v || { ...a, tipo: lerFiltroTipo(), tipo_codigo: lerFiltroTipo() }),
        titulo: escapeHtml(a.apelido || a.placa || '—'),
        detalhe: `${escapeHtml(a.posicao_label || meta.posicoes?.[a.posicao] || a.posicao || '—')}${a.acao_motivo ? ` · ${escapeHtml(a.acao_motivo)}` : ''}`,
        extra: `${a.menor_sulco != null ? `<strong>${a.menor_sulco} mm</strong>` : ''}${badgeAcao(a.acao_sugerida, a.acao_label)}`,
      });
    }).join('')}</div>` : '<div class="empty-state"><h3>Nenhuma ação neste grupo</h3></div>'}
  `;
}

function ligarListaDashboard() {
  const lista = document.getElementById('dashboard-lista');
  if (!lista) return;
  lista.querySelectorAll('.veiculo-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-dash-medir, .btn-concluir-cadastro, #btn-dash-limpar-filtro')) return;
      if (!card.dataset.id) return;
      if (card.dataset.cadastroPendente === '1') {
        abrirConcluirCadastro(card.dataset.id, 'dashboard');
        return;
      }
      openVeiculoDetalhe(card.dataset.id, 'dashboard');
    });
  });
  lista.querySelectorAll('.btn-concluir-cadastro').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      abrirConcluirCadastro(btn.dataset.id, 'dashboard');
    });
  });
  lista.querySelectorAll('.btn-dash-medir').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openVeiculoDetalhe(btn.dataset.id, 'dashboard');
    });
  });
  lista.querySelector('#btn-dash-limpar-filtro')?.addEventListener('click', () => {
    dashFiltroAtivo = 'prioridade';
    if (dashResumoAtual) pintarDashboard(dashResumoAtual);
  });
}

function pintarDashboard(resumo) {
  const veiculos = Array.isArray(resumo.veiculos) ? resumo.veiculos : [];
  const hint = document.getElementById('dashboard-limites-hint');
  if (hint) hint.textContent = hintLimites();
  const selDia = document.getElementById('dash-dia-medicao');
  const hojeEl = document.getElementById('dash-dia-hoje');
  const semana = semanaDoResumo(resumo);
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
  pintarListaDashboard(resumo, veiculos);
  const logEl = document.getElementById('dashboard-log');
  if (logEl) logEl.innerHTML = renderLogMedicoes(resumo.logs_medicao || []);
  const decisaoEl = document.getElementById('dashboard-decisao');
  if (decisaoEl) {
    decisaoEl.innerHTML = renderPainelAcoesDiagnosticos({
      acoes: resumo.acoes_itens || [],
      diagnosticos: resumo.diagnosticos_itens || [],
    });
  }
  ligarListaDashboard();
  document.querySelectorAll('#dashboard-log .frota-log-item[data-veiculo-id]').forEach((row) => {
    row.addEventListener('click', () => {
      if (row.dataset.veiculoId) openVeiculoDetalhe(row.dataset.veiculoId, 'dashboard');
    });
  });
  document.querySelectorAll('#dashboard-decisao [data-veiculo-id]').forEach((row) => {
    row.addEventListener('click', () => {
      if (row.dataset.veiculoId) openVeiculoDetalhe(row.dataset.veiculoId, 'dashboard');
    });
  });
  aplicarBuscaFrotaSalva('dash-frota-busca');
}

async function loadDashboard() {
  setDashboardEstado('loading', 'Carregando prioridades…');
  try {
    const resumo = await fetchDashboardResumo();
    const veiculos = Array.isArray(resumo.veiculos)
      ? resumo.veiculos
      : await fetchJSON(`${API}/veiculos`);
    resumo.veiculos = veiculos;
    veiculosCache = veiculos;
    registrarTiposAvulsos(veiculos);
    preencherSelectsTipo();
    coletarTiposAvulsosDaFrota();
    limitesAtuais = { ...limitesAtuais, ...resumo.limites };
    syncMarkersLimites();
    dashResumoAtual = resumo;
    if (!resumo.indicadores_parciais) setDashboardEstado('');
    pintarDashboard(resumo);
  } catch (err) {
    setDashboardEstado('erro', err.message || 'Não foi possível carregar o dashboard.');
    const lista = document.getElementById('dashboard-lista');
    if (lista && !dashResumoAtual) {
      lista.innerHTML = `<div class="empty-state"><h3>Não foi possível carregar</h3><p>${escapeHtml(err.message || 'Erro ao falar com o servidor.')}</p></div>`;
    }
    toast(err.message, 'error');
  }
}

document.getElementById('dashboard-kpis')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dash-filtro]');
  if (!btn || !dashResumoAtual) return;
  dashFiltroAtivo = dashFiltroAtivo === btn.dataset.dashFiltro ? 'prioridade' : btn.dataset.dashFiltro;
  pintarDashboard(dashResumoAtual);
  document.getElementById('dashboard-lista')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.addEventListener('change', (e) => {
  if (!FILTRO_TIPO_IDS.includes(e.target?.id)) return;
  aoMudarFiltroTipo(e);
});

let frotaBuscaTimer;
function onInputBuscaFrota(e) {
  clearTimeout(frotaBuscaTimer);
  frotaBuscaTimer = setTimeout(() => filtrarListasFrota(e.target.id), 60);
}
['dash-frota-busca', 'veiculos-busca'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', onInputBuscaFrota);
  el.addEventListener('search', () => filtrarListasFrota(id));
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    filtrarListasFrota(id);
    const listaId = id === 'veiculos-busca' ? 'veiculos-lista' : 'dashboard-lista';
    const view = id === 'veiculos-busca' ? 'veiculos' : 'dashboard';
    abrirUnicoVeiculoBusca(listaId, view);
  });
});
ligarCamposBusca(document);

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
    registrarTiposAvulsos(veiculos);
    preencherSelectsTipo();
    const lista = document.getElementById('veiculos-lista');

    if (!veiculos.length) {
      lista.innerHTML = '<div class="empty-state"><h3>Nenhum veículo</h3><p>Clique em "+ Novo Veículo" para começar</p></div>';
      return;
    }

    lista.innerHTML = veiculos.map((v) => `
      <div class="veiculo-card" data-id="${v.id}" data-cadastro-pendente="${ehCadastroPendente(v) ? '1' : '0'}" ${attrsBuscaVeiculo(v)}>
        <div class="veiculo-info">
          <h4>${escapeHtml(v.apelido || v.placa)}</h4>
          <p>${escapeHtml(v.placa)} · ${escapeHtml(normalizarTipoLabel(v.tipo) || v.tipo || '')} · ${ehCadastroPendente(v) ? 'cadastro pendente' : `${v.total_pneus} pneus · ${v.km_atual?.toLocaleString('pt-BR') || 0} km`}</p>
        </div>
        <div class="veiculo-meta">
          ${badge(v.status_sulco)}
          ${ehCadastroPendente(v)
            ? (podeConcluirCadastro() ? `<button type="button" class="btn btn-sm btn-primary btn-concluir-cadastro" data-id="${v.id}">Concluir cadastro</button>` : '')
            : `<button class="btn btn-sm btn-primary btn-medir" data-id="${v.id}">Medir</button>`}
        </div>
      </div>
    `).join('');

    lista.querySelectorAll('.veiculo-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-medir, .btn-concluir-cadastro')) return;
        if (card.dataset.cadastroPendente === '1') {
          abrirConcluirCadastro(card.dataset.id, 'veiculos');
          return;
        }
        openVeiculoDetalhe(card.dataset.id, 'veiculos');
      });
    });
    lista.querySelectorAll('.btn-concluir-cadastro').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        abrirConcluirCadastro(btn.dataset.id, 'veiculos');
      });
    });

    lista.querySelectorAll('.btn-medir').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openVeiculoDetalhe(btn.dataset.id, 'veiculos');
      });
    });
    aplicarBuscaFrotaSalva('veiculos-busca');
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

async function openVeiculoDetalhe(id, origem = 'dashboard', dadosPreload = null, opts = {}) {
  voltarPara = origem;
  const seq = ++veiculoDetalheSeq;
  try {
    const v = dadosPreload || await fetchJSON(`${API}/veiculos/${id}`);
    if (seq !== veiculoDetalheSeq) return;
    veiculoAtual = v;
    veiculoLayoutId = v.id;
    garantirSessaoCampo(v.id);
    document.getElementById('view-veiculo-detalhe')?.classList.remove('campo-medindo');
    document.getElementById('truck-campo-nav')?.classList.add('hidden');

    if (v.posicoes) meta = { ...meta, posicoes: v.posicoes };
    if (v.limites) {
      if (!limitesPainelBackup) limitesPainelBackup = { ...limitesAtuais };
      limitesAtuais = { ...limitesAtuais, ...v.limites };
      syncMarkersLimites();
    }

    const layoutInfo = getLayoutById(v.layout_pneus);
    const nPos = v.posicoes_layout?.length || v.layout?.posicoes?.length || v.pneus.length;
    document.getElementById('truck-header').innerHTML = `
      <h2>${escapeHtml(v.apelido || v.placa)}</h2>
      <p class="hint">${escapeHtml(v.placa)} · ${escapeHtml(normalizarTipoLabel(v.tipo))} · ${v.km_atual?.toLocaleString('pt-BR') || 0} km
        ${v.hr_atual ? ` · ${escapeHtml(String(v.hr_atual))} h` : ''}
        · ${escapeHtml(layoutInfo?.nome || 'Personalizado')}
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
        const semPneus = !(v.pneus || []).length;
        banner.innerHTML = semPneus
          ? `
          <strong>Caminhão sem pneus</strong>
          <span>Toque no slot (+) e use a aba <em>Do estoque</em> para puxar um pneu da filial. Se o estoque estiver vazio, cadastre um novo.</span>`
          : `
          <strong>Modo campo (WhatsApp)</strong>
          <span>Toque no pneu para medir, enviar à recap, estoque ou descarte. Slot vazio (+) = pneu do estoque ou novo.</span>
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
        layoutId: v.layout_pneus,
        onPneuClick: (pneu) => selecionarPneuTruck(pneu),
        onSlotClick: (posicao) => selecionarSlotVazio(posicao),
      });
    }
    truckDiagram.pickerHint = modoAcessoRapido
      ? ((v.pneus || []).length
        ? 'Toque no pneu para medir ou no slot (+) para montar do estoque.'
        : 'Caminhão sem pneus — toque no slot (+) e escolha um pneu do estoque.')
      : 'Clique no pneu para medir ou no slot vazio para montar:';
    truckDiagram.render(v.pneus, meta.posicoes, posicoesLayout, { layoutId: v.layout_pneus });
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

    const btnExcluir = document.getElementById('btn-truck-excluir');
    if (btnExcluir) {
      btnExcluir.onclick = () => {
        if (modoAcessoRapido) return toast('Indisponível no acesso rápido', 'error');
        excluirCaminhaoGestao({
          filialId: v.filial_id,
          veiculoId: v.id,
          placa: v.placa,
          apelido: v.apelido,
          nPneus: v.pneus?.length || 0,
          depois: async () => {
            veiculoAtual = null;
            const destino = voltarPara === 'acesso-rapido' ? 'dashboard' : voltarPara;
            showView(destino);
            if (destino === 'dashboard') loadDashboard();
            else if (destino === 'acoes') loadAcoes();
            else if (destino === 'filiais' && v.filial_id) {
              await abrirDetalheFilial(v.filial_id);
              setUnidadeTab('frota');
            } else loadVeiculos();
          },
        });
      };
    }

    aplicarVisibilidadeAcessoRapido();
    showView('veiculo-detalhe');
  } catch (err) {
    if (opts.silencioso) throw err;
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
  // No link de medição as ações operacionais ficam visíveis; só gestão (layout/WA) some
  const gestao = document.getElementById('truck-panel-acoes-gestao');
  if (gestao) {
    gestao.classList.toggle('gestao-only-hidden', !isGestao() || modoAcessoRapido);
  }
  const btnWa = document.getElementById('btn-truck-whatsapp');
  if (btnWa) btnWa.classList.toggle('hidden', modoAcessoRapido || !isGestao());
  const tabEstoque = document.querySelector('.montar-tab[data-montar-tab="estoque"]');
  if (tabEstoque) tabEstoque.classList.remove('hidden');
  const linkPneus = document.getElementById('link-ir-pneus');
  if (linkPneus) linkPneus.closest('p')?.classList.toggle('hidden', modoAcessoRapido);
  const avancado = document.querySelector('#truck-montar-novo .form-avancado');
  if (avancado && modoAcessoRapido) avancado.classList.add('hidden');
  const custo = document.getElementById('truck-novo-custo')?.closest('.form-group');
  const nota = document.getElementById('truck-novo-nota')?.closest('.form-group');
  if (custo) custo.classList.toggle('hidden', modoAcessoRapido);
  if (nota) nota.classList.toggle('hidden', modoAcessoRapido);
  document.getElementById('truck-novo-compra')?.classList.toggle('hidden', modoAcessoRapido);
  const btnSulco = document.getElementById('btn-truck-salvar-sulco');
  if (btnSulco) {
    btnSulco.textContent = modoAcessoRapido ? 'Concluir medição e voltar' : 'Salvar medição de sulco';
  }
  const empty = document.querySelector('.truck-panel-empty');
  if (empty) {
    empty.innerHTML = modoAcessoRapido
      ? '<p>Toque em um pneu ou no slot vazio (+)</p><p class="hint">Slot vazio = pneu do estoque ou novo · Pneu montado = medir sulco.</p>'
      : '<p>Clique em uma posição</p><p class="hint">Slot vazio (+) = colocar pneu · Pneu montado = medir sulco</p>';
  }
  const bar = document.getElementById('acesso-rapido-bar');
  if (bar && modoAcessoRapido) {
    bar.innerHTML = `
      <span><strong>Modo campo</strong> — medir, trocar, recap, descarte · link 24h</span>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-rapido-recarregar">Atualizar</button>`;
    document.getElementById('btn-rapido-recarregar')?.addEventListener('click', () => recarregarAcessoRapido());
  }
}

async function recarregarAcessoRapido({ silent = false } = {}) {
  if (!tokenAcessoRapido) return;
  try {
    const data = await fetchJSON(`${API}/veiculos/acesso-rapido?token=${encodeURIComponent(tokenAcessoRapido)}`);
    tokenAcessoRapido = data.token_acesso || tokenAcessoRapido;
    await openVeiculoDetalhe(data.id, 'acesso-rapido', data);
    if (!silent) toast('Veículo atualizado', 'success');
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

function flushAutoSavePendente() {
  const tinhaTimer = autoSaveTimer;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (!tinhaTimer || !pneuSelecionado || !veiculoAtual) return;
  const pontos = pontosFromInputs('truck');
  if (pontos.externo == null || pontos.central == null || pontos.interno == null) return;
  salvarMedicaoTruck();
}

function selecionarPneuTruck(pneu) {
  if (pneuSelecionado?.id !== pneu.id) flushAutoSavePendente();
  else clearTimeout(autoSaveTimer);
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
  document.getElementById('truck-pressao').value = pressaoSalvaDoPneu(pneu);
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
  document.getElementById('btn-truck-trocar-estoque').onclick = () => abrirModalTrocarEstoque();
  document.getElementById('btn-truck-mover-frota').onclick = () => abrirModalMoverFrota();
  document.getElementById('btn-truck-recap').onclick = () => registrarEventoPneu('recap');
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
  flushAutoSavePendente();
  pneuSelecionado = null;
  slotPosicaoSelecionada = posicao;
  document.querySelector('.truck-panel-empty').classList.add('hidden');
  document.getElementById('truck-panel-form').classList.remove('hidden');
  document.getElementById('truck-montar-box').classList.remove('hidden');
  document.getElementById('truck-medicao-box').classList.add('hidden');

  const nome = meta.posicoes[posicao] || posicao;
  document.getElementById('truck-pneu-nome').textContent = `${nome} — vazio`;
  document.getElementById('truck-pneu-status').innerHTML = '';
  document.getElementById('truck-pneu-acao').innerHTML = '';
  document.getElementById('truck-pneu-vida').innerHTML = '';

  resetFormMontarNovo();
  aplicarVisibilidadeAcessoRapido();
  await carregarSelectEstoque();
  const temEstoque = estoqueMontarCache.length > 0;
  const tabInicial = modoAcessoRapido && temEstoque ? 'estoque' : 'novo';
  setMontarTab(tabInicial);
  const hintFogo = document.getElementById('truck-novo-fogo-hint');
  if (hintFogo) {
    hintFogo.textContent = 'Clique para analisar o código da unidade e a última marca cadastrada (ex.: 0110-0001).';
  }
  const hint = document.getElementById('truck-montar-hint');
  if (hint) {
    if (modoAcessoRapido) {
      hint.textContent = temEstoque
        ? 'Escolha um pneu do estoque desta filial ou cadastre um novo nesta posição.'
        : 'Não há pneus no estoque. Informe um pneu novo nesta posição.';
    } else {
      hint.textContent = 'Posição vazia — coloque um pneu aqui.';
    }
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
  if (tab === 'estoque') {
    setTimeout(() => document.getElementById('truck-estoque-busca')?.focus(), 40);
  }
}

async function criarEMontarPneuTruck() {
  if (!veiculoAtual || !slotPosicaoSelecionada) return;
  const fogo = document.getElementById('truck-novo-fogo')?.value?.trim();
  const modelo = document.getElementById('truck-novo-modelo')?.value?.trim();
  if (!modelo) {
    mostrarErroCadastro('truck-novo-erro', 'Informe o modelo do pneu');
    return toast('Informe o modelo do pneu', 'error');
  }
  mostrarErroCadastro('truck-novo-erro', '');

  const btn = document.getElementById('btn-truck-criar-montar');
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  let criado = null;
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

    criado = await fetchJSON(`${API}/pneus`, {
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
    if (!pneuId) throw new Error('O servidor não confirmou o pneu. Confira o estoque antes de cadastrar de novo.');

    await fetchJSON(`${API}/pneus/${pneuId}/montar`, {
      method: 'POST',
      body: JSON.stringify({
        veiculo_id: veiculoAtual.id,
        posicao: slotPosicaoSelecionada,
        km_veiculo: numOrNull('truck-km') ?? veiculoAtual.km_atual,
        hr_veiculo: numOrNull('truck-hr') ?? veiculoAtual.hr_atual,
      }),
    });
    toast(criado.mensagem ? `${criado.mensagem} e montado` : 'Pneu criado e montado', 'success');
    const pos = slotPosicaoSelecionada;
    await openVeiculoDetalhe(veiculoAtual.id, voltarPara, null, { silencioso: true });
    const montado = veiculoAtual?.pneus?.find((p) => p.posicao === pos);
    if (montado) {
      truckDiagram?.setAtivo(montado.id);
      selecionarPneuTruck(montado);
    }
  } catch (err) {
    const fogoSalvo = criado?.pneu?.numero_fogo;
    if (criado?.pneu?.id) {
      toast(`Pneu salvo no estoque${fogoSalvo ? ` (fogo ${fogoSalvo})` : ''}. Não montou: ${err.message}`, 'error');
    } else {
      toast(err.message, 'error');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

let estoqueMontarCache = [];
let estoqueTrocaCache = [];
let estoqueFilialTotal = 0;
let estoqueBuscaTimer = null;

function normalizarBuscaPneu(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function compactarBuscaTexto(s) {
  return normalizarBuscaPneu(s).replace(/[^a-z0-9]/g, '');
}

function textoBuscaVeiculo(v) {
  return [
    v?.apelido,
    v?.placa,
    v?.tipo,
    v?.marca,
    v?.modelo,
    v?.filial_nome,
  ].filter(Boolean).join(' ');
}

function attrsBuscaVeiculo(v) {
  const hay = normalizarBuscaPneu(textoBuscaVeiculo(v));
  const tipo = normalizarTipoLabel(v?.tipo) || v?.tipo || '';
  const codigo = v?.tipo_codigo || '';
  return `data-busca="${escapeHtml(hay)}" data-busca-compacta="${escapeHtml(compactarBuscaTexto(hay))}" data-tipo="${escapeHtml(tipo)}" data-tipo-codigo="${escapeHtml(codigo)}"`;
}

function cardCombinaTipo(card, filtro) {
  return veiculoCombinaFiltroTipo({
    tipo: card?.dataset?.tipo || '',
    tipo_codigo: card?.dataset?.tipoCodigo || '',
  }, filtro);
}

function cardVeiculoCombinaBusca(card, qRaw) {
  const q = normalizarBuscaPneu(qRaw);
  if (!q) return true;
  const hay = card.dataset.busca || '';
  if (hay.includes(q)) return true;
  const compacta = compactarBuscaTexto(qRaw);
  const hayComp = card.dataset.buscaCompacta || compactarBuscaTexto(hay);
  return Boolean(compacta) && hayComp.includes(compacta);
}

const FROTA_BUSCA_KEY = 'pneu_frota_busca';

function lerBuscaFrota() {
  return sessionStorage.getItem(FROTA_BUSCA_KEY) || '';
}

function gravarBuscaFrota(q) {
  const t = String(q || '').trim();
  if (t) sessionStorage.setItem(FROTA_BUSCA_KEY, t);
  else sessionStorage.removeItem(FROTA_BUSCA_KEY);
}

function aplicarBuscaListaVeiculos(listaEl, qRaw, contadorEl, filtroTipo = lerFiltroTipo()) {
  if (!listaEl) return 0;
  const q = String(qRaw || '').trim();
  const cards = [...listaEl.querySelectorAll('.veiculo-card')];
  let visiveis = 0;
  cards.forEach((card) => {
    const ok = cardVeiculoCombinaBusca(card, q) && cardCombinaTipo(card, filtroTipo);
    card.classList.toggle('hidden', !ok);
    if (ok) visiveis += 1;
  });
  const filtrando = Boolean(q) || Boolean(filtroTipo);
  listaEl.querySelectorAll('.dash-frota-sec').forEach((sec) => {
    const algum = [...sec.querySelectorAll('.veiculo-card')].some((c) => !c.classList.contains('hidden'));
    sec.classList.toggle('hidden', filtrando && !algum);
  });
  let vazio = listaEl.querySelector('.frota-busca-vazio');
  if (filtrando && cards.length && visiveis === 0) {
    if (!vazio) {
      vazio = document.createElement('p');
      vazio.className = 'hint frota-busca-vazio';
      listaEl.appendChild(vazio);
    }
    const tipoLabel = tipoDoCatalogo(filtroTipo)?.label || filtroTipo;
    vazio.textContent = q
      ? `Nenhum veículo encontrado para “${q}”.`
      : `Nenhum veículo do tipo “${tipoLabel}”.`;
    vazio.classList.remove('hidden');
  } else if (vazio) {
    vazio.classList.add('hidden');
  }
  if (contadorEl) {
    const tipoContagem = listaEl.dataset.contagem || 'veiculo';
    const rotulo = (n) => {
      if (tipoContagem === 'pneu') return n === 1 ? '1 pneu' : `${n} pneus`;
      if (tipoContagem === 'registro') return n === 1 ? '1 registro' : `${n} registros`;
      return n === 1 ? '1 veículo' : `${n} veículos`;
    };
    if (!cards.length) contadorEl.textContent = '';
    else if (!q && !filtroTipo) contadorEl.textContent = rotulo(cards.length);
    else if (visiveis === 1) contadorEl.textContent = '1 encontrado — Enter abre o veículo';
    else contadorEl.textContent = `${visiveis} de ${cards.length}`;
  }
  return visiveis;
}

function sincronizarBuscasFrota(origemId, valor) {
  ['dash-frota-busca', 'veiculos-busca'].forEach((id) => {
    if (id === origemId) return;
    const el = document.getElementById(id);
    if (!el || el === document.activeElement) return;
    if (el.value !== valor) el.value = valor;
    atualizarBotaoLimpar(el);
  });
}

function campoBuscaFrotaAtivo() {
  const id = document.activeElement?.id;
  return id === 'dash-frota-busca' || id === 'veiculos-busca' ? id : '';
}

function aplicarBuscaFrotaSalva(idPreferido) {
  const ativo = campoBuscaFrotaAtivo();
  if (ativo) {
    filtrarListasFrota(ativo);
    return;
  }
  const el = document.getElementById(idPreferido);
  if (el && !el.value) {
    el.value = lerBuscaFrota();
    atualizarBotaoLimpar(el);
  }
  filtrarListasFrota(idPreferido);
}

function filtrarListasFrota(origemId) {
  const origem = origemId
    ? document.getElementById(origemId)
    : (document.getElementById('dash-frota-busca') || document.getElementById('veiculos-busca'));
  const q = origem ? String(origem.value ?? '') : lerBuscaFrota();
  gravarBuscaFrota(q);
  if (origem) atualizarBotaoLimpar(origem);
  sincronizarBuscasFrota(origem?.id, q);
  aplicarBuscaListaVeiculos(
    document.getElementById('dashboard-lista'),
    q,
    document.getElementById('dash-frota-busca-count'),
  );
  aplicarBuscaListaVeiculos(
    document.getElementById('veiculos-lista'),
    q,
    document.getElementById('veiculos-busca-count'),
  );
}

function atualizarBotaoLimpar(input) {
  const btn = input?.closest('.busca-campo')?.querySelector('.busca-limpar');
  if (btn) btn.hidden = !String(input.value || '');
}

function limparCampoBusca(input) {
  if (!input) return;
  input.value = '';
  atualizarBotaoLimpar(input);
  input.focus({ preventScroll: true });
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function ligarCampoBusca(input) {
  if (!input || input.dataset.limparBusca === '1') {
    if (input) atualizarBotaoLimpar(input);
    return;
  }
  input.dataset.limparBusca = '1';
  input.classList.add('campo-busca');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('enterkeyhint', 'search');
  input.setAttribute('inputmode', 'search');
  input.removeAttribute('list');
  if (input.type === 'search') input.type = 'text';

  let wrap = input.closest('.busca-campo');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'busca-campo';
    input.parentNode?.insertBefore(wrap, input);
    wrap.appendChild(input);
  }
  let btn = wrap.querySelector('.busca-limpar');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'busca-limpar';
    btn.setAttribute('aria-label', 'Limpar pesquisa');
    btn.textContent = '×';
    wrap.appendChild(btn);
  }
  let ultimoLimpar = 0;
  const aoLimpar = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const agora = Date.now();
    if (agora - ultimoLimpar < 400) return;
    ultimoLimpar = agora;
    limparCampoBusca(input);
  };
  btn.addEventListener('pointerdown', aoLimpar);
  btn.addEventListener('click', aoLimpar);
  input.addEventListener('input', () => atualizarBotaoLimpar(input));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !input.value) return;
    e.preventDefault();
    e.stopPropagation();
    limparCampoBusca(input);
  });
  atualizarBotaoLimpar(input);
}

function ligarCamposBusca(raiz = document) {
  raiz.querySelectorAll('input.campo-busca, input[id$="-busca"]').forEach((input) => {
    ligarCampoBusca(input);
  });
}

function abrirUnicoVeiculoBusca(listaId, view) {
  const lista = document.getElementById(listaId);
  const visiveis = [...(lista?.querySelectorAll('.veiculo-card') || [])]
    .filter((c) => !c.classList.contains('hidden'));
  if (visiveis.length === 1 && visiveis[0].dataset.id) {
    openVeiculoDetalhe(visiveis[0].dataset.id, view);
  }
}

function rotuloPneuEstoque(p) {
  return [
    p.numero_fogo ? `Fogo ${p.numero_fogo}` : `#${p.id}`,
    p.marca,
    p.modelo,
    p.condicao === 'recapado' ? (p.vida_label || 'Recap') : 'Novo',
    p.padrao_label || labelPadraoPneu(p.tipo_pneu),
  ].filter(Boolean).join(' · ');
}

function pneuEstoqueCombinaBusca(p, q) {
  if (!q) return true;
  const hay = normalizarBuscaPneu([
    p.numero_fogo, p.id, p.marca, p.modelo, p.dot, p.medida,
    p.condicao, p.vida_label, p.padrao_label, p.tipo_pneu,
  ].filter(Boolean).join(' '));
  if (q.split(/\s+/).every((term) => hay.includes(term))) return true;
  const compactQ = compactarBuscaTexto(q);
  const compactHay = compactarBuscaTexto(hay);
  return compactQ.length >= 2 && compactHay.includes(compactQ);
}

function preencherSelectPneusEstoque(select, lista, busca, hintEl) {
  if (!select) return;
  const q = normalizarBuscaPneu(busca);
  const atual = select.value;
  const filtrada = lista.filter((p) => pneuEstoqueCombinaBusca(p, q));

  if (!lista.length) {
    select.innerHTML = '<option value="">Nenhum pneu no estoque</option>';
    if (hintEl) {
      hintEl.textContent = modoAcessoRapido
        ? 'Não há pneus no estoque desta filial. Use a aba Novo pneu.'
        : 'Cadastre um pneu na aba Pneus para montar daqui.';
    }
    return;
  }
  if (!filtrada.length) {
    select.innerHTML = `<option value="">Nenhum pneu com “${escapeHtml(String(busca || '').trim())}”</option>`;
    if (hintEl) hintEl.textContent = 'Nada encontrado. Tente só os números do fogo (ex.: 5316).';
    return;
  }

  const placeholder = q
    ? `${filtrada.length} de ${lista.length} no estoque`
    : `Selecione... (${lista.length} no estoque)`;
  select.innerHTML = `<option value="">${placeholder}</option>` + filtrada.map((p) =>
    `<option value="${p.id}">${escapeHtml(rotuloPneuEstoque(p))}</option>`
  ).join('');

  if (atual && filtrada.some((p) => String(p.id) === String(atual))) {
    select.value = atual;
  } else if (q && filtrada.length === 1) {
    select.value = String(filtrada[0].id);
  }

  if (hintEl) {
    hintEl.textContent = q && filtrada.length === 1
      ? 'Um pneu encontrado — já está selecionado. Clique em Montar.'
      : 'Digite para filtrar a lista e clique no pneu.';
  }
}

function atualizarListaEstoqueMontar() {
  preencherSelectPneusEstoque(
    document.getElementById('truck-estoque-select'),
    estoqueMontarCache,
    document.getElementById('truck-estoque-busca')?.value || '',
    document.getElementById('truck-estoque-hint'),
  );
}

let estoqueBuscaSeq = 0;
async function carregarSelectEstoque({ limparBusca = true } = {}) {
  const seq = ++estoqueBuscaSeq;
  const buscaEl = document.getElementById('truck-estoque-busca');
  if (limparBusca && buscaEl && document.activeElement !== buscaEl) {
    buscaEl.value = '';
    atualizarBotaoLimpar(buscaEl);
  }
  const q = buscaEl?.value?.trim() || '';
  const select = document.getElementById('truck-estoque-select');
  try {
    if (modoAcessoRapido && tokenAcessoRapido) {
      try {
        const data = await fetchJSON(
          `${API}/acesso-rapido/estoque?token=${encodeURIComponent(tokenAcessoRapido)}&q=${encodeURIComponent(q)}`,
        );
        if (seq !== estoqueBuscaSeq) return;
        estoqueMontarCache = Array.isArray(data.estoque) ? data.estoque : [];
        estoqueFilialTotal = Number(data.total || estoqueMontarCache.length);
      } catch {
        if (seq !== estoqueBuscaSeq) return;
        estoqueMontarCache = Array.isArray(veiculoAtual?.estoque) ? veiculoAtual.estoque : [];
      }
      if (veiculoAtual) veiculoAtual.estoque = estoqueMontarCache;
    } else {
      const lista = await fetchJSON(`${API}/pneus?status=estoque${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      if (seq !== estoqueBuscaSeq) return;
      estoqueMontarCache = Array.isArray(lista) ? lista : [];
    }
    const qAtual = document.getElementById('truck-estoque-busca')?.value?.trim() || '';
    if (qAtual !== q) return;
    atualizarListaEstoqueMontar();
    const hint = document.getElementById('truck-estoque-hint');
    if (hint && modoAcessoRapido && !q && estoqueFilialTotal > estoqueMontarCache.length) {
      hint.textContent = `Mostrando ${estoqueMontarCache.length} de ${estoqueFilialTotal}. Digite o nº de fogo (ex.: 5316).`;
    }
  } catch (err) {
    if (seq !== estoqueBuscaSeq) return;
    estoqueMontarCache = [];
    if (select) select.innerHTML = `<option value="">Erro: ${escapeHtml(err.message)}</option>`;
  }
}

async function montarPneuDoEstoque() {
  if (!veiculoAtual || !slotPosicaoSelecionada) return;
  const pneuId = parseInt(document.getElementById('truck-estoque-select').value, 10);
  if (!pneuId) return toast('Selecione um pneu do estoque', 'error');

  const btn = document.getElementById('btn-truck-montar');
  if (btn) btn.disabled = true;
  try {
    if (modoAcessoRapido) {
      if (!tokenAcessoRapido) throw new Error('Token de acesso rápido ausente');
      const result = await fetchJSON(`${API}/veiculos/acesso-rapido/montar-estoque`, {
        method: 'POST',
        body: JSON.stringify({
          token: tokenAcessoRapido,
          posicao: slotPosicaoSelecionada,
          pneu_id: pneuId,
        }),
      });
      toast(result.mensagem || 'Pneu montado do estoque', 'success');
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
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function desmontarPneuTruck() {
  if (!pneuSelecionado || !veiculoAtual) return;
  await abrirModalTrocarEstoque('troca');
}

async function reposicionarPneuTruck() {
  if (!pneuSelecionado || !veiculoAtual) return;
  const posicoes = veiculoAtual.layout?.posicoes || Object.keys(meta.posicoes || {});
  const ocupadas = new Set((veiculoAtual.pneus || []).map((p) => p.posicao));
  // Permite escolher posição ocupada (troca no mesmo caminhão) ou livre
  const outras = posicoes.filter((p) => p !== pneuSelecionado.posicao);
  if (!outras.length) {
    return toast('Não há outra posição neste caminhão', 'error');
  }
  const opcoes = outras.map((p) => {
    const ocup = (veiculoAtual.pneus || []).find((x) => x.posicao === p);
    return `${p} = ${meta.posicoes?.[p] || p}${ocup ? ` (fogo ${ocup.numero_fogo} — troca)` : ' (livre)'}`;
  }).join('\n');
  const livres = outras.filter((p) => !ocupadas.has(p));
  const nova = prompt(`Nova posição (código):\n${opcoes}`, livres[0] || outras[0]);
  if (!nova) return;
  const codigo = nova.trim().toUpperCase();
  if (!posicoes.includes(codigo) && !posicoes.includes(nova.trim())) {
    return toast('Posição inválida', 'error');
  }
  const posFinal = posicoes.includes(codigo) ? codigo : nova.trim();
  try {
    if (modoAcessoRapido && tokenAcessoRapido) {
      await fetchJSON(`${API}/acesso-rapido/pneu-acao`, {
        method: 'POST',
        body: JSON.stringify({
          token: tokenAcessoRapido,
          acao: 'reposicionar',
          pneu_id: pneuSelecionado.id,
          posicao: posFinal,
        }),
      });
    } else if (ocupadas.has(posFinal)) {
      await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/mover-frota`, {
        method: 'POST',
        body: JSON.stringify({
          veiculo_id: veiculoAtual.id,
          posicao: posFinal,
        }),
      });
    } else {
      await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/reposicionar`, {
        method: 'POST',
        body: JSON.stringify({
          posicao: posFinal,
          km_veiculo: numOrNull('truck-km') ?? veiculoAtual.km_atual,
          hr_veiculo: numOrNull('truck-hr') ?? veiculoAtual.hr_atual,
        }),
      });
    }
    toast(`Posição alterada para ${meta.posicoes?.[posFinal] || posFinal}`);
    if (modoAcessoRapido) await recarregarAcessoRapido({ silent: true });
    else {
      await openVeiculoDetalhe(veiculoAtual.id, voltarPara);
      const movido = veiculoAtual.pneus.find((p) => p.id === pneuSelecionado.id);
      if (movido) {
        truckDiagram?.setAtivo(movido.id);
        selecionarPneuTruck(movido);
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

let modoModalEstoque = 'troca';

function textosModalEstoque(modo) {
  const fogo = pneuSelecionado?.numero_fogo || pneuSelecionado?.id;
  const pos = pneuSelecionado?.posicao || '';
  if (modo === 'recap') {
    return {
      titulo: 'Recapagem + substituto',
      resumo: `Envia fogo ${fogo} (${pos}) à recapagem e monta outro do estoque na mesma posição. Cancelar não altera nada.`,
      confirmar: 'Confirmar recap',
    };
  }
  if (modo === 'descarte') {
    return {
      titulo: 'Descarte + substituto',
      resumo: `Envia fogo ${fogo} (${pos}) ao descarte e monta outro do estoque na mesma posição. Cancelar não altera nada.`,
      confirmar: 'Confirmar descarte',
    };
  }
  return {
    titulo: 'Trocar pneu',
    resumo: `Retira fogo ${fogo} (${pos}) e monta outro do estoque no lugar. Cancelar não altera nada.`,
    confirmar: 'Confirmar troca',
  };
}

async function abrirModalTrocarEstoque(modo = 'troca') {
  if (!pneuSelecionado || !veiculoAtual) return;
  modoModalEstoque = modo || 'troca';
  const sel = document.getElementById('trocar-estoque-select');
  const resumo = document.getElementById('trocar-estoque-resumo');
  const tit = document.getElementById('trocar-estoque-titulo');
  const btn = document.getElementById('trocar-estoque-confirmar');
  const txt = textosModalEstoque(modoModalEstoque);
  if (tit) tit.textContent = txt.titulo;
  if (resumo) resumo.textContent = txt.resumo;
  if (btn) btn.textContent = txt.confirmar;
  try {
    let lista = [];
    if (modoAcessoRapido && tokenAcessoRapido) {
      const data = await fetchJSON(
        `${API}/acesso-rapido/estoque?token=${encodeURIComponent(tokenAcessoRapido)}&q=${encodeURIComponent(document.getElementById('trocar-estoque-busca')?.value || '')}`,
      );
      lista = data.estoque || [];
    } else {
      lista = await fetchJSON(`${API}/pneus?status=estoque`);
    }
    if (!lista.length) {
      toast('Estoque vazio — cadastre um pneu antes de trocar', 'error');
      return;
    }
    estoqueTrocaCache = lista;
    const buscaEl = document.getElementById('trocar-estoque-busca');
    if (buscaEl) buscaEl.value = '';
    preencherSelectPneusEstoque(sel, estoqueTrocaCache, '');
    document.getElementById('modal-trocar-estoque')?.showModal();
    setTimeout(() => buscaEl?.focus(), 40);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function confirmarTrocarEstoque() {
  if (!pneuSelecionado) return;
  const montarId = parseInt(document.getElementById('trocar-estoque-select')?.value, 10);
  if (!montarId) return toast('Selecione o pneu do estoque', 'error');
  const modo = modoModalEstoque || 'troca';
  try {
    let result;
    if (modo === 'recap' || modo === 'descarte') {
      if (modoAcessoRapido && tokenAcessoRapido) {
        result = await fetchJSON(`${API}/acesso-rapido/pneu-acao`, {
          method: 'POST',
          body: JSON.stringify({
            token: tokenAcessoRapido,
            acao: modo,
            pneu_id: pneuSelecionado.id,
            montar_pneu_id: montarId,
          }),
        });
      } else {
        const pontos = pontosFromInputs('truck');
        const menor = [pontos.externo, pontos.central, pontos.interno, pontos.auxiliar]
          .filter((v) => v != null);
        const sulco = menor.length ? Math.min(...menor) : pneuSelecionado.menor_sulco;
        result = await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/evento`, {
          method: 'POST',
          body: JSON.stringify({
            tipo: modo,
            km_veiculo: parseInt(document.getElementById('truck-km')?.value, 10) || veiculoAtual?.km_atual,
            hr_veiculo: numOrNull('truck-hr'),
            sulco_mm: modo === 'recap' ? (limitesAtuais.sulco_novo_mm || 14) : sulco,
            montar_pneu_id: montarId,
            detalhes: 'Registrado pelo painel do veículo',
          }),
        });
      }
    } else if (modoAcessoRapido && tokenAcessoRapido) {
      result = await fetchJSON(`${API}/acesso-rapido/pneu-acao`, {
        method: 'POST',
        body: JSON.stringify({
          token: tokenAcessoRapido,
          acao: 'troca_estoque',
          pneu_id: pneuSelecionado.id,
          montar_pneu_id: montarId,
        }),
      });
    } else {
      result = await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/trocar-estoque`, {
        method: 'POST',
        body: JSON.stringify({ montar_pneu_id: montarId }),
      });
    }
    document.getElementById('modal-trocar-estoque')?.close();
    toast(result.mensagem || (modo === 'recap' ? 'Enviado à recapagem' : modo === 'descarte' ? 'Enviado ao descarte' : 'Troca concluída'), 'success');
    if (modoAcessoRapido) await recarregarAcessoRapido({ silent: true });
    else await openVeiculoDetalhe(veiculoAtual.id, voltarPara);
  } catch (err) {
    toast(err.message, 'error');
  }
}

let moverFrotaPosicoesCache = [];

async function abrirModalMoverFrota() {
  if (!pneuSelecionado || !veiculoAtual) return;
  const selV = document.getElementById('mover-frota-veiculo');
  const resumo = document.getElementById('mover-frota-resumo');
  if (resumo) {
    resumo.textContent = `Fogo ${pneuSelecionado.numero_fogo || pneuSelecionado.id} em ${veiculoAtual.placa} (${pneuSelecionado.posicao}) → escolha destino na frota.`;
  }
  try {
    let frota = [];
    if (modoAcessoRapido && tokenAcessoRapido) {
      const data = await fetchJSON(`${API}/acesso-rapido/frota?token=${encodeURIComponent(tokenAcessoRapido)}`);
      frota = data.frota || [];
    } else {
      frota = veiculosCache.length ? veiculosCache : await fetchJSON(`${API}/veiculos`);
      veiculosCache = frota;
    }
    if (!frota.length) {
      toast('Nenhum veículo na frota', 'error');
      return;
    }
    selV.innerHTML = frota.map((v) => {
      const atual = Number(v.id) === Number(veiculoAtual.id) ? ' (atual)' : '';
      return `<option value="${v.id}">${escapeHtml(v.placa)}${v.apelido ? ` — ${escapeHtml(v.apelido)}` : ''}${atual}</option>`;
    }).join('');
    // Prefere outro veículo se existir
    const outro = frota.find((v) => Number(v.id) !== Number(veiculoAtual.id));
    if (outro) selV.value = String(outro.id);
    document.getElementById('modal-mover-frota')?.showModal();
    await carregarPosicoesMoverFrota();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function carregarPosicoesMoverFrota() {
  const veiculoId = parseInt(document.getElementById('mover-frota-veiculo')?.value, 10);
  const selP = document.getElementById('mover-frota-posicao');
  const aviso = document.getElementById('mover-frota-aviso');
  if (!veiculoId || !selP) return;
  try {
    let posicoes = [];
    if (modoAcessoRapido && tokenAcessoRapido) {
      const data = await fetchJSON(
        `${API}/acesso-rapido/veiculo-posicoes?token=${encodeURIComponent(tokenAcessoRapido)}&veiculo_id=${veiculoId}`
      );
      posicoes = data.posicoes || [];
    } else {
      const v = await fetchJSON(`${API}/veiculos/${veiculoId}`);
      const layoutPos = v.layout?.posicoes || (v.posicoes_layout || []).map((p) => p.codigo) || [];
      const porPos = Object.fromEntries((v.pneus || []).map((p) => [p.posicao, p]));
      posicoes = layoutPos.map((codigo) => ({
        codigo,
        label: meta.posicoes?.[codigo] || codigo,
        livre: !porPos[codigo],
        pneu: porPos[codigo] || null,
      }));
    }
    moverFrotaPosicoesCache = posicoes;
    selP.innerHTML = posicoes.map((p) => {
      const extra = p.livre
        ? ' — livre'
        : ` — fogo ${p.pneu?.numero_fogo || '?'} (troca)`;
      const same = Number(veiculoId) === Number(veiculoAtual?.id) && p.codigo === pneuSelecionado?.posicao;
      return `<option value="${p.codigo}" ${same ? 'disabled' : ''}>${escapeHtml(p.label || p.codigo)}${extra}</option>`;
    }).join('');
    atualizarAvisoMoverFrota();
    if (aviso && !posicoes.length) aviso.textContent = 'Este veículo não tem posições no layout.';
  } catch (err) {
    selP.innerHTML = '<option value="">Erro ao carregar</option>';
    if (aviso) aviso.textContent = err.message;
  }
}

function atualizarAvisoMoverFrota() {
  const aviso = document.getElementById('mover-frota-aviso');
  const codigo = document.getElementById('mover-frota-posicao')?.value;
  const p = moverFrotaPosicoesCache.find((x) => x.codigo === codigo);
  if (!aviso) return;
  if (!p) {
    aviso.textContent = '';
    return;
  }
  aviso.textContent = p.livre
    ? 'Posição livre — o pneu será movido para lá.'
    : `Posição ocupada pelo fogo ${p.pneu?.numero_fogo || '?'} — os dois pneus vão trocar de lugar.`;
}

async function confirmarMoverFrota() {
  if (!pneuSelecionado) return;
  const veiculoId = parseInt(document.getElementById('mover-frota-veiculo')?.value, 10);
  const posicao = document.getElementById('mover-frota-posicao')?.value;
  if (!veiculoId || !posicao) return toast('Escolha veículo e posição', 'error');
  try {
    let result;
    if (modoAcessoRapido && tokenAcessoRapido) {
      result = await fetchJSON(`${API}/acesso-rapido/pneu-acao`, {
        method: 'POST',
        body: JSON.stringify({
          token: tokenAcessoRapido,
          acao: 'mover_frota',
          pneu_id: pneuSelecionado.id,
          veiculo_destino_id: veiculoId,
          posicao,
        }),
      });
    } else {
      result = await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/mover-frota`, {
        method: 'POST',
        body: JSON.stringify({ veiculo_id: veiculoId, posicao }),
      });
    }
    document.getElementById('modal-mover-frota')?.close();
    toast(result.mensagem || 'Movimentação concluída', 'success');
    if (modoAcessoRapido) await recarregarAcessoRapido({ silent: true });
    else await openVeiculoDetalhe(veiculoAtual.id, voltarPara);
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
  const pontos = pontosFromInputs('truck');
  const status = document.getElementById('truck-save-status');
  if (pontos.externo == null || pontos.central == null || pontos.interno == null) {
    if (status) {
      status.textContent = 'Informe os 3 sulcos principais (esquerdo, centro e direito)';
      status.className = 'hint save-status';
    }
    return;
  }
  if (status) {
    status.textContent = 'Salvando...';
    status.className = 'hint save-status salvando';
  }
  autoSaveTimer = setTimeout(salvarMedicaoTruck, 700);
}

async function salvarMedicaoTruck({ concluir = false } = {}) {
  if (!pneuSelecionado || !veiculoAtual) return;

  const pneuId = pneuSelecionado.id;
  const veiculoId = veiculoAtual.id;
  const pontos = pontosFromInputs('truck');
  const pressao = numOrNull('truck-pressao');
  const km = parseInt(document.getElementById('truck-km').value, 10);
  const hr = numOrNull('truck-hr');
  const status = document.getElementById('truck-save-status');

  if (pontos.externo == null || pontos.central == null || pontos.interno == null) {
    if (status) {
      status.textContent = 'Informe os 3 sulcos principais (esquerdo, centro e direito)';
      status.className = 'hint save-status';
    }
    return;
  }

  try {
    const result = await fetchJSON(`${API}/medicoes`, {
      method: 'POST',
      body: JSON.stringify({
        pneu_id: pneuId,
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

    if (!veiculoAtual || veiculoAtual.id !== veiculoId) return;
    const idx = veiculoAtual.pneus.findIndex((p) => p.id === pneuId);
    if (idx < 0) return;

    const atualizado = {
      ...veiculoAtual.pneus[idx],
      ult_sulco_ext: pontos.externo,
      ult_sulco_cent: pontos.central,
      ult_sulco_int: pontos.interno,
      ult_sulco_aux: pontos.auxiliar,
      ult_pressao_psi: pressao,
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
        pressao_psi: result.pressao_psi ?? pressao,
        menor_sulco: result.menor_sulco,
      },
    };
    veiculoAtual.pneus[idx] = atualizado;
    truckDiagram.atualizarPneu(atualizado, meta.posicoes);

    const aindaNestePneu = pneuSelecionado?.id === pneuId;
    if (aindaNestePneu) {
      pneuSelecionado = atualizado;
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
      if (status) {
        const acaoTxt = (podeVerOrientacaoGestao() && result.acao_sugerida !== 'ok')
          ? ` · ${result.acao_label}`
          : '';
        status.textContent = result.status_sulco === 'critico'
          ? `Salvo! Crítico — ${result.menor_sulco} mm${acaoTxt}`
          : `Salvo — menor sulco: ${result.menor_sulco ?? '-'} mm${acaoTxt}`;
        status.className = `hint save-status ${result.status_sulco === 'critico' ? 'erro' : 'salvo'}`;
      }
    }

    if (modoAcessoRapido) {
      pneusMedidosSessao.add(pneuId);
      atualizarProgressoCampo();
      marcarPneusMedidosSessao();
      if (aindaNestePneu) toast(`Sulco salvo (${result.menor_sulco ?? '—'} mm)`, 'success');
    }
    if (concluir && modoAcessoRapido) {
      voltarDesenhoCampo({ toastProx: true });
    }
  } catch (err) {
    if (pneuSelecionado?.id !== pneuId) return;
    if (status) {
      status.textContent = err.message;
      status.className = 'hint save-status erro';
    }
    if (modoAcessoRapido) toast(err.message, 'error');
  }
}

async function registrarEventoPneu(tipo) {
  if (!pneuSelecionado || !veiculoAtual) return;
  const montado = pneuSelecionado.status_pneu === 'montado' || pneuSelecionado.veiculo_id;
  if (montado) {
    await abrirModalTrocarEstoque(tipo);
    return;
  }
  const label = tipo === 'recap'
    ? 'envio à recapagem (sai do caminhão e fica em processo até voltar)'
    : 'descarte (envia ao estoque de descarte para definir o tratamento)';
  if (!confirm(`Registrar ${label} deste pneu?`)) return;

  try {
    let result;
    if (modoAcessoRapido && tokenAcessoRapido) {
      result = await fetchJSON(`${API}/acesso-rapido/pneu-acao`, {
        method: 'POST',
        body: JSON.stringify({
          token: tokenAcessoRapido,
          acao: tipo === 'recap' ? 'recap' : 'descarte',
          pneu_id: pneuSelecionado.id,
        }),
      });
    } else {
      const pontos = pontosFromInputs('truck');
      const menor = [pontos.externo, pontos.central, pontos.interno, pontos.auxiliar]
        .filter((v) => v != null);
      const sulco = menor.length ? Math.min(...menor) : pneuSelecionado.menor_sulco;

      result = await fetchJSON(`${API}/pneus/${pneuSelecionado.id}/evento`, {
        method: 'POST',
        body: JSON.stringify({
          tipo,
          km_veiculo: parseInt(document.getElementById('truck-km').value, 10) || veiculoAtual.km_atual,
          hr_veiculo: numOrNull('truck-hr'),
          sulco_mm: tipo === 'recap' ? (limitesAtuais.sulco_novo_mm || 14) : sulco,
          detalhes: `Registrado pelo painel do veículo`,
        }),
      });
    }

    toast(result.mensagem || (tipo === 'recap' ? 'Enviado à recapagem' : 'Enviado ao descarte'), 'success');
    if (modoAcessoRapido) {
      await recarregarAcessoRapido({ silent: true });
      return;
    }
    await openVeiculoDetalhe(veiculoAtual.id, voltarPara);

    if (tipo === 'recap' && confirm('Abrir a lista de pneus em recapagem?')) {
      showView('pneus');
      const filtro = document.getElementById('pneus-filtro-status');
      if (filtro) filtro.value = 'recapagem';
      await loadPneus();
    }

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
document.getElementById('truck-estoque-busca')?.addEventListener('input', () => {
  atualizarListaEstoqueMontar();
  if (!(modoAcessoRapido && tokenAcessoRapido)) return;
  clearTimeout(estoqueBuscaTimer);
  estoqueBuscaTimer = setTimeout(() => carregarSelectEstoque({ limparBusca: false }), 280);
});
document.getElementById('truck-estoque-busca')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    montarPneuDoEstoque();
  }
});
document.getElementById('trocar-estoque-busca')?.addEventListener('input', () => {
  preencherSelectPneusEstoque(
    document.getElementById('trocar-estoque-select'),
    estoqueTrocaCache,
    document.getElementById('trocar-estoque-busca')?.value || '',
  );
});
document.getElementById('link-ir-pneus')?.addEventListener('click', (e) => {
  e.preventDefault();
  showView('pneus');
  loadPneus();
});

document.getElementById('btn-trocar-estoque-cancelar')?.addEventListener('click', () => {
  document.getElementById('modal-trocar-estoque')?.close();
});
document.getElementById('form-trocar-estoque')?.addEventListener('submit', (e) => {
  e.preventDefault();
  confirmarTrocarEstoque();
});
document.getElementById('btn-mover-frota-cancelar')?.addEventListener('click', () => {
  document.getElementById('modal-mover-frota')?.close();
});
document.getElementById('mover-frota-veiculo')?.addEventListener('change', () => carregarPosicoesMoverFrota());
document.getElementById('mover-frota-posicao')?.addEventListener('change', () => atualizarAvisoMoverFrota());
document.getElementById('form-mover-frota')?.addEventListener('submit', (e) => {
  e.preventDefault();
  confirmarMoverFrota();
});

// ── Aba Pneus (estoque) ─────────────────────────────────

let pneusListaSeq = 0;
async function loadPneus() {
  const seq = ++pneusListaSeq;
  const status = document.getElementById('pneus-filtro-status')?.value || 'estoque';
  const q = document.getElementById('pneus-busca')?.value?.trim() || '';
  const lista = document.getElementById('pneus-lista');
  try {
    const params = new URLSearchParams({ status });
    if (q) params.set('q', q);
    const pneus = await fetchJSON(`${API}/pneus?${params}`);
    if (seq !== pneusListaSeq) return;
    const statusAtual = document.getElementById('pneus-filtro-status')?.value || 'estoque';
    const qAtual = document.getElementById('pneus-busca')?.value?.trim() || '';
    if (statusAtual !== status || qAtual !== q || !lista) return;
    if (!pneus.length) {
      const vazioDescarte = status === 'descarte';
      const vazioRecap = status === 'recapagem';
      lista.innerHTML = `
        <div class="empty-state">
          <h3>Nenhum pneu encontrado</h3>
          <p>${vazioDescarte
            ? 'Ainda não há pneus registrados como descarte nesta filial.'
            : vazioRecap
              ? 'Nenhum pneu em processo de recapagem no momento.'
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
      const tratamentoPendente = p.status_pneu === 'descarte'
        && (!p.tratamento_descarte || p.tratamento_descarte === 'pendente');
      return `
        <article class="pneu-card card${p.status_pneu === 'descarte' ? ' pneu-card-descarte' : ''}">
          <div class="pneu-card-main">
            <h3>Fogo ${escapeHtml(p.numero_fogo || '—')}</h3>
            <p>${escapeHtml([p.marca, p.modelo].filter(Boolean).join(' ') || 'Sem modelo')}</p>
            <p class="hint">${[p.dot ? `DOT ${escapeHtml(p.dot)}` : null, p.vida_label].filter(Boolean).join(' · ')}</p>
            <p class="hint">${onde} · ${p.padrao_label || labelPadraoPneu(p.tipo_pneu)}
              ${p.menor_sulco != null ? ` · sulco ${p.menor_sulco} mm` : ' · sem medição'}
              ${p.ultima_medicao?.data ? ` · ${formatDate(p.ultima_medicao.data)}` : ''}</p>
            ${tratamento
              ? `<p class="hint"><strong>Tratamento:</strong> ${escapeHtml(tratamento)}${
                p.tratamento_descarte_obs ? ` — ${escapeHtml(p.tratamento_descarte_obs)}` : ''
              }</p>`
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
                 <button type="button" class="btn btn-ghost btn-sm" data-medir-estoque="${p.id}" data-fogo="${escapeHtml(p.numero_fogo || '')}"
                   data-sulco="${p.menor_sulco ?? p.sulco_inicial_mm ?? ''}">Medir sulco</button>`
              : ''}
            ${p.status_pneu === 'recapagem'
              ? `<button type="button" class="btn btn-primary btn-sm" data-devolver-recap="${p.id}" data-fogo="${escapeHtml(p.numero_fogo || '')}">Devolver ao estoque</button>`
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
    lista.querySelectorAll('[data-medir-estoque]').forEach((btn) => {
      btn.addEventListener('click', () => {
        abrirModalMedirEstoque({
          id: parseInt(btn.dataset.medirEstoque, 10),
          fogo: btn.dataset.fogo || '',
          sulco: btn.dataset.sulco || '',
        });
      });
    });
    lista.querySelectorAll('[data-devolver-recap]').forEach((btn) => {
      btn.addEventListener('click', () => {
        abrirModalDevolverRecap({
          id: parseInt(btn.dataset.devolverRecap, 10),
          fogo: btn.dataset.fogo || '',
        });
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
    lista.querySelectorAll('[data-edit-pneu]').forEach((btn) => {
      btn.addEventListener('click', () => abrirModalPneu(parseInt(btn.dataset.editPneu, 10)));
    });
    lista.querySelectorAll('[data-desmontar-pneu]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Desmontar e enviar ao estoque?')) return;
        try {
          await fetchJSON(`${API}/pneus/${btn.dataset.desmontarPneu}/desmontar`, {
            method: 'POST',
            body: JSON.stringify({ permitir_vazio: true, detalhes: 'Lista de pneus · desmontagem simples' }),
          });
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
    if (seq !== pneusListaSeq || !lista) return;
    lista.innerHTML = `<p class="hint erro">${err.message}</p>`;
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

function abrirModalDevolverRecap({ id, fogo }) {
  const modal = document.getElementById('modal-devolver-recap');
  if (!modal) return;
  document.getElementById('devolver-recap-pneu-id').value = String(id);
  document.getElementById('devolver-recap-label').textContent = fogo
    ? `Fogo ${fogo} — informe o sulco medido após o recap para liberar no estoque.`
    : 'Informe o sulco medido após o recap para liberar no estoque.';
  const sulcoPadrao = limitesAtuais?.sulco_novo_mm ?? 14;
  const input = document.getElementById('devolver-recap-sulco');
  input.value = String(sulcoPadrao);
  modal.showModal();
  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
}

function abrirModalMedirEstoque({ id, fogo, sulco }) {
  const modal = document.getElementById('modal-medir-estoque');
  if (!modal) return;
  document.getElementById('medir-estoque-pneu-id').value = String(id);
  document.getElementById('medir-estoque-label').textContent = fogo
    ? `Fogo ${fogo} — registre a medição atual (pode diferir do sulco cadastrado).`
    : 'Registre a medição atual do pneu em estoque.';
  const atual = sulco !== '' && sulco != null ? String(sulco) : '';
  const padrao = atual || String(limitesAtuais?.sulco_novo_mm ?? 14);
  ['medir-estoque-ext', 'medir-estoque-cent', 'medir-estoque-int', 'medir-estoque-aux'].forEach((idEl) => {
    const el = document.getElementById(idEl);
    if (el) el.value = padrao;
  });
  document.getElementById('medir-estoque-obs').value = '';
  modal.showModal();
  setTimeout(() => document.getElementById('medir-estoque-ext')?.focus(), 50);
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
      ? 'Novo ou recapado — pode corrigir na edição'
      : 'Condição fixa — use Registrar recap';
  }
}

function mostrarDestinoEstoque(mostrar) {
  const box = document.getElementById('pneu-destino-estoque');
  if (box) box.classList.toggle('hidden', !mostrar);
  const obs = document.getElementById('pneu-destino-obs');
  if (obs) obs.value = '';
}

function payloadFormPneu() {
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
    tipo_pneu: document.getElementById('pneu-tipo').value,
    condicao: document.getElementById('pneu-condicao').value,
  };
  return payload;
}

async function abrirModalPneuNovo() {
  document.getElementById('modal-pneu-titulo').textContent = 'Novo pneu no estoque';
  document.getElementById('pneu-edit-id').value = '';
  document.getElementById('pneu-edit-status').value = '';
  document.getElementById('form-pneu').reset();
  document.getElementById('pneu-tipo').value = 'misto';
  document.getElementById('pneu-condicao').value = 'novo';
  document.getElementById('pneu-vida').value = '0';
  const avancado = document.getElementById('pneu-avancado');
  if (avancado) avancado.open = false;
  setTipoCondicaoEditaveis(true);
  mostrarDestinoEstoque(false);
  mostrarBotaoGerarFogo(true);
  const hintFogo = document.getElementById('pneu-fogo-hint');
  if (hintFogo) {
    hintFogo.textContent = 'Clique para analisar o código da unidade e a última marca cadastrada (ex.: 0110-0001).';
  }
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
    document.getElementById('pneu-edit-status').value = p.status_pneu || '';
    const avancado = document.getElementById('pneu-avancado');
    if (avancado) avancado.open = !!p.dot;
    setTipoCondicaoEditaveis(true);
    mostrarDestinoEstoque(p.status_pneu === 'estoque');
    mostrarBotaoGerarFogo(false);
    const hintFogo = document.getElementById('pneu-fogo-hint');
    if (hintFogo) hintFogo.textContent = 'Identificação única do pneu nesta unidade.';
    document.getElementById('modal-pneu').showModal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('btn-novo-pneu')?.addEventListener('click', abrirModalPneuNovo);
document.getElementById('btn-gerar-fogo')?.addEventListener('click', (e) => {
  gerarMarcaFogoNoCampo('pneu-fogo', 'pneu-fogo-hint', e.currentTarget);
});
document.getElementById('btn-truck-gerar-fogo')?.addEventListener('click', (e) => {
  gerarMarcaFogoNoCampo('truck-novo-fogo', 'truck-novo-fogo-hint', e.currentTarget);
});
document.getElementById('btn-ar-gerar-fogo')?.addEventListener('click', (e) => {
  const token = e.currentTarget.dataset.tokenAcesso || '';
  if (!token) {
    toast('Link inválido — token ausente.', 'error');
    return;
  }
  gerarMarcaFogoNoCampo('ar-p-fogo', 'ar-p-fogo-hint', e.currentTarget, token);
});
document.getElementById('btn-cancelar-pneu')?.addEventListener('click', () => {
  document.getElementById('modal-pneu').close();
});
document.getElementById('pneus-filtro-status')?.addEventListener('change', () => {
  const hint = document.getElementById('pneus-filtro-hint');
  const status = document.getElementById('pneus-filtro-status')?.value;
  if (hint) {
    hint.classList.toggle('hidden', status !== 'recapagem');
  }
  loadPneus();
});
// hint só na aba recapagem
document.getElementById('pneus-filtro-hint')?.classList.add('hidden');
let pneusBuscaTimer;
document.getElementById('pneus-busca')?.addEventListener('input', () => {
  clearTimeout(pneusBuscaTimer);
  pneusBuscaTimer = setTimeout(loadPneus, 300);
});

async function enviarPneuEstoqueDestino(tipo) {
  const id = document.getElementById('pneu-edit-id').value;
  const status = document.getElementById('pneu-edit-status')?.value;
  const fogo = (document.getElementById('pneu-fogo')?.value || '').trim();
  if (!id) return toast('Salve o pneu primeiro para enviar à recap ou ao descarte', 'error');
  if (status !== 'estoque') {
    return toast('Só pneus em estoque podem ir para recap ou descarte por aqui', 'error');
  }
  const ehRecap = tipo === 'recap';
  const label = ehRecap
    ? 'à recapagem (sai do estoque e fica em processo até voltar)'
    : 'ao descarte (depois você define o tratamento: reciclagem, sucata…)';
  if (!confirm(`Enviar o pneu${fogo ? ` fogo ${fogo}` : ''} ${label}?`)) return;

  const payload = payloadFormPneu();
  if (!payload.modelo?.trim()) return toast('Informe o modelo do pneu', 'error');
  const obs = document.getElementById('pneu-destino-obs')?.value?.trim() || '';

  const btnRecap = document.getElementById('btn-pneu-enviar-recap');
  const btnDesc = document.getElementById('btn-pneu-enviar-descarte');
  if (btnRecap) btnRecap.disabled = true;
  if (btnDesc) btnDesc.disabled = true;

  try {
    await fetchJSON(`${API}/pneus/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    const result = await fetchJSON(`${API}/pneus/${id}/evento`, {
      method: 'POST',
      body: JSON.stringify({
        tipo,
        detalhes: obs
          ? `Estoque · ${obs}`
          : (ehRecap ? 'Enviado à recap a partir do estoque' : 'Enviado ao descarte a partir do estoque'),
      }),
    });
    document.getElementById('modal-pneu')?.close();
    toast(result.mensagem || (ehRecap ? 'Enviado à recapagem' : 'Enviado ao descarte'), 'success');
    const filtro = document.getElementById('pneus-filtro-status');
    if (filtro) filtro.value = ehRecap ? 'recapagem' : 'descarte';
    const hint = document.getElementById('pneus-filtro-hint');
    if (hint) hint.classList.toggle('hidden', filtro?.value !== 'recapagem');
    await loadPneus();
    if (!ehRecap) {
      abrirModalTratamentoDescarte({
        id: parseInt(id, 10),
        fogo,
        tratamento: 'pendente',
        obs,
      });
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btnRecap) btnRecap.disabled = false;
    if (btnDesc) btnDesc.disabled = false;
  }
}

document.getElementById('btn-pneu-enviar-recap')?.addEventListener('click', () => {
  enviarPneuEstoqueDestino('recap');
});
document.getElementById('btn-pneu-enviar-descarte')?.addEventListener('click', () => {
  enviarPneuEstoqueDestino('descarte');
});

document.getElementById('form-pneu')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (form.dataset.salvando === '1') return;
  const id = document.getElementById('pneu-edit-id').value;
  const payload = payloadFormPneu();
  if (!payload.modelo?.trim()) {
    mostrarErroCadastro('form-pneu-erro', 'Informe o modelo do pneu');
    document.getElementById('pneu-modelo')?.focus();
    return toast('Informe o modelo do pneu', 'error');
  }
  mostrarErroCadastro('form-pneu-erro', '');
  form.dataset.salvando = '1';
  travarSubmit(form, true);
  try {
    if (id) {
      const result = await fetchJSON(`${API}/pneus/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      fecharDialog('modal-pneu');
      toast(result.mensagem || 'Pneu atualizado', 'success');
      loadPneus();
    } else {
      const result = await fetchJSON(`${API}/pneus`, { method: 'POST', body: JSON.stringify(payload) });
      const pneuId = result.pneu?.id;
      if (!pneuId) {
        throw new Error('O servidor não confirmou o pneu. Confira o estoque antes de cadastrar de novo.');
      }
      fecharDialog('modal-pneu');
      const filtro = document.getElementById('pneus-filtro-status');
      if (filtro) filtro.value = 'estoque';
      toast(result.mensagem || 'Pneu cadastrado no estoque', 'success');
      try {
        await loadPneus();
      } catch (err) {
        toast(`Pneu salvo. A lista não atualizou: ${err.message}`, 'error');
      }
      abrirModalPneuPosCriar(pneuId, result.pneu?.numero_fogo || payload.numero_fogo);
    }
  } catch (err) {
    if (!id && err.status === 409) {
      toast(err.message, 'error');
      if (err.data?.id) {
        fecharDialog('modal-pneu');
        loadPneus();
      }
      return;
    }
    toast(err.message, 'error');
  } finally {
    form.dataset.salvando = '0';
    travarSubmit(form, false);
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

document.getElementById('btn-cancelar-devolver-recap')?.addEventListener('click', () => {
  document.getElementById('modal-devolver-recap')?.close();
});

document.getElementById('form-devolver-recap')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pneuId = parseInt(document.getElementById('devolver-recap-pneu-id').value, 10);
  const sulco = parseFloat(document.getElementById('devolver-recap-sulco').value);
  if (!pneuId) return toast('Pneu inválido', 'error');
  if (!Number.isFinite(sulco) || sulco <= 0) {
    return toast('Informe o sulco após o recap (mm)', 'error');
  }
  try {
    const result = await fetchJSON(`${API}/pneus/${pneuId}/evento`, {
      method: 'POST',
      body: JSON.stringify({
        tipo: 'retorno_recap',
        sulco_mm: sulco,
        detalhes: `Recap concluído · sulco ${sulco} mm · voltou ao estoque`,
      }),
    });
    document.getElementById('modal-devolver-recap')?.close();
    toast(result.mensagem || `Pneu no estoque com sulco ${sulco} mm`, 'success');
    const filtro = document.getElementById('pneus-filtro-status');
    if (filtro) filtro.value = 'estoque';
    loadPneus();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('btn-cancelar-medir-estoque')?.addEventListener('click', () => {
  document.getElementById('modal-medir-estoque')?.close();
});

// Replica o externo nos outros pontos vazios (medição rápida em estoque)
document.getElementById('medir-estoque-ext')?.addEventListener('change', () => {
  const v = document.getElementById('medir-estoque-ext')?.value;
  if (v === '' || v == null) return;
  ['medir-estoque-cent', 'medir-estoque-int', 'medir-estoque-aux'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && (el.value === '' || el.value == null)) el.value = v;
  });
});

document.getElementById('form-medir-estoque')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pneuId = parseInt(document.getElementById('medir-estoque-pneu-id').value, 10);
  const num = (id) => {
    const v = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(v) ? v : null;
  };
  let ext = num('medir-estoque-ext');
  let cent = num('medir-estoque-cent');
  let int_ = num('medir-estoque-int');
  let aux = num('medir-estoque-aux');
  if (ext != null) {
    if (cent == null) cent = ext;
    if (int_ == null) int_ = ext;
    if (aux == null) aux = ext;
  }
  if (ext == null && cent == null && int_ == null && aux == null) {
    return toast('Informe ao menos um sulco', 'error');
  }
  try {
    const result = await fetchJSON(`${API}/medicoes`, {
      method: 'POST',
      body: JSON.stringify({
        pneu_id: pneuId,
        sulco_externo: ext,
        sulco_central: cent,
        sulco_interno: int_,
        sulco_auxiliar: aux,
        observacoes: document.getElementById('medir-estoque-obs')?.value?.trim() || 'Medição em estoque',
        responsavel: 'estoque',
      }),
    });
    document.getElementById('modal-medir-estoque')?.close();
    const menor = result.menor_sulco ?? result.medicao?.menor_sulco;
    toast(menor != null ? `Sulco atualizado: ${menor} mm` : 'Medição salva', 'success');
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
        <h4 style="margin-top:1rem">Movimentações (colocar / retirar / mudar posição)</h4>
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
  const permitidos = tipoDoCatalogo(tipo)?.layouts_permitidos;
  return permitidos?.length ? permitidos : null;
}

function preencherSelectLayouts(selectId, selectedId, { soTruckToco = false, tipo = null } = {}) {
  const sel = document.getElementById(selectId);
  if (!sel || !meta.layouts) return;
  let lista = meta.layouts;
  if (soTruckToco) {
    const ids = layoutsParaTipo(tipo || document.getElementById('v-tipo')?.value || '');
    if (ids) lista = meta.layouts.filter((l) => ids.includes(l.id) || l.id === selectedId);
    if (!lista.length) lista = meta.layouts;
  }
  if (selectedId && !lista.some((l) => l.id === selectedId)) {
    const extra = meta.layouts.find((l) => l.id === selectedId);
    lista = [extra || { id: selectedId, nome: selectedId }, ...lista];
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
      layoutId: layout.id,
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

async function carregarMetaVeiculos() {
  if (!(meta.layouts?.length && meta.posicoes && Object.keys(meta.posicoes).length && meta.tipos_equipamento?.length)) {
    const metaData = await fetchJSON(`${API}/veiculos/meta`);
    meta = { ...meta, ...metaData };
  }
  preencherSelectsTipo();
  return meta;
}

function aplicarTipoVeiculo(codigo, { layoutSalvo = null } = {}) {
  const input = document.getElementById('v-tipo');
  if (input) input.value = codigo;
  marcarBotaoTipo(document.getElementById('v-tipo-opcoes'), codigo);
  aplicarVisibilidadeUnidade(codigo, 'v-campo-km', 'v-campo-hr');
  preencherSelectLayouts('v-layout', layoutSalvo || layoutSugeridoPorTipo(codigo), {
    soTruckToco: true,
    tipo: codigo,
  });
}

async function abrirConfigLayout(veiculoId, veiculoNome, layoutAtual, posicoesAtuais) {
  try {
    await carregarMetaVeiculos();
  } catch (err) {
    toast(err.message || 'Não foi possível carregar os layouts', 'error');
    return;
  }
  veiculoLayoutId = veiculoId;
  const nomeEl = document.getElementById('layout-veiculo-nome');
  const modal = document.getElementById('modal-layout');
  if (!modal) {
    toast('Tela de layout não encontrada — recarregue a página', 'error');
    return;
  }
  if (nomeEl) nomeEl.textContent = veiculoNome;
  preencherSelectLayouts('layout-select', layoutAtual || meta.layout_padrao);
  preencherCheckboxesPosicoes('layout-custom-checkboxes', posicoesAtuais || []);
  modal.showModal();
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
    <strong>${escapeHtml(result.mensagem || 'Importação concluída')}</strong>
    <p class="hint" style="margin:.35rem 0 0">
      ${result.veiculos != null ? `Veículos: <strong>${escapeHtml(result.veiculos)}</strong> · ` : ''}
      ${result.pneus_montados != null ? `Montados: <strong>${escapeHtml(result.pneus_montados)}</strong> · ` : ''}
      ${result.pneus_estoque != null ? `Estoque: <strong>${escapeHtml(result.pneus_estoque)}</strong> · ` : ''}
      ${result.inseridos != null ? `Inseridos: <strong>${escapeHtml(result.inseridos)}</strong>` : ''}
      ${erros.length ? ` · Erros: <strong>${erros.length}</strong>` : ''}
      ${avisos.length ? ` · Avisos: <strong>${avisos.length}</strong>` : ''}
    </p>
    ${erros.length
      ? `<ul class="import-erros">${erros.slice(0, 12).map((e) =>
          `<li>Linha ${escapeHtml(e.linha)}${e.placa || e.numero_fogo ? ` (${escapeHtml(e.placa || e.numero_fogo)})` : ''}: ${escapeHtml(e.erro)}</li>`
        ).join('')}${erros.length > 12 ? `<li>… e mais ${erros.length - 12}</li>` : ''}</ul>`
      : ''}
    ${avisos.length
      ? `<ul class="import-avisos">${avisos.slice(0, 8).map((a) =>
          `<li>Linha ${escapeHtml(a.linha)}${a.numero_fogo ? ` (${escapeHtml(a.numero_fogo)})` : ''}: ${escapeHtml(a.aviso)}</li>`
        ).join('')}</ul>`
      : ''}
  `;
}

async function importarCsvArquivo(file, endpoint, resultadoId, onOk) {
  if (!file) return;
  const nome = String(file.name || '').toLowerCase();
  if (/\.xlsx?$/.test(nome) || file.type.includes('spreadsheet') || file.type.includes('excel')) {
    toast('Envie o modelo em CSV (no Excel: Salvar como → CSV). Arquivo .xlsx não preenche o nº de fogo.', 'error');
    return;
  }
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
    loadPneus();
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

function mostrarErroCadastro(id, msg) {
  const box = document.getElementById(id);
  if (!box) return;
  box.textContent = msg || '';
  box.classList.toggle('hidden', !msg);
}

function setCampoObrigatorio(id, obrigatorio) {
  const input = document.getElementById(id);
  if (input) input.required = obrigatorio;
  document.querySelector(`label[for="${id}"] .req`)?.classList.toggle('hidden', !obrigatorio);
}

function ligarErroCadastro(form, erroId) {
  form?.addEventListener('invalid', (e) => {
    form.classList.add('cad-validou');
    mostrarErroCadastro(erroId, e.target.validationMessage || 'Preencha os campos obrigatórios.');
    e.target.closest('.cad-secao')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, true);
}

function ligarNavegacaoCadastro(form) {
  if (!form || form.dataset.cadNav === '1') return;
  const secoes = [...form.querySelectorAll(':scope > .cad-secao, :scope > section.cad-secao')];
  const lista = secoes.length ? secoes : [...form.querySelectorAll('.cad-secao')];
  const nav = form.querySelector('.cad-nav');
  const btnVoltar = form.querySelector('[data-cad-voltar]');
  const btnContinuar = form.querySelector('[data-cad-continuar]');
  if (lista.length < 2 || !nav) return;
  form.dataset.cadNav = '1';
  let idx = 0;
  nav.innerHTML = lista.map((secao, i) => {
    const titulo = (secao.querySelector('h4')?.innerText || `Seção ${i + 1}`).replace(/^\d+\s*/, '').trim();
    return `<button type="button" data-cad-idx="${i}">${i + 1}. ${titulo}</button>`;
  }).join('');
  const pintar = () => {
    lista.forEach((secao, i) => secao.classList.toggle('is-foco', i === idx));
    nav.querySelectorAll('button').forEach((botao, i) => {
      botao.classList.toggle('is-ativo', i === idx);
      if (i === idx) botao.setAttribute('aria-current', 'step');
      else botao.removeAttribute('aria-current');
    });
    if (btnVoltar) btnVoltar.disabled = idx === 0;
    if (btnContinuar) btnContinuar.classList.toggle('hidden', idx === lista.length - 1);
  };
  const ir = (n) => {
    idx = Math.max(0, Math.min(lista.length - 1, n));
    pintar();
    lista[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  nav.addEventListener('click', (e) => {
    const botao = e.target.closest('[data-cad-idx]');
    if (!botao || !nav.contains(botao)) return;
    ir(Number(botao.dataset.cadIdx));
  });
  btnVoltar?.addEventListener('click', () => ir(idx - 1));
  btnContinuar?.addEventListener('click', () => {
    const campos = [...lista[idx].querySelectorAll('input, select, textarea')];
    for (const campo of campos) {
      if (campo.disabled || campo.type === 'hidden') continue;
      if (!campo.checkValidity()) {
        form.classList.add('cad-validou');
        campo.reportValidity();
        return;
      }
    }
    ir(idx + 1);
  });
  pintar();
  form.cadIrEtapa = ir;
}

// ── Modal Veículo ──────────────────────────────────────

const modalVeiculo = document.getElementById('modal-veiculo');
let concluirVeiculoId = null;
let concluirOrigem = 'dashboard';

function restaurarModalVeiculoNovo() {
  concluirVeiculoId = null;
  const form = document.getElementById('form-veiculo');
  form?.reset();
  const placa = document.getElementById('v-placa');
  if (placa) placa.readOnly = false;
  const marca = document.getElementById('v-marca');
  const modelo = document.getElementById('v-modelo');
  if (marca) marca.required = false;
  if (modelo) modelo.required = false;
  const titulo = document.getElementById('modal-veiculo-titulo');
  if (titulo) titulo.textContent = 'Novo Veículo';
  const hint = document.getElementById('form-veiculo-hint');
  if (hint) hint.textContent = 'Informe a placa e a configuração dos eixos. Depois você coloca os pneus no diagrama.';
  setCampoObrigatorio('v-marca', false);
  setCampoObrigatorio('v-modelo', false);
  mostrarErroCadastro('form-veiculo-erro', '');
  form?.classList.remove('cad-validou');
  form?.cadIrEtapa?.(0);
  const submit = form?.querySelector('button[type="submit"]');
  if (submit) submit.textContent = 'Salvar';
}

async function abrirConcluirCadastro(id, origem = 'dashboard') {
  if (!podeConcluirCadastro()) {
    toast('Só o operador da unidade conclui este cadastro', 'error');
    return;
  }
  try {
    await carregarMetaVeiculos();
    const v = await fetchJSON(`${API}/veiculos/${id}`);
    if (!ehCadastroPendente(v)) {
      openVeiculoDetalhe(id, origem === 'filiais' ? 'filiais' : origem);
      return;
    }
    restaurarModalVeiculoNovo();
    concluirVeiculoId = v.id;
    concluirOrigem = origem;
    const titulo = document.getElementById('modal-veiculo-titulo');
    if (titulo) titulo.textContent = 'Concluir cadastro';
    const hint = document.getElementById('form-veiculo-hint');
    if (hint) hint.textContent = 'Informe fabricante, modelo e a configuração dos eixos para liberar o caminhão.';
    const placa = document.getElementById('v-placa');
    if (placa) {
      placa.value = v.placa || '';
      placa.readOnly = true;
    }
    const apelido = document.getElementById('v-apelido');
    if (apelido) apelido.value = v.apelido || '';
    const codigo = codigoTipo(normalizarTipoLabel(v.tipo) || v.tipo);
    renderBotoesTipo('v-tipo-opcoes', codigo, (c) => aplicarTipoVeiculo(c));
    aplicarTipoVeiculo(codigo, { layoutSalvo: v.layout_pneus || null });
    const marca = document.getElementById('v-marca');
    const modelo = document.getElementById('v-modelo');
    setCampoObrigatorio('v-marca', true);
    setCampoObrigatorio('v-modelo', true);
    if (marca) marca.value = v.marca || '';
    if (modelo) modelo.value = (/^pendente$/i.test(v.modelo || '') ? '' : (v.modelo || ''));
    const km = document.getElementById('v-km');
    if (km) km.value = v.km_atual ?? 0;
    const submit = document.querySelector('#form-veiculo button[type="submit"]');
    if (submit) submit.textContent = 'Salvar';
    modalVeiculo.showModal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('btn-novo-veiculo').addEventListener('click', async () => {
  restaurarModalVeiculoNovo();
  try {
    await carregarMetaVeiculos();
  } catch (err) {
    toast(err.message || 'Não foi possível carregar os tipos', 'error');
    return;
  }
  const inicial = codigoTipo('truck_tracao') || (meta.tipos_equipamento?.[0]?.codigo || '');
  renderBotoesTipo('v-tipo-opcoes', inicial, (c) => aplicarTipoVeiculo(c));
  aplicarTipoVeiculo(inicial);
  const selDiaV = document.getElementById('v-dia-medicao');
  if (selDiaV) {
    selDiaV.innerHTML = optionsDiaSemana(diaMedicaoUnidade, { incluirVazio: true, vazioLabel: '— Usar dia da frota —' });
  }
  modalVeiculo.showModal();
});

document.getElementById('v-layout')?.addEventListener('change', () => {
  onLayoutSelectChange('v-layout', 'v-layout-desc', 'v-layout-preview', 'v-layout-diagram');
});
document.getElementById('ar-v-layout')?.addEventListener('change', () => {
  onLayoutSelectChange('ar-v-layout', 'ar-v-layout-desc', 'ar-v-layout-preview', 'ar-v-layout-diagram');
});
ligarErroCadastro(document.getElementById('form-veiculo'), 'form-veiculo-erro');
ligarErroCadastro(document.getElementById('form-pneu'), 'form-pneu-erro');
ligarErroCadastro(document.getElementById('form-ar-veiculo'), 'ar-veiculo-erro');
ligarErroCadastro(document.getElementById('form-ar-pneu'), 'ar-pneu-erro');
['form-veiculo', 'form-pneu', 'form-ar-veiculo', 'form-ar-pneu'].forEach((id) => {
  ligarNavegacaoCadastro(document.getElementById(id));
});

document.getElementById('layout-select')?.addEventListener('change', () => {
  const layout = getLayoutById(document.getElementById('layout-select').value);
  onLayoutSelectChange('layout-select', 'layout-select-desc', 'layout-posicoes-preview');
  if (layout) preencherCheckboxesPosicoes('layout-custom-checkboxes', layout.posicoes);
});

document.getElementById('btn-cancelar-veiculo').addEventListener('click', () => {
  restaurarModalVeiculoNovo();
  modalVeiculo.close();
});

document.getElementById('form-veiculo').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (form.dataset.salvando === '1') return;
  form.dataset.salvando = '1';
  travarSubmit(form, true);
  try {
    if (concluirVeiculoId) {
      const id = concluirVeiculoId;
      const origem = concluirOrigem;
      const result = await fetchJSON(`${API}/veiculos/${id}/concluir`, {
        method: 'POST',
        body: JSON.stringify({
          apelido: document.getElementById('v-apelido').value,
          tipo: document.getElementById('v-tipo').value,
          marca: document.getElementById('v-marca').value,
          modelo: document.getElementById('v-modelo').value,
          ano: parseInt(document.getElementById('v-ano').value, 10) || null,
          km_atual: parseInt(document.getElementById('v-km').value, 10) || 0,
          layout_pneus: document.getElementById('v-layout').value,
        }),
      });
      if (!result?.veiculo_id && !result?.mensagem) {
        throw new Error('O servidor não confirmou a conclusão. Confira o veículo antes de tentar de novo.');
      }
      fecharDialog(modalVeiculo);
      restaurarModalVeiculoNovo();
      toast(result.mensagem || 'Cadastro concluído', 'success');
      if (origem === 'veiculos') loadVeiculos();
      else loadDashboard();
      try {
        await openVeiculoDetalhe(id, origem === 'veiculos' ? 'veiculos' : 'dashboard', null, { silencioso: true });
      } catch (err) {
        toast(`Cadastro concluído. Não abriu o diagrama: ${err.message}`, 'error');
      }
      return;
    }

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
    if (!result?.id) {
      throw new Error('O servidor não confirmou o veículo. Confira a lista antes de cadastrar de novo.');
    }
    fecharDialog(modalVeiculo);
    toast(result.mensagem || 'Veículo cadastrado', 'success');
    try {
      await openVeiculoDetalhe(result.id, 'veiculos', null, { silencioso: true });
    } catch (err) {
      toast(`Veículo salvo. Não abriu o diagrama: ${err.message}`, 'error');
    }
  } catch (err) {
    if (err.status === 409 && err.data?.id) {
      fecharDialog(modalVeiculo);
      toast(err.message, 'error');
      openVeiculoDetalhe(err.data.id, 'veiculos');
      return;
    }
    toast(err.message, 'error');
  } finally {
    form.dataset.salvando = '0';
    travarSubmit(form, false);
  }
});

document.getElementById('btn-cancelar-layout')?.addEventListener('click', () => {
  document.getElementById('modal-layout').close();
});

document.getElementById('form-layout')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (!veiculoLayoutId || form.dataset.salvando === '1') return;

  const custom = [...document.querySelectorAll('input[name="posicao-custom"]:checked')].map((c) => c.value);
  const layoutId = document.getElementById('layout-select').value;
  const layout = getLayoutById(layoutId);
  const posicoesLayout = layout?.posicoes || [];
  const iguais = custom.length === posicoesLayout.length && custom.every((p) => posicoesLayout.includes(p));

  const payload = iguais
    ? { layout_pneus: layoutId }
    : { layout_pneus: 'personalizado', posicoes_custom: custom };

  if (!custom.length) return toast('Selecione ao menos uma posição de pneu', 'error');

  form.dataset.salvando = '1';
  try {
    const result = await fetchJSON(`${API}/veiculos/${veiculoLayoutId}/layout`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    document.getElementById('modal-layout').close();
    toast(result.mensagem, 'success');
    const naInspecao = inspecaoFilialIdAberto
      && Number(inspecaoVeiculoIdAberto) === Number(veiculoLayoutId);
    if (naInspecao) {
      await recarregarInspecaoVeiculoFilial(inspecaoFilialIdAberto, veiculoLayoutId);
    } else if (Number(veiculoAtual?.id) === Number(veiculoLayoutId)) {
      await openVeiculoDetalhe(veiculoLayoutId, voltarPara);
      if (!isGestao()) loadVeiculos();
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    form.dataset.salvando = '0';
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

let medPneusCache = [];

document.getElementById('med-veiculo').addEventListener('change', async (e) => {
  const veiculoId = e.target.value;
  const selectPneu = document.getElementById('med-pneu');

  if (!veiculoId) {
    medPneusCache = [];
    selectPneu.innerHTML = '<option value="">Selecione o veículo primeiro</option>';
    selectPneu.disabled = true;
    return;
  }

  try {
    const v = await fetchJSON(`${API}/veiculos/${veiculoId}`);
    medPneusCache = v.pneus || [];
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
    document.getElementById('med-pneu')?.dispatchEvent(new Event('change'));
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('med-pneu')?.addEventListener('change', () => {
  const id = document.getElementById('med-pneu')?.value;
  const pneu = medPneusCache.find((p) => String(p.id) === String(id));
  const campo = document.getElementById('med-pressao');
  if (campo) campo.value = pressaoSalvaDoPneu(pneu);
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

    const salvo = medPneusCache.find((p) => String(p.id) === String(pneuId));
    const pressaoSalva = result.pressao_psi ?? payload.pressao_psi;
    if (salvo) {
      salvo.ult_pressao_psi = pressaoSalva;
      salvo.ultima_medicao = {
        ...(salvo.ultima_medicao || {}),
        pressao_psi: pressaoSalva,
        sulco_externo: payload.sulco_externo,
        sulco_central: payload.sulco_central,
        sulco_interno: payload.sulco_interno,
        sulco_auxiliar: payload.sulco_auxiliar,
      };
    }

    ['med-externo', 'med-central', 'med-interno', 'med-auxiliar', 'med-obs']
      .forEach((id) => { document.getElementById(id).value = ''; });
    const campoPressao = document.getElementById('med-pressao');
    if (campoPressao) campoPressao.value = pressaoSalva ?? '';
    tireMarker?.reset();
    document.getElementById('med-perfil').innerHTML = '';
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Alertas ────────────────────────────────────────────

async function loadAlertas() {
  try {
    const [alertas, config] = await Promise.all([
      fetchJSON(`${API}/medicoes/alertas`),
      fetchConfiguracoes(),
    ]);
    limitesAtuais = { ...limitesAtuais, ...config };

    const hint = document.getElementById('alertas-limites-hint');
    if (hint) hint.textContent = hintLimites();

    const lista = document.getElementById('alertas-lista');

    if (!alertas.length) {
      lista.innerHTML = '<div class="empty-state"><h3>Nenhum alerta</h3><p>Todos os pneus estão dentro do limite</p></div>';
      return;
    }

    lista.innerHTML = alertas.map((a) => `
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
    const tr = config.trator || {};
    const elTc = document.getElementById('cfg-trator-critico');
    const elTa = document.getElementById('cfg-trator-alerta');
    const elTn = document.getElementById('cfg-trator-novo');
    if (elTc) elTc.value = tr.sulco_critico_mm ?? 10;
    if (elTa) elTa.value = tr.sulco_alerta_mm ?? 15;
    if (elTn) elTn.value = tr.sulco_novo_mm ?? 25;
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

  const tc = parseFloat(document.getElementById('cfg-trator-critico')?.value);
  const ta = parseFloat(document.getElementById('cfg-trator-alerta')?.value);
  const tn = parseFloat(document.getElementById('cfg-trator-novo')?.value);
  if (Number.isFinite(tc) && Number.isFinite(ta) && Number.isFinite(tn)) {
    payload.trator = {
      sulco_critico_mm: tc,
      sulco_alerta_mm: ta,
      sulco_novo_mm: tn,
    };
  }

  if (!Number.isFinite(payload.sulco_critico_mm) || !Number.isFinite(payload.sulco_alerta_mm)) {
    return toast('Informe valores válidos em mm', 'error');
  }

  try {
    const result = await fetchJSON(`${API}/configuracoes`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    configuracoesEmSessao = null;
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
let waStatusWatchTimer = null;

function stopWaQrPoll() {
  if (waPollTimer) {
    clearInterval(waPollTimer);
    waPollTimer = null;
  }
}

function stopWaPoll() {
  stopWaQrPoll();
  if (waStatusWatchTimer) {
    clearInterval(waStatusWatchTimer);
    waStatusWatchTimer = null;
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

function qrPainelAberto() {
  const wrap = document.getElementById('fc-qr-wrap') || document.getElementById('wa-qr-wrap');
  return Boolean(wrap && !wrap.classList.contains('hidden'));
}

function qrImagemVisivel() {
  const img = document.getElementById('fc-qr-img') || document.getElementById('wa-qr-img');
  return Boolean(img && !img.classList.contains('hidden') && img.getAttribute('src'));
}

function estadoDaRespostaWa(st = {}) {
  if (st.estado) return st.estado;
  if (st.loggedIn && !st.sessao_alheia && !st.token_compartilhado) return 'conectado';
  if (st.sessao_alheia || st.token_compartilhado) return 'precisa_qr';
  if (st.infra_wuzapi) return 'servidor_indisponivel';
  if (st.configurado === false) return 'precisa_token';
  if (st.qrcode || (st.connected && !st.loggedIn)) return 'aguardando_qr';
  return 'offline';
}

function abrirPainelQr(mensagem, nomeFilial) {
  const { wrap, img, titulo, status } = painelQrEls();
  if (titulo) titulo.textContent = `Escaneie com o celular do chatbot${nomeFilial ? ` (${nomeFilial})` : ''}`;
  if (status) {
    status.textContent = mensagem || 'Gerando QR Code…';
    status.classList.remove('login-erro', 'hidden');
  }
  img?.classList.add('hidden');
  wrap?.classList.remove('hidden');
  document.getElementById('btn-fc-qr-gerar')?.classList.remove('hidden');
  wrap?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function mostrarQrFilial(data, nomeFilial) {
  const { wrap, img, titulo, status } = painelQrEls();
  if (titulo) titulo.textContent = `Escaneie com o celular do chatbot${nomeFilial ? ` (${nomeFilial})` : ''}`;

  if (data?.loggedIn && !data?.qrcode) {
    wrap?.classList.add('hidden');
    stopWaQrPoll();
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
    document.getElementById('btn-fc-qr-gerar')?.classList.remove('hidden');
    wrap?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  if (qrImagemVisivel() && /401|unauthor/i.test(String(data?.qr_erro || data?.mensagem || ''))) {
    return;
  }

  if (data?.qr_erro && status) {
    wrap?.classList.remove('hidden');
    if (!qrImagemVisivel()) img?.classList.add('hidden');
    status.textContent = data.qr_erro;
    status.classList.toggle('login-erro', Boolean(data.infra_wuzapi) && !/Gerar QR/i.test(data.qr_erro || ''));
  }
}

function startWaPollFilial(filialId, nome) {
  stopWaQrPoll();
  waPollFilialId = filialId;
  let pollEmAndamento = false;
  const tick = async () => {
    if (pollEmAndamento) return;
    pollEmAndamento = true;
    try {
      if (Number(waPollFilialId) !== Number(filialId)) return;
      const comQr = qrImagemVisivel() ? '' : '?qr=1';
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/status${comQr}`);
      if (data.filial_id != null && Number(data.filial_id) !== Number(filialId)) return;
      if (data.token_compartilhado || data.sessao_alheia) {
        if (data.qrcode || data.qr_erro) mostrarQrFilial(data, nome);
        return;
      }
      if (data.qrcode) {
        mostrarQrFilial(data, nome);
      }
      if (data.loggedIn) {
        const chipTela = String(document.getElementById('fc-whatsapp')?.value || '').replace(/\D/g, '');
        const phoneResp = String(data.phone || '').replace(/\D/g, '');
        const resetando = Boolean(sessionStorage.getItem(`wa_forcar_qr_${filialId}`));
        if (resetando && !qrImagemVisivel()) return;
        if (qrPainelAberto() && !qrImagemVisivel() && chipTela.length < 10 && phoneResp.length < 10) {
          return;
        }
        sessionStorage.removeItem(`wa_forcar_qr_${filialId}`);
        toast(`Chatbot ${nome} conectado!`, 'success');
        document.getElementById('fc-qr-wrap')?.classList.add('hidden');
        document.getElementById('wa-qr-wrap')?.classList.add('hidden');
        stopWaQrPoll();
        const statusEl = document.getElementById('fc-status');
        const hero = document.getElementById('fc-hero');
        hero?.classList.add('is-online');
        hero?.classList.remove('is-off', 'is-wait', 'is-warn');
        if (hero) hero.dataset.modo = 'is-online';
        if (statusEl) {
          statusEl.className = '';
          statusEl.textContent = 'Conectado';
        }
        const detail = document.getElementById('fc-status-detail');
        if (detail) detail.textContent = 'Chip no ar — escolha o grupo da medição.';
        const phone = String(data.phone || '').replace(/\D/g, '');
        const chipInput = document.getElementById('fc-whatsapp');
        if (phone.length >= 10 && chipInput) {
          chipInput.value = phone;
          fetchJSON(`${API}/whatsapp/filiais-chatbot/${filialId}`, {
            method: 'PUT',
            body: JSON.stringify({ whatsapp: phone }),
          }).catch(() => {});
        }
        document.getElementById('chatbot-filial-panel')?.dispatchEvent(new CustomEvent('wa-chip-ok', {
          detail: { phone },
        }));
        return;
      }
      if (data.infra_wuzapi && qrImagemVisivel()) return;
      if (/401|unauthor/i.test(String(data.qr_erro || data.mensagem || '')) && qrImagemVisivel()) return;
      if (data.qrcode || data.qr_erro) mostrarQrFilial(data, nome);
    } catch {
      // ignore
    } finally {
      pollEmAndamento = false;
    }
  };
  waPollTimer = setInterval(tick, 2000);
  tick();
}

document.getElementById('btn-wa-qr-fechar')?.addEventListener('click', () => {
  document.getElementById('wa-qr-wrap')?.classList.add('hidden');
  stopWaPoll();
});

// ── Filiais (admin total + gerente de unidade) ──────────

let diagExecPorId = new Map();

function guardarDiagnosticoExecutivo(payload) {
  diagExecPorId = new Map();
  for (const filial of payload?.filiais || []) {
    diagExecPorId.set(Number(filial.id), filial);
  }
}

function fmtPctExec(valor) {
  if (valor == null || valor === '') return '—';
  return `${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function textoCortesExecutivos(cortes) {
  const c = cortes || {};
  const veiculos = c.min_veiculos_criticos ?? 2;
  const criticos = c.pct_criticos ?? 20;
  const semDados = c.pct_sem_dados_nao_avaliada ?? 50;
  return `Cortes provisórios: crítica a partir de ${veiculos} veículos críticos e ${criticos}% dos veículos com condição comprovada. Sem risco comprovado e ${semDados}% ou mais sem dados deixa a unidade não avaliada.`;
}

function renderBlocoExecutivoCard(diag) {
  if (!diag) return '';
  return `
    <div class="filial-exec">
      <span class="exec-sit exec-sit-${escapeHtml(diag.situacao || '')}">${escapeHtml(diag.situacao_label || '—')}</span>
      <p class="hint filial-exec-motivo">${escapeHtml(diag.motivo || '')}</p>
      <div class="filial-exec-nums">
        <span><strong>${diag.veiculos_ativos ?? 0}</strong> ativos</span>
        <span><strong>${diag.sem_risco_critico ?? 0}</strong> sem risco</span>
        <span><strong>${diag.com_monitoramento ?? 0}</strong> monitoramento</span>
        <span class="text-critico"><strong>${diag.com_criticos ?? 0}</strong> críticos</span>
        <span><strong>${diag.sem_dados ?? 0}</strong> sem dados</span>
      </div>
      <p class="hint">Frota avaliada ${fmtPctExec(diag.frota_avaliada_pct)} · ${diag.veiculos_medicao_vencida ?? 0} com medição vencida</p>
    </div>
  `;
}

function linhasJustificativaExec(veiculo) {
  const pneus = veiculo.pneus || [];
  if (!pneus.length) {
    const vazias = (veiculo.posicoes_vazias || []).map((p) => p.label || p.codigo).filter(Boolean);
    const texto = vazias.length
      ? `Posições sem pneu: ${vazias.join(', ')}`
      : (veiculo.classe_label || 'Sem dados suficientes');
    return `<tr>
      <td><strong>${escapeHtml(veiculo.placa || '—')}</strong></td>
      <td colspan="5">${escapeHtml(texto)}</td>
    </tr>`;
  }
  return pneus.map((p) => {
    const status = p.kpi === 'monitorar' ? 'alerta' : (p.kpi || 'sem_dado');
    const alertas = (p.alertas || []).map((a) => `<span class="exec-alerta">${escapeHtml(a)}</span>`).join('');
    return `<tr class="exec-row" data-veiculo-id="${veiculo.id || ''}">
      <td><strong>${escapeHtml(veiculo.placa || '—')}</strong></td>
      <td>${escapeHtml(p.posicao_label || p.posicao || '—')}</td>
      <td>${escapeHtml(p.numero_fogo || '—')}</td>
      <td>${p.menor_sulco != null ? `${escapeHtml(String(p.menor_sulco))} mm` : '—'}</td>
      <td>${p.data_medicao ? formatDate(p.data_medicao) : '—'}</td>
      <td>${badge(status)}${alertas}</td>
    </tr>`;
  }).join('');
}

function grupoJustificativaExec(titulo, veiculos) {
  if (!veiculos.length) return '';
  return `
    <section>
      <h4>${escapeHtml(titulo)} (${veiculos.length})</h4>
      <div class="unidade-table-wrap">
        <table class="historico-table unidade-table">
          <thead>
            <tr><th>Placa</th><th>Posição</th><th>Fogo</th><th>Menor sulco</th><th>Medição</th><th>Alertas</th></tr>
          </thead>
          <tbody>${veiculos.map(linhasJustificativaExec).join('')}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderDiagnosticoExecutivoDetalhe(diag, cortes) {
  if (!diag) return '';
  const lista = diag.justificativa || [];
  const criticos = lista.filter((v) => v.classe === 'critico');
  const monitoramento = lista.filter((v) => v.classe === 'monitoramento');
  const semDados = lista.filter((v) => v.classe === 'sem_dados');
  const outros = lista.filter((v) => v.classe !== 'critico' && v.classe !== 'monitoramento' && v.classe !== 'sem_dados');
  return `
    <section class="unidade-exec" aria-label="Diagnóstico executivo">
      <div class="filial-exec">
        <span class="exec-sit exec-sit-${escapeHtml(diag.situacao || '')}">${escapeHtml(diag.situacao_label || '—')}</span>
        <p class="filial-exec-motivo">${escapeHtml(diag.motivo || '')}</p>
        <div class="filial-exec-nums">
          <span><strong>${diag.veiculos_ativos ?? 0}</strong> ativos</span>
          <span><strong>${diag.sem_risco_critico ?? 0}</strong> sem risco crítico</span>
          <span><strong>${diag.com_monitoramento ?? 0}</strong> em monitoramento</span>
          <span class="text-critico"><strong>${diag.com_criticos ?? 0}</strong> com pneus críticos</span>
          <span><strong>${diag.sem_dados ?? 0}</strong> sem dados suficientes</span>
        </div>
        <p class="hint">Frota efetivamente avaliada: ${fmtPctExec(diag.frota_avaliada_pct)}. Veículos com medição vencida: ${diag.veiculos_medicao_vencida ?? 0}.</p>
        <p class="hint">${escapeHtml(textoCortesExecutivos(cortes))}</p>
      </div>
      <div class="unidade-exec-grupos">
        ${grupoJustificativaExec('Veículos com pneus críticos', criticos)}
        ${grupoJustificativaExec('Veículos com pneus em monitoramento', monitoramento)}
        ${grupoJustificativaExec('Veículos sem dados suficientes', semDados)}
        ${grupoJustificativaExec('Medição vencida ou sulco incompleto', outros)}
      </div>
    </section>
  `;
}

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
    if (tit) tit.textContent = isGerente() && !isAdmin() ? 'Minha unidade' : 'Unidades';
    if (hint) {
      hint.textContent = isGerente() && !isAdmin()
        ? 'Painel da sua unidade: indicadores, pendências e frota para análise.'
        : 'Clique numa filial para ver a situação da frota, os pneus que a justificam e os dados operacionais.';
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
    if (isGerente() && !isAdmin()) {
      const filiaisLeve = await fetchJSON(`${API}/filiais?leve=1`);
      filiaisCache = filiaisLeve;
      if (filiaisLeve.length === 1) {
        await abrirDetalheFilial(filiaisLeve[0].id);
        return;
      }
    }
    const [filiais, compras, diagnostico] = await Promise.all([
      fetchJSON(`${API}/filiais`),
      fetchJSON(`${API}/filiais/compras/consolidado`),
      fetchJSON(`${API}/filiais/diagnostico-executivo`).catch(() => null),
    ]);
    filiaisCache = filiais;
    guardarDiagnosticoExecutivo(diagnostico);
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
            <span>Em recapagem</span>
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
      const diag = diagExecPorId.get(Number(f.id));
      return `
        <div class="filial-card ${urgente ? 'is-urgente' : ''} ${atrasado ? 'is-atrasado' : ''}" data-id="${f.id}" role="button" tabindex="0">
          <div class="filial-card-head">
            <h3>${escapeHtml(f.nome)}</h3>
            <span class="badge badge-vida">${escapeHtml(f.codigo)}</span>
          </div>
          ${renderBlocoExecutivoCard(diag)}
          <p class="hint">${escapeHtml(f.contrato || 'Sem contrato')} · login: ${escapeHtml(f.login || '—')}</p>
          <p class="hint">
            ${f.whatsapp_grupo ? `Grupo: <span class="mono">${escapeHtml(f.whatsapp_grupo)}</span>` : 'Grupo do chatbot: não definido'}
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
            ${isAdmin()
              ? `<button type="button" class="btn btn-sm btn-danger-text btn-excluir-filial" data-id="${f.id}" data-nome="${escapeHtml(f.nome)}" data-codigo="${escapeHtml(f.codigo || '')}">Excluir</button>`
              : ''}
          </div>
        </div>
      `;
    }).join('');

    const abrir = (id) => abrirDetalheFilial(id);
    lista.querySelectorAll('.filial-card[data-id]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-editar-filial') || e.target.closest('.btn-excluir-filial')) return;
        abrir(card.dataset.id);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.target.closest('button')) return;
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
    lista.querySelectorAll('.btn-excluir-filial').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        abrirModalExcluirFilial(btn.dataset.id, btn.dataset.nome, btn.dataset.codigo);
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
  if (el) el.dataset.pendFiltroAtivo = filtro || '';
  const q = normalizarBuscaPneu(document.getElementById('unidade-pend-busca')?.value || '');
  const soAcompanhar = filtro === 'acao-monitorar';
  el?.querySelectorAll('.pendencia-grupo').forEach((g) => {
    const tipo = g.classList.contains('pendencia-troca')
      ? 'troca'
      : g.classList.contains('pendencia-recap')
        ? 'recap'
        : 'monitorar';
    const tipoOk = !filtro || (soAcompanhar ? tipo === 'monitorar' : tipo === filtro);
    let alguma = false;
    g.querySelectorAll('.unidade-pend-row').forEach((row) => {
      const acao = bucketAcaoDashboard(row.dataset.acao || '');
      const acaoOk = !soAcompanhar || !row.dataset.acao || acao === 'monitorar';
      const hay = normalizarBuscaPneu(row.innerText);
      const ok = tipoOk && acaoOk && (!q || hay.includes(q));
      row.classList.toggle('hidden', !ok);
      if (ok) alguma = true;
    });
    g.classList.toggle('hidden', !tipoOk || !alguma);
  });
  const chipFiltro = soAcompanhar ? 'monitorar' : (filtro || '');
  el?.querySelectorAll('.unidade-chip[data-pend-filtro]').forEach((btn) => {
    const val = btn.dataset.pendFiltro || '';
    btn.classList.toggle('ativo', val === chipFiltro);
  });
}

function filtrarFrotaUnidade() {
  const busca = document.getElementById('unidade-frota-busca')?.value || '';
  const filtro = document.getElementById('unidade-frota-filtro')?.value || 'todos';
  const filtroTipo = document.getElementById('unidade-frota-tipo')?.value || lerFiltroTipo();
  document.querySelectorAll('#unidade-frota-grid .veiculo-card, #unidade-frota-tbody tr.veiculo-item').forEach((row) => {
    const matchBusca = cardVeiculoCombinaBusca(row, busca) && cardCombinaTipo(row, filtroTipo);
    let matchFiltro = true;
    if (filtro === 'critico') matchFiltro = row.dataset.status === 'critico';
    else if (filtro === 'comprar') matchFiltro = Number(row.dataset.troca || 0) > 0;
    else if (filtro === 'recap') matchFiltro = Number(row.dataset.recap || 0) > 0;
    else if (filtro === 'monitorar') matchFiltro = Number(row.dataset.monitorar || 0) > 0;
    else if (filtro === 'sem_dado') matchFiltro = row.dataset.status === 'sem_dado';
    else if (filtro === 'ok') matchFiltro = row.dataset.status === 'ok';
    else if (filtro === 'semana') matchFiltro = !medidoNestaSemana(row.dataset.ultima || '', semanaMedicaoBrasil());
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

function abrirPneusRecapagem() {
  showView('pneus');
  const filtro = document.getElementById('pneus-filtro-status');
  if (filtro) filtro.value = 'recapagem';
  loadPneus();
}

function renderPendenciaRows(itens, tipo) {
  if (!itens?.length) return '';
  const titulo = tipo === 'troca'
    ? 'Comprar / Trocar'
    : tipo === 'recap'
      ? 'Em recapagem'
      : 'Monitorar';
  return `
    <div class="pendencia-grupo pendencia-${tipo}">
      <h4>${titulo} (${itens.length})</h4>
      <div class="unidade-table-wrap">
      <table class="historico-table unidade-table">
        <thead>
          <tr>
            <th>${tipo === 'recap' ? 'Origem' : 'Veículo'}</th><th>Posição</th><th>Fogo</th><th>Sulco</th>
            <th>Status</th><th>Diagnóstico</th><th>O que fazer</th><th>${tipo === 'recap' ? 'Envio' : 'Medição'}</th>
          </tr>
        </thead>
        <tbody>
          ${itens.map((p) => `
            <tr class="unidade-pend-row" data-pend-tipo="${tipo}"
                data-acao="${escapeHtml(p.acao_sugerida || '')}"
                data-veiculo-id="${p.veiculo_id || ''}"
                data-pneu-id="${p.pneu_id || ''}"
                data-em-recap="${p.em_recapagem ? '1' : '0'}"
                title="${tipo === 'recap' ? 'Abrir pneus em recapagem' : 'Abrir o veículo para análise'}">
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

function kpiUnidadeBtn({ valor, label, cls = '', attrs = '' }) {
  return `<button type="button" class="stat-card dash-kpi ${cls}" ${attrs}>
    <span class="stat-value">${valor ?? 0}</span>
    <span class="stat-label">${label}</span>
  </button>`;
}

function kpiUnidadeFixo({ valor, label, cls = '' }) {
  return `<div class="stat-card dash-kpi-fixo ${cls}">
    <span class="stat-value">${valor ?? 0}</span>
    <span class="stat-label">${label}</span>
  </div>`;
}

function veiculosSemMedicaoNaSemana(data) {
  const semana = semanaMedicaoBrasil();
  return (data.veiculos || []).filter((v) => !medidoNestaSemana(v.ultima_medicao, semana));
}

function usoUnidadeHtml(titulo, bloco) {
  if (!bloco || !Number(bloco.veiculos)) {
    return `<div class="unidade-uso"><h4>${titulo}</h4><p class="hint">Nenhum veículo nesta unidade de uso.</p></div>`;
  }
  const media = bloco.media == null ? '—' : bloco.media;
  return `<div class="unidade-uso">
    <h4>${titulo}</h4>
    <p><strong>${media}</strong> <span>média · ${bloco.veiculos} veículo${bloco.veiculos === 1 ? '' : 's'}</span></p>
    <p class="hint">OK ${bloco.ok ?? 0} · monitorar ${bloco.monitorar ?? 0} · crítico ${bloco.critico ?? 0} · sem medição ${bloco.sem_dado ?? 0}</p>
  </div>`;
}

function renderUnidadeKpis(data) {
  const r = data.resumo || {};
  const c = data.compras || r.compras || {};
  const uso = r.indicadores_uso || {};
  const total = r.pneus_total || 0;
  const w = (n) => `${pctBar(n, total)}%`;
  const semSemana = veiculosSemMedicaoNaSemana(data).length;
  const medir = r.precisa_medir_semana
    ? '<p class="dash-grupo-alerta">Medir esta semana</p>'
    : '';
  const ultima = r.ultima_medicao
    ? `Última medição ${formatDate(r.ultima_medicao)}${r.dias_sem_medicao != null ? ` · ${r.dias_sem_medicao} dia(s)` : ''}`
    : 'Nunca mediu';
  return `
    <div class="dash-grupos dash-grupos-gerencial" id="unidade-kpis">
      <section class="dash-grupo${(r.pneus_critico || 0) > 0 ? ' dash-grupo-destaque' : ''}" aria-label="Situação dos pneus">
        <h3>Situação dos pneus</h3>
        <div class="stats-grid">
          ${kpiUnidadeBtn({ valor: r.pneus_critico ?? 0, label: 'Críticos', cls: 'stat-critico', attrs: 'data-sulco="critico"' })}
          ${kpiUnidadeBtn({ valor: r.pneus_alerta ?? 0, label: 'Em alerta', cls: 'stat-alerta', attrs: 'data-sulco="alerta"' })}
          ${kpiUnidadeBtn({ valor: r.pneus_sem_dado ?? 0, label: 'Sem medição', cls: 'stat-alerta', attrs: 'data-sulco="sem_dado"' })}
          ${kpiUnidadeBtn({ valor: r.pneus_ok ?? 0, label: 'OK', cls: 'stat-ok', attrs: 'data-sulco="ok"' })}
        </div>
      </section>
      <section class="dash-grupo" aria-label="Estoque e recapagem">
        <h3>Estoque e recapagem</h3>
        <div class="stats-grid">
          ${kpiUnidadeFixo({ valor: r.pneus_em_estoque ?? 0, label: 'Estoque' })}
          ${kpiUnidadeBtn({
            valor: c.pneus_para_recap ?? r.pneus_em_recapagem ?? 0,
            label: 'Em recapagem',
            cls: 'stat-recap',
            attrs: 'data-unidade-tab="pendencias" data-pend-filtro="recap"',
          })}
          ${kpiUnidadeFixo({ valor: r.pneus_em_descarte ?? 0, label: 'Descarte' })}
        </div>
        <p class="dash-grupo-nota">Estoque e descarte são totais do resumo. Esta resposta não traz o pneu a pneu.</p>
      </section>
      <section class="dash-grupo${semSemana ? ' dash-grupo-destaque' : ''}" aria-label="Medições pendentes">
        <h3>Medições pendentes</h3>
        ${medir}
        <div class="stats-grid">
          ${kpiUnidadeBtn({
            valor: semSemana,
            label: 'Sem medição na semana',
            cls: semSemana ? 'stat-alerta' : '',
            attrs: 'data-unidade-tab="frota" data-frota-filtro="semana"',
          })}
        </div>
        <p class="dash-grupo-nota">${ultima}</p>
      </section>
      <section class="dash-grupo${(c.pneus_para_comprar || 0) > 0 ? ' dash-grupo-destaque' : ''}" aria-label="Necessidade de compras">
        <h3>Necessidade de compras</h3>
        <div class="stats-grid">
          ${kpiUnidadeBtn({
            valor: c.pneus_para_comprar ?? 0,
            label: 'Comprar',
            cls: 'stat-critico',
            attrs: 'data-unidade-tab="pendencias" data-pend-filtro="troca"',
          })}
          ${kpiUnidadeBtn({
            valor: c.pneus_monitorar ?? 0,
            label: 'Monitorar',
            cls: 'stat-alerta',
            attrs: 'data-unidade-tab="pendencias" data-pend-filtro="acao-monitorar"',
          })}
        </div>
        <p class="dash-grupo-nota">Comprar abre a lista de troca. Monitorar abre a ação acompanhar. Rodízio continua na aba Pendências.</p>
      </section>
      <section class="dash-grupo dash-grupo-frota" aria-label="Situação da frota">
        <h3>Situação da frota</h3>
        <p class="dash-grupo-nota">Veículos ativos: <strong>${r.veiculos_ativos ?? 0}</strong> · ${total} pneus montados</p>
        <div class="unidade-health" aria-label="Composição da frota">
          <span class="h-crit" style="width:${w(r.pneus_critico)}"></span>
          <span class="h-alerta" style="width:${w(r.pneus_alerta)}"></span>
          <span class="h-ok" style="width:${w(r.pneus_ok)}"></span>
          <span class="h-sem" style="width:${w(r.pneus_sem_dado)}"></span>
        </div>
        <p class="unidade-health-legend hint">
          <span class="dot-inline critico"></span> Crítico
          <span class="dot-inline alerta"></span> Alerta
          <span class="dot-inline ok"></span> OK
          <span class="dot-inline sem"></span> Sem medição
        </p>
        <div class="unidade-uso-grid">
          ${usoUnidadeHtml('Uso em km', uso.km)}
          ${usoUnidadeHtml('Uso em horas', uso.horas)}
        </div>
      </section>
    </div>
    <div id="unidade-lista-kpi" class="unidade-lista-kpi"></div>
  `;
}

function renderListaSulcoUnidade(status) {
  const box = document.getElementById('unidade-lista-kpi');
  if (!box || !filialDetalheCache) return;
  const rotulo = { critico: 'Pneus críticos', alerta: 'Pneus em alerta', sem_dado: 'Pneus sem medição', ok: 'Pneus OK' }[status] || 'Pneus';
  const rows = [];
  for (const v of filialDetalheCache.veiculos || []) {
    for (const p of v.pneus || []) {
      const st = p.status_sulco === 'monitorar' ? 'alerta' : (p.status_sulco || 'sem_dado');
      if (st !== status) continue;
      rows.push({ v, p });
    }
  }
  const r = filialDetalheCache.resumo || {};
  const esperado = { critico: r.pneus_critico, alerta: r.pneus_alerta, sem_dado: r.pneus_sem_dado, ok: r.pneus_ok }[status];
  const aviso = esperado != null && Number(esperado) !== rows.length
    ? `<p class="hint">O cartão mostra ${esperado} no resumo. A lista traz os ${rows.length} pneu(s) que vieram nos veículos desta resposta.</p>`
    : '';
  box.innerHTML = `
    <div class="dash-lista-head">
      <h3>${rotulo} <span>${rows.length}</span></h3>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-unidade-fechar-lista">Fechar lista</button>
    </div>
    ${aviso}
    ${rows.length ? `<div class="unidade-table-wrap"><table class="historico-table unidade-table">
      <thead><tr><th>Veículo</th><th>Placa</th><th>Posição</th><th>Sulco</th><th>Status</th></tr></thead>
      <tbody>
        ${rows.map(({ v, p }) => `
          <tr class="unidade-sulco-row" data-veiculo-id="${v.id}">
            <td><strong>${escapeHtml(v.apelido || v.placa)}</strong></td>
            <td>${escapeHtml(v.placa || '—')}</td>
            <td>${escapeHtml(p.posicao || '—')}</td>
            <td>${p.menor_sulco != null ? `${p.menor_sulco} mm` : '—'}</td>
            <td>${badge(p.status_sulco)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table></div>` : '<p class="hint">Nenhum pneu com esse status na frota desta resposta.</p>'}
  `;
  box.querySelector('#btn-unidade-fechar-lista')?.addEventListener('click', () => {
    box.innerHTML = '';
    box.closest('.unidade-shell')?.querySelectorAll('[data-sulco]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  });
  const filialId = filialDetalheCache.id;
  box.querySelectorAll('.unidade-sulco-row').forEach((row) => {
    row.addEventListener('click', () => {
      if (row.dataset.veiculoId) abrirVeiculoNaUnidade(filialId, row.dataset.veiculoId);
    });
  });
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
        <h4>Ordem de prioridade</h4>
        <ol class="unidade-howto">
          <li>Comprar ou trocar o que está crítico.</li>
          <li>Acompanhar o que está em recapagem.</li>
          <li>Monitorar o restante e medir quem está sem sulco nesta semana.</li>
        </ol>
        <p class="hint" style="margin-top:.75rem">${nPend} registro(s) nas pendências desta unidade.</p>
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
      <div class="busca-campo">
        <input type="text" class="campo-busca" id="unidade-frota-busca" placeholder="Buscar placa ou apelido…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" inputmode="search">
        <button type="button" class="busca-limpar" hidden aria-label="Limpar pesquisa">×</button>
      </div>
      <select id="unidade-frota-tipo" aria-label="Tipo de equipamento"></select>
      <select id="unidade-frota-filtro">
        <option value="todos">Todos</option>
        <option value="atencao">Só com atenção</option>
        <option value="critico">Críticos</option>
        <option value="comprar">A comprar</option>
        <option value="recap">Recap</option>
        <option value="monitorar">Monitorar</option>
        <option value="sem_dado">Sem medição</option>
        <option value="ok">OK</option>
        <option value="semana">Sem medição na semana</option>
      </select>
    </div>
    <div class="frota-visual unidade-frota-visual">
      <div class="frota-grid" id="unidade-frota-grid">
        ${veiculos.map((v) => renderCardCaminhaoFrota(v, {
          pendente: v.status_sulco === 'sem_dado',
          atrasado: v.status_sulco === 'critico',
          diaTxt: '',
          dataMed: v.ultima_medicao ? `Última: ${formatDate(v.ultima_medicao)}` : 'Ainda sem medição',
          posTxt: v.total_pneus ? `${v.total_pneus} pneus` : '',
        })).join('')}
      </div>
      <aside class="frota-log-panel">
        <h3>Log de medições</h3>
        <p class="hint">Clique numa linha para abrir o caminhão.</p>
        <div id="unidade-frota-log">${renderLogMedicoes(data.logs_medicao || [])}</div>
      </aside>
    </div>
    ${renderPainelAcoesDiagnosticos({
      acoes: data.pendencias?.todos || [],
      diagnosticos: data.pendencias?.diagnosticos || [],
    })}
    <div class="unidade-frota-split" id="unidade-frota-split">
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

async function abrirDetalheFilial(id) {
  try {
    const [data, diagResp] = await Promise.all([
      fetchJSON(`${API}/filiais/${id}`),
      fetchJSON(`${API}/filiais/diagnostico-executivo?filial_id=${encodeURIComponent(id)}`).catch(() => null),
    ]);
    filialDetalheCache = data;
    const diag = (diagResp?.filiais || []).find((f) => Number(f.id) === Number(id)) || null;
    if (diag) diagExecPorId.set(Number(id), diag);
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
        : `${data.codigo || ''} · só dados desta unidade. Use “Voltar” para ver todas as unidades.`;
    }

    const nPend = pend.todos?.length || 0;
    const nFrota = data.veiculos?.length || 0;

    el.innerHTML = `
      <div class="unidade-shell">
        <div class="unidade-head">
          <div>
            ${gerenteUnidade
              ? ''
              : '<button type="button" class="btn btn-ghost btn-sm" id="btn-fechar-detalhe-filial">← Voltar às unidades</button>'}
            <h3>${escapeHtml(data.nome)} <span class="hint">(${escapeHtml(data.codigo || '')})</span></h3>
            <p class="hint">${escapeHtml(data.contrato || '')}${data.login ? ` · login ${escapeHtml(data.login)}` : ''}</p>
          </div>
          <div class="unidade-head-actions" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-start">
            <button type="button" class="btn btn-primary btn-sm" id="btn-pdf-semanal" data-filial-id="${data.id}">
              Baixar PDF semanal
            </button>
            ${isAdmin()
              ? `<button type="button" class="btn btn-ghost btn-sm btn-editar-filial-detalhe" data-id="${data.id}">Editar / senha</button>
                 <button type="button" class="btn btn-sm btn-danger-text btn-excluir-filial-detalhe" data-id="${data.id}" data-nome="${escapeHtml(data.nome)}" data-codigo="${escapeHtml(data.codigo || '')}">Excluir</button>`
              : ''}
          </div>
        </div>
        ${renderDiagnosticoExecutivoDetalhe(diag, diagResp?.cortes)}
        ${renderUnidadeKpis(data)}
        <nav class="unidade-tabs" aria-label="Seções da unidade">
          <button type="button" class="unidade-tab ativo" data-unidade-tab="resumo">Visão geral</button>
          <button type="button" class="unidade-tab" data-unidade-tab="pendencias">Pendências (${nPend})</button>
          <button type="button" class="unidade-tab" data-unidade-tab="frota">Frota (${nFrota})</button>
        </nav>
        <div data-unidade-panel="resumo">${renderUnidadeResumo(data)}</div>
        <div data-unidade-panel="pendencias" class="hidden">
          <div class="unidade-pend-filtros">
            <div class="busca-campo">
              <input type="text" class="campo-busca" id="unidade-pend-busca" placeholder="Buscar placa, fogo ou posição…" aria-label="Buscar nas pendências" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" inputmode="search">
              <button type="button" class="busca-limpar" hidden aria-label="Limpar pesquisa">×</button>
            </div>
            <button type="button" class="unidade-chip ativo" data-pend-filtro="">Todas (${nPend})</button>
            <button type="button" class="unidade-chip" data-pend-filtro="troca">Comprar (${pend.troca?.length || 0})</button>
            <button type="button" class="unidade-chip" data-pend-filtro="recap">Em recap (${pend.recap?.length || 0})</button>
            <button type="button" class="unidade-chip" data-pend-filtro="monitorar">Monitorar (${pend.monitorar?.length || 0})</button>
          </div>
          ${nPend
            ? `${renderPendenciaRows(pend.troca, 'troca')}
               ${renderPendenciaRows(pend.recap, 'recap')}
               ${renderPendenciaRows(pend.monitorar, 'monitorar')}`
            : '<p class="hint">Nenhum alerta pendente nesta unidade — frota dentro dos parâmetros.</p>'}
        </div>
        <div data-unidade-panel="frota" class="hidden">
          <p class="hint">Caminhões lado a lado. Verde = ok, amarelo = alerta, vermelho = crítico. Clique para o desenho completo.</p>
          ${renderUnidadeFrota(data)}
        </div>
      </div>
    `;

    document.getElementById('btn-fechar-detalhe-filial')?.addEventListener('click', () => fecharDetalheFilial());
    el.querySelectorAll('.exec-row[data-veiculo-id]').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.veiculoId) abrirVeiculoNaUnidade(id, row.dataset.veiculoId);
      });
    });
    el.querySelector('.btn-editar-filial-detalhe')?.addEventListener('click', () => abrirModalFilial(id));
    el.querySelector('.btn-excluir-filial-detalhe')?.addEventListener('click', () => {
      abrirModalExcluirFilial(id, data.nome, data.codigo);
    });
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
    document.getElementById('unidade-pend-busca')?.addEventListener('input', () => {
      filtrarPendenciasUnidade(el.dataset.pendFiltroAtivo || '');
    });
    el.querySelectorAll('[data-sulco]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.sulco;
        const ligado = btn.getAttribute('aria-pressed') === 'true';
        el.querySelectorAll('[data-sulco]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        if (ligado) {
          document.getElementById('unidade-lista-kpi').innerHTML = '';
          return;
        }
        btn.setAttribute('aria-pressed', 'true');
        renderListaSulcoUnidade(status);
        document.getElementById('unidade-lista-kpi')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    registrarTiposAvulsos(data.veiculos);
    preencherSelectsTipo();
    document.getElementById('unidade-frota-busca')?.addEventListener('input', filtrarFrotaUnidade);
    document.getElementById('unidade-frota-filtro')?.addEventListener('change', filtrarFrotaUnidade);
    ligarCamposBusca(el);
    filtrarFrotaUnidade();

    el.querySelectorAll('.unidade-pend-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.emRecap === '1' || row.dataset.pendTipo === 'recap') {
          abrirPneusRecapagem();
          return;
        }
        if (row.dataset.veiculoId) abrirVeiculoNaUnidade(id, row.dataset.veiculoId);
      });
    });
    el.querySelectorAll('.unidade-prio-btn').forEach((btn) => {
      btn.addEventListener('click', () => abrirVeiculoNaUnidade(id, btn.dataset.veiculoId));
    });
    el.querySelectorAll('.veiculo-item[data-id], .frota-truck-card[data-id]').forEach((row) => {
      const open = () => {
        if (row.dataset.cadastroPendente === '1') {
          abrirConcluirCadastro(row.dataset.id, 'filiais');
          return;
        }
        abrirInspecaoVeiculoFilial(id, row.dataset.id);
      };
      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-dash-medir')) return;
        open();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
    el.querySelectorAll('#unidade-frota-log .frota-log-item[data-veiculo-id]').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.veiculoId) abrirInspecaoVeiculoFilial(id, row.dataset.veiculoId);
      });
    });
    el.querySelectorAll('.frota-decisao-item[data-veiculo-id]').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.veiculoId) abrirInspecaoVeiculoFilial(id, row.dataset.veiculoId);
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
  const chip = valorCampoWa(data.whatsapp);
  const alerta = valorCampoWa(data.whatsapp_alerta);
  const temToken = Boolean(data.tem_wuzapi_token);
  const temGrupo = Boolean(grupoAtual);
  const chipFmt = chip ? chip : 'ainda não informado';
  return `
    <div class="filial-chatbot-panel wa-panel wa-wizard">
      <header class="wa-hero" id="fc-hero">
        <div class="wa-hero-text">
          <p class="cb-kicker">WhatsApp das unidades</p>
          <h3>${escapeHtml(data.nome || 'Unidade')}${data.codigo ? ` <span class="cb-code">${escapeHtml(data.codigo)}</span>` : ''}</h3>
          <div class="wa-live" id="fc-live">
            <span class="wa-dot" aria-hidden="true"></span>
            <span id="fc-status">Verificando…</span>
          </div>
          <p class="hint" id="fc-status-detail">Consultando o chip…</p>
          <p class="wa-chip-line" id="fc-chip-line">Chip: <strong>${escapeHtml(chipFmt)}</strong>${temGrupo ? ' · Grupo escolhido' : ' · Sem grupo'}</p>
        </div>
      </header>

      <div id="fc-view-conectar" class="wa-stage">
        <p class="hint">Um único chip para todas as filiais. Conecte no celular e, nesta tela, escolha só o grupo desta unidade. O chatbot responde com os dados desta filial.</p>
        <button type="button" class="btn btn-primary btn-lg" id="btn-fc-conectar">Conectar</button>
        <div class="cb-qr-panel hidden" id="fc-qr-wrap">
          <h4 id="fc-qr-titulo">Escaneie o QR Code</h4>
          <p class="hint">No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
          <p class="hint" id="fc-qr-status">Gerando QR Code…</p>
          <img id="fc-qr-img" class="wa-qr-img hidden" alt="QR Code WhatsApp">
          <div class="wa-stage-actions">
            <button type="button" class="btn btn-ghost btn-sm hidden" id="btn-fc-qr-gerar">Gerar QR de novo</button>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-qr-fechar">Fechar</button>
          </div>
        </div>
      </div>

      <div id="fc-view-grupo" class="wa-stage hidden">
        <section class="wa-card" id="fc-step-group">
          <div class="wa-card-head">
            <h4>Escolha o grupo <span class="cb-pill cb-pill-lock hidden" id="fc-grupo-pill">definido</span></h4>
            <p class="hint">O chatbot só responde neste grupo, com a frota desta filial. O chip precisa estar no grupo.</p>
          </div>
          <div class="form-row wa-grupo-row">
            <div class="form-group" style="flex:1;margin:0">
              <label for="fc-whatsapp-grupo">Grupo</label>
              <select id="fc-whatsapp-grupo">
                <option value="">— Selecione o grupo —</option>
                ${grupoAtual ? `<option value="${escapeHtml(grupoAtual)}" selected>${escapeHtml(grupoAtual)}</option>` : ''}
              </select>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-grupos">Atualizar lista</button>
          </div>
          <small class="field-hint" id="fc-grupo-trava-hint">Atualize a lista e escolha o grupo da equipe.</small>
        </section>
      </div>

      <div id="fc-disconnect-wrap" class="wa-stage-actions hidden">
        <button type="button" class="btn btn-ghost" id="btn-fc-desconectar">Desconectar</button>
        <button type="button" class="btn btn-ghost btn-sm hidden" id="btn-fc-trocar-grupo">Trocar grupo</button>
      </div>

      <div id="fc-view-online" class="wa-stage hidden">
        <p class="wa-grupo-atual" id="fc-grupo-nome">${temGrupo ? `Grupo: <strong>${escapeHtml(grupoAtual)}</strong>` : ''}</p>
        <section class="wa-card wa-log-card" id="fc-envios-panel">
          <div class="wa-card-head wa-log-head">
            <h4>Log do chatbot</h4>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-envios">Atualizar</button>
          </div>
          <p class="hint" id="fc-envios-hint">Mensagens enviadas neste grupo, com data e hora de Brasília.</p>
          <div id="fc-envios-logs" class="wa-log-feed"></div>
          <div id="fc-envios-pendentes-list" class="hidden"></div>
          <div id="fc-envios-enviados-list" class="hidden"></div>
          <span id="fc-env-pendentes" class="hidden">0</span>
          <span id="fc-env-enviados" class="hidden">0</span>
          <button type="button" class="hidden" id="btn-fc-limpar-pendentes">Limpar pendentes</button>
        </section>
      </div>

      <div class="hidden" id="fc-step-alerta">
        <div id="fc-alerta-lista"></div>
        <input type="hidden" id="fc-whatsapp-alerta" value="${escapeHtml(alerta)}">
        <button type="button" class="hidden" id="btn-fc-alerta-opcoes">Atualizar lista</button>
      </div>
      <div class="hidden">
        <input type="password" id="fc-wuzapi-token" autocomplete="off">
        <button type="button" id="btn-fc-gerar-token">${temToken ? 'Reparar sessão' : 'Preparar sessão'}</button>
        <input type="tel" id="fc-whatsapp" class="mono" value="${escapeHtml(chip)}">
        <p id="fc-wuzapi-hint"></p>
      </div>
      <p class="hint hidden" id="fc-step-connect"></p>
    </div>
  `;
}

async function loadChatbotAdmin() {
  const box = document.getElementById('chatbot-filial-panel');
  if (!box) return;
  stopWaPoll();
  if (!isAdmin()) {
    box.innerHTML = `<p class="hint login-erro">Somente o administrador configura o chatbot WhatsApp.</p>`;
    return;
  }

  box.innerHTML = `<p class="hint">Carregando WhatsApp…</p>`;
  let status = {};
  let filiais = [];
  try {
    [status, filiais] = await Promise.all([
      fetchJSON(`${API}/whatsapp/status`).catch(() => ({})),
      fetchJSON(`${API}/whatsapp/filiais-chatbot`)
        .then((d) => d.filiais || d || [])
        .catch(() => []),
    ]);
  } catch (err) {
    box.innerHTML = `<p class="hint login-erro">${escapeHtml(err.message)}</p>`;
    return;
  }

  const online = Boolean(status.loggedIn);
  const phone = String(status.phone || status.chip_salvo || '').replace(/\D/g, '');
  const filiaisLista = Array.isArray(filiais) ? filiais : [];

  box.innerHTML = `
    <div class="filial-chatbot-panel wa-panel wa-wizard">
      <header class="wa-hero ${online ? 'is-online' : 'is-off'}" id="fc-hero">
        <div class="wa-hero-text">
          <p class="cb-kicker">Chatbot único</p>
          <h3>WhatsApp das filiais</h3>
          <div class="wa-live" id="fc-live">
            <span class="wa-dot" aria-hidden="true"></span>
            <span id="fc-status">${online ? 'Conectado' : 'Desconectado'}</span>
          </div>
          <p class="hint" id="fc-status-detail">${online
            ? (phone ? `Chip ${phone} no ar. Escolha o grupo de cada filial.` : 'Chip no ar. Escolha o grupo de cada filial.')
            : 'Clique em Conectar e escaneie o QR no seu celular.'}</p>
          <p class="wa-chip-line" id="fc-chip-line">Chip: <strong>${phone ? escapeHtml(phone) : 'ainda não conectado'}</strong></p>
        </div>
      </header>
      <div id="fc-view-conectar" class="wa-stage ${online ? 'hidden' : ''}">
        <p class="hint">Um chip para todas as unidades. Depois escolha o grupo de cada filial na lista abaixo.</p>
        <button type="button" class="btn btn-primary btn-lg" id="btn-fc-conectar">Conectar</button>
        <div class="cb-qr-panel hidden" id="fc-qr-wrap">
          <h4 id="fc-qr-titulo">Escaneie com o celular do chatbot</h4>
          <p class="hint">No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
          <p class="hint" id="fc-qr-status">Gerando QR Code…</p>
          <img id="fc-qr-img" class="wa-qr-img hidden" alt="QR Code WhatsApp">
          <div class="wa-stage-actions">
            <button type="button" class="btn btn-ghost btn-sm hidden" id="btn-fc-qr-gerar">Gerar QR de novo</button>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-fc-qr-fechar">Fechar</button>
          </div>
        </div>
      </div>
      <div id="fc-disconnect-wrap" class="wa-stage-actions ${online ? '' : 'hidden'}" style="padding:0 1.4rem 1rem">
        <button type="button" class="btn btn-ghost" id="btn-fc-desconectar">Desconectar chip</button>
      </div>
      <section class="wa-card" id="fc-grupos-admin" style="margin:0 1.4rem 1.4rem;padding:1rem">
        <div class="wa-card-head">
          <h4>Grupo por filial</h4>
          <p class="hint">O chatbot responde só no grupo escolhido, com os dados daquela unidade. O chip precisa estar no grupo.</p>
        </div>
        <div id="fc-grupos-lista"></div>
      </section>
    </div>
  `;

  const pintarOnline = (st) => {
    const on = Boolean(st?.loggedIn);
    const num = String(st?.phone || st?.chip_salvo || '').replace(/\D/g, '');
    const hero = document.getElementById('fc-hero');
    hero?.classList.toggle('is-online', on);
    hero?.classList.toggle('is-off', !on);
    hero?.classList.toggle('is-wait', Boolean(st?.qrcode) && !on);
    const statusEl = document.getElementById('fc-status');
    if (statusEl) statusEl.textContent = on ? 'Conectado' : (st?.qrcode ? 'Aguardando QR' : 'Desconectado');
    const detail = document.getElementById('fc-status-detail');
    if (detail) {
      detail.textContent = on
        ? (num ? `Chip ${num} no ar. Escolha o grupo de cada filial.` : 'Chip no ar. Escolha o grupo de cada filial.')
        : (st?.qrcode ? 'QR pronto — escaneie no celular.' : 'Clique em Conectar e escaneie o QR no seu celular.');
    }
    const line = document.getElementById('fc-chip-line');
    if (line) line.innerHTML = `Chip: <strong>${num ? escapeHtml(num) : 'ainda não conectado'}</strong>`;
    document.getElementById('fc-view-conectar')?.classList.toggle('hidden', on);
    document.getElementById('fc-disconnect-wrap')?.classList.toggle('hidden', !on);
    if (on) document.getElementById('fc-qr-wrap')?.classList.add('hidden');
  };

  const montarSelectGrupo = (filial, grupos) => {
    const atual = valorCampoWa(filial.whatsapp_grupo);
    const opts = ['<option value="">— Selecione o grupo —</option>'];
    for (const g of grupos) {
      const id = valorCampoWa(g.jid || g.id);
      if (!id) continue;
      const nome = valorCampoWa(g.nome || g.name) || id;
      const sel = atual && atual === id ? ' selected' : '';
      opts.push(`<option value="${escapeHtml(id)}"${sel}>${escapeHtml(nome)}</option>`);
    }
    if (atual && !grupos.some((g) => valorCampoWa(g.jid || g.id) === atual)) {
      opts.push(`<option value="${escapeHtml(atual)}" selected>Salvo: ${escapeHtml(atual)}</option>`);
    }
    return opts.join('');
  };

  const carregarTabelaGrupos = async () => {
    const wrap = document.getElementById('fc-grupos-lista');
    if (!wrap) return;
    const on = document.getElementById('fc-hero')?.classList.contains('is-online');
    if (!on) {
      wrap.innerHTML = '<p class="hint">Conecte o chip para listar os grupos e ligar cada filial.</p>';
      return;
    }
    wrap.innerHTML = '<p class="hint">Buscando grupos…</p>';
    let grupos = [];
    try {
      const data = await fetchJSON(`${API}/whatsapp/grupos`);
      if (data.precisa_qr) {
        wrap.innerHTML = `<p class="hint login-erro">${escapeHtml(data.erro || 'Conecte o chip para listar os grupos.')}</p>`;
        return;
      }
      grupos = data.grupos || [];
    } catch (err) {
      wrap.innerHTML = `<p class="hint login-erro">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (!filiaisLista.length) {
      wrap.innerHTML = '<p class="hint">Nenhuma filial cadastrada.</p>';
      return;
    }
    wrap.innerHTML = `
      <div class="wa-grupos-admin">
        ${filiaisLista.map((f) => `
          <label class="wa-grupo-filial">
            <span><strong>${escapeHtml(f.nome)}</strong> <span class="hint">${escapeHtml(f.codigo || '')}</span></span>
            <select data-filial-id="${f.id}">${montarSelectGrupo(f, grupos)}</select>
          </label>
        `).join('')}
      </div>
      ${grupos.length ? '' : '<p class="hint">Nenhum grupo no chip. Entre nos grupos da equipe com esse celular e clique em Conectar de novo, ou atualize esta página.</p>'}
    `;
    wrap.querySelectorAll('select[data-filial-id]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const filialId = sel.dataset.filialId;
        const grupo = valorCampoWa(sel.value);
        if (!grupo) {
          toast('Selecione um grupo da lista', 'error');
          return;
        }
        const atual = filiaisLista.find((x) => String(x.id) === String(filialId));
        try {
          sel.disabled = true;
          await fetchJSON(`${API}/whatsapp/filiais-chatbot/${filialId}`, {
            method: 'PUT',
            body: JSON.stringify({ whatsapp_grupo: grupo, trocar_grupo: true }),
          });
          if (atual) atual.whatsapp_grupo = grupo;
          toast(`Grupo salvo em ${atual?.nome || 'filial'}`, 'success');
        } catch (err) {
          if (atual) sel.value = valorCampoWa(atual.whatsapp_grupo) || '';
          toast(err.message, 'error');
        } finally {
          sel.disabled = false;
        }
      });
    });
  };

  let gerandoQr = false;
  const solicitarQr = async ({ forcar = false } = {}) => {
    if (gerandoQr) {
      toast('A sessão já está ligando. Espere o QR.');
      return;
    }
    gerandoQr = true;
    const btn = document.getElementById('btn-fc-conectar');
    const btnQr = document.getElementById('btn-fc-qr-gerar');
    if (btn) btn.disabled = true;
    if (btnQr) btnQr.disabled = true;
    abrirPainelQr('Gerando o QR…', '');
    toast('Gerando o QR…');
    startWaPollGlobal();
    try {
      const data = await fetchJSON(`${API}/whatsapp/connect`, {
        method: 'POST',
        body: JSON.stringify({ forcar_qr: Boolean(forcar) }),
        timeoutMs: 45_000,
      });
      if ((data.loggedIn || data.estado === 'conectado') && !data.qrcode) {
        stopWaQrPoll();
        pintarOnline(data);
        toast(data.mensagem || 'Chatbot conectado', 'success');
        await carregarTabelaGrupos();
        return;
      }
      if (data.qrcode) {
        mostrarQrFilial(data, '');
        pintarOnline({ ...data, loggedIn: false });
        toast('Escaneie o QR com o WhatsApp do chip', 'success');
        startWaPollGlobal();
        return;
      }
      mostrarQrFilial(data, '');
      toast(data.qr_erro || data.mensagem || 'Aguardando o QR.', data.qrcode ? 'success' : 'error');
      startWaPollGlobal();
    } catch (err) {
      toast(err.message || 'Falha ao gerar o QR', 'error');
      startWaPollGlobal();
    } finally {
      gerandoQr = false;
      if (btn) btn.disabled = false;
      if (btnQr) btnQr.disabled = false;
    }
  };

  document.getElementById('btn-fc-conectar')?.addEventListener('click', () => solicitarQr());
  document.getElementById('btn-fc-qr-gerar')?.addEventListener('click', () => solicitarQr({ forcar: true }));
  document.getElementById('btn-fc-qr-fechar')?.addEventListener('click', () => {
    document.getElementById('fc-qr-wrap')?.classList.add('hidden');
    stopWaQrPoll();
  });
  document.getElementById('btn-fc-desconectar')?.addEventListener('click', async () => {
    if (!confirm('Desconectar o chip? Todas as filiais param de responder até conectar de novo. Os grupos são mantidos.')) return;
    const btn = document.getElementById('btn-fc-desconectar');
    try {
      if (btn) btn.disabled = true;
      stopWaPoll();
      const data = await fetchJSON(`${API}/whatsapp/disconnect`, {
        method: 'POST',
        body: '{}',
        timeoutMs: 25_000,
      });
      toast(data.mensagem || 'Chip desconectado', 'success');
      await loadChatbotAdmin();
    } catch (err) {
      toast(err.message, 'error');
      if (btn) btn.disabled = false;
    }
  });

  pintarOnline(status);
  await carregarTabelaGrupos();
}

function startWaPollGlobal() {
  stopWaQrPoll();
  waPollFilialId = 0;
  let pollEmAndamento = false;
  const tick = async () => {
    if (pollEmAndamento) return;
    pollEmAndamento = true;
    try {
      const comQr = qrImagemVisivel() ? '' : '?qr=1';
      const data = await fetchJSON(`${API}/whatsapp/status${comQr}`);
      if (data.qrcode) mostrarQrFilial(data, '');
      if (data.loggedIn) {
        stopWaQrPoll();
        toast('Chatbot conectado!', 'success');
        document.getElementById('fc-qr-wrap')?.classList.add('hidden');
        const hero = document.getElementById('fc-hero');
        hero?.classList.add('is-online');
        hero?.classList.remove('is-off', 'is-wait');
        const statusEl = document.getElementById('fc-status');
        if (statusEl) statusEl.textContent = 'Conectado';
        const phone = String(data.phone || '').replace(/\D/g, '');
        const detail = document.getElementById('fc-status-detail');
        if (detail) {
          detail.textContent = phone
            ? `Chip ${phone} no ar. Escolha o grupo de cada filial.`
            : 'Chip no ar. Escolha o grupo de cada filial.';
        }
        const line = document.getElementById('fc-chip-line');
        if (line) line.innerHTML = `Chip: <strong>${phone ? escapeHtml(phone) : 'conectado'}</strong>`;
        document.getElementById('fc-view-conectar')?.classList.add('hidden');
        document.getElementById('fc-disconnect-wrap')?.classList.remove('hidden');
        const wrap = document.getElementById('fc-grupos-lista');
        if (wrap && /Conecte o chip/i.test(wrap.textContent || '')) {
          loadChatbotAdmin();
        }
        return;
      }
    } catch {
      // ignore
    } finally {
      pollEmAndamento = false;
    }
  };
  waPollTimer = setInterval(tick, 2000);
  tick();
}

async function loadChatbotGerente() {
  return loadChatbotAdmin();
}

function wireFilialChatbotPanel(filialId, nomeFilial, { alertasEnabled = false } = {}) {
  const statusEl = document.getElementById('fc-status');
  let salvandoChipAuto = false;
  let grupoSalvo = valorCampoWa(document.getElementById('fc-whatsapp-grupo')?.value);
  let grupoTravado = Boolean(grupoSalvo);

  let carregarEnvios = async () => {};

  const temGrupoEscolhido = () => Boolean(valorCampoWa(document.getElementById('fc-whatsapp-grupo')?.value) || grupoSalvo);

  const aplicarTravaGrupo = (travado) => {
    const sel = document.getElementById('fc-whatsapp-grupo');
    const temGrupo = temGrupoEscolhido();
    grupoTravado = Boolean(travado && temGrupo);
    if (sel) sel.disabled = false;
    document.getElementById('btn-fc-grupos')?.classList.remove('hidden');
    document.getElementById('btn-fc-trocar-grupo')?.classList.toggle('hidden', !grupoTravado);
    document.getElementById('fc-grupo-pill')?.classList.toggle('hidden', !grupoTravado);
    const hint = document.getElementById('fc-grupo-trava-hint');
    if (hint) {
      hint.textContent = grupoSalvo
        ? 'Escolha o grupo. O chatbot só responde neste grupo.'
        : 'Atualize a lista e escolha o grupo da equipe.';
    }
    const nomeEl = document.getElementById('fc-grupo-nome');
    if (nomeEl) {
      const g = valorCampoWa(sel?.value) || grupoSalvo;
      const opt = sel?.selectedOptions?.[0];
      const label = opt && opt.value ? opt.textContent : g;
      nomeEl.innerHTML = g ? `Grupo: <strong>${escapeHtml(label || g)}</strong>` : '';
    }
  };

  const mostrarEtapaChatbot = ({ online = false, aguardandoQr = false } = {}) => {
    const vConn = document.getElementById('fc-view-conectar');
    const vGrupo = document.getElementById('fc-view-grupo');
    const vOn = document.getElementById('fc-view-online');
    const disc = document.getElementById('fc-disconnect-wrap');
    const qr = document.getElementById('fc-qr-wrap');
    const grupoOk = temGrupoEscolhido();
    if (online && grupoOk) {
      vConn?.classList.add('hidden');
      vGrupo?.classList.add('hidden');
      vOn?.classList.remove('hidden');
      disc?.classList.remove('hidden');
      qr?.classList.add('hidden');
      aplicarTravaGrupo(true);
      carregarEnvios(true);
      return;
    }
    if (online) {
      vConn?.classList.add('hidden');
      vGrupo?.classList.remove('hidden');
      vOn?.classList.add('hidden');
      disc?.classList.remove('hidden');
      qr?.classList.add('hidden');
      return;
    }
    vConn?.classList.remove('hidden');
    vGrupo?.classList.add('hidden');
    vOn?.classList.add('hidden');
    disc?.classList.add('hidden');
    qr?.classList.toggle('hidden', !aguardandoQr && !qrPainelAberto());
  };
  aplicarTravaGrupo(grupoTravado);

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
  let gruposJaPedidos = false;
  let estadoOnline = false;
  let falhasOff = 0;
  let gerandoQr = false;

  const pintarHero = (modo) => {
    const hero = document.getElementById('fc-hero');
    hero?.classList.remove('is-online', 'is-wait', 'is-off', 'is-warn');
    if (modo) hero?.classList.add(modo);
    if (hero) hero.dataset.modo = modo || '';
  };

  const atualizarBotaoTrocar = () => {
    document.getElementById('btn-fc-desconectar')?.classList.remove('hidden');
  };

  const atualizarLinhaChip = (phone) => {
    const line = document.getElementById('fc-chip-line');
    if (!line) return;
    const digits = String(phone || document.getElementById('fc-whatsapp')?.value || '').replace(/\D/g, '');
    const grupoOk = Boolean(valorCampoWa(document.getElementById('fc-whatsapp-grupo')?.value) || grupoSalvo);
    line.innerHTML = `Chip: <strong>${digits ? escapeHtml(digits) : 'ainda não informado'}</strong>${grupoOk ? ' · Grupo escolhido' : ' · Sem grupo'}`;
  };

  const limparChipLocal = () => {
    const input = document.getElementById('fc-whatsapp');
    if (input) input.value = '';
    chipSessaoAplicado = false;
    atualizarLinhaChip('');
  };

  const detalheStatusWa = (st, fallback) => {
    const raw = String(st?.qr_erro || st?.mensagem || '');
    if (/no session|session not found|not logged/i.test(raw)) {
      return 'Chip desconectado. Clique em Conectar para gerar o QR.';
    }
    return raw || fallback;
  };

  const aplicarEstadoTela = ({ online, aguardandoQr, instavel, aviso, detalhe }) => {
    const detail = document.getElementById('fc-status-detail');
    const btnConn = document.getElementById('btn-fc-conectar');
    const chipNaTela = String(document.getElementById('fc-whatsapp')?.value || '').replace(/\D/g, '').length >= 10;
    if (/401|unauthor/i.test(String(detalhe || '')) && qrImagemVisivel()) {
      detalhe = 'QR pronto — escaneie no celular do chip.';
    }
    if (online) {
      estadoOnline = true;
      falhasOff = 0;
      statusEl.className = '';
      statusEl.textContent = 'Conectado';
      pintarHero(aviso ? 'is-warn' : 'is-online');
      if (detail) {
        detail.textContent = detalhe || (temGrupoEscolhido()
          ? 'Chip no ar. Use Desconectar se precisar trocar o chip.'
          : 'Chip no ar. Escolha o grupo da medição.');
      }
      if (btnConn) {
        btnConn.textContent = 'Conectar';
        btnConn.classList.add('btn-primary');
        btnConn.classList.remove('btn-ghost');
      }
      mostrarEtapaChatbot({ online: true });
      return;
    }
    if (aguardandoQr) {
      statusEl.className = '';
      statusEl.textContent = 'Aguardando QR';
      pintarHero('is-wait');
      if (detail) detail.textContent = detalhe || 'Escaneie o QR com o WhatsApp do chip desta unidade.';
      if (btnConn) {
        btnConn.textContent = 'Conectar';
        btnConn.classList.add('btn-primary');
        btnConn.classList.remove('btn-ghost');
      }
      mostrarEtapaChatbot({ online: false, aguardandoQr: true });
      document.getElementById('fc-qr-wrap')?.classList.remove('hidden');
      return;
    }
    if (instavel) {
      if (estadoOnline || chipNaTela) {
        estadoOnline = true;
        statusEl.className = '';
        statusEl.textContent = 'Conectado';
        pintarHero('is-warn');
        if (detail) {
          const tecnico = /problema interno|não gere outro token|nao gere outro token|banco interno/i.test(detalhe || '');
          detail.textContent = (!detalhe || tecnico)
            ? 'Chip desta unidade continua cadastrado. Não precisa escanear de novo.'
            : detalhe;
        }
        mostrarEtapaChatbot({ online: true });
        return;
      }
      if (btnConn) {
        btnConn.textContent = 'Conectar';
        btnConn.classList.add('btn-primary');
        btnConn.classList.remove('btn-ghost');
      }
      statusEl.className = '';
      statusEl.textContent = 'Verificando';
      pintarHero('is-warn');
      if (detail) detail.textContent = detalhe || 'Confirmando o chip no servidor…';
      mostrarEtapaChatbot({ online: false });
      return;
    }
    estadoOnline = false;
    statusEl.className = '';
    statusEl.textContent = 'Desconectado';
    pintarHero('is-off');
    if (detail) detail.textContent = detalhe || 'Clique em Conectar e escaneie o QR.';
    if (btnConn) {
      btnConn.textContent = 'Conectar';
      btnConn.classList.add('btn-primary');
      btnConn.classList.remove('btn-ghost');
    }
    mostrarEtapaChatbot({ online: false, aguardandoQr: false });
  };

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

  const refreshStatus = async ({ silencioso = true } = {}) => {
    if (!statusEl) return;
    if (document.getElementById('fc-hero')?.dataset.modo === 'is-online') {
      estadoOnline = true;
    }
    if (silencioso && (qrImagemVisivel() || qrPainelAberto())) return;
    try {
      const st = await fetchJSON(`${API}/whatsapp/filial/${filialId}/status`);
      if (st.filial_id != null && Number(st.filial_id) !== Number(filialId)) return;
      const estado = estadoDaRespostaWa(st);
      const sessaoMorta = Boolean(st.sessao_morta || st.sessao_inexistente)
        && !st.loggedIn
        && !st.token_compartilhado
        && !st.sessao_alheia;

      if (st.loggedIn) {
        sessionStorage.removeItem(`wa_forcar_qr_${filialId}`);
        sessionStorage.removeItem(`wa_auto_qr_${filialId}`);
      }

      if (!st.loggedIn && (sessaoMorta || (!st.chip_presumido && !st.infra_wuzapi))) {
        limparChipLocal();
      }

      if (sessaoMorta) {
        aplicarEstadoTela({
          online: false,
          aguardandoQr: Boolean(st.qrcode),
          detalhe: detalheStatusWa(st, 'Chip desconectado. Clique em Conectar para gerar o QR.'),
        });
        return;
      }

      if (estado === 'precisa_qr' || st.token_compartilhado || st.sessao_alheia) {
        aplicarEstadoTela({
          online: false,
          aguardandoQr: Boolean(st.qrcode),
          detalhe: detalheStatusWa(st, 'Clique em Conectar e escaneie o QR no celular do chatbot.'),
        });
        atualizarLinhaChip(st.loggedIn ? (st.chip_salvo || st.whatsapp) : '');
        return;
      }

      if (st.loggedIn && st.phone && !st.chip_presumido) {
        const atual = String(document.getElementById('fc-whatsapp')?.value || '').replace(/\D/g, '');
        if (!chipSessaoAplicado || !atual) {
          await aplicarNumeroChip(st.phone, { salvar: true, forcar: true });
          chipSessaoAplicado = true;
        }
        atualizarLinhaChip(st.phone);
      } else if (!st.loggedIn) {
        atualizarLinhaChip('');
      } else {
        atualizarLinhaChip(st.chip_salvo || st.whatsapp || st.phone || '');
      }

      if (estado === 'conectado' || st.loggedIn) {
        aplicarEstadoTela({
          online: true,
          aviso: Boolean(st.chip_presumido),
          detalhe: st.chip_presumido
            ? (st.mensagem || 'Chip do chatbot continua cadastrado. Não precisa escanear de novo.')
            : (st.phone
              ? `Chip ${st.phone} no ar. Escolha o grupo desta unidade se ainda não tiver um.`
              : 'Chip no ar. Escolha o grupo desta unidade.'),
        });
        if (!gruposJaPedidos && !st.chip_presumido) {
          gruposJaPedidos = true;
          carregarGrupos(true);
        }
        return;
      }

      if (estado === 'servidor_indisponivel' || st.infra_wuzapi || st.instavel) {
        falhasOff += 1;
        const chipJaTem = String(st.chip_salvo || st.whatsapp || document.getElementById('fc-whatsapp')?.value || '').replace(/\D/g, '');
        aplicarEstadoTela({
          online: false,
          instavel: true,
          detalhe: chipJaTem.length >= 10
            ? 'Chip desta unidade continua cadastrado. Não precisa escanear de novo.'
            : detalheStatusWa(st, 'Servidor do WhatsApp lento. Aguarde e atualize o status.'),
        });
        return;
      }

      if (estado === 'aguardando_qr' || (st.connected && !st.loggedIn)) {
        aplicarEstadoTela({
          online: false,
          aguardandoQr: true,
          detalhe: detalheStatusWa(st, 'Escaneie o QR com o WhatsApp do chip desta unidade.'),
        });
        return;
      }

      if (estado === 'precisa_token') {
        aplicarEstadoTela({
          online: false,
          detalhe: 'Clique em Conectar e escaneie o QR no celular do chatbot.',
        });
        return;
      }

      falhasOff += 1;
      if (estadoOnline && falhasOff < 4) {
        aplicarEstadoTela({
          online: false,
          instavel: true,
          detalhe: 'Confirmando o chip…',
        });
        return;
      }
      aplicarEstadoTela({
        online: false,
        detalhe: st.mensagem || 'Clique em Conectar e escaneie o QR.',
      });
    } catch (err) {
      falhasOff += 1;
      if (estadoOnline && falhasOff < 4) {
        aplicarEstadoTela({
          online: false,
          instavel: true,
          detalhe: 'Confirmando o chip…',
        });
        return;
      }
      aplicarEstadoTela({
        online: false,
        instavel: true,
        detalhe: 'Não foi possível consultar o WhatsApp agora. O chip pode continuar no ar.',
      });
      if (!silencioso) {
        const hint = document.getElementById('fc-wuzapi-hint');
        if (hint && err?.message) {
          hint.textContent = err.message;
          hint.classList.add('login-erro');
        }
      }
    }
  };
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

  carregarEnvios = async (silencioso = false) => {
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
          <article class="wa-log-item${i.status === 'erro' ? ' is-erro' : ''}">
            <time class="wa-log-when" datetime="${escapeHtml(i.criado_em || '')}">${escapeHtml(formatDateTime(i.criado_em))}</time>
            <div class="wa-log-body">
              <span class="badge ${i.status === 'erro' ? 'badge-critico' : 'badge-ok'}">${escapeHtml(i.status_label || '')}</span>
              <strong>${escapeHtml(i.tipo_label || 'Chatbot')}</strong>
              ${i.placa ? `<span class="mono">${escapeHtml(i.placa)}</span>` : ''}
              <div class="hint">${escapeHtml(i.preview || '')}${i.erro ? ` · <span class="login-erro">${escapeHtml(i.erro)}</span>` : ''}</div>
            </div>
          </article>
        `).join('') || `<p class="hint">${escapeHtml(data.mensagem || 'Nenhuma mensagem enviada neste grupo ainda.')}</p>`;
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

  const chipInicial = String(document.getElementById('fc-whatsapp')?.value || '').replace(/\D/g, '');
  if (chipInicial.length >= 10) {
    aplicarEstadoTela({
      online: true,
      aviso: true,
      detalhe: 'Chip desta unidade continua cadastrado.',
    });
  }
  refreshStatus({ silencioso: true });
  if (waStatusWatchTimer) clearInterval(waStatusWatchTimer);
  waStatusWatchTimer = setInterval(() => refreshStatus({ silencioso: true }), 20000);

  const carregarGrupos = async (silencioso = false) => {
    const sel = document.getElementById('fc-whatsapp-grupo');
    if (!sel) return;
    const atual = valorCampoWa(sel.value) || grupoSalvo;
    try {
      if (!silencioso) toast('Buscando grupos no WhatsApp…');
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/grupos`);
      if (data.precisa_qr) {
        aplicarEstadoTela({
          online: false,
          aguardandoQr: true,
          detalhe: data.erro || 'Sessão do WhatsApp não está ativa. Desconecte e gere o QR.',
        });
        if (!silencioso) toast(data.erro || 'Sessão inativa. Desconecte e gere o QR de novo.', 'error');
        return;
      }
      const grupos = data.grupos || [];
      sel.innerHTML = '<option value="">— Selecione o grupo —</option>';
      for (const g of grupos) {
        const id = valorCampoWa(g.jid || g.id);
        if (!id) continue;
        const nome = valorCampoWa(g.nome || g.name) || id;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${nome} (${id})`;
        if (atual && atual === id) opt.selected = true;
        sel.appendChild(opt);
      }
      if (atual && !grupos.some((g) => valorCampoWa(g.jid || g.id) === atual)) {
        const opt = document.createElement('option');
        opt.value = atual;
        opt.textContent = `Salvo: ${atual}`;
        opt.selected = true;
        sel.appendChild(opt);
      }
      if (!silencioso) {
        toast(grupos.length ? `${grupos.length} grupo(s) encontrado(s)` : 'Nenhum grupo — entre no grupo com o chip e tente de novo', grupos.length ? 'success' : 'error');
      }
    } catch (err) {
      if (!silencioso) toast(err.message, 'error');
    }
  };

  document.getElementById('btn-fc-grupos')?.addEventListener('click', () => carregarGrupos(false));
  document.getElementById('chatbot-filial-panel')?.addEventListener('wa-chip-ok', () => {
    estadoOnline = true;
    falhasOff = 0;
    atualizarLinhaChip(document.getElementById('fc-whatsapp')?.value);
    aplicarEstadoTela({
      online: true,
      detalhe: 'Chip no ar. Escolha o grupo da medição.',
    });
    if (!gruposJaPedidos) {
      gruposJaPedidos = true;
      carregarGrupos(true);
    }
  });
  document.getElementById('btn-fc-trocar-grupo')?.addEventListener('click', async () => {
    aplicarTravaGrupo(false);
    grupoTravado = false;
    document.getElementById('fc-view-online')?.classList.add('hidden');
    document.getElementById('fc-view-grupo')?.classList.remove('hidden');
    toast('Selecione o novo grupo. O chatbot continua no grupo atual até você escolher.');
    await carregarGrupos(true);
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

  const salvarTokenDigitado = async () => {
    const tokenInput = document.getElementById('fc-wuzapi-token');
    const tok = tokenInput?.value?.trim();
    if (!tok) return;
    await salvarCamposChatbot({ wuzapi_token: tok }, { silencioso: true });
    tokenInput.value = '';
    tokenInput.placeholder = '•••• (deixe em branco para manter)';
    toast('Token WuzAPI salvo', 'success');
    refreshStatus();
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
    const grupo = valorCampoWa(sel?.value);
    if (!grupo) {
      if (sel) sel.value = grupoSalvo || '';
      toast('Selecione um grupo da lista', 'error');
      return;
    }
    if (grupo === grupoSalvo) {
      aplicarTravaGrupo(true);
      return;
    }
    try {
      toast('Salvando grupo do chatbot…');
      const body = { whatsapp_grupo: grupo };
      if (grupoSalvo) body.trocar_grupo = true;
      await salvarCamposChatbot(body, { silencioso: true });
      grupoSalvo = grupo;
      document.getElementById('fc-step-group')?.classList.toggle('is-done', true);
      aplicarTravaGrupo(true);
      aplicarEstadoTela({
        online: true,
        detalhe: 'Grupo salvo. O chatbot só responde neste grupo.',
      });
      toast('Grupo definido — o chatbot só responde neste grupo', 'success');
    } catch (err) {
      if (sel) sel.value = grupoSalvo || '';
      aplicarTravaGrupo(Boolean(grupoSalvo));
      toast(err.message || 'Falha ao salvar grupo', 'error');
    }
  });

  document.getElementById('fc-wuzapi-token')?.addEventListener('change', async () => {
    try {
      await salvarTokenDigitado();
    } catch (err) {
      toast(err.message || 'Falha ao salvar o token', 'error');
    }
  });
  document.getElementById('fc-wuzapi-token')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('fc-wuzapi-token')?.blur();
    }
  });

  document.getElementById('btn-fc-alerta-opcoes')?.addEventListener('click', () => carregarAlertaOpcoes(false));
  setTimeout(() => carregarAlertaOpcoes(true), 600);
  document.getElementById('btn-fc-gerar-token')?.addEventListener('click', async () => {
    try {
      const btnGerar = document.getElementById('btn-fc-gerar-token');
      if (btnGerar?.textContent && /reparar/i.test(btnGerar.textContent)) {
        if (!confirm('Reparar só se o suporte pedir. Isso não troca o chip. Continuar?')) return;
      }
      toast('Verificando a sessão desta unidade…');
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/provisionar-token`, {
        method: 'POST',
        body: JSON.stringify({ forcar_novo: false }),
      });
      toast(data.mensagem || 'Sessão verificada', 'success');
      const tokenInput = document.getElementById('fc-wuzapi-token');
      if (tokenInput) {
        tokenInput.value = '';
        tokenInput.placeholder = '•••• sessão desta unidade — deixe em branco';
      }
      const hint = document.getElementById('fc-wuzapi-hint');
      if (hint) {
        hint.textContent = data.precisa_conectar
          ? 'Sessão pronta. Clique em Conectar e escaneie o QR.'
          : 'Sessão do chatbot ok. Use Conectar só se o status não estiver Conectado.';
        hint.classList.remove('login-erro');
      }
      await refreshStatus({ silencioso: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-fc-conectar')?.addEventListener('click', async () => {
    await solicitarQr();
  });

  document.getElementById('btn-fc-qr-gerar')?.addEventListener('click', () => solicitarQr({ forcar: true }));

  async function solicitarQr({ forcar = false } = {}) {
    const btnHero = document.getElementById('btn-fc-conectar');
    const btnQr = document.getElementById('btn-fc-qr-gerar');
    if (gerandoQr) {
      toast('A sessão já está ligando. Espere o QR — não clique de novo.');
      return;
    }
    gerandoQr = true;
    if (btnHero) btnHero.disabled = true;
    if (btnQr) btnQr.disabled = true;
    const temChip = String(document.getElementById('fc-whatsapp')?.value || '').replace(/\D/g, '').length >= 10;
    const forcarQr = Boolean(forcar);
    abrirPainelQr('Gerando o QR…', nomeFilial);
    aplicarEstadoTela({
      online: false,
      aguardandoQr: true,
      detalhe: forcarQr
        ? 'Gerando um QR novo. Escaneie quando aparecer.'
        : 'Ligando a sessão desta unidade e gerando o QR.',
    });
    if (forcarQr) sessionStorage.setItem(`wa_forcar_qr_${filialId}`, '1');
    toast('Gerando o QR…');
    startWaPollFilial(filialId, nomeFilial);
    try {
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/connect`, {
        method: 'POST',
        body: JSON.stringify({ forcar_qr: forcarQr }),
        timeoutMs: 45_000,
      });
      if (!(forcarQr && data.qrcode)) {
        sessionStorage.removeItem(`wa_forcar_qr_${filialId}`);
      }
      const estado = estadoDaRespostaWa(data);
      const phoneResp = String(data.phone || '').replace(/\D/g, '');
      if ((estado === 'conectado' || data.loggedIn) && !data.sessao_alheia && !data.token_compartilhado && !data.qrcode) {
        document.getElementById('fc-qr-wrap')?.classList.add('hidden');
        stopWaQrPoll();
        if (phoneResp.length >= 10) {
          chipSessaoAplicado = false;
          await aplicarNumeroChip(phoneResp, { salvar: true, forcar: true });
          chipSessaoAplicado = true;
          atualizarLinhaChip(phoneResp);
        }
        toast(data.mensagem || `Chatbot ${nomeFilial} já está conectado`, 'success');
        aplicarEstadoTela({
          online: true,
          detalhe: phoneResp
            ? `Chip ${phoneResp} no ar. Escolha o grupo da medição.`
            : (data.mensagem || 'Chip no ar. Escolha o grupo da medição.'),
        });
        gruposJaPedidos = false;
        setTimeout(() => carregarGrupos(true), 800);
        return;
      }
      if (data.qrcode) {
        mostrarQrFilial(data, nomeFilial);
        aplicarEstadoTela({
          online: false,
          aguardandoQr: true,
          detalhe: 'QR pronto — escaneie no celular do chip.',
        });
        toast('Escaneie o QR com o WhatsApp do chip', 'success');
        startWaPollFilial(filialId, nomeFilial);
        return;
      }
      if (data.qr_pendente) {
        aplicarEstadoTela({
          online: false,
          aguardandoQr: true,
          detalhe: data.mensagem || 'Aguarde o QR aparecer.',
        });
        toast(data.mensagem || 'Aguarde o QR aparecer.');
        startWaPollFilial(filialId, nomeFilial);
        return;
      }
      mostrarQrFilial(data, nomeFilial);
      aplicarEstadoTela({
        online: false,
        aguardandoQr: true,
        detalhe: data.qr_erro || data.mensagem || 'Aguardando o QR. Clique em Gerar QR de novo se não aparecer.',
      });
      toast(data.qr_erro || data.mensagem || 'QR ainda não veio. Clique em Gerar QR de novo.', 'error');
      startWaPollFilial(filialId, nomeFilial);
    } catch (err) {
      const msg = err.message || 'Falha ao gerar o QR';
      if (qrImagemVisivel() && /401|unauthor/i.test(msg)) {
        aplicarEstadoTela({
          online: false,
          aguardandoQr: true,
          detalhe: 'QR pronto — escaneie no celular do chip.',
        });
        startWaPollFilial(filialId, nomeFilial);
        return;
      }
      aplicarEstadoTela({
        online: false,
        aguardandoQr: true,
        detalhe: /demorou/i.test(msg)
          ? 'Ainda gerando o QR… se não aparecer, clique de novo.'
          : msg,
      });
      startWaPollFilial(filialId, nomeFilial);
      if (/demorou/i.test(msg)) {
        toast('Ainda gerando… o QR deve aparecer em instantes');
      } else {
        abrirPainelQr(msg, nomeFilial);
        const { status } = painelQrEls();
        status?.classList.add('login-erro');
        toast(msg, 'error');
      }
    } finally {
      gerandoQr = false;
      if (btnHero) btnHero.disabled = false;
      if (btnQr) btnQr.disabled = false;
    }
  }

  document.getElementById('btn-fc-desconectar')?.addEventListener('click', async () => {
    if (!confirm('Desconectar o chip do chatbot? Todas as unidades param de responder até conectar de novo. Os grupos escolhidos são mantidos.')) return;
    const btn = document.getElementById('btn-fc-desconectar');
    try {
      if (btn) btn.disabled = true;
      stopWaPoll();
      const chip = document.getElementById('fc-whatsapp');
      if (chip) chip.value = '';
      document.getElementById('fc-qr-wrap')?.classList.add('hidden');
      document.getElementById('wa-qr-wrap')?.classList.add('hidden');

      toast('Encerrando sessão no WhatsApp…');
      const data = await fetchJSON(`${API}/whatsapp/filial/${filialId}/disconnect`, {
        method: 'POST',
        body: '{}',
        timeoutMs: 25_000,
      });
      sessionStorage.setItem(`wa_forcar_qr_${filialId}`, '1');
      toast(data.mensagem || 'Sessão limpa. Clique em Conectar para gerar o QR.', 'success');
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
    stopWaQrPoll();
  });

  if (sessionStorage.getItem(`wa_forcar_qr_${filialId}`)) {
    aplicarEstadoTela({
      online: false,
      aguardandoQr: false,
      detalhe: 'Sessão limpa. Clique em Conectar e escaneie o QR do novo chip.',
    });
    atualizarLinhaChip('');
  }
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
  const opcoes = document.getElementById('insp-tipo-opcoes');
  opcoes?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tipo-opcao');
    if (!btn || !opcoes.contains(btn)) return;
    const codigo = btn.dataset.codigo;
    const input = document.getElementById('insp-v-tipo');
    if (input) input.value = codigo;
    marcarBotaoTipo(opcoes, codigo);
    aplicarVisibilidadeUnidade(codigo, 'insp-campo-km', 'insp-campo-hr');
  });
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

async function excluirCaminhaoGestao({ filialId, veiculoId, placa, apelido, nPneus, depois }) {
  if (!isGestao()) {
    toast('Só gerente ou administrador pode excluir caminhão', 'error');
    return false;
  }
  const nome = [apelido, placa].filter(Boolean).join(' · ') || 'este caminhão';
  const n = Number(nPneus) || 0;
  const pneusTxt = n === 1
    ? 'o pneu montado nele'
    : n > 0
      ? `os ${n} pneus montados nele`
      : 'os pneus montados nele';
  if (!confirm(
    `Excluir ${nome} e ${pneusTxt}?\n\nMedições e histórico desses pneus também serão apagados. Esta ação não pode ser desfeita.`
  )) {
    return false;
  }
  try {
    const url = filialId
      ? `${API}/filiais/${filialId}/veiculos/${veiculoId}`
      : `${API}/veiculos/${veiculoId}`;
    const data = await fetchJSON(url, { method: 'DELETE' });
    toast(data.mensagem || 'Caminhão excluído', 'success');
    if (typeof depois === 'function') await depois(data);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
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
    await carregarMetaVeiculos().catch(() => {});
    const v = await fetchJSON(`${API}/filiais/${filialId}/veiculos/${veiculoId}`);
    if (inspecaoVeiculoIdAberto !== idNum) return;

    inspecaoVeiculoCache = v;
    const labels = v.posicoes_labels || {};
    const posicoes = v.posicoes_layout?.map((p) => p.codigo) || v.layout?.posicoes || [];
    const nAnom = v.anomalias?.length || 0;
    const catAtual = tipoDoCatalogo(v.tipo_codigo) || tipoDoCatalogo(v.tipo);
    const codigoInicial = catAtual?.codigo || v.tipo || '';
    const unidadeInicial = catAtual?.unidade_uso || v.unidade_uso || null;

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
          <button type="button" class="btn btn-ghost btn-sm btn-danger-text" id="btn-insp-excluir-veiculo">Excluir caminhão</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-fechar-inspecao">Fechar desenho</button>
        </div>
      </div>
      <details class="form-avancado inspecao-corrigir" open>
        <summary>Corrigir dados do veículo</summary>
        <p class="hint">Use se a placa, KM ou identificação foram cadastrados errados. O layout dos pneus continua no botão Configurar layout.</p>
        <section class="cad-secao">
          <h4><span>1</span> Identificação</h4>
          <div class="form-row">
            <div class="form-group">
              <label for="insp-v-placa">Placa <abbr class="req" title="obrigatório">*</abbr></label>
              <input type="text" id="insp-v-placa" value="${escapeHtml(v.placa || '')}" maxlength="8">
            </div>
            <div class="form-group">
              <label for="insp-v-apelido">Apelido</label>
              <input type="text" id="insp-v-apelido" value="${escapeHtml(v.apelido || '')}">
            </div>
          </div>
        </section>
        <section class="cad-secao">
          <h4><span>2</span> Configuração operacional</h4>
          <div class="form-group">
            <label>Tipo</label>
            <div id="insp-tipo-opcoes" class="tipo-opcoes" role="group" aria-label="Tipo de equipamento">${htmlBotoesTipo(codigoInicial)}</div>
            <input type="hidden" id="insp-v-tipo" value="${escapeHtml(codigoInicial)}">
          </div>
          <div class="form-row">
            <div class="form-group${unidadeInicial === 'horas' ? ' hidden' : ''}" id="insp-campo-km">
              <label for="insp-v-km">KM atual</label>
              <input type="number" id="insp-v-km" min="0" value="${v.km_atual ?? 0}">
            </div>
            <div class="form-group${unidadeInicial === 'km' ? ' hidden' : ''}" id="insp-campo-hr">
              <label for="insp-v-hr">Horas</label>
              <input type="number" id="insp-v-hr" min="0" step="0.1" value="${v.hr_atual ?? 0}">
            </div>
            <div class="form-group">
              <label for="insp-v-dia">Dia da medição</label>
              <select id="insp-v-dia">${optionsDiaSemana(v.dia_medicao, { incluirVazio: true, vazioLabel: '— Usar dia da frota —' })}</select>
            </div>
          </div>
        </section>
        <section class="cad-secao">
          <h4><span>3</span> Informações complementares</h4>
          <div class="form-row">
            <div class="form-group">
              <label for="insp-v-marca">Marca</label>
              <input type="text" id="insp-v-marca" value="${escapeHtml(v.marca || '')}">
            </div>
            <div class="form-group">
              <label for="insp-v-modelo">Modelo</label>
              <input type="text" id="insp-v-modelo" value="${escapeHtml(v.modelo || '')}">
            </div>
          </div>
        </section>
        <div class="cad-acoes">
          <button type="button" class="btn btn-primary btn-sm" id="btn-insp-salvar-veiculo">Salvar</button>
        </div>
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
    document.getElementById('btn-insp-excluir-veiculo').onclick = () => {
      excluirCaminhaoGestao({
        filialId,
        veiculoId: v.id,
        placa: v.placa,
        apelido: v.apelido,
        nPneus: v.pneus?.length || 0,
        depois: async () => {
          fecharInspecaoVeiculoFilial();
          await abrirDetalheFilial(filialId);
          setUnidadeTab('frota');
        },
      });
    };
    wireEdicaoVeiculoInspecao();

    const setPainel = (pneu) => {
      const painel = document.getElementById('filial-inspecao-painel');
      if (!painel) return;
      painel.innerHTML = renderPainelPneuInspecao(pneu);
      wirePainelInspecaoEdicao();
    };

    inspecaoDiagram = new TruckDiagram('filial-inspecao-diagram', {
      layoutId: v.layout_pneus,
      pickerHint: 'Clique no pneu colorido para ver a anomalia e o que fazer:',
      onPneuClick: (pneu) => setPainel(pneu),
      onSlotClick: () => {
        const painel = document.getElementById('filial-inspecao-painel');
        if (painel) {
          painel.innerHTML = `<div class="inspecao-empty"><p>Posição vazia — a filial precisa montar um pneu do estoque neste slot.</p></div>`;
        }
      },
    });
    inspecaoDiagram.render(v.pneus, labels, posicoes, { layoutId: v.layout_pneus });

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

function abrirModalExcluirFilial(id, nome, codigo) {
  if (!isAdmin()) return toast('Só o administrador pode excluir uma unidade', 'error');
  const modal = document.getElementById('modal-excluir-filial');
  if (!modal) return toast('Modal de exclusão não encontrado — recarregue a página', 'error');
  document.getElementById('excluir-filial-id').value = id;
  document.getElementById('excluir-filial-senha').value = '';
  const rotulo = [nome, codigo].filter(Boolean).join(' · ');
  document.getElementById('excluir-filial-aviso').textContent =
    `Excluir “${rotulo}” apaga veículos, pneus, medições, chatbot e logins dessa unidade. Não dá para desfazer.`;
  modal.showModal();
  document.getElementById('excluir-filial-senha')?.focus();
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
  document.getElementById('f-wuzapi-token-wrap')?.classList.add('hidden');
  document.getElementById('f-whatsapp-wrap')?.classList.add('hidden');
  modal.showModal();
}

document.getElementById('btn-nova-filial')?.addEventListener('click', () => abrirModalFilial());
document.getElementById('btn-cancelar-filial')?.addEventListener('click', () => {
  document.getElementById('modal-filial').close();
});

document.getElementById('btn-cancelar-excluir-filial')?.addEventListener('click', () => {
  document.getElementById('modal-excluir-filial')?.close();
});

document.getElementById('form-excluir-filial')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('excluir-filial-id')?.value;
  const senha = document.getElementById('excluir-filial-senha')?.value || '';
  if (!id) return;
  if (!senha) return toast('Informe a senha de administrador', 'error');
  const btn = document.getElementById('btn-confirmar-excluir-filial');
  try {
    if (btn) btn.disabled = true;
    const data = await fetchJSON(`${API}/filiais/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ senha_admin: senha }),
    });
    document.getElementById('modal-excluir-filial')?.close();
    document.getElementById('excluir-filial-senha').value = '';
    filiaisCache = [];
    fecharDetalheFilial();
    toast(data.mensagem || 'Unidade excluída', 'success');
    await loadFiliais();
  } catch (err) {
    toast(err.message || 'Falha ao excluir a unidade', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
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
        whatsapp_alerta: document.getElementById('f-whatsapp-alerta')?.value || null,
        dia_medicao: document.getElementById('f-dia-medicao')?.value
          ? Number(document.getElementById('f-dia-medicao').value)
          : null,
      };
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
          whatsapp_alerta: document.getElementById('f-whatsapp-alerta')?.value || null,
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
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const s = String(iso).replace('T', ' ').slice(0, 19);
    const [dia, hora] = s.split(' ');
    const [y, m, day] = String(dia || '').split('-');
    if (y && m && day) return `${day}/${m}/${y}${hora ? ` ${hora.slice(0, 8)}` : ''}`;
    return String(iso);
  }
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
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
            const badgePapel = u.papel === 'presidente'
              ? '<span class="badge badge-ok">Presidente</span>'
              : u.papel === 'gerente'
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
                ${isAdmin() && u.papel !== 'admin' && u.papel !== 'presidente' ? `
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

function ehContaPresidente(usuario) {
  return String(usuario?.id) === '34'
    && String(usuario?.login || '').toLowerCase() === 'presidente'
    && usuario?.papel === 'presidente';
}

function configurarSelectPapel(usuario) {
  const select = document.getElementById('u-papel');
  if (!select) return;
  const reservado = ehContaPresidente(usuario);
  let option = select.querySelector('option[value="presidente"]');
  if (reservado) {
    if (!option) {
      option = document.createElement('option');
      option.value = 'presidente';
      option.textContent = 'Presidente — exclusivo deste usuário';
      select.appendChild(option);
    }
    select.value = 'presidente';
    select.disabled = true;
    return;
  }
  option?.remove();
  select.disabled = false;
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
    hint.textContent = 'Gerente: Minha unidade, alertas/compras e frota da sua unidade.';
    filialWrap?.classList.remove('hidden');
  } else if (papel === 'presidente') {
    hint.textContent = 'Presidente: consulta e PDF da visão executiva. Sem cadastro, medição ou configuração.';
    filialWrap?.classList.add('hidden');
  } else {
    hint.textContent = 'Admin total: relatórios, usuários, filiais, WhatsApp e limites. Sem a aba Saúde e desgaste.';
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
    configurarSelectPapel(usuario);
    document.getElementById('u-papel').value = usuario.papel || 'filial';
    document.getElementById('u-whatsapp').value = usuario.whatsapp || '';
    senhaWrap?.classList.add('hidden');
    senhaInput.required = false;
    senhaInput.value = '';
  } else {
    titulo.textContent = 'Novo usuário';
    btnSalvar.textContent = 'Criar';
    loginInput.readOnly = false;
    configurarSelectPapel(null);
    senhaWrap?.classList.remove('hidden');
    senhaInput.required = true;
  }
  atualizarHintPapelUsuario();
  configurarSelectPapel(usuario);
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
  const contaPresidente = document.getElementById('u-papel')?.disabled
    && String(id) === '34';

  if (!contaPresidente && papel === 'presidente') {
    return toast('O papel presidente não pode ser atribuído por esta tela', 'error');
  }

  if (papel === 'filial' && !filialId) {
    return toast('Operador de filial precisa de uma filial', 'error');
  }

  try {
    if (id) {
      await fetchJSON(`${API}/usuarios/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(contaPresidente ? {} : {
            papel,
            filial_id: papel === 'admin' ? null : filialId,
          }),
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

// ── Diagnóstico da frota (gerente e admin) ─────────────

let diagAtual = null;

function diagQuery() {
  const qs = new URLSearchParams();
  const filial = document.getElementById('diag-filial')?.value;
  const placa = document.getElementById('diag-placa')?.value?.trim();
  const tipo = document.getElementById('diag-tipo')?.value;
  const pendencia = document.getElementById('diag-pendencia')?.value;
  const inicio = document.getElementById('diag-inicio')?.value;
  const fim = document.getElementById('diag-fim')?.value;
  if (filial) qs.set('filial_id', filial);
  if (placa) qs.set('placa', placa);
  if (tipo) qs.set('tipo', tipo);
  if (pendencia) qs.set('pendencia', pendencia);
  if (inicio) qs.set('periodo_inicio', inicio);
  if (fim) qs.set('periodo_fim', fim);
  return qs;
}

function labelSeveridadeDiag(s) {
  if (s === 'critica') return 'Crítica';
  if (s === 'atencao') return 'Atenção';
  if (s === 'cadastral') return 'Cadastral';
  return s || '—';
}

function preencherTiposDiag() {
  const sel = document.getElementById('diag-tipo');
  if (!sel || sel.dataset.pronto === '1') return;
  const tipos = meta.tipos_equipamento || [];
  sel.innerHTML = `<option value="">Todos</option>${tipos.map((t) => (
    `<option value="${escapeHtml(t.codigo)}">${escapeHtml(t.label)}</option>`
  )).join('')}`;
  sel.dataset.pronto = '1';
}

function pintarDetalheDiag(veiculo) {
  const box = document.getElementById('diag-detalhe');
  if (!box) return;
  if (!veiculo) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const itens = veiculo.pendencias || [];
  box.classList.remove('hidden');
  box.innerHTML = `
    <h3>${escapeHtml(veiculo.placa)} · ${escapeHtml(veiculo.filial)} (${escapeHtml(veiculo.codigo)})</h3>
    <p class="hint">${escapeHtml(veiculo.tipo || 'Sem tipo')}${veiculo.dia_medicao_label ? ` · dia de medição ${escapeHtml(veiculo.dia_medicao_label)}` : ' · dia de medição não configurado'} · última medição ${veiculo.ultima_medicao ? formatDate(veiculo.ultima_medicao) : '—'}</p>
    ${itens.length ? itens.map((p) => `
      <article class="diag-item">
        <strong class="diag-sev-${escapeHtml(p.severidade)}">${labelSeveridadeDiag(p.severidade)}${p.reprova ? '' : ' · aviso'}</strong>
        <p><strong>${escapeHtml(veiculo.placa)}</strong> · ${escapeHtml(p.posicao_label || p.posicao || 'Veículo')} · fogo ${escapeHtml(p.numero_fogo || '—')} · última medição ${p.data_medicao ? formatDate(p.data_medicao) : '—'}</p>
        <p>${escapeHtml(p.descricao)}</p>
        <p><strong>O que fazer:</strong> ${escapeHtml(p.orientacao)}</p>
      </article>
    `).join('') : '<p>Nenhuma pendência neste veículo.</p>'}
  `;
  box.scrollIntoView({ block: 'nearest' });
}

function pintarDiagnosticoFrota(dados) {
  const r = dados.resumo || {};
  const pct = r.conformidade_pct == null
    ? '—'
    : `${Number(r.conformidade_pct).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const kpis = [
    ['Veículos analisados', r.veiculos_analisados ?? 0, ''],
    ['Sem pendência', r.veiculos_conformes ?? 0, 'stat-ok'],
    ['Com pendências', r.veiculos_com_pendencia ?? 0, 'stat-alerta'],
    ['Pneus sem fogo', r.pneus_sem_fogo ?? 0, ''],
    ['Pneus sem medição', r.pneus_sem_medicao ?? 0, 'stat-alerta'],
    ['Medições atrasadas', r.medicoes_atrasadas ?? 0, 'stat-critico'],
    ['Posições sem pneu', r.posicoes_sem_pneu ?? 0, ''],
    ['Conformidade', pct, 'stat-ok'],
  ];
  const kpiEl = document.getElementById('diag-kpis');
  if (kpiEl) {
    kpiEl.innerHTML = kpis.map(([rotulo, valor, cls]) => `
      <article class="stat-card ${cls}">
        <p class="hint" style="margin:0">${escapeHtml(rotulo)}</p>
        <strong>${escapeHtml(String(valor))}</strong>
      </article>
    `).join('');
  }

  const sel = document.getElementById('diag-filial');
  if (sel) {
    const atual = sel.value;
    sel.innerHTML = `<option value="">Todas do meu acesso</option>${(dados.filiais || []).map((f) => (
      `<option value="${f.id}">${escapeHtml(f.nome)} (${escapeHtml(f.codigo)})</option>`
    )).join('')}`;
    if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
  }

  const corpoFiliais = document.getElementById('diag-filiais');
  if (corpoFiliais) {
    const linhas = dados.por_filial || [];
    corpoFiliais.innerHTML = linhas.length ? linhas.map((f) => `
      <tr>
        <td>${escapeHtml(f.filial)} <span class="hint">${escapeHtml(f.codigo)}</span></td>
        <td>${f.veiculos_analisados}</td>
        <td>${f.veiculos_conformes}</td>
        <td>${f.veiculos_com_pendencia}</td>
        <td>${f.pneus_sem_fogo}</td>
        <td>${f.pneus_sem_medicao}</td>
        <td>${f.medicoes_atrasadas}</td>
        <td>${f.posicoes_sem_pneu}</td>
        <td>${f.conformidade_pct == null ? '—' : `${Number(f.conformidade_pct).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}</td>
      </tr>
    `).join('') : '<tr><td colspan="9">Nenhuma filial no filtro.</td></tr>';
  }

  const inc = dados.cadastros_incompletos || { veiculos: [], pneus: [] };
  const incEl = document.getElementById('diag-incompletos');
  if (incEl) {
    const veiculos = inc.veiculos || [];
    const pneus = inc.pneus || [];
    incEl.innerHTML = `
      <p>${veiculos.length} veículo(s) e ${pneus.length} pneu(s) montado(s) com cadastro incompleto. Eles não entram no percentual de conformidade.</p>
      ${veiculos.slice(0, 30).map((v) => `<p>${escapeHtml(v.filial)} · ${escapeHtml(v.placa)} — ${escapeHtml(v.descricao)} ${escapeHtml(v.orientacao)}</p>`).join('')}
      ${veiculos.length > 30 ? `<p>e mais ${veiculos.length - 30} veículo(s).</p>` : ''}
      ${pneus.slice(0, 30).map((p) => `<p>${escapeHtml(p.filial)} · ${escapeHtml(p.placa)} · ${escapeHtml(p.posicao_label || 'sem posição')} · fogo ${escapeHtml(p.numero_fogo || '—')} — ${escapeHtml(p.orientacao)}</p>`).join('')}
      ${pneus.length > 30 ? `<p>e mais ${pneus.length - 30} pneu(s).</p>` : ''}
    `;
  }

  const corpo = document.getElementById('diag-veiculos');
  if (corpo) {
    const lista = dados.veiculos || [];
    corpo.innerHTML = lista.length ? lista.map((v) => `
      <tr class="unidade-veiculo-row" data-diag-id="${v.id}">
        <td>${escapeHtml(v.filial)}</td>
        <td>${escapeHtml(v.placa)}</td>
        <td>${escapeHtml(v.tipo || '—')}</td>
        <td>${v.ultima_medicao ? formatDate(v.ultima_medicao) : '—'}</td>
        <td>${v.conforme ? 'Conforme' : 'Com pendência'}</td>
      </tr>
    `).join('') : '<tr><td colspan="5">Nenhum veículo analisado neste filtro.</td></tr>';
    corpo.querySelectorAll('[data-diag-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const id = Number(tr.dataset.diagId);
        pintarDetalheDiag((diagAtual?.veiculos || []).find((v) => Number(v.id) === id));
      });
    });
  }
  const regra = document.getElementById('diag-regra-atraso');
  if (regra && dados.semana) {
    regra.textContent = `O filtro de período só escolhe quais medições aparecem na lista. O atraso é calculado pela semana de ${formatDate(dados.semana.inicio)} a ${formatDate(dados.semana.fim)} (${dados.semana.dia_hoje_label || 'hoje'}), segundo o dia de medição já configurado. Medição prevista para hoje não é atraso.`;
  }
  pintarDetalheDiag(null);
}

async function loadDiagnosticoFrota() {
  if (!isGestao()) throw new Error('Acesso restrito a gerente e administrador');
  preencherTiposDiag();
  const dados = await fetchJSON(`${API}/relatorios/diagnostico-frota?${diagQuery()}`);
  diagAtual = dados;
  pintarDiagnosticoFrota(dados);
}

async function baixarPdfDiagnosticoFrota() {
  if (!isGestao()) return toast('Acesso restrito a gerente e administrador', 'error');
  try {
    toast('Gerando PDF do diagnóstico…');
    const resp = await fetch(`${API}/relatorios/diagnostico-frota.pdf?${diagQuery()}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) {
      let msg = 'Falha ao gerar PDF';
      try {
        const err = await resp.json();
        if (err?.erro) msg = err.erro;
      } catch { /* resposta não é JSON */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagnostico-frota-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    toast('PDF do diagnóstico baixado', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('btn-diag-atualizar')?.addEventListener('click', () => {
  loadDiagnosticoFrota().catch((err) => toast(err.message, 'error'));
});
document.getElementById('btn-diag-pdf')?.addEventListener('click', () => {
  baixarPdfDiagnosticoFrota();
});
for (const id of ['diag-filial', 'diag-tipo', 'diag-pendencia', 'diag-inicio', 'diag-fim']) {
  document.getElementById(id)?.addEventListener('change', () => {
    loadDiagnosticoFrota().catch((err) => toast(err.message, 'error'));
  });
}
document.getElementById('diag-placa')?.addEventListener('change', () => {
  loadDiagnosticoFrota().catch((err) => toast(err.message, 'error'));
});

// ── Relatórios diretoria ───────────────────────────────

async function baixarPdfSemanalUnidade(filialId) {
  if (!isGestao()) return toast('Acesso restrito ao gerente', 'error');
  if (!filialId) return toast('Filial não informada', 'error');
  try {
    toast('Gerando PDF semanal…');
    const tipo = document.getElementById('unidade-frota-tipo')?.value || lerFiltroTipo();
    const qs = new URLSearchParams({ filial_id: String(filialId) });
    if (tipo) qs.set('tipo', tipo);
    const resp = await fetch(`${API}/relatorios/unidade/semanal.pdf?${qs}`, {
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
    await carregarMetaVeiculos().catch(() => {});
    preencherSelectsTipo();
    const rel = await fetchJSON(`${API}/relatorios/diretoria${queryTipo()}`);
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
      const csvUrl = `${API}/relatorios/diretoria.csv${queryTipo()}`;
      csv.href = csvUrl;
      csv.onclick = async (e) => {
        e.preventDefault();
        try {
          const resp = await fetch(`${API}/relatorios/diretoria.csv${queryTipo()}`, {
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
    || path.includes('/acesso-rapido')
    || (window.location.search.includes('token=') && path.includes('acesso-rapido'));
}

function tipoRotaAcessoRapido() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path.endsWith('/acesso-rapido/veiculo')) return 'cadastrar_veiculo';
  if (path.endsWith('/acesso-rapido/pneu')) return 'cadastrar_pneu';
  if (path.endsWith('/acesso-rapido/troca')) return 'troca';
  if (path.endsWith('/veiculo-acesso-rapido')) return 'medir';
  return null;
}

function mostrarErroToken(msg) {
  document.getElementById('app-login')?.classList.add('hidden');
  document.getElementById('app-shell')?.classList.remove('hidden');
  finalizarBootVisual();
  document.getElementById('nav-tabs-filial')?.classList.add('hidden');
  document.getElementById('nav-tabs-admin')?.classList.add('hidden');
  document.getElementById('nav-tabs-gerente')?.classList.add('hidden');
  document.getElementById('btn-logout')?.classList.add('hidden');
  setCabecalho({
    unidade: 'Acesso rápido',
    papel: 'WhatsApp',
    login: '',
    subtitle: 'Link WhatsApp',
  });
  const box = document.querySelector('#view-acesso-erro .erro-token-container p');
  if (box && msg) box.textContent = msg;
  showView('acesso-erro');
}

function prepararShellAcessoRapido(titulo) {
  modoAcessoRapido = true;
  document.getElementById('app-login')?.classList.add('hidden');
  document.getElementById('app-shell')?.classList.remove('hidden');
  finalizarBootVisual();
  document.getElementById('nav-tabs-filial')?.classList.add('hidden');
  document.getElementById('nav-tabs-admin')?.classList.add('hidden');
  document.getElementById('nav-tabs-gerente')?.classList.add('hidden');
  document.getElementById('btn-logout')?.classList.add('hidden');
  setCabecalho({
    unidade: 'Acesso rápido',
    papel: 'WhatsApp',
    login: '',
    subtitle: titulo || 'Link temporário',
  });
}

async function bootArCadastroVeiculo(token) {
  prepararShellAcessoRapido('Cadastrar caminhão');
  showView('ar-veiculo');
  try {
    const data = await fetchJSON(`${API}/acesso-rapido?token=${encodeURIComponent(token)}`);
    if (data.tipo && data.tipo !== 'cadastrar_veiculo') {
      throw new Error('Este link não é de cadastro de caminhão');
    }
    const fil = document.getElementById('ar-veiculo-filial');
    if (fil) fil.textContent = data.filial ? `${data.filial.nome} (${data.filial.codigo || ''})` : '';
    if (Array.isArray(data.tipos_equipamento) && data.tipos_equipamento.length) {
      meta = { ...meta, tipos_equipamento: data.tipos_equipamento, tipos: data.tipos || meta.tipos };
    }
    if (Array.isArray(data.layouts) && data.layouts.length) {
      meta = { ...meta, layouts: data.layouts };
    }
    if (data.ja_gravado) {
      const ok = document.getElementById('ar-veiculo-ok');
      if (ok) ok.textContent = data.mensagem || 'Este veículo já estava cadastrado.';
      formDesativar(document.getElementById('form-ar-veiculo'));
      return;
    }
    const v = data.veiculo;
    const codigoInicial = codigoTipo(v?.tipo) || 'truck_tracao';
    const aplicarAr = (codigo, layoutSalvo = null) => {
      const input = document.getElementById('ar-v-tipo');
      if (input) input.value = codigo;
      marcarBotaoTipo(document.getElementById('ar-v-tipo-opcoes'), codigo);
      aplicarVisibilidadeUnidade(codigo, 'ar-campo-km', 'ar-campo-hr');
      preencherSelectLayouts('ar-v-layout', layoutSalvo || layoutSugeridoPorTipo(codigo), {
        soTruckToco: true,
        tipo: codigo,
      });
      const titulo = document.getElementById('ar-veiculo-titulo');
      if (titulo && !v) {
        titulo.textContent = tipoDoCatalogo(codigo)?.familia === 'rodoviario'
          ? 'Cadastrar caminhão'
          : 'Cadastrar equipamento';
      }
    };
    renderBotoesTipo('ar-v-tipo-opcoes', codigoInicial, (c) => aplicarAr(c));
    if (v) {
      const titulo = document.getElementById('ar-veiculo-titulo');
      if (titulo) titulo.textContent = 'Concluir cadastro do veículo';
      const inpPlaca = document.getElementById('ar-v-placa');
      if (inpPlaca) {
        inpPlaca.value = v.placa || '';
        inpPlaca.readOnly = true;
      }
      if (document.getElementById('ar-v-apelido')) document.getElementById('ar-v-apelido').value = v.apelido || '';
      if (document.getElementById('ar-v-marca')) document.getElementById('ar-v-marca').value = v.marca || '';
      if (document.getElementById('ar-v-modelo')) document.getElementById('ar-v-modelo').value = v.modelo || '';
      if (document.getElementById('ar-v-km')) document.getElementById('ar-v-km').value = v.km_atual ?? 0;
      if (document.getElementById('ar-v-hr')) document.getElementById('ar-v-hr').value = v.hr_atual ?? 0;
      aplicarAr(codigoInicial, v.layout_pneus || null);
    } else {
      aplicarAr(codigoInicial);
    }
  } catch (err) {
    mostrarErroToken(err.message);
    return;
  }

  const form = document.getElementById('form-ar-veiculo');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.dataset.salvando === '1') return;
    const erro = document.getElementById('ar-veiculo-erro');
    const ok = document.getElementById('ar-veiculo-ok');
    erro?.classList.add('hidden');
    if (ok) ok.textContent = '';
    form.dataset.salvando = '1';
    travarSubmit(form, true);
    try {
      const resp = await fetchJSON(`${API}/acesso-rapido/veiculo`, {
        method: 'POST',
        body: JSON.stringify({
          token,
          placa: document.getElementById('ar-v-placa')?.value,
          apelido: document.getElementById('ar-v-apelido')?.value || null,
          tipo: document.getElementById('ar-v-tipo')?.value,
          marca: document.getElementById('ar-v-marca')?.value,
          modelo: document.getElementById('ar-v-modelo')?.value,
          layout_pneus: document.getElementById('ar-v-layout')?.value,
          km_atual: Number(document.getElementById('ar-v-km')?.value) || 0,
          hr_atual: Number(document.getElementById('ar-v-hr')?.value) || 0,
        }),
      });
      if (!resp?.veiculo_id && !resp?.ja_gravado) {
        throw new Error('O servidor não confirmou o veículo. Confira a lista antes de cadastrar de novo.');
      }
      if (ok) ok.textContent = resp.mensagem || 'Caminhão cadastrado. Pode fechar esta página.';
      formDesativar(form);
      toast(resp.mensagem || 'Veículo cadastrado', 'success');
    } catch (err) {
      form.dataset.salvando = '0';
      travarSubmit(form, false);
      if (erro) {
        erro.textContent = err.message;
        erro.classList.remove('hidden');
      }
      toast(err.message, 'error');
    }
  });
}

async function bootArCadastroPneu(token) {
  prepararShellAcessoRapido('Cadastrar pneu');
  const btnFogo = document.getElementById('btn-ar-gerar-fogo');
  if (btnFogo) btnFogo.dataset.tokenAcesso = token || '';
  showView('ar-pneu');
  try {
    const data = await fetchJSON(`${API}/acesso-rapido?token=${encodeURIComponent(token)}`);
    if (data.tipo && data.tipo !== 'cadastrar_pneu') {
      throw new Error('Este link não é de cadastro de pneu');
    }
    const fil = document.getElementById('ar-pneu-filial');
    if (fil) fil.textContent = data.filial ? `${data.filial.nome} (${data.filial.codigo || ''})` : '';
    if (data.ja_gravado) {
      const ok = document.getElementById('ar-pneu-ok');
      if (ok) ok.textContent = data.mensagem || 'Este pneu já estava no estoque.';
      formDesativar(document.getElementById('form-ar-pneu'));
      return;
    }
    const p = data.pneu;
    if (p) {
      const inpFogo = document.getElementById('ar-p-fogo');
      if (inpFogo) {
        inpFogo.value = p.numero_fogo || '';
        inpFogo.readOnly = true;
      }
      if (document.getElementById('ar-p-modelo') && p.modelo && !/^pendente$/i.test(p.modelo)) {
        document.getElementById('ar-p-modelo').value = p.modelo;
      }
      if (document.getElementById('ar-p-marca')) document.getElementById('ar-p-marca').value = p.marca || '';
      if (document.getElementById('ar-p-tipo') && p.tipo_pneu) document.getElementById('ar-p-tipo').value = p.tipo_pneu;
      if (document.getElementById('ar-p-condicao') && p.condicao) document.getElementById('ar-p-condicao').value = p.condicao;
      if (document.getElementById('ar-p-sulco') && p.sulco_inicial_mm != null) {
        document.getElementById('ar-p-sulco').value = p.sulco_inicial_mm;
      }
    }
  } catch (err) {
    mostrarErroToken(err.message);
    return;
  }

  const form = document.getElementById('form-ar-pneu');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.dataset.salvando === '1') return;
    const erro = document.getElementById('ar-pneu-erro');
    const ok = document.getElementById('ar-pneu-ok');
    erro?.classList.add('hidden');
    if (ok) ok.textContent = '';
    form.dataset.salvando = '1';
    travarSubmit(form, true);
    try {
      const sulcoRaw = document.getElementById('ar-p-sulco')?.value;
      const resp = await fetchJSON(`${API}/acesso-rapido/pneu`, {
        method: 'POST',
        body: JSON.stringify({
          token,
          numero_fogo: document.getElementById('ar-p-fogo')?.value,
          modelo: document.getElementById('ar-p-modelo')?.value,
          marca: document.getElementById('ar-p-marca')?.value || null,
          tipo_pneu: document.getElementById('ar-p-tipo')?.value,
          condicao: document.getElementById('ar-p-condicao')?.value,
          sulco_inicial_mm: sulcoRaw === '' || sulcoRaw == null ? null : Number(String(sulcoRaw).replace(',', '.')),
        }),
      });
      if (!resp?.pneu?.id && !resp?.pneu_id && !resp?.ja_gravado) {
        throw new Error('O servidor não confirmou o pneu. Confira o estoque antes de cadastrar de novo.');
      }
      if (ok) ok.textContent = resp.mensagem || 'Pneu no estoque. Pode fechar esta página.';
      formDesativar(form);
      toast(resp.mensagem || 'Pneu cadastrado', 'success');
    } catch (err) {
      form.dataset.salvando = '0';
      travarSubmit(form, false);
      if (erro) {
        erro.textContent = err.message;
        erro.classList.remove('hidden');
      }
      toast(err.message, 'error');
    }
  });
}

async function bootArTroca(token) {
  prepararShellAcessoRapido('Troca de pneu');
  showView('ar-troca');
  let estado = { retirar: null, veiculo: null, estoque: [] };
  let diagram = null;

  const preencherEstoque = (lista) => {
    const sel = document.getElementById('ar-troca-estoque');
    if (!sel) return;
    sel.innerHTML = (lista || []).map((p) =>
      `<option value="${p.id}">${escapeHtml(p.numero_fogo)} — ${escapeHtml([p.marca, p.modelo].filter(Boolean).join(' ') || p.tipo_pneu)}</option>`
    ).join('') || '<option value="">Estoque vazio</option>';
  };

  const pintarDiagrama = (veiculo) => {
    const posicoesLayout = veiculo.posicoes_layout?.length
      ? veiculo.posicoes_layout.map((p) => p.codigo)
      : (veiculo.layout?.posicoes || (veiculo.pneus || []).map((p) => p.posicao));
    const labels = {};
    (veiculo.posicoes_layout || []).forEach((p) => { labels[p.codigo] = p.label || p.codigo; });
    if (!diagram) {
      diagram = new TruckDiagram('ar-troca-diagram', {
        layoutId: veiculo.layout_pneus,
        pickerHint: 'Toque no pneu montado para retirar',
        onPneuClick: (pneu) => {
          estado.retirar = { id: pneu.id, posicao: pneu.posicao, fogo: pneu.numero_fogo };
          const st = document.getElementById('ar-troca-status');
          if (st) st.textContent = `Retirar fogo ${pneu.numero_fogo} (${pneu.posicao}). Escolha o substituto do estoque.`;
          document.getElementById('ar-troca-estoque-wrap')?.classList.remove('hidden');
        },
        onSlotClick: () => toast('Posição vazia — escolha um pneu montado', 'error'),
      });
    }
    diagram.render(veiculo.pneus || [], labels, posicoesLayout, { layoutId: veiculo.layout_pneus });
  };

  try {
    const data = await fetchJSON(`${API}/acesso-rapido?token=${encodeURIComponent(token)}`);
    if (data.tipo && data.tipo !== 'troca') throw new Error('Este link não é de troca');
    estado.veiculo = data.veiculo;
    estado.estoque = data.estoque || [];
    const tit = document.getElementById('ar-troca-titulo');
    if (tit) tit.textContent = `Troca — ${data.veiculo?.placa || ''}`;
    preencherEstoque(estado.estoque);
    pintarDiagrama(data.veiculo);
  } catch (err) {
    mostrarErroToken(err.message);
    return;
  }

  document.getElementById('btn-ar-troca-confirmar')?.addEventListener('click', async () => {
    const erro = document.getElementById('ar-troca-erro');
    const ok = document.getElementById('ar-troca-ok');
    erro?.classList.add('hidden');
    if (ok) ok.textContent = '';
    if (!estado.retirar?.id) {
      toast('Selecione o pneu a retirar no diagrama', 'error');
      return;
    }
    const montarId = document.getElementById('ar-troca-estoque')?.value;
    if (!montarId) {
      toast('Escolha um pneu do estoque', 'error');
      return;
    }
    try {
      const resp = await fetchJSON(`${API}/acesso-rapido/troca`, {
        method: 'POST',
        body: JSON.stringify({
          token,
          retirar_pneu_id: estado.retirar.id,
          montar_pneu_id: Number(montarId),
        }),
      });
      if (ok) ok.textContent = resp.mensagem || 'Troca concluída!';
      toast(resp.mensagem || 'Troca ok', 'success');
      estado.retirar = null;
      document.getElementById('ar-troca-estoque-wrap')?.classList.add('hidden');
      const st = document.getElementById('ar-troca-status');
      if (st) st.textContent = 'Troca feita. Pode trocar outro pneu ou fechar.';
      if (resp.veiculo) {
        estado.veiculo = resp.veiculo;
        try {
          const data = await fetchJSON(`${API}/acesso-rapido?token=${encodeURIComponent(token)}`);
          estado.estoque = data.estoque || [];
        } catch {
          estado.estoque = [];
        }
        preencherEstoque(estado.estoque);
        pintarDiagrama(resp.veiculo);
      }
    } catch (err) {
      if (erro) {
        erro.textContent = err.message;
        erro.classList.remove('hidden');
      }
      toast(err.message, 'error');
    }
  });
}

async function bootAcessoRapido(token) {
  const tipoPath = tipoRotaAcessoRapido();
  if (tipoPath === 'cadastrar_veiculo') return bootArCadastroVeiculo(token);
  if (tipoPath === 'cadastrar_pneu') return bootArCadastroPneu(token);
  if (tipoPath === 'troca') return bootArTroca(token);

  prepararShellAcessoRapido('Medição sem login — link temporário');
  tokenAcessoRapido = token;

  try {
    // Preferir API unificada; fallback na rota antiga
    let data;
    try {
      data = await fetchJSON(`${API}/acesso-rapido?token=${encodeURIComponent(token)}`);
      if (data.tipo && data.tipo !== 'medir' && data.veiculo) {
        // token tipado com veiculo embutido
      } else if (data.tipo === 'cadastrar_veiculo') {
        return bootArCadastroVeiculo(token);
      } else if (data.tipo === 'cadastrar_pneu') {
        return bootArCadastroPneu(token);
      } else if (data.tipo === 'troca') {
        return bootArTroca(token);
      }
      if (!data.id && data.veiculo) data = data.veiculo;
    } catch {
      data = await fetchJSON(`${API}/veiculos/acesso-rapido?token=${encodeURIComponent(token)}`);
    }
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
  if (isPresidente()) {
    showView('presidente', 'visao');
    return;
  }
  try {
    const config = await fetchConfiguracoes();
    limitesAtuais = { ...limitesAtuais, ...config };
    await carregarMetaVeiculos();
    preencherSelectLayouts('v-layout', meta.layout_padrao, { soTruckToco: true });
    preencherSelectLayouts('layout-select', meta.layout_padrao);
    preencherCheckboxesPosicoes('layout-custom-checkboxes', getLayoutById(meta.layout_padrao)?.posicoes || []);

    if (isAdmin()) {
      showView('relatorios');
      loadRelatorioDiretoria();
      return;
    }

    if (isGerente()) {
      showView('filiais');
      loadFiliais();
      return;
    }

    showView('dashboard');
    loadDashboard();
  } catch (err) {
    toast(err.message || 'Erro ao carregar o sistema', 'error');
  }
}

async function init() {
  ligarIndicacaoMenuRolavel();
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
  if (saved?.token) {
    authToken = saved.token;
    // Não pinta o header com usuário do localStorage — só após /auth/me
    // (evita ficar preso no último login em cache enquanto a API valida)
    try {
      const me = await fetchJSON(`${API}/auth/me`);
      currentUser = me;
      saveAuth(authToken, me);
      await bootApp();
      return;
    } catch {
      clearAuth();
    }
  }
  showLogin();
}

initPresidente({
  api: API,
  fetchJSON,
  getToken: () => authToken,
  toast,
  podeVer: () => isPresidente(),
  isAdmin,
  navegar: (painel) => showView('presidente', painel),
  abrirView: (view) => {
    if (!isAdmin()) return;
    showView(view);
    if (view === 'saude') loadSaudeDesgaste();
    if (view === 'relatorios') loadRelatorioDiretoria();
  },
});

init();


// ── Saúde e desgaste (presidente) ─────────────────────

let saudeAtual = null;

function mmOuTraco(v) {
  return v == null || v === '' ? '—' : String(v);
}

function textoConsumoSaude(p) {
  if (p.consumo?.mm_por_1000_km != null) return `${p.consumo.mm_por_1000_km} mm/1.000 km`;
  if (p.consumo?.mm_por_100_h != null) return `${p.consumo.mm_por_100_h} mm/100 h`;
  return '—';
}

function textoProjecaoSaude(alvo, unidade) {
  if (!alvo) return '—';
  if (alvo.ja_atingido) return 'Já atingido';
  const uso = alvo.uso_restante != null
    ? `${alvo.uso_restante} ${unidade === 'horas' ? 'h' : 'km'}`
    : '';
  const data = alvo.data ? formatDate(alvo.data) : '';
  return [uso, data].filter(Boolean).join(' · ') || '—';
}

function textoDesgasteSaude(p) {
  const rotulos = {
    uniforme: 'Uniforme',
    uniforme_parcial: 'Uniforme parcial',
    progressivo: 'Progressivo',
    irregular: 'Irregular',
    insuficiente: 'Insuficiente',
  };
  return rotulos[p.desgaste?.padrao] || '—';
}

function textoRecapSaude(p) {
  const e = p.elegibilidade || {};
  if (p.faixa === 'critico' || p.faixa === 'critico_equipamento') return 'Crítico — não apto';
  if (e.candidato_programacao) return 'Programar avaliação';
  if (e.bloqueios?.length) return 'Bloqueado';
  return 'Sem envio';
}

function saudeFiltrado(lista) {
  const filial = document.getElementById('saude-filial')?.value || '';
  const q = (document.getElementById('saude-busca')?.value || '').trim().toLowerCase();
  return (lista || []).filter((p) => {
    if (filial && String(p.filial_id) !== filial) return false;
    if (!q) return true;
    const blob = `${p.placa || ''} ${p.apelido || ''} ${p.numero_fogo || ''} ${p.filial || ''}`.toLowerCase();
    return blob.includes(q);
  });
}

function renderSaudeDesgaste() {
  const rel = saudeAtual;
  if (!rel) return;
  const filial = document.getElementById('saude-filial')?.value || '';
  const busca = (document.getElementById('saude-busca')?.value || '').trim();
  const unidades = (rel.por_unidade || []).filter((u) => !filial || String(u.filial_id) === filial);
  const veiculos = saudeFiltrado(rel.por_veiculo || []);
  const montados = saudeFiltrado((rel.pneus || []).filter((p) => p.status_pneu === 'montado'));
  const compras = (rel.compras_por_medida || []).filter((c) => !filial || String(c.filial_id) === filial);
  const faixas = {
    acompanhamento_normal: 0,
    monitoramento_preventivo: 0,
    programar_recapagem: 0,
    critico: 0,
  };
  for (const p of montados) {
    if (faixas[p.faixa] != null) faixas[p.faixa] += 1;
  }
  const c = rel.consolidado || {};
  document.getElementById('saude-resumo').innerHTML = `
    <div class="stat-card stat-ok"><span class="stat-value">${faixas.acompanhamento_normal}</span><span class="stat-label">Acima de 8 mm</span></div>
    <div class="stat-card stat-alerta"><span class="stat-value">${faixas.monitoramento_preventivo}</span><span class="stat-label">Acima de 5 até 8 mm</span></div>
    <div class="stat-card stat-recap"><span class="stat-value">${faixas.programar_recapagem}</span><span class="stat-label">Programar recapagem</span></div>
    <div class="stat-card stat-critico"><span class="stat-value">${faixas.critico}</span><span class="stat-label">Crítico · não apto</span></div>
    <div class="stat-card"><span class="stat-value">${montados.filter((p) => p.faixa === 'sem_medicao').length}</span><span class="stat-label">Sem medição de banda</span></div>
    <div class="stat-card"><span class="stat-value">${montados.filter((p) => p.desgaste?.padrao === 'irregular').length}</span><span class="stat-label">Desgaste irregular</span></div>
    <div class="stat-card"><span class="stat-value">${montados.filter((p) => p.comparacao?.acima).length}</span><span class="stat-label">Acima da média</span></div>
  `;
  document.getElementById('saude-regras').innerHTML = `
    <div class="compras-banner-inner">
      <div>
        <h3>Régua e segurança</h3>
        <p class="hint">Gerado em ${formatDateTime(rel.gerado_em)}. ${busca || filial ? 'Os cartões seguem o filtro da tela.' : `${c.pneus_montados ?? 0} pneus montados em ${c.filiais ?? 0} unidades.`}</p>
        <ul style="margin:.5rem 0 0;padding-left:1.1rem">
          <li>Acima de 8 mm: acompanhamento normal.</li>
          <li>Acima de 5 até 8 mm: monitoramento preventivo.</li>
          <li>Acima de 3 até 5 mm: programar recapagem, depois de elegibilidade, danos e histórico.</li>
          <li>3 mm ou menos: crítico, retirada e avaliação urgente. Nunca apto automático.</li>
          <li>Dianteira de caminhão continua exigindo pneu novo.</li>
        </ul>
      </div>
    </div>`;
  document.getElementById('saude-limitacoes').innerHTML = `
    <div>
      <h3>Limitações dos dados</h3>
      <ul style="margin:.5rem 0 0;padding-left:1.1rem">
        ${(rel.limitacoes || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}
      </ul>
    </div>`;
  document.querySelector('#saude-tabela-unidades tbody').innerHTML = unidades.map((u) => {
    const fx = u.faixas || {};
    return `<tr>
      <td>${escapeHtml(u.filial)}</td>
      <td>${u.veiculos}</td><td>${u.pneus_montados}</td>
      <td>${fx.acompanhamento_normal || 0}</td>
      <td>${fx.monitoramento_preventivo || 0}</td>
      <td>${fx.programar_recapagem || 0}</td>
      <td>${fx.critico || 0}</td>
      <td>${fx.sem_medicao || 0}</td>
      <td>${u.irregulares || 0}</td>
      <td>${u.acima_da_media || 0}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="10">Nenhuma unidade no filtro.</td></tr>';
  document.querySelector('#saude-tabela-veiculos tbody').innerHTML = veiculos.map((v) => `
    <tr>
      <td>${escapeHtml(v.filial)}</td>
      <td>${escapeHtml(v.placa || '—')}${v.apelido ? ` · ${escapeHtml(v.apelido)}` : ''}</td>
      <td>${escapeHtml(v.tipo || '—')}</td>
      <td>${v.pneus}</td>
      <td><span class="saude-faixa ${escapeHtml(v.pior_faixa || '')}">${escapeHtml(v.pior_faixa_label || '—')}</span></td>
      <td>${mmOuTraco(v.menor_sulco)}</td>
      <td>${v.irregulares}</td>
    </tr>`).join('') || '<tr><td colspan="7">Nenhum veículo no filtro.</td></tr>';
  document.querySelector('#saude-tabela-pneus tbody').innerHTML = montados.map((p) => `
    <tr>
      <td>${escapeHtml(p.filial)}</td>
      <td>${escapeHtml(p.placa || '—')}</td>
      <td>${escapeHtml(p.numero_fogo || p.id)}</td>
      <td>${escapeHtml(p.posicao || '—')}</td>
      <td>${mmOuTraco(p.sulcos?.externo)}</td>
      <td>${mmOuTraco(p.sulcos?.central)}</td>
      <td>${mmOuTraco(p.sulcos?.interno)}</td>
      <td>${mmOuTraco(p.menor_sulco)}</td>
      <td><span class="saude-faixa ${escapeHtml(p.faixa)}">${escapeHtml(p.faixa_label)}</span></td>
      <td>${escapeHtml(textoDesgasteSaude(p))}</td>
      <td title="${escapeHtml(p.consumo?.motivo || p.ciclo_motivo || '')}">${escapeHtml(textoConsumoSaude(p))}</td>
      <td>${escapeHtml(p.regua_recap ? textoProjecaoSaude(p.consumo?.projecao?.alvo_5, p.unidade) : '—')}</td>
      <td>${escapeHtml(p.regua_recap ? textoProjecaoSaude(p.consumo?.projecao?.alvo_3, p.unidade) : '—')}</td>
      <td title="${escapeHtml((p.elegibilidade?.bloqueios || []).concat(p.elegibilidade?.motivo || '').filter(Boolean).join(' · '))}">${escapeHtml(textoRecapSaude(p))}</td>
    </tr>`).join('') || '<tr><td colspan="14">Nenhum pneu montado no filtro.</td></tr>';

  const irregulares = montados.filter((p) => (p.desgaste?.hipoteses || []).length);
  document.getElementById('saude-hipoteses').innerHTML = irregulares.length
    ? irregulares.map((p) => `
      <article class="saude-evolucao-item">
        <strong>${escapeHtml(p.filial)} · ${escapeHtml(p.placa || '—')} · fogo ${escapeHtml(p.numero_fogo || p.id)} · ${escapeHtml(p.posicao || '—')}</strong>
        ${(p.desgaste?.hipoteses || []).map((h) => `<p class="saude-hipotese hint">${escapeHtml(h.texto)}</p>`).join('')}
      </article>`).join('')
    : '<p class="hint">Nenhuma hipótese de desgaste no filtro.</p>';

  const comEvolucao = montados.filter((p) => (p.evolucao || []).some((c) => (c.medicoes || []).length));
  document.getElementById('saude-evolucao').innerHTML = comEvolucao.length
    ? comEvolucao.map((p) => `
      <details class="saude-evolucao-item">
        <summary>${escapeHtml(p.filial)} · ${escapeHtml(p.placa || '—')} · fogo ${escapeHtml(p.numero_fogo || p.id)} · ciclo ${escapeHtml(p.ciclo_label || '—')} · ${escapeHtml(textoConsumoSaude(p))}</summary>
        ${(p.evolucao || []).map((ciclo) => `
          <p><strong>${escapeHtml(ciclo.ciclo_label)}</strong> · ${ciclo.medicoes_total || 0} medição(ões)${ciclo.consumo_motivo ? ` · ${escapeHtml(ciclo.consumo_motivo)}` : ''}</p>
          <table class="historico-table">
            <thead><tr><th>Data</th><th>Ext.</th><th>Cent.</th><th>Int.</th><th>Menor</th><th>Km</th><th>Horas</th></tr></thead>
            <tbody>
              ${(ciclo.medicoes || []).map((m) => `<tr>
                <td>${formatDate(m.data)}</td>
                <td>${mmOuTraco(m.externo)}</td>
                <td>${mmOuTraco(m.central)}</td>
                <td>${mmOuTraco(m.interno)}</td>
                <td>${mmOuTraco(m.menor)}</td>
                <td>${mmOuTraco(m.km)}</td>
                <td>${mmOuTraco(m.horas)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        `).join('')}
      </details>`).join('')
    : '<p class="hint">Sem série de medições separada por ciclo no filtro. Quando o ciclo não está delimitado, a evolução não é montada.</p>';

  const nomeFilial = (id) => (rel.por_unidade || []).find((u) => u.filial_id === id)?.filial || id;
  const semMedidaMontados = montados.filter((p) => !String(p.medida || '').trim()).length;
  const alertaCompras = document.getElementById('saude-alerta-compras');
  if (alertaCompras) {
    alertaCompras.innerHTML = semMedidaMontados
      ? `<p class="saude-alerta-incompleto">${semMedidaMontados} pneu(s) montado(s) estão sem medida neste recorte. A recomendação de compra não é definitiva: o saldo ignora esses pneus e só fecha onde a medida foi informada.</p>`
      : '';
  }
  const thCompra = document.querySelector('#saude-tabela-compras thead th:nth-child(6)');
  if (thCompra) thCompra.textContent = semMedidaMontados ? 'Comprar novo (não definitivo)' : 'Comprar novo';
  document.querySelector('#saude-tabela-compras tbody').innerHTML = compras.map((cpr) => {
    let compraTxt = String(cpr.comprar_novo);
    if (!cpr.medida_informada) compraTxt = `${cpr.necessidade_pneu_novo} sem saldo`;
    else if (cpr.recomendacao_definitiva === false || semMedidaMontados) compraTxt = `${cpr.comprar_novo} · não definitivo`;
    return `
    <tr>
      <td>${escapeHtml(nomeFilial(cpr.filial_id))}</td>
      <td>${escapeHtml(cpr.medida || 'Sem medida')}</td>
      <td>${cpr.estoque_novo}</td>
      <td>${cpr.estoque_recapado}</td>
      <td>${cpr.em_recapagem}</td>
      <td>${escapeHtml(compraTxt)}</td>
      <td>${cpr.candidatos_recap}</td>
      <td>${cpr.avaliacao_urgente}</td>
      <td>novo ${cpr.previsao_novo_90d} · recap ${cpr.previsao_recap_90d}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9">Sem estoque ou demanda no filtro.</td></tr>';
}

async function loadSaudeDesgaste() {
  if (!isPresidente()) return;
  try {
    const rel = await fetchJSON(`${API}/relatorios/saude-desgaste`);
    saudeAtual = rel;
    const select = document.getElementById('saude-filial');
    if (select) {
      const atual = select.value;
      select.innerHTML = '<option value="">Todas as unidades</option>'
        + (rel.por_unidade || []).map((u) => `<option value="${u.filial_id}">${escapeHtml(u.filial)}</option>`).join('');
      if ([...select.options].some((o) => o.value === atual)) select.value = atual;
    }
    renderSaudeDesgaste();
  } catch (err) {
    toast(err.message || 'Falha ao carregar saúde e desgaste', 'error');
  }
}

async function baixarPdfSaude(filialId) {
  if (!isPresidente()) return;
  try {
    toast('Gerando PDF executivo…');
    const filial = filialId != null && filialId !== ''
      ? String(filialId)
      : (document.getElementById('saude-filial')?.value || '');
    const q = filial ? `?filial_id=${encodeURIComponent(filial)}` : '';
    const resp = await fetch(`${API}/relatorios/saude-desgaste.pdf${q}`, {
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
    const filename = match?.[1] || 'saude-desgaste-pneus.pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast('PDF executivo baixado', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('btn-saude-refresh')?.addEventListener('click', () => loadSaudeDesgaste());
document.getElementById('btn-saude-pdf')?.addEventListener('click', () => baixarPdfSaude());
document.getElementById('saude-filial')?.addEventListener('change', () => renderSaudeDesgaste());
document.getElementById('saude-busca')?.addEventListener('input', () => renderSaudeDesgaste());
