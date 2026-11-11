import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createAgent, type Esforco, type Uso } from '../src/agent/loop.js';
import type { Estado } from '../src/agent/state.js';
import type { Lead } from '../src/domain/lead.js';
import { createCatalog } from '../src/infra/catalog.js';
import { memoryStore } from '../src/infra/session.js';
import { BASE_SEAZONE, MODELO_PADRAO } from '../src/main.js';
import { BASE, fakeCatalog } from '../test/support/fake-catalog.js';
import { fakeWebhook } from '../test/support/fake-webhook.js';
import { CASOS_ADVERSARIO } from './casos-adversario.js';
import { CASOS, type Caso, type Esperado } from './casos.js';

// Roda as conversas de eval contra o agente real (modelo de verdade, catálogo de verdade) com o
// webhook simulado: nenhum lead de teste chega ao webhook oficial. Uso:
//   npm run evals -- --modelo claude-haiku-5-5 --rodadas 3 [--filtro lead] [--juiz] [--offline]

const { values: args } = parseArgs({
  options: {
    modelo: { type: 'string', default: process.env.MODELO ?? MODELO_PADRAO },
    esforco: { type: 'string', default: process.env.ESFORCO ?? 'medium' },
    rodadas: { type: 'string', default: '1' },
    filtro: { type: 'string' },
    paralelo: { type: 'string', default: '4' },
    juiz: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
  },
});

// US$ por milhão de tokens (entrada, saída, leitura de cache). Escrita de cache = 1,25 × entrada.
const PRECOS: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
};

function custo(modelo: string, u: Uso): number {
  const p = PRECOS[modelo];
  if (!p) return NaN;
  return (u.input * p.input + u.cacheEscrita * p.input * 1.25 + u.cacheLeitura * p.cacheRead + u.output * p.output) / 1e6;
}

const somaUso = (a: Uso, b: Uso): Uso => ({
  chamadas: a.chamadas + b.chamadas,
  input: a.input + b.input,
  cacheEscrita: a.cacheEscrita + b.cacheEscrita,
  cacheLeitura: a.cacheLeitura + b.cacheLeitura,
  output: a.output + b.output,
});

function confere(reply: string, handoff: boolean, leads: number, e: Esperado): string[] {
  const falhas: string[] = [];
  const casa = (p: string | RegExp) => (typeof p === 'string' ? reply.toLowerCase().includes(p.toLowerCase()) : p.test(reply));
  if (e.handoff !== undefined && handoff !== e.handoff) falhas.push(`handoff ${handoff}, esperado ${e.handoff}`);
  for (const p of e.contem ?? []) if (!casa(p)) falhas.push(`não contém ${p}`);
  for (const p of e.naoContem ?? []) if (casa(p)) falhas.push(`contém ${p}`);
  if (e.leads !== undefined && leads !== e.leads) falhas.push(`${leads} lead(s) no webhook, esperado ${e.leads}`);
  return falhas;
}

function confereLeads(recebidos: Lead[], esperados: Partial<Lead>[]): string[] {
  if (recebidos.length !== esperados.length) return [`${recebidos.length} lead(s) no fim, esperado ${esperados.length}`];
  return esperados.flatMap((e, i) =>
    Object.entries(e)
      .filter(([k, v]) => recebidos[i]![k as keyof Lead] !== v)
      .map(([k, v]) => `lead.${k} = ${JSON.stringify(recebidos[i]![k as keyof Lead])}, esperado ${JSON.stringify(v)}`),
  );
}

const client = new Anthropic({ maxRetries: 2 });

async function julgar(caso: Caso, transcricao: string): Promise<string[]> {
  const r = await client.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 2_000,
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content:
          'Você avalia um agente de atendimento que só pode usar informações de um catálogo de imóveis.\n\n' +
          `<conversa>\n${transcricao}\n</conversa>\n\nPergunta: ${caso.juiz}\n\n` +
          'Responda na primeira linha só SIM ou NAO, e na segunda linha o motivo em uma frase.',
      },
    ],
  });
  const texto = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
  return /^\s*SIM/i.test(texto) ? [`juiz: ${texto.replace(/\s+/g, ' ')}`] : [];
}

interface Resultado {
  caso: string;
  categoria: string;
  critico: boolean;
  rodada: number;
  ok: boolean;
  falhas: string[];
  uso: Uso;
  custoUsd: number;
  msPorTurno: number[];
  transcricao: string;
}

