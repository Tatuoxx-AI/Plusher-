'use strict';
/* PLUSHER — servidor local (PC / VPS). Na Vercel corre api/index.js.
   Dados em data/ (ver README). Acesso do gerente: npm run acesso */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('./lib/app');
const fsStore = require('./lib/store-fs');

const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// segredo das sessões: variável SESSION_SECRET, ou gerado uma vez e guardado em data/
const secretFile = path.join(DATA, 'session.secret');
let secret = process.env.SESSION_SECRET;
if (!secret) {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  secret = fs.readFileSync(secretFile, 'utf8').trim();
}

// com BLOB_READ_WRITE_TOKEN definido usa o Vercel Blob (útil para testar o armazenamento da Vercel no PC)
const store = process.env.BLOB_READ_WRITE_TOKEN ? require('./lib/store-blob')() : fsStore(DATA);
const app = createApp({ store, sessionSecret: secret, trustProxy: process.env.TRUST_PROXY === '1', staticDir: path.join(__dirname, 'public') });

const PORT = Number(process.env.PORT) || 5195;
http.createServer((req, res) => app(req, res)).listen(PORT, async () => {
  console.log(`PLUSHER a correr em http://localhost:${PORT}`);
  if (!(await store.getAdmin())) console.warn('⚠  Acesso do gerente por configurar: npm run acesso');
});
