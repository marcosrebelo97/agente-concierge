import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { formatarData, diaDaSemana } from '../domain/dates.js';
import { cotar, diariaFimDeSemana, formatarReais, reaisParaCentavos } from '../domain/pricing.js';
import { confirmaReserva, hashReserva, normalizarTelefone, validarNome, type Lead } from '../domain/lead.js';
import { CatalogError, type Catalog, type Ficha } from '../infra/catalog.js';
import type { Webhook } from '../infra/webhook.js';
import { registrarValores, type Estado } from './state.js';

// Ferramentas do agente. O modelo escolhe qual chamar; o que cada uma devolve vem do catálogo ou
// do código, e é isso que o modelo repassa ao hóspede. Entradas são validadas de novo aqui, mesmo
// com strict: true, porque o que chega ao catálogo e às contas não pode depender do modelo.

export interface Contexto {
  estado: Estado;
  catalog: Catalog;
  webhook: Webhook;
  /** AAAA-MM-DD em Brasília */
  hoje: string;
  /** O que o hóspede escreveu neste turno: a confirmação da reserva é conferida nela. */
  mensagem: string;
  /** Aborta no prazo do turno: nenhuma chamada externa passa dele. */
  signal: AbortSignal;
  /** Grava agora o estado fora do histórico (reserva, leads), antes de uma ação que não se desfaz. */
  salvar(): Promise<void>;
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
    diaria_noites_de_sexta_e_sabado: formatarReais(diariaFimDeSemana(reaisParaCentavos(f.diaria))),
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
      return { conteudo: { cidades: await ctx.catalog.cidades(ctx.signal) } };
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
      const filtro = {
        cidade: e.cidade ?? undefined,
        busca: e.busca ?? undefined,
        hospedes: e.hospedes ?? undefined,
        aceita_pet: e.aceita_pet ?? undefined,
      };
      const imoveis = await ctx.catalog.buscar(filtro, ctx.signal);
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
      const f = await ctx.catalog.imovel(e.imovel_id, ctx.signal);
      const diaria = reaisParaCentavos(f.diaria);
      registrarValores(ctx.estado, diaria, diariaFimDeSemana(diaria), reaisParaCentavos(f.taxa_limpeza));
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
      ficha = await ctx.catalog.imovel(e.imovel_id, ctx.signal);
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

interface DadosReserva {
  nome: string;
  telefone: string;
  imovel_id: string;
  checkin: string;
  checkout: string;
  hospedes: number;
}

const prepararReserva: Ferramenta<DadosReserva> = {
  definicao: {
    name: 'preparar_reserva',
    description:
      'Primeiro passo para registrar o pedido de reserva, quando o hóspede quer fechar e você já tem nome, ' +
      'telefone com DDD, imóvel, datas e número de hóspedes. Valida os dados, recalcula o preço e devolve o ' +
      'resumo que você deve mostrar ao hóspede, pedindo que ele confirme. NÃO registra nada: o registro só ' +
      'acontece com confirmar_reserva, depois que o hóspede responder confirmando. Se o hóspede mudar qualquer ' +
      'dado, chame esta ferramenta de novo com os dados novos.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do responsável pela reserva' },
        telefone: { type: 'string', description: 'Telefone com DDD, ex.: (48) 99999-0000, ou internacional com +' },
        imovel_id: { type: 'string', description: 'Id do imóvel, ex.: GRM-301' },
        checkin: { type: 'string', description: 'Data de entrada, AAAA-MM-DD' },
        checkout: { type: 'string', description: 'Data de saída, AAAA-MM-DD' },
        hospedes: { type: 'integer', description: 'Número total de hóspedes' },
      },
      required: ['nome', 'telefone', 'imovel_id', 'checkin', 'checkout', 'hospedes'],
      additionalProperties: false,
    },
  },
  entrada: z.strictObject({
    nome: z.string().max(200),
    telefone: z.string().max(40),
    imovel_id: idImovel,
    checkin: data,
    checkout: data,
    hospedes: z.number().int(),
  }),
  async executar(e, ctx) {
    const problemas: string[] = [];
    const nome = validarNome(e.nome);
    if (!nome.ok) problemas.push(nome.motivo);
    const telefone = normalizarTelefone(e.telefone);
    if (!telefone.ok) problemas.push(telefone.motivo);

    let ficha: Ficha;
    try {
      ficha = await ctx.catalog.imovel(e.imovel_id, ctx.signal);
    } catch (err) {
      return erroDoCatalogo(err);
    }
    const c = cotar(ficha, e, ctx.hoje);
    if (!c.ok) problemas.push(...c.recusas.map((r) => r.mensagem));
    if (!nome.ok || !telefone.ok || !c.ok) return { conteudo: { ok: false, problemas } };

    const lead: Lead = {
      nome: nome.valor,
      telefone: telefone.valor,
      imovel_id: ficha.id,
      checkin: c.checkin,
      checkout: c.checkout,
      hospedes: c.hospedes,
      valor_total: c.totalCentavos / 100,
    };
    const hash = hashReserva(lead);
    if (ctx.estado.leadsEnviados.includes(hash)) {
      return { conteudo: { ok: false, problemas: ['Esta reserva, com estes mesmos dados, já foi registrada.'] } };
    }
    ctx.estado.pendente = { turno: ctx.estado.turno, hash, lead };
    // Um envio anterior desta mesma reserva pode ter chegado: a confirmação confere o webhook antes.
    if (ctx.estado.enviosIncertos?.includes(hash)) ctx.estado.pendente.envioIniciado = true;
    registrarValores(ctx.estado, c.totalCentavos);
    return {
      conteudo: {
        ok: true,
        resumo: {
          nome: lead.nome,
          telefone: lead.telefone,
          imovel: `${ficha.nome} (${ficha.id}), ${ficha.cidade}/${ficha.uf}`,
          entrada: `${formatarData(c.checkin)} (${diaDaSemana(c.checkin)})`,
          saida: `${formatarData(c.checkout)} (${diaDaSemana(c.checkout)})`,
          hospedes: lead.hospedes,
          total: formatarReais(c.totalCentavos),
        },
        proximo_passo:
          'Mostre este resumo ao hóspede e pergunte se pode registrar o pedido. Chame confirmar_reserva só ' +
          'depois que ele responder confirmando.',
      },
    };
  },
};

