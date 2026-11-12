import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { motivoBloqueio, PREFIXO_SESSAO } from './bateria.js';

// Manda uma mensagem ao /chat publicado e confere o contrato. É a única forma de o subagente
// `bateria-em-producao` falar com a produção: recusa mensagens que poderiam gerar um lead (ver bateria.ts).
//   npx tsx evals/conversar.ts --sessao bateria-preco-1 "Quanto fica o GRM-301 de 15 a 18/01/2027 para 2?"

const PRODUCAO = 'https://agente-concierge-seven.vercel.app';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: 'string', default: PRODUCAO }, sessao: { type: 'string' } },
});
const mensagem = positionals.join(' ');
if (!mensagem) {
  console.error('uso: tsx evals/conversar.ts [--url <base>] [--sessao bateria-...] "<mensagem>"');
  process.exit(2);
}
const sessao = values.sessao ?? `${PREFIXO_SESSAO}${randomUUID().slice(0, 8)}`;
if (!sessao.startsWith(PREFIXO_SESSAO)) {
  console.error(`a sessão precisa começar com "${PREFIXO_SESSAO}"`);
  process.exit(2);
}
// Mensagens já enviadas por sessão, só nesta máquina e fora do git: a trava de confirmação vale a partir
// da segunda mensagem de cada sessão.
const RESULTADOS = new URL('./results/', import.meta.url);
const REGISTRO = new URL('bateria-sessoes.json', RESULTADOS);
let enviadas: Record<string, number> = {};
try {
  enviadas = JSON.parse(readFileSync(REGISTRO, 'utf8')) as Record<string, number>;
} catch {
  // primeira rodada nesta máquina
}
const bloqueio = motivoBloqueio(mensagem, !enviadas[sessao]);
if (bloqueio) {
  console.error(`mensagem não enviada: ${bloqueio}`);
  process.exit(3);
}

enviadas[sessao] = (enviadas[sessao] ?? 0) + 1; // conta antes de enviar: uma falha no meio não reabre a sessão
mkdirSync(RESULTADOS, { recursive: true });
writeFileSync(REGISTRO, JSON.stringify(enviadas, null, 2));

const inicio = Date.now();
const res = await fetch(new URL('/chat', values.url), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: sessao, message: mensagem }),
  signal: AbortSignal.timeout(65_000),
});
const ms = Date.now() - inicio;
const corpo: unknown = await res.json().catch(() => null);

// Contrato: 200 com exatamente {reply: string, handoff: boolean}, em até 60 s.
const problemas: string[] = [];
if (res.status !== 200) problemas.push(`status ${res.status}`);
if (ms > 60_000) problemas.push(`levou ${ms} ms`);
const c = corpo as Record<string, unknown> | null;
if (!c || typeof c.reply !== 'string' || typeof c.handoff !== 'boolean' || Object.keys(c).length !== 2) {
  problemas.push('corpo fora do contrato {reply, handoff}');
}

console.log(JSON.stringify({ sessao, status: res.status, ms, contrato: problemas.length ? problemas : 'ok', corpo }));
