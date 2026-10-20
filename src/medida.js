/**
 * Mesma conta de saude-desgaste.js no backend.
 * Só iguala a grafia na leitura. Não grava a medida.
 */
export function normalizarMedida(medida) {
  let t = String(medida || '').trim().replace(/\s+/g, '').replace(/,/g, '.').toLowerCase();
  if (!t) return null;
  // 275/80/22.5 é a mesma medida métrica que 275/80R22.5: a barra ocupa o lugar do R.
  t = t.replace(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/, '$1/$2r$3');
  // 12-16-5 é o aro 16.5 escrito com hífen no lugar do ponto. Não mexe em 22 contra 22.5.
  t = t.replace(/^(\d+)-(\d+)-(\d)$/, '$1-$2.$3');
  return t;
}
