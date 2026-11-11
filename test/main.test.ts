import { describe, expect, it } from 'vitest';
import { appFromEnv } from '../src/main.js';

// Configuração errada falha ao subir, com mensagem clara, e nunca no meio de uma conversa.

const BASE = { ANTHROPIC_API_KEY: 'chave-de-teste', SEAZONE_TOKEN: 'token-de-teste' };

describe('configuração', () => {
  it('sobe com o mínimo: chave, token e sessões em memória', async () => {
    const app = appFromEnv({ ...BASE });
    expect((await app.request('/health')).status).toBe(200);
  });

  it('falha sem chave da Anthropic ou sem token do teste', () => {
    expect(() => appFromEnv({ SEAZONE_TOKEN: 'x' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => appFromEnv({ ANTHROPIC_API_KEY: 'x', SEAZONE_TOKEN: '  ' })).toThrow(/SEAZONE_TOKEN/);
  });

  it('falha com esforço inválido e aceita os válidos', () => {
    expect(() => appFromEnv({ ...BASE, ESFORCO: 'turbo' })).toThrow(/ESFORCO inválido/);
    for (const e of ['low', 'medium', 'high']) expect(() => appFromEnv({ ...BASE, ESFORCO: e })).not.toThrow();
  });
});
