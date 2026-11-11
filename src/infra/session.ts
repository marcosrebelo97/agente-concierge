import { Redis } from '@upstash/redis';

// Guarda o estado de cada conversa pelo session_id. Em produção (Vercel) as funções não guardam
// memória entre chamadas, então o estado vai para o Upstash Redis; localmente, sem as variáveis,
// fica em memória. As duas implementações têm o mesmo contrato e o mesmo lock por sessão.

export interface SessionStore<T> {
  get(id: string): Promise<T | null>;
  set(id: string, valor: T): Promise<void>;
  /** Executa `fn` com exclusividade sobre a sessão: duas mensagens da mesma conversa não se misturam. */
  withLock<R>(id: string, fn: () => Promise<R>): Promise<R>;
}

export class SessaoOcupadaError extends Error {
  constructor() {
    super('A conversa ainda está processando a mensagem anterior.');
    this.name = 'SessaoOcupadaError';
  }
}

export const TTL_SEGUNDOS = 7 * 24 * 3600;
const LOCK_MS = 60_000; // nunca menor que o tempo máximo de um turno
const ESPERA_LOCK_MS = 20_000;
const INTERVALO_MS = 150;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function memoryStore<T>(opts: { esperaLockMs?: number } = {}): SessionStore<T> {
  const dados = new Map<string, string>();
  const locks = new Set<string>();
  const esperaLockMs = opts.esperaLockMs ?? ESPERA_LOCK_MS;
  return {
    async get(id) {
      const v = dados.get(id);
      // cópia profunda: quem lê não altera o que está guardado sem chamar set
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    async set(id, valor) {
      dados.set(id, JSON.stringify(valor));
    },
    async withLock(id, fn) {
      const limite = Date.now() + esperaLockMs;
      while (locks.has(id)) {
        if (Date.now() > limite) throw new SessaoOcupadaError();
        await espera(INTERVALO_MS);
      }
      locks.add(id);
      try {
        return await fn();
      } finally {
        locks.delete(id);
      }
    },
  };
}

// Solta o lock só se ainda for nosso: um turno que passou do prazo não apaga o lock do próximo.
const SOLTAR = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export function redisStore<T>(redis: Redis, prefixo = 'concierge'): SessionStore<T> {
  const chave = (id: string) => `${prefixo}:sessao:${id}`;
  const chaveLock = (id: string) => `${prefixo}:lock:${id}`;
  return {
    async get(id) {
      return ((await redis.get<T>(chave(id))) ?? null) as T | null;
    },
    async set(id, valor) {
      await redis.set(chave(id), valor, { ex: TTL_SEGUNDOS });
    },
    async withLock(id, fn) {
      const dono = crypto.randomUUID();
      const limite = Date.now() + ESPERA_LOCK_MS;
      while ((await redis.set(chaveLock(id), dono, { nx: true, px: LOCK_MS })) !== 'OK') {
        if (Date.now() > limite) throw new SessaoOcupadaError();
        await espera(INTERVALO_MS);
      }
      try {
        return await fn();
      } finally {
        await redis.eval(SOLTAR, [chaveLock(id)], [dono]).catch(() => undefined);
      }
    },
  };
}

const preenchida = (v: string | undefined) => v?.trim() || undefined;

/**
 * Upstash quando as variáveis existem; memória só fora da Vercel (desenvolvimento local e testes).
 * Configuração pela metade, ou Vercel sem Redis, falha ao subir: sessão em memória numa função
 * serverless faria o agente esquecer a conversa entre mensagens, sem erro nenhum.
 */
export function storeFromEnv<T>(env: NodeJS.ProcessEnv = process.env): SessionStore<T> {
  // Variável vazia (linha copiada do .env.example) conta como ausente.
  const url = preenchida(env.UPSTASH_REDIS_REST_URL) ?? preenchida(env.KV_REST_API_URL);
  const token = preenchida(env.UPSTASH_REDIS_REST_TOKEN) ?? preenchida(env.KV_REST_API_TOKEN);
  if (url && token) return redisStore<T>(new Redis({ url, token }));
  if (url || token) throw new Error('Redis configurado pela metade: informe a URL e o token REST.');
  if (env.VERCEL) throw new Error('Sessões exigem Redis na Vercel: configure UPSTASH_REDIS_REST_URL e _TOKEN.');
  return memoryStore<T>();
}
