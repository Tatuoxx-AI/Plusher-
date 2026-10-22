'use strict';
/* PLUSHER na Vercel: todas as rotas (exceto ficheiros de public/) chegam aqui pelo vercel.json. */
const { createApp } = require('../lib/app');
const blobStore = require('../lib/store-blob');

let app;
module.exports = async (req, res) => {
  app = app || createApp({ store: blobStore(), sessionSecret: process.env.SESSION_SECRET, trustProxy: true });
  // o vercel.json reescreve /<caminho> → /api/index?__p=/<caminho>
  const u = new URL(req.url, 'http://x');
  const p = u.searchParams.get('__p');
  return app(req, res, p ? '/' + p.replace(/^\/+/, '') : u.pathname);
};
