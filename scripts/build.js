'use strict';
/* Build: gera site/index.build.html — a versão que os visitantes recebem — a partir de site/index.html.
   - JavaScript minificado (terser, nomes trocados por letras) e ofuscado (textos codificados);
   - CSS e HTML sem comentários nem espaços.
   site/index.html continua a ser o original legível em que se trabalha.
   O servidor só usa o build se o hash bater certo com o original atual; senão entrega o original.
   Corre sozinho na Vercel (vercel.json → buildCommand) e localmente com: npm run build */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { minify } = require('terser');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SITE = path.join(__dirname, '..', 'site');
const SRC = path.join(SITE, 'index.html');
const OUT = path.join(SITE, 'index.build.html');
const META = path.join(SITE, 'index.build.json');
const DATA = '__PLUSHER_DATA__'; // o servidor troca isto pelos dados da loja

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .replace(/:\s+/g, ':')
    .replace(/;}/g, '}')
    .trim();
}

async function build() {
  const raw = fs.readFileSync(SRC, 'utf8');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  let html = raw.replace(/\/\*ADMIN_DATA\*\/[\s\S]*?\/\*END_ADMIN_DATA\*\//, DATA);
  if (!html.includes(DATA)) throw new Error('marcador ADMIN_DATA não encontrado');

  // nomes de topo do script principal usados pelo módulo 3D: não podem ser trocados
  const scripts = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const mainSrc = scripts.filter(m => !m[1]).map(m => m[2]).join('\n');
  const modSrc = scripts.filter(m => /type="module"/.test(m[1] || '')).map(m => m[2]).join('\n');
  const topNames = [...mainSrc.matchAll(/^(?:const|let|var|(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  const shared = [...new Set(topNames)].filter(n => new RegExp(`(^|[^\\w$.])${esc(n)}(?![\\w$])`).test(modSrc));
  const reserved = [DATA, ...shared];

  // guarda scripts e estilos à parte para mexer no HTML sem lhes tocar
  const blocks = [];
  const keep = s => `\u0000${blocks.push(s) - 1}\u0000`;
  let out = html;

  for (const m of scripts) {
    const [whole, attrs = '', code] = m;
    let result;
    if (/\ssrc=/.test(attrs)) result = whole;
    else if (/type="importmap"/.test(attrs)) result = `<script${attrs}>${JSON.stringify(JSON.parse(code))}</script>`;
    else if (/type="module"/.test(attrs)) {
      const r = await minify(code, { module: true, compress: { passes: 2 }, mangle: true, format: { comments: false } });
      result = `<script${attrs}>${r.code}</script>`;
    } else {
      const r = await minify(code, { toplevel: true, compress: { passes: 2 }, mangle: { reserved }, format: { comments: false } });
      const ob = JavaScriptObfuscator.obfuscate(r.code, {
        compact: true,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 1,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        reservedNames: reserved.map(n => `^${esc(n)}$`),
        controlFlowFlattening: false,
        deadCodeInjection: false,
        selfDefending: false,
        splitStrings: false,
        unicodeEscapeSequence: false,
        target: 'browser',
      }).getObfuscatedCode();
      result = `<script>${ob}</script>`;
    }
    out = out.replace(whole, () => keep(result));
  }
  out = out.replace(/<style>([\s\S]*?)<\/style>/g, (w, css) => keep(`<style>${minifyCss(css)}</style>`));

  // HTML: sem comentários; espaços de indentação entre etiquetas removidos
  out = out
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s*\n\s*</g, '><')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\u0000(\d+)\u0000/g, (w, i) => blocks[+i]);

  const n = out.split(DATA).length - 1;
  if (n !== 1) throw new Error(`o marcador de dados aparece ${n} vezes no build (devia ser 1)`);

  fs.writeFileSync(OUT, out);
  fs.writeFileSync(META, JSON.stringify({ hash, criado: new Date().toISOString() }));
  console.log(`build: ${(raw.length / 1024).toFixed(0)} KB → ${(out.length / 1024).toFixed(0)} KB · nomes protegidos: ${reserved.join(', ')}`);
}

build().catch(e => {
  // o build nunca deve impedir a publicação: sem build, o servidor entrega o original
  console.error('build falhou (o site usa o original):', e.message);
  try { fs.unlinkSync(META); } catch {}
});
