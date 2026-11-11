// "Hoje" para o agente é o dia no fuso de Brasília, não o do servidor (a Vercel roda em UTC).

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export const FUSO = 'America/Sao_Paulo';

/** AAAA-MM-DD da data `agora` no fuso de Brasília. */
export function hojeEmBrasilia(agora: Date = new Date()): string {
  // en-CA formata como AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    agora,
  );
}

/** Dia da semana de uma data AAAA-MM-DD (calendário puro, sem fuso). */
export function diaDaSemana(iso: string): string {
  const [a, m, d] = iso.split('-').map(Number);
  return DIAS[new Date(Date.UTC(a!, m! - 1, d!)).getUTCDay()]!;
}

/** 2027-01-15 → 15/01/2027 */
export function formatarData(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}
