/**
 * Diagrama de eixos/pneus com silhueta transparente do caminhão
 * Suporta posições vazias (montar do estoque) e pneus montados.
 */

const STATUS_CORES = {
  ok: { fill: '#16a34a', stroke: '#14532d' },
  alerta: { fill: '#d97706', stroke: '#92400e' },
  critico: { fill: '#dc2626', stroke: '#7f1d1d' },
  sem_dado: { fill: '#94a3b8', stroke: '#475569' },
  vazio: { fill: '#f1f5f9', stroke: '#94a3b8' },
};

const COORDS_PNEU = {
  '1E': { cx: 170, cy: 145, w: 54, h: 68, short: '1E' },
  '1D': { cx: 430, cy: 145, w: 54, h: 68, short: '1D' },
  '2E': { cx: 170, cy: 320, w: 54, h: 68, short: '2E' },
  '2D': { cx: 430, cy: 320, w: 54, h: 68, short: '2D' },
  '2EE': { cx: 130, cy: 320, w: 48, h: 62, short: '2EE' },
  '2EI': { cx: 192, cy: 320, w: 48, h: 62, short: '2EI' },
  '2DI': { cx: 408, cy: 320, w: 48, h: 62, short: '2DI' },
  '2DE': { cx: 470, cy: 320, w: 48, h: 62, short: '2DE' },
  '3E': { cx: 170, cy: 420, w: 54, h: 68, short: '3E' },
  '3D': { cx: 430, cy: 420, w: 54, h: 68, short: '3D' },
  '3EE': { cx: 130, cy: 420, w: 48, h: 62, short: '3EE' },
  '3EI': { cx: 192, cy: 420, w: 48, h: 62, short: '3EI' },
  '3DI': { cx: 408, cy: 420, w: 48, h: 62, short: '3DI' },
  '3DE': { cx: 470, cy: 420, w: 48, h: 62, short: '3DE' },

  DE: { cx: 170, cy: 145, w: 54, h: 68, short: 'DE' },
  DD: { cx: 430, cy: 145, w: 54, h: 68, short: 'DD' },
  D: { cx: 300, cy: 145, w: 54, h: 68, short: 'D' },

  E2EE: { cx: 130, cy: 320, w: 48, h: 62, short: 'E2EE' },
  E2EI: { cx: 192, cy: 320, w: 48, h: 62, short: 'E2EI' },
  E2DI: { cx: 408, cy: 320, w: 48, h: 62, short: 'E2DI' },
  E2DE: { cx: 470, cy: 320, w: 48, h: 62, short: 'E2DE' },

  E3EE: { cx: 130, cy: 420, w: 48, h: 62, short: 'E3EE' },
  E3EI: { cx: 192, cy: 420, w: 48, h: 62, short: 'E3EI' },
  E3DI: { cx: 408, cy: 420, w: 48, h: 62, short: 'E3DI' },
  E3DE: { cx: 470, cy: 420, w: 48, h: 62, short: 'E3DE' },

  TE: { cx: 170, cy: 360, w: 54, h: 68, short: 'TE' },
  TD: { cx: 430, cy: 360, w: 54, h: 68, short: 'TD' },
  TEE: { cx: 130, cy: 360, w: 48, h: 62, short: 'TEE' },
  TEI: { cx: 192, cy: 360, w: 48, h: 62, short: 'TEI' },
  TDI: { cx: 408, cy: 360, w: 48, h: 62, short: 'TDI' },
  TDE: { cx: 470, cy: 360, w: 48, h: 62, short: 'TDE' },
  T: { cx: 300, cy: 360, w: 54, h: 68, short: 'T' },

  ESTEPE: { cx: 530, cy: 250, w: 44, h: 58, short: 'EST' },
};

/** Trator 4 pneus: dianteiros menores, traseiros maiores */
const COORDS_TRATOR = {
  '1E': { cx: 185, cy: 145, w: 44, h: 56, short: '1E' },
  '1D': { cx: 415, cy: 145, w: 44, h: 56, short: '1D' },
  '2E': { cx: 150, cy: 320, w: 74, h: 90, short: '2E' },
  '2D': { cx: 450, cy: 320, w: 74, h: 90, short: '2D' },
};

