import { describe, expect, it } from 'vitest';
import { RESPOSTA_CONTINGENCIA } from '../src/agent/loop.js';
import { createApp, MAX_MENSAGEM } from '../src/app.js';
import { SessaoOcupadaError } from '../src/infra/session.js';

function post(app: ReturnType<typeof createApp>, corpo: unknown) {
  return app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

const eco = {
  async responder(sessionId: string, mensagem: string) {
    return { reply: `${sessionId}:${mensagem}`, handoff: mensagem === 'humano', uso: {} as never, ms: 0 };
  },
};

describe('POST /chat', () => {
  it('segue o contrato: 200 com exatamente reply e handoff', async () => {
    const res = await post(createApp(eco), { session_id: 'abc-123', message: 'oi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: 'abc-123:oi', handoff: false });
    expect(await (await post(createApp(eco), { session_id: 'a', message: 'humano' })).json()).toEqual({
      reply: 'a:humano',
      handoff: true,
    });
  });

  it('erro inesperado do agente ainda responde 200, com contingência', async () => {
    const app = createApp({ responder: async () => Promise.reject(new Error('boom')) });
    const res = await post(app, { session_id: 'a', message: 'oi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: RESPOSTA_CONTINGENCIA, handoff: false });
  });

  it('conversa ocupada responde 200 pedindo um instante', async () => {
    const app = createApp({ responder: async () => Promise.reject(new SessaoOcupadaError()) });
    const res = await post(app, { session_id: 'a', message: 'oi' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: string }).reply).toMatch(/mensagem anterior/);
  });

  it('mensagem vazia ou longa demais é respondida sem chamar o agente', async () => {
    let chamou = false;
    const app = createApp({ responder: async () => ((chamou = true), eco.responder('', '')) });
    for (const message of ['   ', 'x'.repeat(MAX_MENSAGEM + 1)]) {
      const res = await post(app, { session_id: 'a', message });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ handoff: false });
    }
    expect(chamou).toBe(false);
  });

  it('corpo fora do contrato é 400, ainda no formato {reply, handoff}', async () => {
    const app = createApp(eco);
    for (const corpo of ['não é json', { message: 'oi' }, { session_id: '', message: 'oi' }, { session_id: 'a' }]) {
      const res = await post(app, corpo);
      expect(res.status).toBe(400);
      expect(Object.keys((await res.json()) as object).sort()).toEqual(['handoff', 'reply']);
    }
  });
});
