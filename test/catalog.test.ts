import { describe, expect, it } from 'vitest';
import { CatalogError, createCatalog } from '../src/infra/catalog.js';
import { BASE, fakeCatalog } from './support/fake-catalog.js';

function setup(extra: Partial<Parameters<typeof createCatalog>[0]> = {}) {
  const fake = fakeCatalog();
  return { fake, catalog: createCatalog({ baseUrl: BASE, fetch: fake.fetch, ...extra }) };
}

async function erro(p: Promise<unknown>): Promise<CatalogError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error('esperava CatalogError');
}

describe('catálogo', () => {
  it('lista as cidades', async () => {
    const { catalog } = setup();
    const cidades = await catalog.cidades();
    expect(cidades.find((c) => c.cidade === 'Florianopolis')?.imoveis).toBe(3);
  });

  it('busca por cidade, com filtros de hóspedes e pet', async () => {
    const { catalog } = setup();
    expect((await catalog.buscar({ cidade: 'Florianópolis' })).map((i) => i.id)).toEqual(['FLN-101', 'FLN-102', 'FLN-103']);
    const r = await catalog.buscar({ cidade: 'florianopolis', hospedes: 5, aceita_pet: true });
    expect(r.map((i) => i.id)).toEqual(['FLN-102']);
  });

  it('busca por texto livre', async () => {
    const { catalog } = setup();
    expect((await catalog.buscar({ busca: 'chale serra' })).map((i) => i.id)).toEqual(['GRM-301']);
  });

  it('exige cidade ou busca antes de chamar a API', async () => {
    const { catalog, fake } = setup();
    expect((await erro(catalog.buscar({ hospedes: 2 }))).tipo).toBe('parametro_invalido');
    expect((await erro(catalog.buscar({ cidade: '  ' }))).tipo).toBe('parametro_invalido');
    expect(fake.chamadas).toHaveLength(0);
  });

  it('devolve a ficha completa e validada', async () => {
    const { catalog } = setup();
    const f = await catalog.imovel('grm-301');
    expect(f).toMatchObject({ id: 'GRM-301', diaria: 590, taxa_limpeza: 150, minimo_noites: 2, capacidade: 4 });
  });

  it('imóvel inexistente é nao_encontrado, e um id fora do formato nem chega à API', async () => {
    const { catalog, fake } = setup();
    expect((await erro(catalog.imovel('XYZ-999'))).tipo).toBe('nao_encontrado');
    expect((await erro(catalog.imovel('../cidades'))).tipo).toBe('nao_encontrado');
    expect(fake.chamadas).toEqual(['/catalogo/TOKEN/imoveis/XYZ-999']);
  });

  it('guarda respostas em cache pelo tempo de vida e a mesma consulta reaproveita a URL', async () => {
    let agora = 0;
    const { catalog, fake } = setup({ ttlMs: 1000, now: () => agora });
    await catalog.imovel('GRM-301');
    await catalog.imovel('GRM-301');
    await catalog.buscar({ cidade: 'Gramado', hospedes: 2 });
    await catalog.buscar({ hospedes: 2, cidade: 'Gramado' });
    expect(fake.chamadas).toHaveLength(2);
    agora = 1001;
    await catalog.imovel('GRM-301');
    expect(fake.chamadas).toHaveLength(3);
  });

  it('tenta de novo uma vez em falha de rede ou 5xx, e depois desiste como indisponivel', async () => {
    let n = 0;
    const instavel = (async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ cidades: [] }), { status: 200 });
    }) as typeof fetch;
    expect(await createCatalog({ baseUrl: BASE, fetch: instavel }).cidades()).toEqual([]);

    let m = 0;
    const fora = (async () => {
      m++;
      return new Response('erro', { status: 503 });
    }) as typeof fetch;
    expect((await erro(createCatalog({ baseUrl: BASE, fetch: fora }).cidades())).tipo).toBe('indisponivel');
    expect(m).toBe(2);
  });

  it('resposta fora do formato esperado vira indisponivel, não dado inventado', async () => {
    const torta = (async () => new Response(JSON.stringify({ id: 'GRM-301' }), { status: 200 })) as typeof fetch;
    expect((await erro(createCatalog({ baseUrl: BASE, fetch: torta }).imovel('GRM-301'))).tipo).toBe('indisponivel');
  });

  it('JSON inválido vira indisponivel, e resposta torta não fica em cache', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) return new Response('<html>erro</html>', { status: 200 });
      if (n === 2) return new Response(JSON.stringify({ cidades: 'x' }), { status: 200 });
      return new Response(JSON.stringify({ cidades: [] }), { status: 200 });
    }) as typeof fetch;
    const catalog = createCatalog({ baseUrl: BASE, fetch: f });
    expect((await erro(catalog.cidades())).tipo).toBe('indisponivel');
    expect((await erro(catalog.cidades())).tipo).toBe('indisponivel');
    expect(await catalog.cidades()).toEqual([]);
    expect(n).toBe(3);
  });

  it('para no prazo do turno, sem nova tentativa', async () => {
    let n = 0;
    const pendurado = ((_u: string, init?: RequestInit) => {
      n++;
      return new Promise((_r, rejeita) => init?.signal?.addEventListener('abort', () => rejeita(init.signal!.reason)));
    }) as typeof fetch;
    const catalog = createCatalog({ baseUrl: BASE, fetch: pendurado, timeoutMs: 5_000 });
    const inicio = Date.now();
    expect((await erro(catalog.imovel('GRM-301', AbortSignal.timeout(50)))).tipo).toBe('indisponivel');
    expect(Date.now() - inicio).toBeLessThan(1_000);
    expect(n).toBe(1);
  });
});
