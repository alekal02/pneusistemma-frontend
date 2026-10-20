import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const bloco = app.match(/function isAdmin\(\) \{[\s\S]*?\n\}/);
assert.ok(bloco, 'isAdmin ausente');
assert.match(bloco[0], /return currentUser\?\.papel === 'admin';/);
assert.equal(bloco[0].includes('isPresidente'), false);
assert.match(app, /if \(isPresidente\(\)\) \{\s*await abrirDashboardExecutivo\(\);\s*return;/);

console.log('app-presidente: ok');
