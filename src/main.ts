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

export function appFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const token = obrigatoria(env, 'SEAZONE_TOKEN');
  obrigatoria(env, 'ANTHROPIC_API_KEY');
  const client = new Anthropic({ maxRetries: 1 });
  const agent = createAgent({
    llm: (params, opts) => client.messages.create(params, opts),
    catalog: createCatalog({ baseUrl: `${env.CATALOGO_URL ?? `${BASE_SEAZONE}/catalogo`}/${token}` }),
    // WEBHOOK_URL completo (com token) permite apontar os evals para um webhook local
    webhook: createWebhook({ url: env.WEBHOOK_URL ?? `${BASE_SEAZONE}/leads/${token}` }),
    store: storeFromEnv<Estado>(env),
    modelo: env.MODELO ?? MODELO_PADRAO,
    esforco: (env.ESFORCO as Esforco | undefined) ?? 'medium',
  });
  return createApp(agent);
}
