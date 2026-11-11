import { describe, expect, it } from 'vitest';
import { memoryStore, SessaoOcupadaError, storeFromEnv } from '../src/infra/session.js';

describe('sessão em memória', () => {
  it('guarda e devolve o estado pelo id, e sessão nova é null', async () => {
    const s = memoryStore<{ n: number }>();
    expect(await s.get('a')).toBeNull();
    await s.set('a', { n: 1 });
    expect(await s.get('a')).toEqual({ n: 1 });
    expect(await s.get('b')).toBeNull();
  });

  it('quem lê recebe uma cópia: mudar o objeto não altera a sessão sem set', async () => {
    const s = memoryStore<{ itens: string[] }>();
    await s.set('a', { itens: [] });
    const lido = (await s.get('a'))!;
    lido.itens.push('x');
    expect(await s.get('a')).toEqual({ itens: [] });
  });

  it('serializa duas mensagens da mesma conversa', async () => {
    const s = memoryStore<number>();
    const ordem: string[] = [];
    const turno = (nome: string, ms: number) =>
      s.withLock('a', async () => {
        ordem.push(`${nome}:início`);
        await new Promise((r) => setTimeout(r, ms));
        ordem.push(`${nome}:fim`);
      });
    await Promise.all([turno('1', 50), turno('2', 0)]);
    expect(ordem).toEqual(['1:início', '1:fim', '2:início', '2:fim']);
  });

  it('não bloqueia conversas diferentes', async () => {
    const s = memoryStore<number>();
    const ordem: string[] = [];
    await Promise.all([
      s.withLock('a', async () => {
        await new Promise((r) => setTimeout(r, 50));
        ordem.push('a');
      }),
      s.withLock('b', async () => {
        ordem.push('b');
      }),
    ]);
    expect(ordem).toEqual(['b', 'a']);
  });

  it('solta o lock mesmo quando o turno falha', async () => {
    const s = memoryStore<number>();
    await expect(s.withLock('a', async () => Promise.reject(new Error('falhou')))).rejects.toThrow('falhou');
    expect(await s.withLock('a', async () => 'ok')).toBe('ok');
  });

  it('desiste com SessaoOcupadaError se a conversa fica ocupada além do limite', async () => {
    const s = memoryStore<number>({ esperaLockMs: 100 });
    const longo = s.withLock('a', () => new Promise((r) => setTimeout(r, 400)));
    await expect(s.withLock('a', async () => 'nunca')).rejects.toBeInstanceOf(SessaoOcupadaError);
    await longo;
  });
});

describe('escolha do armazenamento', () => {
  // Redis com host inexistente: só serve para saber se o Redis foi escolhido (a leitura falha na rede).
  const REDIS = { url: 'https://redis-inexistente.invalid', token: 'x' };

  it('variável vazia copiada do .env.example não esconde a outra preenchida', async () => {
    const s = storeFromEnv({
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: ' ',
      KV_REST_API_URL: REDIS.url,
      KV_REST_API_TOKEN: REDIS.token,
    });
    await expect(s.get('a')).rejects.toThrow();
  });

  it('sem Redis e fora da Vercel, usa memória', async () => {
    const s = storeFromEnv({ UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });
    expect(await s.get('a')).toBeNull();
  });

  it('falha ao subir com Redis pela metade ou na Vercel sem Redis', () => {
    expect(() => storeFromEnv({ KV_REST_API_URL: REDIS.url })).toThrow(/pela metade/);
    expect(() => storeFromEnv({ VERCEL: '1' })).toThrow(/exigem Redis/);
  });
});
