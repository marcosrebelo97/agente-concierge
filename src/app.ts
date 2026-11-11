import { Hono } from 'hono';
import { z } from 'zod';
import { RESPOSTA_CONTINGENCIA, type Agent } from './agent/loop.js';
import { SessaoOcupadaError } from './infra/session.js';

// Contrato: POST /chat {session_id, message} → 200 {reply, handoff}. A resposta tem exatamente esses
// dois campos. Qualquer falha depois de validar a entrada ainda responde 200, com uma resposta de
// contingência: quem conversa recebe uma mensagem, não um erro.

export const MAX_MENSAGEM = 4_000;

const Entrada = z.object({
  session_id: z.string().trim().min(1).max(200),
  message: z.string(),
});

export function createApp(agent: Pick<Agent, 'responder'>) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/chat', async (c) => {
    const corpo: unknown = await c.req.json().catch(() => undefined);
    const entrada = Entrada.safeParse(corpo);
    if (!entrada.success) {
      return c.json({ reply: 'Envie um JSON com session_id e message.', handoff: false }, 400);
    }
    const { session_id, message } = entrada.data;

    if (!message.trim()) return c.json({ reply: 'Não recebi nenhuma mensagem. Como posso ajudar?', handoff: false });
    if (message.length > MAX_MENSAGEM) {
      return c.json({ reply: 'Sua mensagem ficou longa demais. Pode resumir em poucas linhas?', handoff: false });
    }

    try {
      const r = await agent.responder(session_id, message);
      return c.json({ reply: r.reply, handoff: r.handoff });
    } catch (erro) {
      if (erro instanceof SessaoOcupadaError) {
        return c.json({ reply: 'Ainda estou respondendo sua mensagem anterior. Um instante, por favor.', handoff: false });
      }
      console.error(JSON.stringify({ evento: 'erro_chat', erro: String(erro) }));
      return c.json({ reply: RESPOSTA_CONTINGENCIA, handoff: false });
    }
  });

  return app;
}
