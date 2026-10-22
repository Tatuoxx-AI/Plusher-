'use strict';
/* Armazenamento no Vercel Blob PRIVADO (nada é acessível sem o token da loja).
   Estrutura:
     loja/atual.json            dados da loja (lidos sempre da origem, sem cache da CDN)
     loja/hist/<data>.json      últimas 30 versões
     encomendas/<oid>.json      uma por encomenda
     uploads/<nome>             fotos carregadas no painel
     rl/login/<ip>/<data>       tentativas de login falhadas (bloqueio partilhado entre instâncias)
   Credenciais do gerente: variáveis ADMIN_USER_HASH, ADMIN_SALT, ADMIN_HASH. */
const { put, get, list, del } = require('@vercel/blob');

const ACCESS = { access: 'private' };
const toBuffer = async r => Buffer.from(await new Response(r.stream).arrayBuffer());

async function readJSON(pathname) {
  const r = await get(pathname, { ...ACCESS, useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse((await toBuffer(r)).toString('utf8'));
}
const writeJSON = (pathname, data, overwrite = true) =>
  put(pathname, JSON.stringify(data), { ...ACCESS, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: overwrite, cacheControlMaxAge: 60 });

async function listAll(prefix, max = 5000) {
  const out = []; let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor && out.length < max);
  return out;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Ao ligar o Blob na Vercel pode escolher-se outro prefixo (ex.: PLUSHER_READ_WRITE_TOKEN):
// aceita qualquer variável *_READ_WRITE_TOKEN / *_STORE_ID e passa-a ao SDK com o nome padrão.
function resolveBlobEnv() {
  const env = process.env;
  if (!env.BLOB_READ_WRITE_TOKEN) {
    const k = Object.keys(env).find(n => n.endsWith('_READ_WRITE_TOKEN') && String(env[n]).startsWith('vercel_blob_rw_'));
    if (k) env.BLOB_READ_WRITE_TOKEN = env[k];
  }
  if (!env.BLOB_STORE_ID) {
    const k = Object.keys(env).find(n => n !== 'BLOB_STORE_ID' && n.endsWith('_STORE_ID') && env[n]);
    if (k) env.BLOB_STORE_ID = env[k];
  }
}

module.exports = function blobStore() {
  resolveBlobEnv();
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    // só os NOMES das variáveis, nunca os valores
    const names = Object.keys(process.env).filter(n => /BLOB|STORE|READ_WRITE/i.test(n)).join(', ') || 'nenhuma';
    throw new Error(`Vercel Blob não está ligado ao projeto (falta BLOB_READ_WRITE_TOKEN). Variáveis relacionadas encontradas: ${names}`);
  }

  return {
    async getLoja() { return readJSON('loja/atual.json'); },
    async saveLoja(d) {
      const atual = await readJSON('loja/atual.json');
      if (atual) await writeJSON(`loja/hist/${stamp()}.json`, atual, false);
      await writeJSON('loja/atual.json', d);
      const hist = (await listAll('loja/hist/')).sort((a, b) => a.pathname.localeCompare(b.pathname));
      if (hist.length > 30) await del(hist.slice(0, hist.length - 30).map(b => b.url));
    },

    async listOrders() {
      const blobs = (await listAll('encomendas/')).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).slice(0, 300);
      const orders = await Promise.all(blobs.map(b => readJSON(b.pathname).catch(() => null)));
      return orders.filter(Boolean).sort((a, b) => b.data.localeCompare(a.data));
    },
    async addOrder(o) {
      // allowOverwrite:false → se o número já existir, gera outro
      for (let i = 0; i < 5; i++) {
        try { await writeJSON(`encomendas/${o.oid}.json`, o, false); return; }
        catch (e) { if (i === 4) throw e; o.oid = 'PLS-' + require('crypto').randomBytes(4).toString('hex').toUpperCase().slice(0, 6); }
      }
    },
    async setOrderState(oid, estado, extra = {}) {
      const o = await readJSON(`encomendas/${oid}.json`);
      if (!o) return null;
      Object.assign(o, extra); o.estado = estado; o.atualizada = new Date().toISOString();
      await writeJSON(`encomendas/${oid}.json`, o);
      return o;
    },

    async putUpload(name, buf, contentType) {
      await put(`uploads/${name}`, buf, { ...ACCESS, contentType, addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 31536000 });
    },
    async getUpload(name) {
      const r = await get(`uploads/${name}`, ACCESS);
      return r && r.statusCode === 200 ? toBuffer(r) : null;
    },

    async getAdmin() {
      const { ADMIN_USER_HASH: userHash, ADMIN_SALT: salt, ADMIN_HASH: hash } = process.env;
      return userHash && salt && hash ? { userHash, salt, hash } : null;
    },
    async loginFails(key, since) {
      const blobs = await listAll(`rl/login/${key}/`, 100);
      const old = blobs.filter(b => new Date(b.uploadedAt).getTime() <= since);
      if (old.length) del(old.map(b => b.url)).catch(() => {});
      return blobs.length - old.length;
    },
    async addLoginFail(key) { await writeJSON(`rl/login/${key}/${stamp()}-${Math.random().toString(36).slice(2, 8)}.json`, {}, false); },
    async clearLoginFails(key) {
      const blobs = await listAll(`rl/login/${key}/`, 100);
      if (blobs.length) await del(blobs.map(b => b.url));
    },
  };
};
