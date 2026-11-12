// Regra de preço do enunciado, em centavos inteiros: float não arredonda dinheiro.

export interface ImovelPreco {
  id: string;
  diaria: number;
  taxa_limpeza: number;
  minimo_noites: number;
  capacidade: number;
}

export interface PedidoCotacao {
  checkin: string; // AAAA-MM-DD
  checkout: string; // AAAA-MM-DD
  hospedes: number;
}

export type CodigoRecusa =
  | 'data_invalida'
  | 'checkout_nao_posterior'
  | 'checkin_no_passado'
  | 'estadia_longa_demais'
  | 'hospedes_invalido'
  | 'abaixo_minimo_noites'
  | 'acima_capacidade';

export interface Recusa {
  codigo: CodigoRecusa;
  mensagem: string;
}

export interface Noite {
  data: string;
  diaSemana: string;
  acrescimoFimDeSemana: boolean;
  valorCentavos: number;
}

export type Cotacao =
  | {
      ok: true;
      imovelId: string;
      checkin: string;
      checkout: string;
      hospedes: number;
      noites: Noite[];
      subtotalCentavos: number;
      taxaLimpezaCentavos: number;
      totalCentavos: number;
    }
  | { ok: false; recusas: Recusa[] };

/** Estadias mais longas que isso não são cotadas pelo agente (decisão registrada em DECISOES.md). */
export const MAX_NOITES = 90;

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const SEXTA = 5;
const SABADO = 6;
const DIA_MS = 86_400_000;

/** Converte AAAA-MM-DD em dias desde a época, ou null se a data não existe (ex.: 2027-02-30). */
export function diaDoCalendario(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(ano, mes - 1, dia);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return ms / DIA_MS;
}

function isoDoDia(dia: number): string {
  return new Date(dia * DIA_MS).toISOString().slice(0, 10);
}

export function reaisParaCentavos(valor: number): number {
  return Math.round(valor * 100);
}

/** 215600 → "R$ 2.156,00" (espaço comum, não o NBSP que o Intl usa). */
export function formatarReais(centavos: number): string {
  const sinal = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  const inteiro = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${sinal}R$ ${inteiro},${frac}`;
}

/** +20% das noites de sexta e sábado, em inteiros: diária × 12 / 10, arredondada ao centavo. */
export function diariaFimDeSemana(diariaCentavos: number): number {
  return Math.round((diariaCentavos * 12) / 10);
}

/**
 * Cota uma estadia. `hoje` (AAAA-MM-DD) é opcional: quando informado, check-in no passado é recusado.
 * Recusas são acumuladas, para o agente explicar todos os motivos de uma vez.
 */
export function cotar(imovel: ImovelPreco, pedido: PedidoCotacao, hoje?: string): Cotacao {
  const recusas: Recusa[] = [];
  const entrada = diaDoCalendario(pedido.checkin);
  const saida = diaDoCalendario(pedido.checkout);

  if (entrada === null || saida === null) {
    recusas.push({ codigo: 'data_invalida', mensagem: 'Uma das datas não existe ou não está no formato AAAA-MM-DD.' });
  }

  if (!Number.isInteger(pedido.hospedes) || pedido.hospedes < 1) {
    recusas.push({ codigo: 'hospedes_invalido', mensagem: 'O número de hóspedes precisa ser um inteiro a partir de 1.' });
  } else if (pedido.hospedes > imovel.capacidade) {
    recusas.push({
      codigo: 'acima_capacidade',
      mensagem: `O imóvel comporta até ${imovel.capacidade} hóspedes; o pedido é para ${pedido.hospedes}.`,
    });
  }

  if (entrada !== null && saida !== null) {
    const hojeDia = hoje === undefined ? null : diaDoCalendario(hoje);
    const noites = saida - entrada;
    if (noites <= 0) {
      recusas.push({ codigo: 'checkout_nao_posterior', mensagem: 'A data de saída precisa ser depois da data de entrada.' });
    } else {
      if (hojeDia !== null && entrada < hojeDia) {
        recusas.push({ codigo: 'checkin_no_passado', mensagem: 'A data de entrada já passou.' });
      }
      if (noites > MAX_NOITES) {
        recusas.push({
          codigo: 'estadia_longa_demais',
          mensagem: `Cotamos estadias de até ${MAX_NOITES} noites; o pedido tem ${noites}.`,
        });
      }
      if (noites < imovel.minimo_noites) {
        recusas.push({
          codigo: 'abaixo_minimo_noites',
          mensagem: `O mínimo neste imóvel é de ${imovel.minimo_noites} noites; o pedido tem ${noites}.`,
        });
      }
    }
  }

  if (recusas.length > 0 || entrada === null || saida === null) return { ok: false, recusas };

  const diariaCentavos = reaisParaCentavos(imovel.diaria);
  const noites: Noite[] = [];
  for (let dia = entrada; dia < saida; dia++) {
    const semana = new Date(dia * DIA_MS).getUTCDay();
    const fimDeSemana = semana === SEXTA || semana === SABADO;
    noites.push({
      data: isoDoDia(dia),
      diaSemana: DIAS[semana]!,
      acrescimoFimDeSemana: fimDeSemana,
      valorCentavos: fimDeSemana ? diariaFimDeSemana(diariaCentavos) : diariaCentavos,
    });
  }
  const subtotalCentavos = noites.reduce((s, n) => s + n.valorCentavos, 0);
  const taxaLimpezaCentavos = reaisParaCentavos(imovel.taxa_limpeza);

  return {
    ok: true,
    imovelId: imovel.id,
    checkin: pedido.checkin,
    checkout: pedido.checkout,
    hospedes: pedido.hospedes,
    noites,
    subtotalCentavos,
    taxaLimpezaCentavos,
    totalCentavos: subtotalCentavos + taxaLimpezaCentavos,
  };
}
