'use strict';
/* =====================================================================
   PLUSHER — lógica do servidor, partilhada entre:
     - server.js      → no PC / VPS, dados em ficheiros (lib/store-fs.js)
     - api/index.js   → na Vercel, dados no Vercel Blob privado (lib/store-blob.js)
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'site', 'index.html');
const SESSION_MS = 8 * 60 * 60 * 1000; // sessão do gerente: 8 horas
const COOKIE = 'plusher_sid';
const ESTADOS = ['aguardando_pagamento', 'pago', 'enviado', 'cancelado'];

/* ===================== RESPOSTAS ===================== */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self' mailto:",
    "object-src 'none'",
  ].join('; '),
};
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}
const NOSTORE = { 'Cache-Control': 'no-store' };
const fail = (res, status, erro) => send(res, status, { erro }, NOSTORE);
const err = (status, msg) => Object.assign(new Error(msg), { status });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(err(413, 'Pedido demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req, limit = 200 * 1024) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw err(400, 'JSON inválido'); }
}

/* ===================== VALIDAÇÃO ===================== */
const str = (v, max, def = '') => (typeof v === 'string' ? v.trim().slice(0, max) : def);
const bool = v => v === true;
const num = (v, min, max, def = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
// URLs aceites: https://… ou /uploads/… sem aspas, espaços ou < > (evita injeção no HTML)
const URL_RE = /^(https:\/\/[^\s"'<>`\\]{3,2000}|\/uploads\/[a-z0-9-]{8,64}\.(jpg|png|webp))$/i;
const url = v => (typeof v === 'string' && URL_RE.test(v.trim()) ? v.trim() : '');
const urls = (v, max = 20) => (Array.isArray(v) ? v.map(url).filter(Boolean).slice(0, max) : []);
const color = v => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : '');

function sanitizeLoja(d) {
  if (!d || typeof d !== 'object' || !d.config || !Array.isArray(d.produtos)) throw err(400, 'Dados inválidos');
  const c = d.config;
  const categorias = (Array.isArray(c.categorias) ? c.categorias : []).slice(0, 12)
    .map(k => ({ nome: str(k?.nome, 40), imagem: url(k?.imagem), ativa: bool(k?.ativa) })).filter(k => k.nome);
  const cupoes = {};
  for (const [k, v] of Object.entries(c.cupoes || {})) {
    const code = String(k).toUpperCase().trim();
    if (/^[A-Z0-9_-]{2,30}$/.test(code)) { const p = Math.round(num(v, 0, 90)); if (p > 0) cupoes[code] = p; }
  }
  const dropData = str(c.drop?.data, 25);
  const config = {
    marca: str(c.marca, 40, 'PLUSHER'),
    slogan: str(c.slogan, 80),
    subtitulo: str(c.subtitulo, 200),
    sobre: str(c.sobre, 2000),
    anuncio: str(c.anuncio, 200),
    marquee: (Array.isArray(c.marquee) ? c.marquee : []).map(x => str(x, 40)).filter(Boolean).slice(0, 12),
    email: str(c.email, 120),
    instagram: url(c.instagram),
    mbway: str(c.mbway, 30),
    iban: str(c.iban, 50),
    titular: str(c.titular, 80),
    envioGratisAcima: num(c.envioGratisAcima, 0, 100000, 100),
    envioInfo: str(c.envioInfo, 500),
    heroImg: url(c.heroImg),
    marcaImg: url(c.marcaImg),
    cupoes,
    drop: {
      nome: str(c.drop?.nome, 80),
      descricao: str(c.drop?.descricao, 1000),
      data: dropData && !isNaN(new Date(dropData)) ? dropData : '',
      imagens: urls(c.drop?.imagens, 4),
    },
    categorias,
  };
  const ids = new Set();
  const produtos = d.produtos.slice(0, 200).map(p => {
    let id = str(p?.id, 80).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'produto-' + crypto.randomBytes(3).toString('hex');
    while (ids.has(id)) id += '-2';
    ids.add(id);
    const out = {
      id,
      nome: str(p.nome, 150, 'Produto'),
      categoria: str(p.categoria, 40),
      preco: Math.round(num(p.preco, 0, 100000) * 100) / 100,
      tamanhos: (Array.isArray(p.tamanhos) ? p.tamanhos : []).map(t => str(t, 12)).filter(Boolean).slice(0, 15),
      imagens: urls(p.imagens),
      descricao: str(p.descricao, 3000),
    };
    if (bool(p.emBreve)) out.emBreve = true;
    if (bool(p.destaque)) out.destaque = true;
    const cor = color(p.cor); if (cor) out.cor = cor;
    const arte = str(p.arte, 40); if (arte) out.arte = arte;
    if (Array.isArray(p.specs)) out.specs = p.specs.filter(Array.isArray).map(s => [str(s[0], 20), str(s[1], 60)]).filter(s => s[0]).slice(0, 8);
    if (!out.tamanhos.length) out.tamanhos = ['Único'];
    return out;
  });
  return { config, produtos };
}

// Na primeira execução, os dados iniciais vêm do CONFIG/PRODUTOS escritos no próprio index.html.
function seedFromTemplate() {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const start = html.indexOf('const IMG = {');
  const end = html.indexOf('/* Dados guardados pelo painel');
  if (start < 0 || end < 0) throw new Error('Não encontrei CONFIG/PRODUTOS no index.html');
  const ctx = {};
  vm.runInNewContext(html.slice(start, end) + '\n;this.out = { config: CONFIG, produtos: PRODUTOS };', ctx, { timeout: 1000 });
  return sanitizeLoja(JSON.parse(JSON.stringify(ctx.out)));
}

/* ===================== LIMITES (memória, por instância) ===================== */
function limiter(max, ms) {
  const hits = new Map();
  return {
    blocked(key) { const h = hits.get(key); return !!h && h.reset > Date.now() && h.n >= max; },
    hit(key) {
      const now = Date.now(); let h = hits.get(key); if (!h || h.reset < now) h = { n: 0, reset: now + ms }; h.n++; hits.set(key, h);
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    },
  };
}

/* ===================== UPLOADS ===================== */
const MAGIC = [
  { ext: 'jpg', type: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', type: 'image/png', test: b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', type: 'image/webp', test: b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
];
const UPLOAD_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/* =====================================================================
   createApp({ store, sessionSecret, trustProxy, staticDir })
   store: { getLoja, saveLoja, listOrders, addOrder, setOrderState, putUpload, getUpload,
            getAdmin, loginFails(key, sinceMs), addLoginFail(key), clearLoginFails(key) }
   ===================================================================== */
function createApp({ store, sessionSecret, trustProxy = false, staticDir = null }) {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET em falta ou demasiado curto (mín. 32 caracteres)');
  const orderLimit = limiter(10, 60 * 60 * 1000);  // 10 encomendas por hora por IP
  const couponLimit = limiter(20, 10 * 60 * 1000); // 20 tentativas de cupão em 10 min
  const LOGIN_MAX = 5, LOGIN_WINDOW = 15 * 60 * 1000;   // 5 falhas → 15 min bloqueado (guardado no store)

  // cache curta da loja para não ler o armazenamento a cada pedido
  let cache = null, cacheAt = 0;
  async function loja() {
    if (cache && Date.now() - cacheAt < 15000) return cache;
    let d = await store.getLoja();
    if (!d) { d = seedFromTemplate(); await store.saveLoja(d); }
    cache = d; cacheAt = Date.now();
    return d;
  }
  const publicLoja = l => { const { cupoes, ...config } = l.config; return { api: true, config: { ...config, cupoes: {} }, produtos: l.produtos }; };

  const clientIp = req => {
    if (trustProxy) { const f = req.headers['x-real-ip'] || req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
    return req.socket?.remoteAddress || '?';
  };
  const ipKey = ip => crypto.createHmac('sha256', sessionSecret).update('ip|' + ip).digest('hex').slice(0, 32);
  const isHttps = req => req.socket?.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');

  /* ---------- autenticação ---------- */
  const scrypt = (pass, salt) => new Promise((res, rej) => crypto.scrypt(String(pass), Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
  const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
  async function checkLogin(user, pass) {
    const a = await store.getAdmin();
    const key = await scrypt(pass, a?.salt || DUMMY_SALT); // corre sempre, para não revelar nada pelo tempo
    if (!a) return false;
    const okUser = crypto.timingSafeEqual(crypto.createHash('sha256').update(String(user).trim().toLowerCase()).digest(), Buffer.from(a.userHash, 'hex'));
    const okPass = crypto.timingSafeEqual(key, Buffer.from(a.hash, 'hex'));
    return okUser && okPass;
  }
  // token assinado (sem estado): mudar a senha invalida todas as sessões
  async function signKey() {
    const a = await store.getAdmin();
    return crypto.createHmac('sha256', sessionSecret).update('sessao|' + (a?.hash || '')).digest();
  }
  async function newToken() {
    const payload = `${Date.now() + SESSION_MS}.${crypto.randomBytes(16).toString('base64url')}`;
    const sig = crypto.createHmac('sha256', await signKey()).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }
  async function validSession(req) {
    const raw = parseCookies(req)[COOKIE];
    if (!raw) return false;
    const parts = raw.split('.');
    if (parts.length !== 3) return false;
    const payload = parts[0] + '.' + parts[1];
    const expected = crypto.createHmac('sha256', await signKey()).update(payload).digest();
    let given; try { given = Buffer.from(parts[2], 'base64url'); } catch { return false; }
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    return Number(parts[0]) > Date.now();
  }
  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    return out;
  }
  const cookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  // pedidos que alteram dados: cabeçalho próprio + mesma origem (proteção CSRF)
  function sameOrigin(req) {
    if (req.headers['x-plusher'] !== '1') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === (req.headers['x-forwarded-host'] && trustProxy ? req.headers['x-forwarded-host'] : req.headers.host); } catch { return false; }
  }

  /* ---------- encomendas ---------- */
  function buildOrder(body, l) {
    const c = body?.cliente || {};
    const cliente = { nome: str(c.nome, 120), tel: str(c.tel, 30), email: str(c.email, 120), morada: str(c.morada, 400) };
    if (!cliente.nome || !cliente.tel || !cliente.morada || !/^\S+@\S+\.\S+$/.test(cliente.email)) throw err(400, 'Preenche todos os campos');
    const pagamento = body.pagamento === 'transferencia' ? 'transferencia' : 'mbway';
    const itens = [];
    for (const it of (Array.isArray(body.itens) ? body.itens.slice(0, 30) : [])) {
      const p = l.produtos.find(x => x.id === it?.id);
      if (!p || p.emBreve) throw err(409, 'Um dos produtos já não está disponível');
      const size = str(it.size, 12);
      if (!p.tamanhos.includes(size)) throw err(400, `Tamanho inválido em ${p.nome}`);
      const qty = Math.round(num(it.qty, 1, 20, 1));
      itens.push({ id: p.id, nome: p.nome, size, qty, preco: p.preco, total: Math.round(p.preco * qty * 100) / 100 });
    }
    if (!itens.length) throw err(400, 'O saco está vazio');
    // preços e descontos calculados SEMPRE no servidor
    const subtotal = Math.round(itens.reduce((s, i) => s + i.total, 0) * 100) / 100;
    const code = str(body.cupao, 30).toUpperCase();
    const pct = (code && l.config.cupoes[code]) || 0;
    const desconto = Math.round(subtotal * pct) / 100;
    const total = Math.round((subtotal - desconto) * 100) / 100;
    return {
      oid: 'PLS-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6),
      data: new Date().toISOString(), estado: 'aguardando_pagamento', cliente, pagamento, itens,
      subtotal, cupao: pct ? code : '', desconto, total, envioGratis: total >= l.config.envioGratisAcima,
    };
  }

  /* ---------- página ---------- */
  async function renderIndex() {
    const html = fs.readFileSync(TEMPLATE, 'utf8');
    const json = JSON.stringify(publicLoja(await loja())).replace(/</g, '\\u003c'); // impede fechar o <script>
    return html.replace(/\/\*ADMIN_DATA\*\/[\s\S]*?\/\*END_ADMIN_DATA\*\//, () => '/*ADMIN_DATA*/' + json + '/*END_ADMIN_DATA*/');
  }
  const STATIC_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary' };
  function serveStatic(res, rel) {
    if (!staticDir) return fail(res, 404, 'Não encontrado');
    const file = path.resolve(staticDir, '.' + path.posix.normalize('/' + rel));
    const type = STATIC_TYPES[path.extname(file).toLowerCase()];
    if (!file.startsWith(staticDir + path.sep) || !type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, 'Não encontrado');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  }

  /* ---------- rotas ---------- */
  async function handle(req, res, pathname) {
    const p = pathname;
    const method = req.method;
    const ip = clientIp(req);

    if (p.startsWith('/api/')) {
      if (method !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'Pedido recusado');

      if (p === '/api/loja' && method === 'GET') return send(res, 200, publicLoja(await loja()), NOSTORE);

      if (p === '/api/cupao' && method === 'POST') {
        if (couponLimit.blocked(ip)) return fail(res, 429, 'Demasiadas tentativas. Tenta mais tarde.');
        couponLimit.hit(ip);
        const code = str((await readJsonBody(req, 2048)).code, 30).toUpperCase();
        const pct = (await loja()).config.cupoes[code];
        return pct ? send(res, 200, { code, pct }, NOSTORE) : fail(res, 404, 'Cupão inválido');
      }

      if (p === '/api/encomendas' && method === 'POST') {
        if (orderLimit.blocked(ip)) return fail(res, 429, 'Demasiadas encomendas seguidas. Tenta mais tarde ou contacta-nos.');
        const order = buildOrder(await readJsonBody(req, 50 * 1024), await loja());
        orderLimit.hit(ip);
        await store.addOrder(order);
        console.log(`Nova encomenda ${order.oid} — ${order.total.toFixed(2)} €`);
        const { oid, total, subtotal, desconto, envioGratis, pagamento } = order;
        return send(res, 201, { oid, total, subtotal, desconto, envioGratis, pagamento }, NOSTORE);
      }

      if (p === '/api/admin/login' && method === 'POST') {
        const key = ipKey(ip);
        if ((await store.loginFails(key, Date.now() - LOGIN_WINDOW)) >= LOGIN_MAX) return fail(res, 429, 'Demasiadas tentativas. Tenta daqui a 15 min.');
        if (!(await store.getAdmin())) return fail(res, 503, 'Acesso ainda não configurado no servidor.');
        const b = await readJsonBody(req, 2048);
        if (!(await checkLogin(b.user || '', b.pass || ''))) {
          await store.addLoginFail(key);
          console.warn('Login do gerente falhado');
          return fail(res, 401, 'Login ou senha incorretos.');
        }
        await store.clearLoginFails(key);
        return send(res, 200, { ok: true }, { ...NOSTORE, 'Set-Cookie': cookie(req, await newToken(), SESSION_MS / 1000) });
      }

      if (p.startsWith('/api/admin/')) {
        if (p === '/api/admin/logout' && method === 'POST') return send(res, 200, { ok: true }, { ...NOSTORE, 'Set-Cookie': cookie(req, '', 0) });
        if (!(await validSession(req))) return fail(res, 401, 'Sessão expirada. Entra novamente.');

        if (p === '/api/admin/me' && method === 'GET') return send(res, 200, { ok: true }, NOSTORE);
        if (p === '/api/admin/loja' && method === 'GET') { cache = null; return send(res, 200, await loja(), NOSTORE); }
        if (p === '/api/admin/loja' && method === 'PUT') {
          const next = sanitizeLoja(await readJsonBody(req, 2 * 1024 * 1024));
          await store.saveLoja(next);
          cache = next; cacheAt = Date.now();
          return send(res, 200, { ok: true }, NOSTORE);
        }
        if (p === '/api/admin/upload' && method === 'POST') {
          const buf = await readBody(req, 4 * 1024 * 1024);
          const kind = MAGIC.find(m => m.test(buf));
          if (!kind) return fail(res, 415, 'Só são aceites imagens JPG, PNG ou WEBP.');
          const name = crypto.randomBytes(12).toString('hex') + '.' + kind.ext;
          await store.putUpload(name, buf, kind.type);
          return send(res, 201, { url: '/uploads/' + name }, NOSTORE);
        }
        if (p === '/api/admin/encomendas' && method === 'GET') return send(res, 200, await store.listOrders(), NOSTORE);
        const m = p.match(/^\/api\/admin\/encomendas\/(PLS-[A-Z0-9]{6})$/);
        if (m && method === 'PATCH') {
          const b = await readJsonBody(req, 2048);
          if (!ESTADOS.includes(b.estado)) return fail(res, 400, 'Estado inválido');
          const o = await store.setOrderState(m[1], b.estado);
          return o ? send(res, 200, o, NOSTORE) : fail(res, 404, 'Encomenda não encontrada');
        }
      }
      return fail(res, 404, 'Não encontrado');
    }

    if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'Método não permitido');
    if (p === '/' || p === '/index.html') {
      // a CDN guarda a página 15 s; o painel recarrega com ?v=… para ver logo as mudanças
      return send(res, 200, await renderIndex(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=60' });
    }
    const up = p.match(/^\/uploads\/([a-f0-9]{24})\.(jpg|png|webp)$/);
    if (up) {
      const buf = await store.getUpload(`${up[1]}.${up[2]}`);
      if (!buf) return fail(res, 404, 'Não encontrado');
      return send(res, 200, buf, { 'Content-Type': UPLOAD_TYPES[up[2]], 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    return serveStatic(res, p.slice(1));
  }

  return async function handler(req, res, pathnameOverride) {
    try {
      const pathname = pathnameOverride || new URL(req.url, 'http://x').pathname;
      await handle(req, res, pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) fail(res, status, status === 500 ? 'Erro no servidor' : e.message);
    }
  };
}

module.exports = { createApp, sanitizeLoja, seedFromTemplate, ESTADOS };