function coordsPneu(codigo, index, total, layoutId) {
  if (String(layoutId || '') === 'trator_4' && COORDS_TRATOR[codigo]) {
    return COORDS_TRATOR[codigo];
  }
  return COORDS_PNEU[codigo] || coordsFallback(index, total);
}

function coordsFallback(index, total) {
  const cols = Math.min(total, 4);
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    cx: 140 + col * 110,
    cy: 140 + row * 100,
    w: 48,
    h: 62,
    short: String(index + 1),
  };
}

function statusLabel(status) {
  return {
    ok: 'OK',
    alerta: 'Alerta',
    critico: 'Crítico',
    sem_dado: 'Sem medição',
    vazio: 'Vazio',
  }[status] || status;
}

function eixosPresentes(posicoes) {
  const pos = new Set(posicoes);
  const tem = (...codes) => codes.some((c) => pos.has(c));
  return {
    e1: tem('1E', '1D', 'DE', 'DD', 'D'),
    e2: tem('2E', '2D', '2EE', '2EI', '2DI', '2DE', 'E2EE', 'E2EI', 'E2DI', 'E2DE', 'TEE', 'TEI', 'TDI', 'TDE', 'TE', 'TD', 'T'),
    e3: tem('3E', '3D', '3EE', '3EI', '3DI', '3DE', 'E3EE', 'E3EI', 'E3DI', 'E3DE'),
  };
}

function renderPneu(p, n, coord, cores, sulco, nome, ativo) {
  const { cx, cy, w, h, short } = coord;
  const x = cx - w / 2;
  const y = cy - h / 2;
  return `
    <g class="pneu-click${ativo}" data-pneu-id="${p.id}" data-posicao="${p.posicao}" style="cursor:pointer">
      <rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="10"
            fill="none" stroke="${ativo ? '#2563eb' : 'transparent'}" stroke-width="3" class="pneu-halo"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"
            fill="${cores.fill}" stroke="${cores.stroke}" stroke-width="2"
            class="pneu-ellipse pneu-status-ring"/>
      <line x1="${cx - w * 0.22}" y1="${y + 8}" x2="${cx - w * 0.22}" y2="${y + h - 8}"
            stroke="#fff" stroke-width="2" opacity="0.35" pointer-events="none"/>
      <line x1="${cx}" y1="${y + 8}" x2="${cx}" y2="${y + h - 8}"
            stroke="#fff" stroke-width="2" opacity="0.35" pointer-events="none"/>
      <line x1="${cx + w * 0.22}" y1="${y + 8}" x2="${cx + w * 0.22}" y2="${y + h - 8}"
            stroke="#fff" stroke-width="2" opacity="0.35" pointer-events="none"/>
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="12" font-weight="800"
            fill="#fff" pointer-events="none">${short}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="11" font-weight="700"
            fill="#fff" pointer-events="none">${sulco}</text>
      <title>${n}. ${nome} — ${sulco} mm</title>
    </g>`;
}

function renderSlotVazio(posicao, coord, nome, ativo) {
  const { cx, cy, w, h, short } = coord;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const cores = STATUS_CORES.vazio;
  return `
    <g class="slot-vazio${ativo}" data-posicao="${posicao}" style="cursor:pointer">
      <rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="10"
            fill="none" stroke="${ativo ? '#2563eb' : 'transparent'}" stroke-width="3" class="pneu-halo"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"
            fill="${cores.fill}" stroke="${cores.stroke}" stroke-width="2" stroke-dasharray="5 4"
            class="pneu-ellipse pneu-status-ring"/>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="11" font-weight="800"
            fill="#64748b" pointer-events="none">${short}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="16" font-weight="700"
            fill="#94a3b8" pointer-events="none">+</text>
      <title>${nome} — vazio (montar do estoque)</title>
    </g>`;
}

