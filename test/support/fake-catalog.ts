import fixture from '../fixtures/catalogo.json' with { type: 'json' };
import type { Ficha } from '../../src/infra/catalog.js';

// Imitação da API do catálogo sobre as 15 fichas reais gravadas em fixtures/catalogo.json.
// Segue o comportamento observado: cidade ou busca obrigatória, acentos e maiúsculas ignorados,
// 400 para parâmetro faltando, 404 para imóvel inexistente.

export const FICHAS = fixture.fichas as Ficha[];
export const BASE = 'https://catalogo.test/catalogo/TOKEN';

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

export interface FakeCatalog {
  fetch: typeof fetch;
  chamadas: string[];
}

export function fakeCatalog(): FakeCatalog {
  const chamadas: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    chamadas.push(url.pathname + url.search);
    const caminho = url.pathname.replace(/^\/catalogo\/[^/]+/, '');

    if (caminho === '/cidades') {
      const por = new Map<string, { cidade: string; uf: string; imoveis: number }>();
      for (const f of FICHAS) {
        const c = por.get(f.cidade) ?? { cidade: f.cidade, uf: f.uf, imoveis: 0 };
        c.imoveis++;
        por.set(f.cidade, c);
      }
      return json({ cidades: [...por.values()] });
    }

    if (caminho === '/imoveis') {
      const cidade = url.searchParams.get('cidade');
      const busca = url.searchParams.get('busca');
      if (!cidade && !busca) return json({ erro: 'informe cidade= ou busca=' }, 400);
      const hospedes = url.searchParams.get('hospedes');
      const pet = url.searchParams.get('aceita_pet');
      const lista = FICHAS.filter((f) => {
        if (cidade && semAcento(f.cidade) !== semAcento(cidade)) return false;
        if (busca) {
          const alvo = semAcento(`${f.nome} ${f.bairro} ${f.cidade}`);
          if (!semAcento(busca).split(/\s+/).every((p) => alvo.includes(p))) return false;
        }
        if (hospedes && f.capacidade < Number(hospedes)) return false;
        if (pet && String(f.regras.aceita_pet) !== pet) return false;
        return true;
      }).map(({ id, nome, cidade, uf, bairro, tipo, capacidade }) => ({ id, nome, cidade, uf, bairro, tipo, capacidade }));
      return json({ imoveis: lista, total: lista.length });
    }

    const m = /^\/imoveis\/([^/]+)$/.exec(caminho);
    if (m) {
      const ficha = FICHAS.find((f) => f.id === decodeURIComponent(m[1]!));
      return ficha ? json(ficha) : json({ erro: 'imovel nao encontrado' }, 404);
    }
    return json({ erro: 'rota inexistente' }, 404);
  };
  return { fetch: impl as typeof fetch, chamadas };
}
