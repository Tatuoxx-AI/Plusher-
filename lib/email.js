'use strict';
/* Emails de encomenda via Resend (https://resend.com), sem dependências.
   - RESEND_API_KEY      chave da conta (segredo)
   - RESEND_FROM         remetente; sem domínio verificado no Resend só funciona "PLUSHER <onboarding@resend.dev>",
                         e nesse modo o Resend só entrega ao email do dono da conta.
   - RESEND_CLIENTE=1    envia também confirmação ao cliente (exige domínio verificado em RESEND_FROM).
   Sem RESEND_API_KEY não faz nada. Um erro no email nunca impede a encomenda. */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = v => Number(v).toFixed(2).replace('.', ',') + ' €';

async function send({ to, subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM || 'PLUSHER <onboarding@resend.dev>', to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { ok: true };
  } finally { clearTimeout(timer); }
}

function orderTable(o) {
  const rows = o.itens.map(i => `<tr><td style="padding:6px 0">${i.qty}× ${esc(i.nome)} <span style="color:#777">(${esc(i.size)})</span></td><td style="padding:6px 0;text-align:right">${eur(i.total)}</td></tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    <tr><td style="padding-top:10px;border-top:1px solid #ddd">Subtotal</td><td style="padding-top:10px;border-top:1px solid #ddd;text-align:right">${eur(o.subtotal)}</td></tr>
    ${o.desconto ? `<tr><td>Cupão ${esc(o.cupao)}</td><td style="text-align:right">−${eur(o.desconto)}</td></tr>` : ''}
    <tr><td>Envio</td><td style="text-align:right">${o.envioGratis ? 'Grátis' : 'A calcular'}</td></tr>
    <tr><td style="font-weight:700;font-size:16px;padding-top:6px">Total</td><td style="font-weight:700;font-size:16px;padding-top:6px;text-align:right">${eur(o.total)}</td></tr></table>`;
}
const shell = (title, body) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111">
  <div style="background:#050505;color:#FAFF00;padding:18px 22px;font-weight:900;letter-spacing:.08em;font-size:20px">PLUSHER</div>
  <div style="padding:22px;border:1px solid #eee;border-top:0"><h2 style="margin:0 0 14px;font-size:18px">${title}</h2>${body}</div>
  <p style="font-size:11px;color:#999;text-align:center">Always in motion.</p></div>`;

// email para a loja a cada nova encomenda (+ confirmação ao cliente, se ativado)
async function notifyOrder(o, config) {
  const pag = o.pagamento === 'mbway' ? `MBWay (${esc(config.mbway)})` : `Transferência — IBAN ${esc(config.iban)}`;
  const jobs = [send({
    to: config.email,
    replyTo: o.cliente.email,
    subject: `Nova encomenda ${o.oid} — ${eur(o.total)}`,
    html: shell(`Nova encomenda ${esc(o.oid)}`, `${orderTable(o)}
      <p style="margin:18px 0 6px;font-weight:700">Cliente</p>
      <p style="margin:0;font-size:14px;line-height:1.6">${esc(o.cliente.nome)}<br>${esc(o.cliente.tel)} · ${esc(o.cliente.email)}<br>${esc(o.cliente.morada)}</p>
      <p style="margin:14px 0 0;font-size:14px"><b>Pagamento:</b> ${pag} — a aguardar confirmação.</p>
      <p style="font-size:12px;color:#777">Responde a este email para falar diretamente com o cliente. Confirma o pagamento no painel do gerente.</p>`),
  })];
  if (process.env.RESEND_CLIENTE === '1') jobs.push(send({
    to: o.cliente.email,
    replyTo: config.email,
    subject: `Recebemos a tua encomenda ${o.oid}`,
    html: shell(`Obrigado, ${esc(o.cliente.nome.split(' ')[0])}!`, `<p style="font-size:14px">A tua encomenda <b>${esc(o.oid)}</b> ficou registada.</p>${orderTable(o)}
      <p style="font-size:14px;margin-top:16px">Paga <b>${eur(o.total)}</b> por ${pag}${o.pagamento === 'transferencia' ? ` (${esc(config.titular)})` : ''} e usa <b>${esc(o.oid)}</b> como descrição.
      Depois responde a este email com o comprovativo.</p><p style="font-size:13px;color:#555">${esc(config.envioInfo)}</p>`),
  }));
  const res = await Promise.allSettled(jobs);
  for (const r of res) if (r.status === 'rejected') console.error('Email da encomenda falhou:', r.reason?.message || r.reason);
}

module.exports = { notifyOrder };
