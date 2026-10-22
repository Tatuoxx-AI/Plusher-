# PLUSHER — loja online

Loja de streetwear PLUSHER: site (`site/index.html`) + servidor protegido. O mesmo código corre no PC (`server.js`, dados em ficheiros) e na Vercel (`api/index.js`, dados no Vercel Blob privado).

## Arrancar no PC

```bash
npm install
npm start
```

Abre em http://localhost:5195 (muda com a variável `PORT`).

Para criar ou mudar o login do gerente: `npm run acesso`, depois reinicia o servidor.

## Vercel

- Função única `api/index.js`; o `vercel.json` encaminha todas as rotas para ela. Os ficheiros de `public/` (logo, modelo 3D) são servidos diretamente.
- Os dados ficam num **Blob store privado** ligado ao projeto, que cria a variável `BLOB_READ_WRITE_TOKEN`:
  `loja/`, `encomendas/`, `uploads/` e o registo de tentativas de login.
- Variáveis necessárias (tipo *sensitive*): `SESSION_SECRET`, `ADMIN_USER_HASH`, `ADMIN_SALT`, `ADMIN_HASH` (os mesmos valores que o `npm run acesso` escreve em `data/admin.json`) e `NODEJS_HELPERS=0`.

## Pagamentos

- **MBWay e transferência**: manuais. O cliente paga e o gerente confirma no painel. A loja recebe um email a cada encomenda (`RESEND_API_KEY`).
- **Cartão, Apple Pay e Google Pay** via Stripe Checkout (página segura do Stripe; os dados do cartão nunca passam pela loja). Fica **escondido** até configurar:
  1. Na Vercel, define `STRIPE_SECRET_KEY` (`sk_live_…`, ou `sk_test_…` para testar).
  2. No Stripe, em Developers → Webhooks, cria um endpoint `https://plusher.vercel.app/api/stripe/webhook` com os eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` e `checkout.session.expired`. Copia o segredo para `STRIPE_WEBHOOK_SECRET` (`whsec_…`).
  3. Em Stripe → Definições → Métodos de pagamento, ativa o Apple Pay e o Google Pay.
  4. Volta a publicar. O painel (separador "Loja & pagamentos") mostra se está tudo ativo.

  Com o webhook ligado, a encomenda passa sozinha a "Pago" e a loja recebe o email "Encomenda PAGA". Os valores são sempre calculados no servidor, e cada webhook é validado pela assinatura do Stripe.

## Área do gerente

Clica **3 vezes seguidas na gota** do topo do site → login → painel (produtos, loja e pagamentos, drop, cupões, encomendas, backup).

## Segurança

- A senha só fica guardada como hash **scrypt**, e o login é verificado no servidor.
- A sessão é um token assinado (HMAC) num cookie `HttpOnly` + `SameSite=Strict` + `Secure`, válido 8 h. Mudar a senha termina todas as sessões.
- 5 tentativas de login erradas bloqueiam esse IP durante 15 min.
- Proteção CSRF: os pedidos que alteram dados exigem o cabeçalho `X-Plusher` e têm de vir da mesma origem.
- Preços, cupões e totais são **recalculados no servidor**, e os códigos de cupão nunca chegam ao browser.
- Tudo o que o painel grava é validado (URLs, cores, textos). Os uploads só aceitam JPG, PNG ou WEBP verdadeiros.
- O site envia cabeçalhos de segurança: CSP, `X-Frame-Options`, `nosniff`, HSTS.

## Dados locais (`data/`, fora do git)

| Ficheiro | Conteúdo |
|---|---|
| `loja.json` | produtos e configuração (criado a partir do `site/index.html` no primeiro arranque) |
| `encomendas.json` | encomendas |
| `admin.json` | hash do acesso do gerente |
| `session.secret` | segredo das sessões |
| `uploads/`, `backups/` | fotos e últimas 30 versões da loja |
