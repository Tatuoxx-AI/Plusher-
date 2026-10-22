'use strict';
/* Chat de ajuda com IA (Claude), opcional.
   - ANTHROPIC_API_KEY vazia → o site usa o assistente local (respostas fixas a partir dos dados da loja).
   - CHAT_MODEL permite trocar o modelo (por omissão claude-opus-5-5; claude-haiku-5-5 é bem mais barato).
   O modelo só recebe informação pública da loja: nada de encomendas, clientes ou chaves. */
const Anthropic = require('@anthropic-ai/sdk');

const enabled = () => !!process.env.ANTHROPIC_API_KEY;
let client;
const getClient = () => (client = client || new Anthropic());

const eur = v => Number(v).toFixed(2).replace('.', ',') + ' €';

// texto do sistema: só dados públicos da loja (o que já aparece no site)
function systemPrompt(loja, stripeOn) {
  const c = loja.config;
  const produtos = loja.produtos.map(p =>
    `- ${p.nome} | ${p.categoria} | ${p.emBreve ? 'EM BREVE (ainda não está à venda)' : eur(p.preco)} | tamanhos: ${p.tamanhos.join(', ')}${p.descricao ? ` | ${p.descricao}` : ''}`).join('\n');
  const pagamentos = ['MBWay (' + c.mbway + ')', `Transferência bancária (IBAN ${c.iban}, titular ${c.titular})`];
  if (stripeOn) pagamentos.push('Cartão, Apple Pay ou Google Pay (página segura do Stripe)');
  return `És o assistente de apoio ao cliente da loja online ${c.marca || 'PLUSHER'}, streetwear feito em Portugal ("Always In Motion").
Responde sempre no idioma em que o cliente escreve, de forma curta, simpática e útil (normalmente 1 a 4 frases). Usa texto simples, sem markdown nem tabelas.

Informação da loja (a única fonte de verdade — não inventes nada fora disto, como medidas em cm, prazos, políticas de troca ou stock):
- Sobre: ${c.sobre}
- Envio: ${c.envioInfo}
- Envio grátis acima de: ${eur(c.envioGratisAcima)}
- Pagamentos: ${pagamentos.join('; ')}
- Próximo drop: ${c.drop?.nome || '—'}${c.drop?.data ? ` — lançamento a ${c.drop.data}` : ''}. ${c.drop?.descricao || ''}
- Contactos: WhatsApp ${c.whatsapp || '+351 926795705'}, email ${c.email}, Instagram ${c.instagram}
- Categorias: ${(c.categorias || []).map(k => `${k.nome}${k.ativa ? '' : ' (em breve)'}`).join(', ')}

Produtos:
${produtos}

Regras:
- Não consegues ver encomendas, pagamentos nem dados de clientes. Para confirmar ou acompanhar uma encomenda, pede ao cliente que use o botão do WhatsApp com o número da encomenda (PLS-…).
- Para trocas, devoluções, medidas exatas ou qualquer coisa que não esteja acima, diz que não tens essa informação e indica o WhatsApp ou o email.
- Para comprar, explica que se escolhe a peça no catálogo, o tamanho e se finaliza no saco.
- Nunca peças dados de cartão, senhas ou códigos.`;
}

// histórico vindo do browser: só texto, papéis alternados, tamanho limitado
function cleanHistory(msgs) {
  const out = [];
  for (const m of (Array.isArray(msgs) ? msgs : []).slice(-12)) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const text = typeof m?.text === 'string' ? m.text.trim().slice(0, 800) : '';
    if (!text) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + text;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

async function reply(loja, history, stripeOn) {
  const messages = cleanHistory(history);
  if (!messages) throw Object.assign(new Error('Mensagem vazia'), { status: 400 });
  try {
    const response = await getClient().beta.messages.create({
      model: process.env.CHAT_MODEL || 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low' }, // conversa simples: respostas rápidas e baratas
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: systemPrompt(loja, stripeOn),
      messages,
    });
    if (response.stop_reason === 'refusal') return 'Não consigo ajudar com isso aqui. Fala connosco pelo WhatsApp e respondemos-te diretamente.';
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return text || 'Desculpa, não consegui responder. Fala connosco pelo WhatsApp.';
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) console.error('Chat IA: limite de pedidos atingido');
    else if (e instanceof Anthropic.AuthenticationError) console.error('Chat IA: ANTHROPIC_API_KEY inválida');
    else if (e instanceof Anthropic.APIError) console.error(`Chat IA: erro ${e.status}`, e.message);
    else console.error('Chat IA:', e.message);
    throw Object.assign(new Error('O assistente está indisponível'), { status: 503 });
  }
}

module.exports = { enabled, reply };
