'use strict';
/* Define (ou muda) o login e a senha do gerente.
   Guarda só hashes em data/admin.json — a senha nunca fica escrita em lado nenhum.

   Uso:
     node scripts/definir-acesso.js              → pergunta o login e a senha
     <texto> | node scripts/definir-acesso.js --stdin
        aceita "login - UTILIZADOR senha - SENHA" ou duas linhas (login, senha)

   Depois de mudar, reinicia o servidor para terminar as sessões abertas. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const FILE = path.join(__dirname, '..', 'data', 'admin.json');

function parse(text) {
  text = text.replace(/^﻿/, '').trim();
  const m = text.match(/login\s*[-:=]\s*(\S+)\s+senha\s*[-:=]\s*(\S+)/i);
  if (m) return [m[1], m[2]];
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.length >= 2 ? [lines[0], lines[1]] : null;
}

function save(user, pass) {
  if (!user || pass.length < 8) { console.error('Login vazio ou senha com menos de 8 caracteres.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({
    userHash: crypto.createHash('sha256').update(user.trim().toLowerCase()).digest('hex'),
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    alterado: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
  console.log(`Acesso do gerente guardado (login com ${user.length} caracteres, senha com ${pass.length}).`);
}

if (process.argv.includes('--stdin')) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => (buf += d));
  process.stdin.on('end', () => {
    const r = parse(buf);
    if (!r) { console.error('Não percebi o formato. Usa: login - UTILIZADOR senha - SENHA'); process.exit(1); }
    save(r[0], r[1]);
  });
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Login do gerente: ', user => {
    rl.stdoutMuted = true;
    rl.question('Senha (mín. 8 caracteres): ', pass => { rl.close(); console.log(); save(user.trim(), pass); });
    rl._writeToOutput = s => { if (!rl.stdoutMuted || /[\r\n]/.test(s)) rl.output.write(rl.stdoutMuted ? '' : s); else rl.output.write('*'); };
  });
}
