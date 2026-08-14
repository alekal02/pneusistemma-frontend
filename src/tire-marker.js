/**
 * Marcação visual do pneu — 4 pontos Esq → Dir na banda de rodagem
 * SVG embutido com IDs únicos por instância (evita sumir o desenho).
 */

let _uid = 0;

function buildTireSvg(uid) {
  const p = `tm${uid}`;
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 520" class="pneu-svg" role="img" aria-label="Banda de rodagem do pneu">
  <defs>
    <linearGradient id="${p}-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#eef2f7"/>
      <stop offset="100%" stop-color="#dbe3ee"/>
    </linearGradient>
    <linearGradient id="${p}-rubber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#52525b"/>
      <stop offset="45%" stop-color="#27272a"/>
      <stop offset="100%" stop-color="#09090b"/>
    </linearGradient>
    <linearGradient id="${p}-face" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#18181b"/>
      <stop offset="20%" stop-color="#3f3f46"/>
      <stop offset="50%" stop-color="#52525b"/>
      <stop offset="80%" stop-color="#3f3f46"/>
      <stop offset="100%" stop-color="#18181b"/>
    </linearGradient>
    <linearGradient id="${p}-groove" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000"/>
      <stop offset="100%" stop-color="#27272a"/>
    </linearGradient>
    <marker id="${p}-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#64748b"/>
    </marker>
  </defs>

  <rect width="420" height="520" fill="url(#${p}-bg)" rx="12"/>
  <text x="210" y="28" text-anchor="middle" font-family="Segoe UI,system-ui,sans-serif"
        font-size="13" font-weight="700" fill="#1e293b">Banda de rodagem — 4 medições (Esq → Dir)</text>

  <!-- Corpo do pneu -->
  <g transform="translate(30, 48)">
    <ellipse cx="180" cy="398" rx="148" ry="14" fill="#0f172a" opacity="0.18"/>

    <path d="M42 36 Q18 36 18 68 L18 305 Q18 348 62 348 L298 348 Q342 348 342 305 L342 68 Q342 36 318 36 Z"
          fill="url(#${p}-rubber)" stroke="#09090b" stroke-width="2.5"/>

    <!-- ombros -->
    <path d="M18 70 L18 305 Q18 336 52 342 L18 342 Q6 326 6 295 L6 82 Q6 54 18 70 Z" fill="#09090b"/>
    <path d="M342 70 L342 305 Q342 336 308 342 L342 342 Q354 326 354 295 L354 82 Q354 54 342 70 Z" fill="#09090b"/>

    <!-- face da banda -->
    <rect x="42" y="52" width="276" height="260" rx="10" fill="url(#${p}-face)" stroke="#09090b" stroke-width="1"/>

    <!-- 4 sulcos -->
    <rect x="78" y="60" width="24" height="244" rx="7" fill="url(#${p}-groove)" stroke="#000"/>
    <rect x="138" y="60" width="24" height="244" rx="7" fill="url(#${p}-groove)" stroke="#000"/>
    <rect x="198" y="60" width="24" height="244" rx="7" fill="url(#${p}-groove)" stroke="#000"/>
    <rect x="258" y="60" width="24" height="244" rx="7" fill="url(#${p}-groove)" stroke="#000"/>

    <!-- blocos da banda -->
    <g fill="#71717a" opacity="0.45">
      <rect x="50" y="68" width="22" height="26" rx="3"/><rect x="50" y="108" width="22" height="26" rx="3"/>
      <rect x="50" y="148" width="22" height="26" rx="3"/><rect x="50" y="188" width="22" height="26" rx="3"/>
      <rect x="50" y="228" width="22" height="26" rx="3"/><rect x="50" y="268" width="22" height="22" rx="3"/>

      <rect x="108" y="68" width="24" height="26" rx="3"/><rect x="108" y="108" width="24" height="26" rx="3"/>
      <rect x="108" y="148" width="24" height="26" rx="3"/><rect x="108" y="188" width="24" height="26" rx="3"/>
      <rect x="108" y="228" width="24" height="26" rx="3"/><rect x="108" y="268" width="24" height="22" rx="3"/>

      <rect x="168" y="68" width="24" height="26" rx="3"/><rect x="168" y="108" width="24" height="26" rx="3"/>
      <rect x="168" y="148" width="24" height="26" rx="3"/><rect x="168" y="188" width="24" height="26" rx="3"/>
      <rect x="168" y="228" width="24" height="26" rx="3"/><rect x="168" y="268" width="24" height="22" rx="3"/>

      <rect x="228" y="68" width="24" height="26" rx="3"/><rect x="228" y="108" width="24" height="26" rx="3"/>
      <rect x="228" y="148" width="24" height="26" rx="3"/><rect x="228" y="188" width="24" height="26" rx="3"/>
      <rect x="228" y="228" width="24" height="26" rx="3"/><rect x="228" y="268" width="24" height="22" rx="3"/>

      <rect x="288" y="68" width="22" height="26" rx="3"/><rect x="288" y="108" width="22" height="26" rx="3"/>
      <rect x="288" y="148" width="22" height="26" rx="3"/><rect x="288" y="188" width="22" height="26" rx="3"/>
      <rect x="288" y="228" width="22" height="26" rx="3"/><rect x="288" y="268" width="22" height="22" rx="3"/>
    </g>

    <!-- mínimo legal -->
    <line x1="42" y1="275" x2="318" y2="275" stroke="#ef4444" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.9"/>
    <text x="324" y="279" font-family="Segoe UI,sans-serif" font-size="10" font-weight="700" fill="#ef4444">1,6 mm</text>

    <text x="48" y="378" font-family="Segoe UI,sans-serif" font-size="12" font-weight="700" fill="#475569">ESQ.</text>
    <line x1="82" y1="374" x2="268" y2="374" stroke="#64748b" stroke-width="2" marker-end="url(#${p}-arrow)"/>
    <text x="278" y="378" font-family="Segoe UI,sans-serif" font-size="12" font-weight="700" fill="#475569">DIR.</text>
  </g>

  <!-- Pontos de medição (sobre os sulcos) -->
  <g id="ponto-externo" class="ponto-medicao" data-sulco="externo" style="cursor:pointer">
    <circle cx="120" cy="198" r="22" fill="#145223" stroke="#fff" stroke-width="3" class="ponto-circulo"/>
    <text x="120" y="203" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="11" font-weight="800" fill="#fff" pointer-events="none">1ª</text>
  </g>
  <g id="ponto-central" class="ponto-medicao" data-sulco="central" style="cursor:pointer">
    <circle cx="180" cy="198" r="22" fill="#2d8a3e" stroke="#fff" stroke-width="3" class="ponto-circulo"/>
    <text x="180" y="203" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="11" font-weight="800" fill="#fff" pointer-events="none">2ª</text>
  </g>
  <g id="ponto-interno" class="ponto-medicao" data-sulco="interno" style="cursor:pointer">
    <circle cx="240" cy="198" r="22" fill="#4caf50" stroke="#fff" stroke-width="3" class="ponto-circulo"/>
    <text x="240" y="203" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="11" font-weight="800" fill="#fff" pointer-events="none">3ª</text>
  </g>
  <g id="ponto-auxiliar" class="ponto-medicao" data-sulco="auxiliar" style="cursor:pointer">
    <circle cx="300" cy="198" r="22" fill="#81c784" stroke="#fff" stroke-width="3" class="ponto-circulo"/>
    <text x="300" y="203" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="11" font-weight="800" fill="#145223" pointer-events="none">4ª</text>
  </g>

  <g id="valores-sulco" font-family="Segoe UI,sans-serif" font-size="12" font-weight="700">
    <text id="valor-externo" x="120" y="158" text-anchor="middle" fill="#145223">-- mm</text>
    <text id="valor-central" x="180" y="158" text-anchor="middle" fill="#2d8a3e">-- mm</text>
    <text id="valor-interno" x="240" y="158" text-anchor="middle" fill="#388e3c">-- mm</text>
    <text id="valor-auxiliar" x="300" y="158" text-anchor="middle" fill="#66bb6a">-- mm</text>
  </g>

  <g font-family="Segoe UI,sans-serif" font-size="11" fill="#475569">
    <rect x="24" y="450" width="372" height="52" rx="8" fill="#fff" stroke="#e2e8f0"/>
    <circle cx="48" cy="468" r="6" fill="#145223"/><text x="60" y="472">1ª MED</text>
    <circle cx="128" cy="468" r="6" fill="#2d8a3e"/><text x="140" y="472">2ª MED</text>
    <circle cx="208" cy="468" r="6" fill="#4caf50"/><text x="220" y="472">3ª MED</text>
    <circle cx="288" cy="468" r="6" fill="#81c784"/><text x="300" y="472">4ª MED</text>
    <text x="48" y="490" font-size="10" fill="#94a3b8">Clique no sulco para focar o campo de medição</text>
  </g>
</svg>`;
}

class TireMarker {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.onSulcoClick = options.onSulcoClick || (() => {});
    this.limites = options.limites || { sulco_critico_mm: 1.6, sulco_alerta_mm: 3.0 };
    this.valores = { externo: null, central: null, interno: null, auxiliar: null };
    this.sulcoAtivo = null;
    this.uid = ++_uid;
    this._init();
  }

  setLimites(limites) {
    this.limites = { ...this.limites, ...limites };
    this.setValores(
      this.valores.externo,
      this.valores.central,
      this.valores.interno,
      this.valores.auxiliar
    );
  }

  _init() {
    if (!this.container) return;
    this.container.innerHTML = buildTireSvg(this.uid);
    this.svg = this.container.querySelector('svg');
    this._bindEvents();
  }

  _bindEvents() {
    this.svg?.querySelectorAll('.ponto-medicao').forEach((ponto) => {
      ponto.addEventListener('click', () => {
        const sulco = ponto.dataset.sulco;
        this._setAtivo(sulco);
        this.onSulcoClick(sulco);
      });
    });
  }

  _setAtivo(sulco) {
    this.sulcoAtivo = sulco;
    this.svg?.querySelectorAll('.ponto-medicao').forEach((p) => {
      p.classList.toggle('ativo', p.dataset.sulco === sulco);
    });
  }

  _cor(mm) {
    if (mm == null) return '#64748b';
    if (mm <= this.limites.sulco_critico_mm) return '#dc2626';
    if (mm <= this.limites.sulco_alerta_mm) return '#d97706';
    return '#166534';
  }

  setValor(sulco, mm) {
    this.valores[sulco] = mm;
    const el = this.svg?.querySelector(`#valor-${sulco}`);
    if (el) {
      el.textContent = mm != null ? `${mm} mm` : '-- mm';
      el.setAttribute('fill', this._cor(mm));
    }
    const ponto = this.svg?.querySelector(`[data-sulco="${sulco}"] .ponto-circulo`);
    if (ponto && mm != null) {
      const base = { externo: '#145223', central: '#2d8a3e', interno: '#4caf50', auxiliar: '#81c784' }[sulco];
      if (mm <= this.limites.sulco_critico_mm) ponto.setAttribute('fill', '#dc2626');
      else if (mm <= this.limites.sulco_alerta_mm) ponto.setAttribute('fill', '#d97706');
      else ponto.setAttribute('fill', base || '#2d8a3e');
    }
  }

  setValores(externo, central, interno, auxiliar = null) {
    this.setValor('externo', externo);
    this.setValor('central', central);
    this.setValor('interno', interno);
    this.setValor('auxiliar', auxiliar);
  }

  getValores() {
    return { ...this.valores };
  }

  reset() {
    this.valores = { externo: null, central: null, interno: null, auxiliar: null };
    this.setValores(null, null, null, null);
    this._setAtivo(null);
  }
}

export { TireMarker };
