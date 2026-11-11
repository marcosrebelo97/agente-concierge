import { Redis } from '@upstash/redis';
import { describe, expect, it } from 'vitest';
import { redisStore, SessaoOcupadaError, TTL_SEGUNDOS } from '../src/infra/session.js';

// Integração com um Upstash real. Só roda com as variáveis no ambiente:
//   npx vitest run test/session.redis.test.ts   (com o .env carregado, ex.: node --env-file=.env)
// Usa um prefixo único por execução e apaga as próprias chaves no fim.

const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim();
const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim();

describe.skipIf(!url || !token)('sessão no Redis real', () => {
  const redis = new Redis({ url: url!, token: token! });
  const prefixo = `teste-${crypto.randomUUID()}`;
  const store = redisStore<Record<string, unknown>>(redis, prefixo);
  const limpar = async () => {
    const chaves = await redis.keys(`${prefixo}:*`);
    if (chaves.length) await redis.del(...chaves);
  };

  it('guarda e devolve o estado sem perder tipos, acentos nem estrutura, com TTL de 7 dias', async () => {
    const estado = {
      turno: 3,
      mensagens: [{ role: 'user', content: 'Olá, quero o Chalé em Gramado 🏔️' }],
      valoresLegitimos: [215600, 70800],
      pendente: null,
      humanoAcionado: false,
    };
    await store.set('s1', estado);
    expect(await store.get('s1')).toEqual(estado);
    expect(await store.get('nao-existe')).toBeNull();
    const ttl = await redis.ttl(`${prefixo}:sessao:s1`);
    expect(ttl).toBeGreaterThan(TTL_SEGUNDOS - 60);
    expect(ttl).toBeLessThanOrEqual(TTL_SEGUNDOS);
  });

  it('serializa duas mensagens simultâneas da mesma conversa e solta o lock depois de um erro', async () => {
    const ordem: string[] = [];
    const turno = (nome: string) =>
      store.withLock('s2', async () => {
        ordem.push(`inicio-${nome}`);
        await new Promise((r) => setTimeout(r, 300));
        ordem.push(`fim-${nome}`);
      });
    await Promise.all([turno('a'), turno('b')]);
    // um turno começa só depois que o outro termina, em qualquer ordem
    expect([
      ['inicio-a', 'fim-a', 'inicio-b', 'fim-b'],
      ['inicio-b', 'fim-b', 'inicio-a', 'fim-a'],
    ]).toContainEqual(ordem);

    await expect(store.withLock('s2', async () => Promise.reject(new Error('falhou')))).rejects.toThrow('falhou');
    expect(await store.withLock('s2', async () => 'livre')).toBe('livre');
  });

  it('turno que perdeu o prazo não apaga o lock de quem veio depois', async () => {
    const lock = `${prefixo}:lock:s3`;
    await store.withLock('s3', async () => {
      // o lock deste turno expirou e outro turno pegou a sessão
      await redis.set(lock, 'outro-turno', { px: 10_000 });
    });
    expect(await redis.get(lock)).toBe('outro-turno');
    await limpar();
  });

  it('desiste com SessaoOcupadaError quando a sessão continua ocupada', async () => {
    await redis.set(`${prefixo}:lock:s4`, 'ocupado', { px: 60_000 });
    await expect(store.withLock('s4', async () => 'nunca')).rejects.toBeInstanceOf(SessaoOcupadaError);
    await limpar();
  }, 30_000);
});