const confirmarReserva: Ferramenta<Record<string, never>> = {
  definicao: {
    name: 'confirmar_reserva',
    description:
      'Registra o pedido de reserva preparado por preparar_reserva, enviando-o ao time comercial. Só chame quando ' +
      'o hóspede, na mensagem atual, confirmar o resumo que você mostrou. Não recebe dados: envia exatamente o ' +
      'que foi preparado.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  entrada: z.strictObject({}),
  async executar(_e, ctx) {
    const { estado } = ctx;
    const p = estado.pendente;
    if (!p) {
      // Depois de um envio a pendente é apagada: confirmar de novo nunca duplica o lead. O motivo não diz
      // "já registrado": a pendente também some quando o resumo não chegou ao hóspede, e aí nada foi enviado.
      const motivo = 'Não há reserva preparada. Use preparar_reserva e mostre o resumo ao hóspede primeiro.';
      return { conteudo: { ok: false, motivo }, erro: true };
    }
    if (p.turno >= estado.turno) {
      const motivo = 'O hóspede ainda não viu o resumo. Mostre o resumo e espere a resposta dele antes de confirmar.';
      return { conteudo: { ok: false, motivo }, erro: true };
    }
    if (!confirmaReserva(ctx.mensagem)) {
      const motivo =
        'A mensagem do hóspede não é uma confirmação clara do resumo. Pergunte se pode registrar o pedido ' +
        'ou, se ele quer mudar algo, prepare a reserva de novo.';
      return { conteudo: { ok: false, motivo }, erro: true };
    }

    // O preço e as datas são conferidos de novo: o lead sai com o que vale agora, não com o que valia no resumo.
    let ficha: Ficha;
    try {
      ficha = await ctx.catalog.imovel(p.lead.imovel_id, ctx.signal);
    } catch (err) {
      return erroDoCatalogo(err);
    }
    const c = cotar(ficha, p.lead, ctx.hoje);
    if (!c.ok || c.totalCentavos !== Math.round(p.lead.valor_total * 100)) {
      estado.pendente = null;
      const motivo =
        'O preço ou as datas não valem mais como no resumo. Chame preparar_reserva de novo e mostre o novo resumo.';
      return { conteudo: { ok: false, motivo }, erro: true };
    }

    // Se uma tentativa anterior pode ter chegado ao webhook (a função caiu ou o estado não foi gravado depois
    // do envio), confere antes de enviar de novo.
    if (p.envioIniciado) {
      let chegou: boolean;
      try {
        chegou = await ctx.webhook.recebido(p.lead, ctx.signal);
      } catch {
        return naoRegistrado(estado);
      }
      if (chegou) return registrado(estado, ctx);
    }
    p.envioIniciado = true;
    marcarIncerto(estado, p.hash, true);
    await ctx.salvar(); // se não der para gravar, não envia: sem essa marca, uma nova tentativa duplicaria

    const r = await ctx.webhook.enviar(p.lead, ctx.signal);
    if (r.status === 'criado') return registrado(estado, ctx);
    if (r.status === 'invalido') {
      p.envioIniciado = false;
      marcarIncerto(estado, p.hash, false);
      return { conteudo: { ok: false, motivo: 'O registro foi recusado.', erros: r.erros }, erro: true };
    }
    return naoRegistrado(estado);
  },
};

function marcarIncerto(estado: Estado, hash: string, incerto: boolean): void {
  const lista = (estado.enviosIncertos ?? []).filter((h) => h !== hash);
  estado.enviosIncertos = incerto ? [...lista, hash] : lista;
}

async function registrado(estado: Estado, ctx: Contexto): Promise<Resultado> {
  estado.leadsEnviados.push(estado.pendente!.hash);
  marcarIncerto(estado, estado.pendente!.hash, false);
  estado.pendente = null;
  // Grava já: se o fim do turno não chegar ao Redis, o próximo "sim" não reenvia. Se falhar, a marca de
  // envio iniciado faz a próxima tentativa conferir o webhook antes.
  await ctx.salvar().catch(() => undefined);
  return { conteudo: { ok: true, registrado: true } };
}

/** O hóspede pode confirmar de novo na próxima mensagem: a pendente conta como mostrada neste turno. */
function naoRegistrado(estado: Estado): Resultado {
  estado.pendente!.turno = estado.turno;
  const motivo =
    'Não foi possível registrar agora (sistema indisponível). Não diga que foi registrado; diga que não ' +
    'conseguiu e pergunte se o hóspede quer tentar de novo.';
  return { conteudo: { ok: false, motivo }, erro: true };
}

const MOTIVOS_HANDOFF = [
  'reclamacao',
  'desconto_ou_negociacao',
  'excecao_a_regra',
  'pedido_de_atendente',
  'fora_do_alcance',
] as const;

const passarParaHumano: Ferramenta<{ motivo: (typeof MOTIVOS_HANDOFF)[number]; resumo: string }> = {
  definicao: {
    name: 'passar_para_humano',
    description:
      'Passa a conversa para um atendente humano. Use em: reclamação; pedido de desconto, negociação de preço ' +
      'ou condição especial; pedido de exceção a uma regra do imóvel; pedido para falar com uma pessoa; assunto ' +
      'que você não consegue resolver (reserva existente, cancelamento ou política de cancelamento, pagamento ou ' +
      'formas de pagamento, problema durante a estadia).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', enum: [...MOTIVOS_HANDOFF] },
        resumo: { type: 'string', description: 'Uma frase para o atendente sobre o que o hóspede precisa' },
      },
      required: ['motivo', 'resumo'],
      additionalProperties: false,
    },
  },
  entrada: z.strictObject({ motivo: z.enum(MOTIVOS_HANDOFF), resumo: z.string().max(500) }),
  async executar(e) {
    // O resumo é texto livre do modelo e pode ter dados do hóspede: o log guarda só o motivo.
    console.log(JSON.stringify({ evento: 'handoff', motivo: e.motivo }));
    return {
      handoff: true,
      conteudo: {
        ok: true,
        proximo_passo:
          'Diga ao hóspede, em poucas palavras, que um atendente da equipe vai continuar o atendimento. ' +
          'Não negocie nem prometa nada em nome do atendente.',
      },
    };
  },
};

// Ordem fixa: a lista de ferramentas é o começo do prompt em cache.
const FERRAMENTAS = [
  buscarImoveis,
  confirmarReserva,
  cotarEstadia,
  listarCidades,
  passarParaHumano,
  prepararReserva,
  verImovel,
] as Ferramenta<unknown>[];

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
