import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { erroLog, RESPOSTA_CONTINGENCIA, type Agent } from './agent/loop.js';
import { SessaoOcupadaError } from './infra/session.js';

// Contrato: POST /chat {session_id, message} → 200 {reply, handoff}. A resposta tem exatamente esses
// dois campos. Qualquer falha depois de validar a entrada ainda responde 200, com uma resposta de
// contingência: quem conversa recebe uma mensagem, não um erro.

export const MAX_MENSAGEM = 4_000;
// O prazo começa quando a requisição chega e vale para tudo: lock, Redis, modelo, catálogo e webhook.
// Fica abaixo dos 60 s do contrato e do maxDuration da Vercel, com folga para gravar a sessão.
export const PRAZO_MS = 52_000;
const REDE_FINAL_MS = 57_000; // se algo escapar do prazo, ainda responde 200 antes do corte da Vercel

const Entrada = z.object({
  session_id: z.string().trim().min(1).max(200),
  message: z.string(),
});

export function createApp(agent: Pick<Agent, 'responder'>) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  const LONGA = 'Sua mensagem ficou longa demais. Pode resumir em poucas linhas?';
  const corpoGrande = bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ reply: LONGA, handoff: false }, 413) });

  app.post('/chat', corpoGrande, async (c) => {
    const prazo = Date.now() + PRAZO_MS;
    const corpo: unknown = await c.req.json().catch(() => undefined);
    const entrada = Entrada.safeParse(corpo);
    if (!entrada.success) {
      return c.json({ reply: 'Envie um JSON com session_id e message.', handoff: false }, 400);
    }
    const { session_id, message } = entrada.data;

    if (!message.trim()) return c.json({ reply: 'Não recebi nenhuma mensagem. Como posso ajudar?', handoff: false });
    if (message.length > MAX_MENSAGEM) {
      return c.json({ reply: LONGA, handoff: false });
    }

    let relogio: NodeJS.Timeout | undefined;
    const redeFinal = new Promise<null>((r) => (relogio = setTimeout(() => r(null), REDE_FINAL_MS)));
    try {
      const r = await Promise.race([agent.responder(session_id, message, prazo), redeFinal]);
      if (!r) {
        console.error(JSON.stringify({ evento: 'rede_final' }));
        return c.json({ reply: RESPOSTA_CONTINGENCIA, handoff: false });
      }
      return c.json({ reply: r.reply, handoff: r.handoff });
    } catch (erro) {
      if (erro instanceof SessaoOcupadaError) {
        return c.json({ reply: 'Ainda estou respondendo sua mensagem anterior. Um instante, por favor.', handoff: false });
      }
      console.error(JSON.stringify({ evento: 'erro_chat', erro: erroLog(erro) }));
      return c.json({ reply: RESPOSTA_CONTINGENCIA, handoff: false });
    } finally {
      clearTimeout(relogio);
    }
  });

  return app;
}
