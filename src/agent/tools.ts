import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { formatarData, diaDaSemana } from '../domain/dates.js';
import { cotar, formatarReais, reaisParaCentavos } from '../domain/pricing.js';
import { CatalogError, type Catalog, type Ficha } from '../infra/catalog.js';
import { registrarValores, type Estado } from './state.js';

// Ferramentas do agente. O modelo escolhe qual chamar; o que cada uma devolve vem do catálogo ou
// do código, e é isso que o modelo repassa ao hóspede. Entradas são validadas de novo aqui, mesmo
// com strict: true, porque o que chega ao catálogo e às contas não pode depender do modelo.

export interface Contexto {
  estado: Estado;
  catalog: Catalog;
  /** AAAA-MM-DD em Brasília */
  hoje: string;
}

export interface Resultado {
  conteudo: unknown;
  erro?: boolean;
  handoff?: boolean;
}

interface Ferramenta<T> {
  definicao: Anthropic.Tool;
  entrada: z.ZodType<T>;
  executar(entrada: T, ctx: Contexto): Promise<Resultado>;
}

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');
const idImovel = z.string().min(1).max(20);

/** Ficha como o modelo a vê: só o que o catálogo informa, com os campos ausentes ditos como ausentes. */
function fichaParaModelo(f: Ficha) {
  return {
    id: f.id,
    nome: f.nome,
    cidade: `${f.cidade}/${f.uf}`,
    bairro: f.bairro,
    tipo: f.tipo,
    quartos: f.quartos,
    banheiros: f.banheiros,
    capacidade_maxima_hospedes: f.capacidade,
    diaria: formatarReais(reaisParaCentavos(f.diaria)),
    diaria_noites_de_sexta_e_sabado: formatarReais(Math.round((reaisParaCentavos(f.diaria) * 12) / 10)),
    taxa_limpeza_por_estadia: formatarReais(reaisParaCentavos(f.taxa_limpeza)),
    minimo_noites: f.minimo_noites,
    checkin_a_partir_de: f.checkin_hora,
    checkout_ate: f.checkout_hora,
    distancia_praia: f.distancia_praia_m === null ? 'não informada no catálogo' : `${f.distancia_praia_m} m`,
    comodidades: f.comodidades,
    aceita_pet: f.regras.aceita_pet,
    permite_fumar: f.regras.permite_fumar,
    permite_festas: f.regras.permite_festas,
    descricao: f.descricao,
  };
}

function erroDoCatalogo(e: unknown): Resultado {
  if (e instanceof CatalogError) return { conteudo: { erro: e.tipo, mensagem: e.message }, erro: true };
  throw e;
}

const listarCidades: Ferramenta<Record<string, never>> = {
  definicao: {
    name: 'listar_cidades',
    description: 'Lista as cidades onde há imóveis no catálogo e quantos imóveis há em cada uma.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  entrada: z.strictObject({}),
  async executar(_e, ctx) {
    try {
      return { conteudo: { cidades: await ctx.catalog.cidades() } };
    } catch (e) {
      return erroDoCatalogo(e);
    }
  },
};

interface FiltroModelo {
  cidade: string | null;
  busca: string | null;
  hospedes: number | null;
  aceita_pet: boolean | null;
}

const buscarImoveis: Ferramenta<FiltroModelo> = {
  definicao: {
    name: 'buscar_imoveis',
    description:
      'Busca imóveis no catálogo e devolve um resumo de cada um (id, nome, cidade, bairro, tipo, capacidade). ' +
      'Informe cidade ou busca (texto livre que procura em nome, bairro e cidade). ' +
      'Filtros opcionais: hospedes (capacidade mínima) e aceita_pet. Para preço e detalhes, use ver_imovel.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        cidade: { type: ['string', 'null'], description: 'Nome da cidade, ex.: Florianópolis' },
        busca: { type: ['string', 'null'], description: 'Texto livre, ex.: "chale serra" ou "Jurerê"' },
        hospedes: { type: ['integer', 'null'], description: 'Número de hóspedes (capacidade mínima)' },
        aceita_pet: { type: ['boolean', 'null'], description: 'true para só imóveis que aceitam pet' },
      },
      required: ['cidade', 'busca', 'hospedes', 'aceita_pet'],
      additionalProperties: false,
    },
  },
  entrada: z.strictObject({
    cidade: z.string().max(80).nullable(),
    busca: z.string().max(80).nullable(),
    hospedes: z.number().int().min(1).max(50).nullable(),
    aceita_pet: z.boolean().nullable(),
  }),
  async executar(e, ctx) {
    try {
      const imoveis = await ctx.catalog.buscar({
        cidade: e.cidade ?? undefined,
        busca: e.busca ?? undefined,
        hospedes: e.hospedes ?? undefined,
        aceita_pet: e.aceita_pet ?? undefined,
      });
      return { conteudo: { imoveis, total: imoveis.length } };
    } catch (err) {
      return erroDoCatalogo(err);
    }
  },
};

