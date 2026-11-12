import { describe, expect, it } from 'vitest';
import type { Lead } from '../src/domain/lead.js';
import { createWebhook } from '../src/infra/webhook.js';

const LEAD: Lead = {
  nome: 'Maria Souza',
  telefone: '(48) 99999-0000',
  imovel_id: 'GRM-301',
  checkin: '2027-01-15',
  checkout: '2027-01-18',
  hospedes: 2,
  valor_total: 2156,
};

/** O GET do webhook real envolve cada lead num registro (formato conferido em 12/11 com um lead de teste). */
const registro = (lead: Lead) => ({ token: 'T', recebido_em: '2026-11-12T13:15:47+00:00', lead });

/** Servidor falso: `posts` define a resposta de cada POST; o GET devolve o que foi gravado. */
function servidor(posts: (number | 'rede' | 'grava-e-cai')[]) {
  const gravados: Lead[] = [];
  let n = 0;
  const f = (async (_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      return new Response(JSON.stringify({ leads: gravados.map(registro) }));
    }
    const passo = posts[n++];
    const lead = JSON.parse(init.body as string) as Lead;
    if (passo === 'rede') throw new TypeError('fetch failed');
    if (passo === 'grava-e-cai') {
      gravados.push(lead);
      throw new TypeError('socket hang up');
    }
    if (passo === 201) gravados.push(lead);
    if (passo === 422) return new Response(JSON.stringify({ detalhes: ['campo obrigatorio ausente: nome'] }), { status: 422 });
    return new Response('{}', { status: passo });
  }) as typeof fetch;
  return { webhook: createWebhook({ url: 'https://wh.test/leads/T', fetch: f }), gravados, posts: () => n };
}

describe('webhook de leads', () => {
  it('201 é criado', async () => {
    const s = servidor([201]);
    expect(await s.webhook.enviar(LEAD)).toEqual({ status: 'criado' });
    expect(s.gravados).toHaveLength(1);
  });

  it('422 devolve a lista de erros do webhook', async () => {
    const s = servidor([422]);
    expect(await s.webhook.enviar(LEAD)).toEqual({ status: 'invalido', erros: ['campo obrigatorio ausente: nome'] });
  });

  it('falha de rede depois de gravar: confere com GET e não manda de novo', async () => {
    const s = servidor(['grava-e-cai', 201]);
    expect(await s.webhook.enviar(LEAD)).toEqual({ status: 'criado' });
    expect(s.posts()).toBe(1);
    expect(s.gravados).toHaveLength(1);
  });

  it('falha de rede sem gravar: tenta mais uma vez', async () => {
    const s = servidor(['rede', 201]);
    expect(await s.webhook.enviar(LEAD)).toEqual({ status: 'criado' });
    expect(s.gravados).toHaveLength(1);
  });

  it('5xx duas vezes vira falha, sem terceira tentativa', async () => {
    const s = servidor([503, 503, 201]);
    expect((await s.webhook.enviar(LEAD)).status).toBe('falha');
    expect(s.posts()).toBe(2);
  });
  it('GET em formato inesperado não vira "nenhum lead": falha em vez de arriscar duplicar', async () => {
    const f = (async (_u: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ itens: [] }));
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const webhook = createWebhook({ url: 'https://wh.test/leads/T', fetch: f });
    await expect(webhook.recebido(LEAD)).rejects.toThrow(/formato inesperado/);
    expect((await webhook.enviar(LEAD)).status).toBe('falha');
  });

  // Achado no teste com o webhook real em 12/11: o GET envolve cada lead num registro, e a leitura plana
  // nunca encontrava o lead já recebido.
  it('reconhece o lead dentro do registro devolvido pelo GET real', async () => {
    const s = servidor([201]);
    await s.webhook.enviar(LEAD);
    expect(await s.webhook.recebido(LEAD)).toBe(true);
    expect(await s.webhook.listar()).toEqual([LEAD]);
  });

  it('registro sem o campo lead é formato inesperado, não "nenhum lead"', async () => {
    const f = (async () => new Response(JSON.stringify({ leads: [{ ...LEAD }] }))) as typeof fetch;
    const webhook = createWebhook({ url: 'https://wh.test/leads/T', fetch: f });
    await expect(webhook.recebido(LEAD)).rejects.toThrow(/formato inesperado/);
  });

  it('sem tempo no turno, não confere nem tenta de novo', async () => {
    const s = servidor(['rede', 201]);
    const acabou = AbortSignal.abort();
    expect((await s.webhook.enviar(LEAD, acabou)).status).toBe('falha');
    expect(s.gravados).toHaveLength(0);
  });
});
