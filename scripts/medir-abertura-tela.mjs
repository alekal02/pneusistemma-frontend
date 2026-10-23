/**
 * Mede login → Início em desktop e celular, contra a API local.
 * Atraso artificial só em GET /dashboard/desenhos, para ver se os indicadores esperam.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL('C:/Users/Kal/AppData/Local/Temp/pneu-fase5/node_modules/playwright-core/index.mjs').href);

const BASE = process.env.FRONT || 'http://127.0.0.1:5185';
const OUT = 'C:/Users/Kal/AppData/Local/Temp/pneu-fase5';
const ATRASO_DESENHOS = Number(process.env.ATRASO_DESENHOS || 900);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function caminho(url) {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

async function medir(browser, { nome, largura, altura, atrasarDesenhos, falharDesenhos, atrasarBoot = false }) {
  const page = await browser.newPage({ viewport: { width: largura, height: altura } });
  const pedidos = [];
  const erros = [];
  page.on('pageerror', (err) => erros.push(`page: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') erros.push(`console: ${msg.text()}`);
  });
  page.on('request', (req) => {
    if (!req.url().includes('/api/')) return;
    pedidos.push({ t: Date.now(), fase: 'ini', path: caminho(req.url()) });
  });
  page.on('response', (res) => {
    if (!res.url().includes('/api/')) return;
    pedidos.push({ t: Date.now(), fase: 'fim', status: res.status(), path: caminho(res.url()) });
  });
  page.on('requestfailed', (req) => {
    if (!req.url().includes('/api/')) return;
    if (falharDesenhos && req.url().includes('/dashboard/desenhos')) return;
    erros.push(`rede: ${caminho(req.url())} ${req.failure()?.errorText || ''}`);
  });

  if (atrasarDesenhos || falharDesenhos) {
    await page.route('**/api/dashboard/desenhos**', async (route) => {
      if (falharDesenhos) {
        await route.abort('failed');
        return;
      }
      await new Promise((r) => setTimeout(r, ATRASO_DESENHOS));
      await route.continue();
    });
  }
  if (atrasarBoot) {
    const segurar = async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    };
    await page.route('**/api/configuracoes', (route) => (
      route.request().method() === 'GET' ? segurar(route) : route.continue()
    ));
    await page.route('**/api/veiculos/meta**', segurar);
    await page.route('**/api/dashboard/resumo**', segurar);
  }

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#login-user', 'filial_homolog');
  await page.fill('#login-senha', 'teste-local-frota');
  const tLogin = Date.now();
  await page.click('#form-login button[type="submit"]');

  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('#stat-veiculos');
      const view = document.querySelector('#view-dashboard');
      return view?.classList.contains('active')
        && el
        && el.textContent
        && el.textContent !== '—';
    }, null, { timeout: 20000 });
  } catch (err) {
    const info = await page.evaluate(() => ({
      url: location.href,
      stat: document.querySelector('#stat-veiculos')?.textContent,
      view: document.querySelector('#view-dashboard')?.className,
      login: document.querySelector('#app-login')?.className,
      erro: document.querySelector('#login-erro')?.textContent,
      estado: document.querySelector('#dashboard-estado')?.textContent,
    }));
    erros.push(`timeout indicadores: ${JSON.stringify(info)} (${err.message})`);
  }
  const tIndicadores = Date.now() - tLogin;

  let tDesenhos = null;
  let svg = 0;
  if (!falharDesenhos) {
    try {
    await page.waitForSelector('#dashboard-lista .frota-truck-svg [data-pneu-id]', { timeout: 20000, state: 'attached' });
      tDesenhos = Date.now() - tLogin;
    } catch (err) {
      erros.push(`timeout desenhos: ${err.message}`);
    }
    svg = await page.locator('#dashboard-lista .frota-truck-svg [data-pneu-id]').count();
  } else {
    await page.waitForTimeout(400);
    svg = await page.locator('#dashboard-lista .frota-truck-svg [data-pneu-id]').count();
  }

  const stat = await page.locator('#stat-veiculos').innerText();
  const estado = await page.locator('#dashboard-estado').innerText().catch(() => '');
  const cards = await page.locator('#dashboard-lista .veiculo-card').count();
  const lista = await page.locator('#dashboard-lista').innerText();
  const shell = await page.locator('#view-dashboard').evaluate((el) => el.classList.contains('active'));
  await page.screenshot({ path: `${OUT}/${nome}.png`, fullPage: true });
  await page.close();

  const desdeLogin = pedidos.filter((p) => p.t >= tLogin - 20);
  const contagem = {};
  for (const p of desdeLogin) {
    if (p.fase !== 'ini') continue;
    const chave = p.path.split('?')[0];
    contagem[chave] = (contagem[chave] || 0) + 1;
  }
  const fim = (trecho) => desdeLogin.find((p) => p.fase === 'fim' && p.path.includes(trecho));
  const ini = (trecho) => desdeLogin.find((p) => p.fase === 'ini' && p.path.includes(trecho));
  const resumoFim = fim('/dashboard/resumo');
  const desenhosIni = ini('/dashboard/desenhos');
  const metaIni = ini('/veiculos/meta');
  const configIni = ini('/configuracoes');
  const resumoIni = ini('/dashboard/resumo');

  return {
    nome,
    largura,
    altura,
    utilizavel_ms: tIndicadores,
    indicadores_ms: tIndicadores,
    desenhos_ms: tDesenhos,
    stat_veiculos: stat,
    cards,
    svg,
    shell,
    estado: estado.slice(0, 180),
    lista_tem_prioridade: /Prioridade da semana|Atrasados|Pendentes|Medir hoje|Nenhum veículo/.test(lista),
    contagem,
    sobreposicao: {
      config_e_meta: Boolean(configIni && metaIni && resumoIni
        && configIni.t <= resumoIni.t + 40
        && metaIni.t <= resumoIni.t + 40),
      resumo_antes_de_desenhos: Boolean(resumoFim && desenhosIni && resumoFim.t <= desenhosIni.t + 30),
    },
    erros,
    inicios_ms: desdeLogin.filter((p) => p.fase === 'ini').map((p) => ({
      path: p.path.split('?')[0],
      ms: p.t - tLogin,
    })),
    duracao_total_ms: Date.now() - t0,
  };
}

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
});

const cenarios = [
  ['desktop', 1280, 800],
  ['celular', 390, 844],
];
const relatorio = { atraso_desenhos_ms: ATRASO_DESENHOS, cenarios: [] };
const somente = process.env.SOMENTE || '';
for (const [nome, largura, altura] of cenarios) {
  const lista = [
    { sufixo: 'natural', atrasarDesenhos: false, falharDesenhos: false, atrasarBoot: false },
    { sufixo: 'desenhos-lentos', atrasarDesenhos: true, falharDesenhos: false, atrasarBoot: false },
    { sufixo: 'desenhos-falham', atrasarDesenhos: false, falharDesenhos: true, atrasarBoot: false },
    { sufixo: 'boot-lento', atrasarDesenhos: true, falharDesenhos: false, atrasarBoot: true },
  ];
  for (const item of lista) {
    const titulo = `${nome}-${item.sufixo}`;
    if (somente && titulo !== somente) continue;
    relatorio.cenarios.push(await medir(browser, {
      nome: titulo,
      largura,
      altura,
      ...item,
    }));
  }
}
await browser.close();
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/relatorio.json`, JSON.stringify(relatorio, null, 2));
console.log(JSON.stringify(relatorio, null, 2));
