# PneuSistemma — Frontend

Interface web (Vite + HTML/CSS/JS) para controle de desgaste de pneus.

**Deploy:** [Vercel](https://vercel.com)  
**Repositório backend:** https://github.com/alekal02/pneusistemma-backend

## Local

```bash
cp .env.example .env
npm install
npm run dev
```

App: http://localhost:5173  

Em desenvolvimento, o Vite faz proxy de `/api` para `http://localhost:3000`.

## Vercel

1. Import este repositório
2. Framework: Vite (ou Other)
3. Build: `npm run build` · Output: `dist`
4. Variável obrigatória:

```text
VITE_API_URL=https://SEU-BACKEND.onrender.com/api
```

5. Redeploy após salvar a variável

O `vercel.json` já configura rewrite SPA (ex.: `/veiculo-acesso-rapido`).

## Variáveis de ambiente

Documento completo: **[VARIAVEIS_AMBIENTE.md](./VARIAVEIS_AMBIENTE.md)**
