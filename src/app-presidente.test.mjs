import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const bloco = app.match(/function isAdmin\(\) \{[\s\S]*?\n\}/);
assert.ok(bloco, 'isAdmin ausente');
assert.match(bloco[0], /return currentUser\?\.papel === 'admin';/);
assert.equal(bloco[0].includes('isPresidente'), false);
assert.match(app, /if \(isPresidente\(\)\) \{\s*showView\('presidente', 'visao'\);\s*return;/);
assert.match(app, /if \(isAdmin\(\)\) \{\s*showView\('relatorios'\);\s*loadRelatorioDiretoria\(\);/);
assert.match(app, /podeVer: \(\) => isPresidente\(\)/);
assert.equal(app.includes('abrirDashboardExecutivo'), false);
assert.equal(app.includes('exibirExecutivo'), false);

const presidente = fs.readFileSync(new URL('./presidente.js', import.meta.url), 'utf8');
assert.match(presidente, /\/presidente\/visao/);
assert.match(presidente, /\/presidente\/evolucao/);
assert.match(presidente, /\/presidente\/detalhe/);
assert.match(presidente, /\/presidente\/visao\.pdf/);
assert.match(presidente, /\/presidente\/diagnostico-filiais/);
assert.match(presidente, /htmlBarrasFiliais\(state\.resumo\.filiais/);
assert.match(presidente, /incluir_matriz: false/);
assert.equal(presidente.includes('classificar'), false);

console.log('app-presidente: ok');