/** Silhueta transparente vista de cima (cabine + carroceria) */
function silhuetaCaminhao(eixos) {
  const bodyEnd = eixos.e3 ? 455 : eixos.e2 ? 355 : 210;
  const rear = bodyEnd + 40;
  return `
  <g class="truck-ghost" pointer-events="none">
    <rect x="215" y="198" width="170" height="${bodyEnd - 198}" rx="12"
          fill="#64748b" fill-opacity="0.08" stroke="#475569" stroke-width="2.2" stroke-opacity="0.55"/>
    <line x1="215" y1="${198 + (bodyEnd - 198) * 0.33}" x2="385" y2="${198 + (bodyEnd - 198) * 0.33}"
          stroke="#64748b" stroke-width="1" stroke-opacity="0.25"/>
    <line x1="215" y1="${198 + (bodyEnd - 198) * 0.66}" x2="385" y2="${198 + (bodyEnd - 198) * 0.66}"
          stroke="#64748b" stroke-width="1" stroke-opacity="0.25"/>
    <path d="M215 ${bodyEnd} L385 ${bodyEnd} Q400 ${bodyEnd} 400 ${bodyEnd + 12}
             L400 ${rear - 8} Q400 ${rear} 385 ${rear} L215 ${rear} Q200 ${rear} 200 ${rear - 8}
             L200 ${bodyEnd + 12} Q200 ${bodyEnd} 215 ${bodyEnd} Z"
          fill="#64748b" fill-opacity="0.06" stroke="#475569" stroke-width="2" stroke-opacity="0.5"/>
    <path d="M225 48 L375 48 Q395 48 395 68 L395 178 Q395 192 380 192 L220 192 Q205 192 205 178
             L205 68 Q205 48 225 48 Z"
          fill="#94a3b8" fill-opacity="0.14" stroke="#475569" stroke-width="2.2" stroke-opacity="0.6"/>
    <rect x="235" y="62" width="130" height="48" rx="10"
          fill="#38bdf8" fill-opacity="0.18" stroke="#64748b" stroke-width="1.4" stroke-opacity="0.5"/>
    <rect x="245" y="122" width="110" height="52" rx="6"
          fill="#64748b" fill-opacity="0.06" stroke="#64748b" stroke-width="1" stroke-opacity="0.3"/>
    <rect x="188" y="88" width="14" height="32" rx="4"
          fill="#64748b" fill-opacity="0.2" stroke="#475569" stroke-width="1.5" stroke-opacity="0.55"/>
    <rect x="398" y="88" width="14" height="32" rx="4"
          fill="#64748b" fill-opacity="0.2" stroke="#475569" stroke-width="1.5" stroke-opacity="0.55"/>
  </g>`;
}

/** Silhueta vista de cima — capô à frente, corpo curto, traseira larga */
function silhuetaTrator() {
  return `
  <g class="truck-ghost" pointer-events="none">
    <path d="M250 52 L350 52 Q368 52 368 70 L368 175 Q368 192 350 192 L250 192 Q232 192 232 175
             L232 70 Q232 52 250 52 Z"
          fill="#94a3b8" fill-opacity="0.14" stroke="#475569" stroke-width="2.2" stroke-opacity="0.6"/>
    <rect x="248" y="68" width="104" height="42" rx="8"
          fill="#38bdf8" fill-opacity="0.18" stroke="#64748b" stroke-width="1.4" stroke-opacity="0.5"/>
    <rect x="258" y="118" width="84" height="58" rx="6"
          fill="#64748b" fill-opacity="0.08" stroke="#64748b" stroke-width="1" stroke-opacity="0.35"/>
    <rect x="230" y="198" width="140" height="155" rx="16"
          fill="#64748b" fill-opacity="0.08" stroke="#475569" stroke-width="2.2" stroke-opacity="0.55"/>
    <path d="M238 353 L362 353 Q378 353 378 368 L378 392 Q378 408 362 408 L238 408 Q222 408 222 392
             L222 368 Q222 353 238 353 Z"
          fill="#64748b" fill-opacity="0.06" stroke="#475569" stroke-width="2" stroke-opacity="0.5"/>
  </g>`;
}

function ehLayoutTrator(layoutId) {
  return String(layoutId || '').startsWith('trator');
}

