import Anthropic from '@anthropic-ai/sdk';
import { createAgent, type Esforco } from './agent/loop.js';
import type { Estado } from './agent/state.js';
import { createApp } from './app.js';
import { createCatalog } from './infra/catalog.js';
import { storeFromEnv } from './infra/session.js';
import { createWebhook } from './infra/webhook.js';

// Monta a aplicação a partir das variáveis de ambiente. Usado pelo servidor Node e pela Vercel.

export const BASE_SEAZONE = 'https://teste-tecnico-webhook.seazone.properties';
export const MODELO_PADRAO = 'claude-sonnet-5-5';

function obrigatoria(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome]?.trim();
  if (!v) throw new Error(`variável de ambiente ausente: ${nome}`);
  return v;
}

const ESFORCOS: readonly Esforco[] = ['low', 'medium', 'high'];

/** Valor inválido falha ao subir, não no primeiro /chat com um 400 da API. */
function esforcoDe(env: NodeJS.ProcessEnv): Esforco {
  const v = env.ESFORCO?.trim() || 'medium';
  if (!ESFORCOS.includes(v as Esforco)) throw new Error(`ESFORCO inválido: ${v} (use ${ESFORCOS.join(', ')})`);
  return v as Esforco;
}

export function appFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const token = obrigatoria(env, 'SEAZONE_TOKEN');
  const apiKey = obrigatoria(env, 'ANTHROPIC_API_KEY');
  const esforco = esforcoDe(env);
  const client = new Anthropic({ apiKey });
  const agent = createAgent({
    // timeout, signal e número de tentativas vêm do loop, a cada chamada, pelo prazo que resta
    llm: (params, opts) => client.messages.create(params, opts),
    catalog: createCatalog({ baseUrl: `${BASE_SEAZONE}/catalogo/${token}` }),
    webhook: createWebhook({ url: `${BASE_SEAZONE}/leads/${token}` }),
    store: storeFromEnv<Estado>(env),
    modelo: env.MODELO?.trim() || MODELO_PADRAO,
    esforco,
  });
  return createApp(agent);
}