const verImovel: Ferramenta<{ imovel_id: string }> = {
  definicao: {
    name: 'ver_imovel',
    description:
      'Devolve a ficha completa de um imóvel pelo id (ex.: GRM-301): preços, mínimo de noites, capacidade, ' +
      'horários, comodidades, regras (pet, fumar, festas) e descrição. É a única fonte para responder sobre o imóvel.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { imovel_id: { type: 'string', description: 'Id do imóvel, ex.: GRM-301' } },
      required: ['imovel_id'],
      additionalProperties: false,
    },
  },
  entrada: z.strictObject({ imovel_id: idImovel }),
  async executar(e, ctx) {
    try {
      const f = await ctx.catalog.imovel(e.imovel_id);
      const diaria = reaisParaCentavos(f.diaria);
      registrarValores(ctx.estado, diaria, Math.round((diaria * 12) / 10), reaisParaCentavos(f.taxa_limpeza));
      return { conteudo: fichaParaModelo(f) };
    } catch (err) {
      return erroDoCatalogo(err);
    }
  },
};

const cotarEstadia: Ferramenta<{ imovel_id: string; checkin: string; checkout: string; hospedes: number }> = {
  definicao: {
    name: 'cotar',
    description:
      'Calcula o preço de uma estadia pela regra oficial (diária; noites de sexta e sábado +20%; taxa de limpeza ' +
      'uma vez) ou recusa explicando o motivo (mínimo de noites, capacidade, datas). Use sempre que falar de ' +
      'valor de estadia: nunca calcule por conta própria. Datas em AAAA-MM-DD.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        imovel_id: { type: 'string', description: 'Id do imóvel, ex.: GRM-301' },
        checkin: { type: 'string', description: 'Data de entrada, AAAA-MM-DD' },
        checkout: { type: 'string', description: 'Data de saída, AAAA-MM-DD' },
        hospedes: { type: 'integer', description: 'Número total de hóspedes, contando crianças' },
      },
      required: ['imovel_id', 'checkin', 'checkout', 'hospedes'],
      additionalProperties: false,
    },
  },
  entrada: z.strictObject({ imovel_id: idImovel, checkin: data, checkout: data, hospedes: z.number().int() }),
  async executar(e, ctx) {
    let ficha: Ficha;
    try {
      ficha = await ctx.catalog.imovel(e.imovel_id);
    } catch (err) {
      return erroDoCatalogo(err);
    }
    const c = cotar(ficha, e, ctx.hoje);
    if (!c.ok) {
      const motivos = c.recusas.map((r) => r.mensagem);
      return { conteudo: { ok: false, imovel: `${ficha.nome} (${ficha.id})`, motivos } };
    }
    const noites = c.noites.map((n) => n.valorCentavos);
    registrarValores(ctx.estado, c.totalCentavos, c.subtotalCentavos, c.taxaLimpezaCentavos, ...noites);
    ctx.estado.cotacoes.push({
      imovelId: c.imovelId,
      checkin: c.checkin,
      checkout: c.checkout,
      hospedes: c.hospedes,
      totalCentavos: c.totalCentavos,
    });
    return {
      conteudo: {
        ok: true,
        imovel: `${ficha.nome} (${ficha.id})`,
        entrada: `${formatarData(c.checkin)} (${diaDaSemana(c.checkin)}), check-in a partir de ${ficha.checkin_hora}`,
        saida: `${formatarData(c.checkout)} (${diaDaSemana(c.checkout)}), check-out até ${ficha.checkout_hora}`,
        hospedes: c.hospedes,
        noites: c.noites.map((n) => ({
          noite: `${formatarData(n.data)} (${n.diaSemana})`,
          valor: formatarReais(n.valorCentavos),
          ...(n.acrescimoFimDeSemana ? { observacao: '+20% (noite de sexta ou sábado)' } : {}),
        })),
        taxa_limpeza: formatarReais(c.taxaLimpezaCentavos),
        total: formatarReais(c.totalCentavos),
      },
    };
  },
};

// Ordem fixa: a lista de ferramentas é o começo do prompt em cache.
const FERRAMENTAS = [buscarImoveis, cotarEstadia, listarCidades, verImovel] as Ferramenta<unknown>[];

export const definicoes: Anthropic.Tool[] = FERRAMENTAS.map((f) => f.definicao);

export async function executarFerramenta(nome: string, entrada: unknown, ctx: Contexto): Promise<Resultado> {
  const f = FERRAMENTAS.find((x) => x.definicao.name === nome);
  if (!f) return { conteudo: { erro: `ferramenta desconhecida: ${nome}` }, erro: true };
  const r = f.entrada.safeParse(entrada);
  if (!r.success) {
    const detalhes = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { conteudo: { erro: 'entrada inválida', detalhes }, erro: true };
  }
  return f.executar(r.data, ctx);
}
