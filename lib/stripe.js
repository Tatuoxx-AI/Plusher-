'use strict';
/* Pagamentos com cartão, Apple Pay e Google Pay via Stripe Checkout (página de pagamento do Stripe).
   Os dados do cartão nunca passam pela loja. Sem dependências: usa a API REST do Stripe.

   Variáveis (deixar vazias até ter as chaves — a opção fica escondida no site):
     STRIPE_SECRET_KEY       sk_live_… / sk_test_… (ou chave restrita rk_…)
     STRIPE_WEBHOOK_SECRET   whsec_… do endpoint  https://<site>/api/stripe/webhook
                             (eventos: checkout.session.completed, checkout.session.async_payment_succeeded,
                              checkout.session.async_payment_failed, checkout.session.expired)
   Apple Pay e Google Pay aparecem sozinhos no Checkout quando estão ativos em
   Stripe → Definições → Métodos de pagamento. */
const crypto = require('crypto');

const secret = () => process.env.STRIPE_SECRET_KEY || '';
const enabled = () => /^(sk|rk)_(live|test)_/.test(secret());
const webhookEnabled = () => /^whsec_/.test(process.env.STRIPE_WEBHOOK_SECRET || '');

// codifica objetos aninhados no formato application/x-www-form-urlencoded do Stripe (a[b][0][c]=…)
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

async function stripeApi(path, body, idempotencyKey) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: form(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Stripe:', r.status, data?.error?.message);
    throw Object.assign(new Error('Não foi possível iniciar o pagamento. Tenta outro método ou contacta-nos.'), { status: 502 });
  }
  return data;
}

const cents = v => Math.round(Number(v) * 100);

// cria a sessão de pagamento com os valores JÁ calculados no servidor
async function createCheckout(order, origin) {
  const items = order.desconto
    ? [{ price_data: { currency: 'eur', unit_amount: cents(order.total), product_data: { name: `Encomenda ${order.oid}`, description: order.itens.map(i => `${i.qty}× ${i.nome} (${i.size})`).join(', ').slice(0, 480) } }, quantity: 1 }]
    : order.itens.map(i => ({ price_data: { currency: 'eur', unit_amount: cents(i.preco), product_data: { name: `${i.nome} — ${i.size}`.slice(0, 250) } }, quantity: i.qty }));
  const session = await stripeApi('checkout/sessions', {
    mode: 'payment',
    line_items: items,
    customer_email: order.cliente.email,
    client_reference_id: order.oid,
    metadata: { oid: order.oid },
    payment_intent_data: { metadata: { oid: order.oid }, description: `PLUSHER ${order.oid}` },
    locale: 'pt',
    success_url: `${origin}/?pago=${order.oid}#saco`,
    cancel_url: `${origin}/?cancelado=${order.oid}#saco`,
  }, 'checkout-' + order.oid);
  return { id: session.id, url: session.url };
}

// valida a assinatura "Stripe-Signature: t=…,v1=…" (HMAC-SHA256 de "t.corpo"), com 5 min de tolerância
function verifyWebhook(raw, header) {
  const sec = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!webhookEnabled() || !header) return null;
  const parts = Object.fromEntries(String(header).split(',').map(s => s.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').filter(s => s.trim().startsWith('v1=')).map(s => s.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return null;
  const expected = crypto.createHmac('sha256', sec).update(`${t}.${raw.toString('utf8')}`).digest();
  const ok = sigs.some(s => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) return null;
  try { return JSON.parse(raw.toString('utf8')); } catch { return null; }
}

module.exports = { enabled, webhookEnabled, createCheckout, verifyWebhook };
