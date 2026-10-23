export const AUTH_KEY = 'pneu_auth';

export function descartarTokenLegado(storageLocal) {
  try {
    storageLocal?.removeItem(AUTH_KEY);
  } catch {
    /* armazenamento indisponível */
  }
}

export function lerSessaoAba(storageAba) {
  try {
    const raw = storageAba?.getItem(AUTH_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.token) return null;
    return data;
  } catch {
    try { storageAba?.removeItem(AUTH_KEY); } catch { /* ignore */ }
    return null;
  }
}

export function gravarSessaoAba(storageAba, storageLocal, token, usuario) {
  descartarTokenLegado(storageLocal);
  storageAba.setItem(AUTH_KEY, JSON.stringify({ token, usuario }));
}

export function limparSessaoAba(storageAba, storageLocal) {
  try { storageAba?.removeItem(AUTH_KEY); } catch { /* ignore */ }
  descartarTokenLegado(storageLocal);
}

export function sidDoToken(token) {
  try {
    const parte = String(token || '').split('.')[1];
    if (!parte) return null;
    const b64 = parte.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    return json.sid || null;
  } catch {
    return null;
  }
}

/** Só a aba com o mesmo sid encerra. Outro login na mesma origem permanece. */
export function avisoEncerraEstaAba(sidAba, sidAviso) {
  if (!sidAba || !sidAviso) return false;
  return sidAba === sidAviso;
}