function buildSchemaSvg(pneusSvg, posicoes, layoutId = null) {
  const eixos = eixosPresentes(posicoes);
  const trator = ehLayoutTrator(layoutId);
  const lines = [];
  if (eixos.e1) {
    const x1 = trator ? 185 : 170;
    const x2 = trator ? 415 : 430;
    lines.push(`<line x1="${x1}" y1="145" x2="${x2}" y2="145" stroke="#94a3b8" stroke-width="5" stroke-linecap="round" opacity="0.5"/>`);
    lines.push(`<text x="300" y="108" text-anchor="middle" class="axis-label">Eixo 1</text>`);
  }
  if (eixos.e2) {
    const x1 = trator ? 150 : 130;
    const x2 = trator ? 450 : 470;
    lines.push(`<line x1="${x1}" y1="320" x2="${x2}" y2="320" stroke="#94a3b8" stroke-width="5" stroke-linecap="round" opacity="0.5"/>`);
    lines.push(`<text x="300" y="288" text-anchor="middle" class="axis-label">Eixo 2</text>`);
  }
  if (eixos.e3 && !trator) {
    lines.push(`<line x1="130" y1="420" x2="470" y2="420" stroke="#94a3b8" stroke-width="5" stroke-linecap="round" opacity="0.5"/>`);
    lines.push(`<text x="300" y="388" text-anchor="middle" class="axis-label">Eixo 3</text>`);
  }

  const h = eixos.e3 && !trator ? 540 : eixos.e2 ? 440 : 280;
  const silhueta = trator ? silhuetaTrator() : silhuetaCaminhao(eixos);
  const aria = trator ? 'Trator — clique no pneu ou posição vazia' : 'Caminhão — clique no pneu ou posição vazia';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 ${h}" class="truck-svg"
     role="img" aria-label="${aria}">
  <style>
    .axis-label { font-family: Segoe UI, system-ui, sans-serif; font-size: 11px; font-weight: 600; fill: #94a3b8; }
    .orient { font-family: Segoe UI, system-ui, sans-serif; font-size: 11px; font-weight: 700; fill: #94a3b8; }
  </style>
  <rect width="600" height="${h}" fill="#f8fafc" rx="12"/>

  <text x="300" y="28" text-anchor="middle" class="orient">▲ FRENTE</text>
  <text x="22" y="${h / 2}" text-anchor="middle" class="orient" transform="rotate(-90 22 ${h / 2})">ESQ</text>
  <text x="578" y="${h / 2}" text-anchor="middle" class="orient" transform="rotate(90 578 ${h / 2})">DIR</text>

  ${silhueta}

  ${lines.join('\n  ')}

  <g transform="translate(20, ${h - 24})" font-family="Segoe UI,system-ui,sans-serif" font-size="11">
    <circle cx="6" cy="0" r="5" fill="#16a34a"/><text x="16" y="4" fill="#64748b">OK</text>
    <circle cx="56" cy="0" r="5" fill="#d97706"/><text x="66" y="4" fill="#64748b">Alerta</text>
    <circle cx="118" cy="0" r="5" fill="#dc2626"/><text x="128" y="4" fill="#64748b">Crítico</text>
    <circle cx="188" cy="0" r="5" fill="#94a3b8"/><text x="198" y="4" fill="#64748b">Sem medição</text>
    <rect x="300" y="-6" width="12" height="12" rx="2" fill="#f1f5f9" stroke="#94a3b8" stroke-dasharray="2 2"/>
    <text x="318" y="4" fill="#64748b">Vazio</text>
  </g>

  ${pneusSvg}
</svg>`;
}

function buildPickerItem(p, n, cores, sulco, nome, ativo) {
  if (p.vazio) {
    return `
    <button type="button" class="tire-pick tire-pick-vazio${ativo}" data-posicao="${p.posicao}" title="${nome} — montar">
      <span class="tire-pick-num" style="background:#94a3b8">+</span>
      <span class="tire-pick-body">
        <span class="tire-pick-name">${nome}</span>
        <span class="tire-pick-meta">
          <span class="tire-pick-code">${p.posicao}</span>
          <span class="tire-pick-status" style="color:#64748b">Montar do estoque</span>
        </span>
      </span>
    </button>`;
  }
  return `
    <button type="button" class="tire-pick${ativo}" data-pneu-id="${p.id}" title="${nome}">
      <span class="tire-pick-num" style="background:${cores.fill}">${n}</span>
      <span class="tire-pick-body">
        <span class="tire-pick-name">${nome}</span>
        <span class="tire-pick-meta">
          <span class="tire-pick-code">${p.posicao}</span>
          <span class="tire-pick-sulco">${sulco} mm</span>
          <span class="tire-pick-status" style="color:${cores.stroke}">${statusLabel(p.status_sulco)}</span>
        </span>
      </span>
    </button>`;
}

function renderSlotPreview(posicao, coord, nome, papel) {
  const { cx, cy, w, h, short } = coord;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const cores = {
    direcional: { fill: '#1b5e2a', stroke: '#145223', label: 'Dir.' },
    tracao: { fill: '#4caf50', stroke: '#2d8a3e', label: 'Trac.' },
    estepe: { fill: '#94a3b8', stroke: '#475569', label: 'Est.' },
  }[papel] || { fill: '#64748b', stroke: '#334155', label: '' };

  return `
    <g pointer-events="none">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"
            fill="${cores.fill}" stroke="${cores.stroke}" stroke-width="2"/>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="11" font-weight="800"
            fill="#fff">${short}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="9" font-weight="700"
            fill="#fff" opacity="0.9">${cores.label}</text>
      <title>${nome} — ${papel === 'tracao' ? 'eixo de tração' : papel === 'direcional' ? 'dianteiro' : papel}</title>
    </g>`;
}

/**
 * Preview estático do layout (cadastro de veículo) — mostra eixos e tipo (dianteiro/tração).
 */
export function renderLayoutPreview(container, {
  posicoes = [],
  labels = {},
  papeis = {},
  layoutId = null,
} = {}) {
  if (!container) return;
  if (!posicoes.length) {
    container.innerHTML = '<p class="hint">Selecione o tipo do veículo para ver o desenho dos eixos.</p>';
    return;
  }

  const slotsSvg = posicoes.map((codigo, i) => {
    const coord = coordsPneu(codigo, i, posicoes.length, layoutId);
    const nome = labels[codigo] || codigo;
    const papel = papeis[codigo] || 'tracao';
    return renderSlotPreview(codigo, coord, nome, papel);
  }).join('');

  const eixos = eixosPresentes(posicoes);
  const roleEixo = (codes) => {
    const presentes = codes.filter((c) => posicoes.includes(c));
    if (!presentes.length) return '';
    const roles = presentes.map((c) => papeis[c]).filter(Boolean);
    const n = presentes.length;
    const tipoEixo = n >= 4 ? '4 pneus' : '2 pneus';
    if (roles.includes('direcional')) return `Dianteiro · ${tipoEixo}`;
    if (roles.includes('tracao')) return `Tração · ${tipoEixo}`;
    return tipoEixo;
  };

  const eixosData = eixosPresentes(posicoes);
  const trator = ehLayoutTrator(layoutId);
  const lines = [];
  if (eixosData.e1) {
    const role = roleEixo(['1E', '1D', 'DE', 'DD', 'D']);
    const x1 = trator ? 185 : 170;
    const x2 = trator ? 415 : 430;
    lines.push(`<line x1="${x1}" y1="145" x2="${x2}" y2="145" stroke="#94a3b8" stroke-width="5" stroke-linecap="round" opacity="0.5"/>`);
    lines.push(`<text x="300" y="108" text-anchor="middle" class="axis-label">Eixo 1${role ? ` · ${role}` : ''}</text>`);
  }
  if (eixosData.e2) {
    const role = roleEixo(['2E', '2D', '2EE', '2EI', '2DI', '2DE', 'E2EE', 'E2EI', 'E2DI', 'E2DE', 'TEE', 'TEI', 'TDI', 'TDE', 'TE', 'TD', 'T']);
    const x1 = trator ? 150 : 130;
    const x2 = trator ? 450 : 470;
    lines.push(`<line x1="${x1}" y1="320" x2="${x2}" y2="320" stroke="#94a3b8" stroke-width="5" stroke-linecap="round" opacity="0.5"/>`);
    lines.push(`<text x="300" y="288" text-anchor="middle" class="axis-label">Eixo 2${role ? ` · ${role}` : ''}</text>`);
  }
  if (eixosData.e3 && !trator) {
    const role = roleEixo(['3E', '3D', '3EE', '3EI', '3DI', '3DE', 'E3EE', 'E3EI', 'E3DI', 'E3DE']);
    lines.push(`<line x1="130" y1="420" x2="470" y2="420" stroke="#94a3b8" stroke-width="5" stroke-linecap="round" opacity="0.5"/>`);
    lines.push(`<text x="300" y="388" text-anchor="middle" class="axis-label">Eixo 3${role ? ` · ${role}` : ''}</text>`);
  }

  const h = eixosData.e3 && !trator ? 540 : eixosData.e2 ? 440 : 280;
  const nDir = posicoes.filter((p) => (papeis[p] || '') === 'direcional').length;
  const nTrac = posicoes.filter((p) => (papeis[p] || '') === 'tracao').length;
  const silhueta = trator ? silhuetaTrator() : silhuetaCaminhao(eixos);

  container.innerHTML = `
    <div class="layout-diagram-wrap">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 ${h}" class="truck-svg layout-preview-svg"
           role="img" aria-label="Vista de cima — eixos do veículo">
        <style>
          .axis-label { font-family: Segoe UI, system-ui, sans-serif; font-size: 11px; font-weight: 600; fill: #64748b; }
          .orient { font-family: Segoe UI, system-ui, sans-serif; font-size: 11px; font-weight: 700; fill: #94a3b8; }
        </style>
        <rect width="600" height="${h}" fill="#f8fafc" rx="12"/>
        <text x="300" y="28" text-anchor="middle" class="orient">▲ FRENTE</text>
        ${silhueta}
        ${lines.join('\n        ')}
        ${slotsSvg}
        <g transform="translate(20, ${h - 22})" font-family="Segoe UI,system-ui,sans-serif" font-size="11">
          <rect x="0" y="-8" width="12" height="12" rx="2" fill="#1b5e2a"/>
          <text x="18" y="2" fill="#475569">Dianteiro (${nDir})</text>
          <rect x="130" y="-8" width="12" height="12" rx="2" fill="#4caf50"/>
          <text x="148" y="2" fill="#475569">Tração (${nTrac})</text>
        </g>
      </svg>
      <p class="hint layout-diagram-hint">${trator
        ? 'Trator: dianteiros menores e traseiros maiores. A medição usa faixas de sulco próprias.'
        : 'Confira os eixos de tração (verde claro) e o dianteiro (verde escuro). Troque o layout se o caminhão for diferente.'}</p>
    </div>`;
}

export class TruckDiagram {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.onPneuClick = options.onPneuClick || (() => {});
    this.onSlotClick = options.onSlotClick || (() => {});
    this.pickerHint = options.pickerHint
      || 'Clique no pneu para medir ou no slot vazio para montar:';
    this.pneus = [];
    this.slots = [];
    this.labels = {};
    this.posicoesLayout = [];
    this.layoutId = options.layoutId || null;
    this.pneuAtivo = null;
    this.slotAtivo = null;
  }

  /**
   * @param {Array} pneus montados
   * @param {Object} labels mapa posicao → nome
   * @param {string[]} posicoesLayout códigos do layout (slots)
   * @param {{ layoutId?: string }} [opts]
   */
  render(pneus, labels = {}, posicoesLayout = null, opts = {}) {
    this.pneus = pneus || [];
    this.labels = labels;
    if (opts.layoutId !== undefined) this.layoutId = opts.layoutId || null;
    if (posicoesLayout?.length) {
      this.posicoesLayout = posicoesLayout;
    } else {
      this.posicoesLayout = this.pneus.map((p) => p.posicao);
    }
    this._paint();
  }

  _buildSlots() {
    const byPos = new Map(this.pneus.map((p) => [p.posicao, p]));
    return this.posicoesLayout.map((codigo, i) => {
      const montado = byPos.get(codigo);
      if (montado) return { ...montado, vazio: false, _idx: i };
      return {
        id: null,
        posicao: codigo,
        posicao_label: this.labels[codigo] || codigo,
        status_sulco: 'vazio',
        menor_sulco: null,
        vazio: true,
        _idx: i,
      };
    });
  }

  _paint() {
    this.slots = this._buildSlots();
    let nMontado = 0;
    const items = this.slots.map((p) => {
      const coord = coordsPneu(p.posicao, p._idx, this.slots.length, this.layoutId);
      const nome = this.labels[p.posicao] || p.posicao_label || p.posicao;
      if (p.vazio) {
        const ativo = this.slotAtivo === p.posicao ? ' pneu-ativo' : '';
        const ativoBtn = this.slotAtivo === p.posicao ? ' is-active' : '';
        return {
          marcador: renderSlotVazio(p.posicao, coord, nome, ativo),
          picker: buildPickerItem(p, '+', STATUS_CORES.vazio, '—', nome, ativoBtn),
        };
      }
      nMontado += 1;
      const cores = STATUS_CORES[p.status_sulco] || STATUS_CORES.sem_dado;
      const sulco = p.menor_sulco != null ? `${p.menor_sulco}` : '—';
      const ativo = this.pneuAtivo === p.id ? ' pneu-ativo' : '';
      const ativoBtn = this.pneuAtivo === p.id ? ' is-active' : '';
      return {
        marcador: renderPneu(p, nMontado, coord, cores, sulco, nome, ativo),
        picker: buildPickerItem(p, nMontado, cores, sulco, nome, ativoBtn),
      };
    });

    this.container.innerHTML = `
      <div class="truck-diagram-inner">
        ${buildSchemaSvg(items.map((x) => x.marcador).join(''), this.posicoesLayout, this.layoutId)}
        <div class="tire-picker" role="listbox" aria-label="Selecionar posição">
          <p class="tire-picker-hint">${this.pickerHint}</p>
          <div class="tire-picker-grid">
            ${items.map((x) => x.picker).join('')}
          </div>
        </div>
      </div>`;

    this.svg = this.container.querySelector('svg');
    this._bindEvents();
  }

  _bindEvents() {
    this.container.querySelectorAll('.pneu-click').forEach((g) => {
      g.addEventListener('click', () => {
        const id = parseInt(g.dataset.pneuId, 10);
        this.setAtivo(id);
        const pneu = this.pneus.find((p) => p.id === id);
        if (pneu) this.onPneuClick(pneu);
      });
    });

    this.container.querySelectorAll('.slot-vazio').forEach((g) => {
      g.addEventListener('click', () => {
        const pos = g.dataset.posicao;
        this.setSlotAtivo(pos);
        this.onSlotClick(pos);
      });
    });

    this.container.querySelectorAll('.tire-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.posicao && !btn.dataset.pneuId) {
          this.setSlotAtivo(btn.dataset.posicao);
          this.onSlotClick(btn.dataset.posicao);
          return;
        }
        const id = parseInt(btn.dataset.pneuId, 10);
        this.setAtivo(id);
        const pneu = this.pneus.find((p) => p.id === id);
        if (pneu) this.onPneuClick(pneu);
      });
    });
  }

  setAtivo(pneuId) {
    this.pneuAtivo = pneuId;
    this.slotAtivo = null;
    this.container.querySelectorAll('.pneu-click').forEach((g) => {
      g.classList.toggle('pneu-ativo', parseInt(g.dataset.pneuId, 10) === pneuId);
    });
    this.container.querySelectorAll('.slot-vazio').forEach((g) => {
      g.classList.remove('pneu-ativo');
    });
    this.container.querySelectorAll('.tire-pick').forEach((btn) => {
      btn.classList.toggle('is-active', parseInt(btn.dataset.pneuId, 10) === pneuId);
    });
  }

  setSlotAtivo(posicao) {
    this.slotAtivo = posicao;
    this.pneuAtivo = null;
    this.container.querySelectorAll('.pneu-click').forEach((g) => g.classList.remove('pneu-ativo'));
    this.container.querySelectorAll('.slot-vazio').forEach((g) => {
      g.classList.toggle('pneu-ativo', g.dataset.posicao === posicao);
    });
    this.container.querySelectorAll('.tire-pick').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.posicao === posicao && !btn.dataset.pneuId);
    });
  }

  atualizarPneu(pneuAtualizado, labels) {
    const idx = this.pneus.findIndex((p) => p.id === pneuAtualizado.id);
    if (idx >= 0) this.pneus[idx] = { ...this.pneus[idx], ...pneuAtualizado };
    if (labels) this.labels = labels;
    const ativo = this.pneuAtivo;
    this._paint();
    if (ativo) this.setAtivo(ativo);
  }
}