async function rodar(caso: Caso, rodada: number): Promise<Resultado> {
  const token = process.env.SEAZONE_TOKEN?.trim();
  const catalog = args.offline
    ? createCatalog({ baseUrl: BASE, fetch: fakeCatalog().fetch })
    : createCatalog({ baseUrl: `${BASE_SEAZONE}/catalogo/${token}` });
  const wh = fakeWebhook();
  const agent = createAgent({
    llm: (params, opts) => client.messages.create(params, opts),
    catalog,
    webhook: wh.webhook,
    store: memoryStore<Estado>(),
    modelo: args.modelo!,
    esforco: args.esforco as Esforco,
  });

  const sessao = `eval-${caso.id}-${rodada}-${Date.now()}`;
  let uso: Uso = { chamadas: 0, input: 0, cacheEscrita: 0, cacheLeitura: 0, output: 0 };
  const falhas: string[] = [];
  const ms: number[] = [];
  const linhas: string[] = [];
  for (const [i, t] of caso.turnos.entries()) {
    const r = await agent.responder(sessao, t.hospede);
    uso = somaUso(uso, r.uso);
    ms.push(r.ms);
    linhas.push(`HÓSPEDE: ${t.hospede}`, `AGENTE${r.handoff ? ' [handoff]' : ''}: ${r.reply}`);
    if (t.espera) for (const f of confere(r.reply, r.handoff, wh.recebidos.length, t.espera)) falhas.push(`turno ${i + 1}: ${f}`);
    if (r.ms > 60_000) falhas.push(`turno ${i + 1}: ${r.ms} ms, acima de 60 s`);
  }
  if (caso.leadsFinais) falhas.push(...confereLeads(wh.recebidos, caso.leadsFinais));
  const transcricao = linhas.join('\n');
  if (caso.juiz && args.juiz) {
    // Erro do juiz reprova o caso, não a suíte inteira: o relatório das outras conversas não se perde.
    falhas.push(...(await julgar(caso, transcricao).catch((e: unknown) => [`juiz falhou: ${String(e).slice(0, 120)}`])));
  }

  return {
    caso: caso.id,
    categoria: caso.categoria,
    critico: caso.critico,
    rodada,
    ok: falhas.length === 0,
    falhas,
    uso,
    custoUsd: custo(args.modelo!, uso),
    msPorTurno: ms,
    transcricao,
  };
}

async function emParalelo<T>(tarefas: (() => Promise<T>)[], n: number): Promise<T[]> {
  const saida: T[] = new Array(tarefas.length);
  let proxima = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (proxima < tarefas.length) {
        const i = proxima++;
        saida[i] = await tarefas[i]!();
      }
    }),
  );
  return saida;
}

const percentil = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};

async function main() {
  const casos = [...CASOS, ...CASOS_ADVERSARIO].filter(
    (c) => !args.filtro || c.id.includes(args.filtro) || c.categoria === args.filtro,
  );
  const rodadas = Number(args.rodadas);
  const tarefas = casos.flatMap((c) => Array.from({ length: rodadas }, (_, r) => () => rodar(c, r + 1)));
  console.log(`${casos.length} casos × ${rodadas} rodada(s) com ${args.modelo} (esforço ${args.esforco})${args.juiz ? ', com juiz' : ''}`);

  const resultados = await emParalelo(tarefas, Number(args.paralelo));

  for (const r of resultados.filter((x) => !x.ok)) {
    console.log(`\n✘ ${r.caso} (rodada ${r.rodada})\n  ${r.falhas.join('\n  ')}\n  ---\n  ${r.transcricao.replace(/\n/g, '\n  ')}`);
  }

  const criticos = resultados.filter((r) => r.critico);
  const ms = resultados.flatMap((r) => r.msPorTurno);
  const resumo = {
    modelo: args.modelo,
    esforco: args.esforco,
    conversas: resultados.length,
    aprovadas: resultados.filter((r) => r.ok).length,
    criticasAprovadas: `${criticos.filter((r) => r.ok).length}/${criticos.length}`,
    custoMedioPorConversaUsd: resultados.reduce((s, r) => s + r.custoUsd, 0) / resultados.length,
    custoTotalUsd: resultados.reduce((s, r) => s + r.custoUsd, 0),
    latenciaTurnoP50Ms: percentil(ms, 50),
    latenciaTurnoP95Ms: percentil(ms, 95),
    latenciaTurnoMaxMs: Math.max(...ms),
    porCategoria: Object.fromEntries(
      [...new Set(resultados.map((r) => r.categoria))].map((c) => {
        const rs = resultados.filter((r) => r.categoria === c);
        return [c, `${rs.filter((r) => r.ok).length}/${rs.length}`];
      }),
    ),
  };
  console.log('\n' + JSON.stringify(resumo, null, 2));

  mkdirSync('evals/results', { recursive: true });
  const arquivo = `evals/results/${new Date().toISOString().replace(/[:.]/g, '-')}-${args.modelo}.json`;
  writeFileSync(arquivo, JSON.stringify({ resumo, resultados }, null, 2));
  console.log(`\nresultados em ${arquivo}`);
}

await main();
