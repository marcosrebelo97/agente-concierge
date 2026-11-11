import { z } from 'zod';

// Cliente da API do catálogo. O catálogo é a única fonte de verdade do agente: nada aqui inventa
// ou completa dados, e a forma de cada resposta é validada antes de chegar ao modelo.

export const Ficha = z.object({
  id: z.string(),
  nome: z.string(),
  cidade: z.string(),
  uf: z.string(),
  bairro: z.string(),
  tipo: z.string(),
  quartos: z.number(),
  banheiros: z.number(),
  capacidade: z.number().int(),
  diaria: z.number().nonnegative(),
  taxa_limpeza: z.number().nonnegative(),
  minimo_noites: z.number().int().positive(),
  checkin_hora: z.string(),
  checkout_hora: z.string(),
  distancia_praia_m: z.number().nullable(),
  comodidades: z.array(z.string()),
  regras: z.object({ aceita_pet: z.boolean(), permite_fumar: z.boolean(), permite_festas: z.boolean() }),
  descricao: z.string(),
});
export type Ficha = z.infer<typeof Ficha>;

export const Resumo = z.object({
  id: z.string(),
  nome: z.string(),
  cidade: z.string(),
  uf: z.string(),
  bairro: z.string(),
  tipo: z.string(),
  capacidade: z.number().int(),
});
export type Resumo = z.infer<typeof Resumo>;

const ListaImoveis = z.object({ imoveis: z.array(Resumo) });
const ListaCidades = z.object({
  cidades: z.array(z.object({ cidade: z.string(), uf: z.string(), imoveis: z.number().int() })),
});
export type Cidade = z.infer<typeof ListaCidades>['cidades'][number];

export interface FiltroBusca {
  cidade?: string;
  busca?: string;
  hospedes?: number;
  aceita_pet?: boolean;
}

export type TipoErroCatalogo = 'nao_encontrado' | 'parametro_invalido' | 'indisponivel';

export class CatalogError extends Error {
  constructor(
    readonly tipo: TipoErroCatalogo,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** `signal` corta a consulta e a nova tentativa no prazo do turno. */
export interface Catalog {
  cidades(signal?: AbortSignal): Promise<Cidade[]>;
  buscar(filtro: FiltroBusca, signal?: AbortSignal): Promise<Resumo[]>;
  imovel(id: string, signal?: AbortSignal): Promise<Ficha>;
}

export interface CatalogOptions {
  baseUrl: string; // .../catalogo/<token>
  fetch?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Id no formato do catálogo (ex.: GRM-301). Evita montar URL com texto arbitrário vindo do modelo. */
const ID = /^[A-Z]{3}-\d{3}$/;
/** Teto de consultas em cache por instância: a busca é texto livre e a instância pode ficar quente por horas. */
const MAX_CACHE = 200;

export function createCatalog(opts: CatalogOptions): Catalog {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  // Guarda só respostas já validadas: uma resposta fora do formato não fica 10 minutos servindo erro.
  const cache = new Map<string, { expira: number; valor: unknown }>();

  async function tentar(url: string, signal?: AbortSignal): Promise<Response> {
    const limite = AbortSignal.timeout(timeoutMs);
    return doFetch(url, {
      signal: signal ? AbortSignal.any([limite, signal]) : limite,
      headers: { accept: 'application/json' },
    });
  }

  function guardar(url: string, valor: unknown): void {
    const agora = now();
    for (const [k, v] of cache) if (v.expira <= agora) cache.delete(k);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!); // a mais antiga
    cache.set(url, { expira: agora + ttlMs, valor });
  }

  async function get<T>(caminho: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const url = `${opts.baseUrl}${caminho}`;
    const hit = cache.get(url);
    if (hit && hit.expira > now()) return hit.valor as T;

    let res: Response | undefined;
    // Uma nova tentativa só para falha de rede, timeout ou 5xx; 4xx é resposta definitiva.
    for (let tentativa = 0; tentativa < 2 && !signal?.aborted; tentativa++) {
      try {
        res = await tentar(url, signal);
        if (res.status < 500) break;
      } catch {
        res = undefined;
      }
    }
    if (!res || res.status >= 500) throw new CatalogError('indisponivel', 'O catálogo não respondeu.');
    if (res.status === 404) throw new CatalogError('nao_encontrado', 'Imóvel não encontrado no catálogo.');
    if (res.status === 400) {
      const corpo = (await res.json().catch(() => ({}))) as { erro?: unknown };
      const detalhe = typeof corpo.erro === 'string' ? corpo.erro : 'parâmetro inválido';
      throw new CatalogError('parametro_invalido', `Consulta inválida ao catálogo: ${detalhe}.`);
    }
    if (!res.ok) throw new CatalogError('indisponivel', `O catálogo respondeu ${res.status}.`);

    let corpo: unknown;
    try {
      corpo = await res.json();
    } catch {
      throw new CatalogError('indisponivel', 'O catálogo respondeu num formato inesperado.');
    }
    const r = schema.safeParse(corpo);
    if (!r.success) throw new CatalogError('indisponivel', 'O catálogo respondeu num formato inesperado.');
    guardar(url, r.data);
    return r.data;
  }

  return {
    async cidades(signal) {
      return (await get('/cidades', ListaCidades, signal)).cidades;
    },

    async buscar(filtro, signal) {
      const params = new URLSearchParams();
      if (filtro.cidade?.trim()) params.set('cidade', filtro.cidade.trim());
      if (filtro.busca?.trim()) params.set('busca', filtro.busca.trim());
      if (!params.has('cidade') && !params.has('busca')) {
        throw new CatalogError('parametro_invalido', 'Informe uma cidade ou um texto de busca.');
      }
      if (filtro.hospedes !== undefined) params.set('hospedes', String(filtro.hospedes));
      if (filtro.aceita_pet !== undefined) params.set('aceita_pet', String(filtro.aceita_pet));
      params.sort(); // mesma consulta, mesma URL, mesmo cache
      return (await get(`/imoveis?${params}`, ListaImoveis, signal)).imoveis;
    },

    async imovel(id, signal) {
      const normalizado = id.trim().toUpperCase();
      if (!ID.test(normalizado)) throw new CatalogError('nao_encontrado', `Não existe imóvel com o código "${id}".`);
      return get(`/imoveis/${normalizado}`, Ficha, signal);
    },
  };
}
