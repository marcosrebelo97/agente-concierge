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

export interface Catalog {
  cidades(): Promise<Cidade[]>;
  buscar(filtro: FiltroBusca): Promise<Resumo[]>;
  imovel(id: string): Promise<Ficha>;
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

export function createCatalog(opts: CatalogOptions): Catalog {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { expira: number; corpo: unknown }>();

  async function tentar(url: string): Promise<Response> {
    return doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  }

  async function get(caminho: string): Promise<unknown> {
    const url = `${opts.baseUrl}${caminho}`;
    const hit = cache.get(url);
    if (hit && hit.expira > now()) return hit.corpo;

    let res: Response | undefined;
    // Uma nova tentativa só para falha de rede, timeout ou 5xx; 4xx é resposta definitiva.
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      try {
        res = await tentar(url);
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

    const corpo: unknown = await res.json();
    cache.set(url, { expira: now() + ttlMs, corpo });
    return corpo;
  }

  function parse<T>(schema: z.ZodType<T>, corpo: unknown): T {
    const r = schema.safeParse(corpo);
    if (!r.success) throw new CatalogError('indisponivel', 'O catálogo respondeu num formato inesperado.');
    return r.data;
  }

  return {
    async cidades() {
      return parse(ListaCidades, await get('/cidades')).cidades;
    },

    async buscar(filtro) {
      const params = new URLSearchParams();
      if (filtro.cidade?.trim()) params.set('cidade', filtro.cidade.trim());
      if (filtro.busca?.trim()) params.set('busca', filtro.busca.trim());
      if (!params.has('cidade') && !params.has('busca')) {
        throw new CatalogError('parametro_invalido', 'Informe uma cidade ou um texto de busca.');
      }
      if (filtro.hospedes !== undefined) params.set('hospedes', String(filtro.hospedes));
      if (filtro.aceita_pet !== undefined) params.set('aceita_pet', String(filtro.aceita_pet));
      params.sort(); // mesma consulta, mesma URL, mesmo cache
      return parse(ListaImoveis, await get(`/imoveis?${params}`)).imoveis;
    },

    async imovel(id) {
      const normalizado = id.trim().toUpperCase();
      if (!ID.test(normalizado)) throw new CatalogError('nao_encontrado', `Não existe imóvel com o código "${id}".`);
      return parse(Ficha, await get(`/imoveis/${normalizado}`));
    },
  };
}
