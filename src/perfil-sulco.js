/**
 * Perfil visual do sulco (4 pontos) + diagnóstico
 */

const CORES = {
  ok: '#22c55e',
  alerta: '#f59e0b',
  critico: '#ef4444',
  sem_dado: '#94a3b8',
};

function corPonto(mm, limites) {
  if (mm == null) return CORES.sem_dado;
  if (mm <= limites.sulco_critico_mm) return CORES.critico;
  if (mm <= limites.sulco_alerta_mm) return CORES.alerta;
  return CORES.ok;
}

/**
 * Renderiza SVG do perfil de desgaste Esq → Dir
 */
export function renderPerfilSulco(container, pontos, limites = {}, diagnostico = null) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;

  const vals = [
    pontos.externo ?? pontos[0] ?? null,
    pontos.central ?? pontos[1] ?? null,
    pontos.interno ?? pontos[2] ?? null,
    pontos.auxiliar ?? pontos[3] ?? null,
  ];

  const labels = ['1ª', '2ª', '3ª', '4ª'];
  const maxY = Math.max(limites.sulco_novo_mm || 17, ...vals.filter((v) => v != null), 1);
  const W = 280;
  const H = 120;
  const pad = { t: 16, r: 12, b: 28, l: 28 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const xs = vals.map((_, i) => pad.l + (i / Math.max(vals.length - 1, 1)) * plotW);
  const ys = vals.map((v) => {
    if (v == null) return null;
    return pad.t + plotH - (v / maxY) * plotH;
  });

  const pathPts = xs
    .map((x, i) => (ys[i] != null ? `${i === 0 || ys.slice(0, i).every((y) => y == null) ? 'M' : 'L'}${x},${ys[i]}` : null))
    .filter(Boolean)
    .join(' ');

  // Linhas de referência
  const yCrit = pad.t + plotH - ((limites.sulco_critico_mm || 1.6) / maxY) * plotH;
  const yAlerta = pad.t + plotH - ((limites.sulco_alerta_mm || 3) / maxY) * plotH;
  const yRecap = pad.t + plotH - ((limites.sulco_recap_mm || 5) / maxY) * plotH;

  const dots = xs.map((x, i) => {
    if (ys[i] == null) return '';
    const c = corPonto(vals[i], limites);
    return `<circle cx="${x}" cy="${ys[i]}" r="5" fill="${c}" stroke="#fff" stroke-width="1.5"/>
      <text x="${x}" y="${ys[i] - 8}" text-anchor="middle" font-size="9" fill="#334155">${vals[i]}</text>`;
  }).join('');

  const axisLabels = xs.map((x, i) =>
    `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#64748b">${labels[i]}</text>`
  ).join('');

  const diagHtml = diagnostico
    ? `<p class="perfil-diag"><strong>${diagnostico.label || diagnostico}</strong>${diagnostico.desc ? ` — ${diagnostico.desc}` : ''}</p>`
    : '';

  el.innerHTML = `
    <div class="perfil-sulco">
      <svg viewBox="0 0 ${W} ${H}" class="perfil-svg" role="img" aria-label="Perfil de desgaste do sulco">
        <line x1="${pad.l}" y1="${yCrit}" x2="${W - pad.r}" y2="${yCrit}" stroke="#ef4444" stroke-dasharray="4 3" stroke-width="1" opacity="0.7"/>
        <line x1="${pad.l}" y1="${yAlerta}" x2="${W - pad.r}" y2="${yAlerta}" stroke="#f59e0b" stroke-dasharray="4 3" stroke-width="1" opacity="0.7"/>
        <line x1="${pad.l}" y1="${yRecap}" x2="${W - pad.r}" y2="${yRecap}" stroke="#6366f1" stroke-dasharray="3 3" stroke-width="1" opacity="0.5"/>
        <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + plotH}" stroke="#cbd5e1"/>
        <line x1="${pad.l}" y1="${pad.t + plotH}" x2="${W - pad.r}" y2="${pad.t + plotH}" stroke="#cbd5e1"/>
        ${pathPts ? `<path d="${pathPts}" fill="none" stroke="#0f172a" stroke-width="2"/>` : ''}
        ${dots}
        ${axisLabels}
        <text x="4" y="${pad.t + 4}" font-size="8" fill="#94a3b8">mm</text>
      </svg>
      <div class="perfil-labels">
        <span>ESQ</span><span>DIR</span>
      </div>
      ${diagHtml}
    </div>
  `;
}
