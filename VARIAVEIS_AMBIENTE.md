# Variáveis de Ambiente — PneuSistemma

Guia para configurar **Render** (backend) e **Vercel** (frontend).

Substitua os placeholders pelas URLs reais depois do primeiro deploy:

| Serviço | Exemplo de URL |
|---------|----------------|
| Backend (Render) | `https://pneusistemma-backend.onrender.com` |
| Frontend (Vercel) | `https://pneusistemma-frontend.vercel.app` |
| WuzAPI | `https://seu-wuzapi.exemplo.com` |

---

## 1. Vercel (Frontend)

Em **Project → Settings → Environment Variables**, crie:

| Variável | Ambiente | Valor | Obrigatória |
|----------|----------|-------|-------------|
| `VITE_API_URL` | Production, Preview, Development | `https://pneusistemma-backend.onrender.com/api` | **Sim** |

### Observações Vercel

- O prefixo `VITE_` é obrigatório (Vite só expõe variáveis com esse prefixo).
- Após alterar `VITE_API_URL`, faça um **Redeploy** (variáveis entram no *build*).
- Framework preset: **Vite** (ou Other). Build: `npm run build`. Output: `dist`.
- O arquivo `vercel.json` já faz rewrite SPA (`/veiculo-acesso-rapido` etc.).

### Root Directory na Vercel

Se o repositório for só o frontend (`pneusistemma-frontend`), deixe Root Directory vazio / `.`.

---

## 2. Render (Backend)

Em **Dashboard → seu Web Service → Environment**, crie:

### Obrigatórias

| Variável | Valor exemplo | Descrição |
|----------|---------------|-----------|
| `NODE_ENV` | `production` | Ambiente |
| `HOST` | `0.0.0.0` | Escuta pública (Render) |
| `PORT` | *(automático)* | Render define sozinho — **não fixe** se o painel já injetar |
| `JWT_SECRET` | string longa e aleatória | Assinatura dos tokens de login |
| `JWT_EXPIRES_IN` | `7d` | Validade do JWT |
| `ADMIN_USER` | `admin` | Login do admin inicial |
| `ADMIN_PASSWORD` | senha forte | Senha do admin (troque após o 1º login) |
| `CORS_ORIGIN` | `https://pneusistemma-frontend.vercel.app` | Origem do front (várias: separar por vírgula) |
| `FRONTEND_URL` | `https://pneusistemma-frontend.vercel.app` | Links do WhatsApp (acesso rápido) |
| `DB_PATH` | `/var/data/pneus.db` | Caminho do SQLite no disco persistente |

### WhatsApp (WuzAPI) — necessárias para chatbot/alertas

| Variável | Valor exemplo | Descrição |
|----------|---------------|-----------|
| `WUZAPI_BASE_URL` | `https://seu-wuzapi.exemplo.com` | URL pública do WuzAPI (**não** use `localhost` no Render) |
| `WUZAPI_TOKEN` | token do usuário da instância | Header `token` nas chamadas `/chat/send/text` |
| `WUZAPI_ADMIN_TOKEN` | token admin do WuzAPI | Gestão de usuários / admin |
| `WUZAPI_WEBHOOK_PUBLIC_URL` | `https://pneusistemma-backend.onrender.com/api/webhook/whatsapp` | URL que o WuzAPI chama ao receber mensagem |
| `WUZAPI_WEBHOOK_SECRET` | *(opcional)* | HMAC do webhook, se configurado no WuzAPI |
| `GERENTE_COMPRAS_WHATSAPP` | `5511999999999` | Fallback WhatsApp do gerente de compras (DDI+DDD+número, sem `+`) |

### Opcionais

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `ALLOW_VERCEL_PREVIEWS` | `true` | Libera CORS para `*.vercel.app` (previews) |
| `SULCO_MINIMO_MM` | `3.0` | Limite crítico de sulco (mm) |
| `SULCO_ALERTA_MM` | `8.0` | Limite de alerta de sulco (mm) |
| `NODE_VERSION` | `22` | Versão do Node (engines do projeto: ≥ 22) |

---

## 3. Disco persistente no Render (SQLite)

O banco é **SQLite**. Sem disco, os dados **somem** a cada redeploy.

1. No serviço Web do Render → **Disks**
2. Monte em `/var/data` (ex.: 1 GB)
3. Defina `DB_PATH=/var/data/pneus.db`

---

## 4. Ordem recomendada de deploy

1. **Render** — suba o backend e anote a URL (`https://….onrender.com`).
2. Configure as envs do backend (CORS/FRONTEND ainda podem ser placeholder).
3. **Vercel** — suba o frontend com `VITE_API_URL=https://….onrender.com/api`.
4. Volte no Render e ajuste:
   - `CORS_ORIGIN` = URL da Vercel
   - `FRONTEND_URL` = URL da Vercel
   - `WUZAPI_WEBHOOK_PUBLIC_URL` = `https://….onrender.com/api/webhook/whatsapp`
5. No WuzAPI, aponte o webhook para a mesma URL pública do Render (evento `Message`).
6. Teste: `GET https://….onrender.com/api/health` e login no front.

---

## 5. Checklist rápido

### Render
- [ ] `JWT_SECRET` forte
- [ ] `ADMIN_PASSWORD` alterada
- [ ] Disco em `/var/data` + `DB_PATH`
- [ ] `CORS_ORIGIN` = URL Vercel
- [ ] `FRONTEND_URL` = URL Vercel
- [ ] `WUZAPI_BASE_URL` acessível da internet
- [ ] `WUZAPI_TOKEN` preenchido
- [ ] `WUZAPI_WEBHOOK_PUBLIC_URL` apontando para este backend
- [ ] Health: `/api/health` OK

### Vercel
- [ ] `VITE_API_URL` = `https://SEU-BACKEND.onrender.com/api`
- [ ] Redeploy após salvar a variável
- [ ] Site abre e faz login
- [ ] Rotas SPA (`/veiculo-acesso-rapido`) não dão 404

---

## 6. Exemplos prontos para colar

### Vercel

```text
VITE_API_URL=https://pneusistemma-backend.onrender.com/api
```

### Render

```text
NODE_ENV=production
HOST=0.0.0.0
JWT_SECRET=troque-por-um-segredo-longo
JWT_EXPIRES_IN=7d
ADMIN_USER=admin
ADMIN_PASSWORD=troque-esta-senha
CORS_ORIGIN=https://pneusistemma-frontend.vercel.app
FRONTEND_URL=https://pneusistemma-frontend.vercel.app
DB_PATH=/var/data/pneus.db
ALLOW_VERCEL_PREVIEWS=true
SULCO_MINIMO_MM=3.0
SULCO_ALERTA_MM=8.0
WUZAPI_BASE_URL=https://seu-wuzapi.exemplo.com
WUZAPI_TOKEN=
WUZAPI_ADMIN_TOKEN=
WUZAPI_WEBHOOK_PUBLIC_URL=https://pneusistemma-backend.onrender.com/api/webhook/whatsapp
WUZAPI_WEBHOOK_SECRET=
GERENTE_COMPRAS_WHATSAPP=5511999999999
```

> **Importante:** `localhost` / `host.docker.internal` **não funcionam** no Render nem na Vercel. WuzAPI e webhook precisam de URLs públicas HTTPS.
