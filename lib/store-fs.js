'use strict';
/* Armazenamento em ficheiros (PC / VPS). Tudo fica em data/. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

module.exports = function fsStore(DATA) {
  const UPLOADS = path.join(DATA, 'uploads');
  const BACKUPS = path.join(DATA, 'backups');
  for (const d of [DATA, UPLOADS, BACKUPS]) fs.mkdirSync(d, { recursive: true });
  const F = { loja: path.join(DATA, 'loja.json'), encomendas: path.join(DATA, 'encomendas.json'), admin: path.join(DATA, 'admin.json') };
  const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; } };

  // escritas em série + atómicas (ficheiro temporário e rename)
  let chain = Promise.resolve();
  const writeJSON = (file, data) => (chain = chain.then(async () => {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, file);
  }));

  let encomendas = readJSON(F.encomendas, []);
  const fails = new Map();

  return {
    async getLoja() { return readJSON(F.loja, null); },
    async saveLoja(d) {
      if (fs.existsSync(F.loja)) {
        await fsp.copyFile(F.loja, path.join(BACKUPS, `loja-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
        const old = (await fsp.readdir(BACKUPS)).filter(f => f.startsWith('loja-')).sort();
        for (const f of old.slice(0, Math.max(0, old.length - 30))) await fsp.unlink(path.join(BACKUPS, f)).catch(() => {});
      }
      await writeJSON(F.loja, d);
    },
    async listOrders() { return [...encomendas].reverse(); },
    async addOrder(o) {
      while (encomendas.some(x => x.oid === o.oid)) o.oid = 'PLS-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
      encomendas.push(o); await writeJSON(F.encomendas, encomendas);
    },
    async setOrderState(oid, estado, extra = {}) {
      const o = encomendas.find(x => x.oid === oid); if (!o) return null;
      Object.assign(o, extra); o.estado = estado; o.atualizada = new Date().toISOString();
      await writeJSON(F.encomendas, encomendas); return o;
    },
    async putUpload(name, buf) { await fsp.writeFile(path.join(UPLOADS, name), buf); },
    async getUpload(name) { try { return await fsp.readFile(path.join(UPLOADS, name)); } catch { return null; } },
    async getAdmin() { return readJSON(F.admin, null); },
    async loginFails(key, since) { const l = (fails.get(key) || []).filter(t => t > since); fails.set(key, l); return l.length; },
    async addLoginFail(key) { const l = fails.get(key) || []; l.push(Date.now()); fails.set(key, l); },
    async clearLoginFails(key) { fails.delete(key); },
  };
};
