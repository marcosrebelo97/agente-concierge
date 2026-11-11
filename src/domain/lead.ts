import { createHash } from 'node:crypto';

// Regras do lead que o webhook não confere (ele só exige presença, tipo e formato das datas):
// nome de gente, telefone brasileiro válido, e uma identidade estável da reserva para nunca
// mandar o mesmo lead duas vezes.

export interface Lead {
  nome: string;
  telefone: string;
  imovel_id: string;
  checkin: string;
  checkout: string;
  hospedes: number;
  valor_total: number;
}

export type Validacao<T> = { ok: true; valor: T } | { ok: false; motivo: string };

/** Aceita "(48) 99999-0000", "48999990000", "+55 48 99999-0000". Devolve no formato do exemplo do enunciado. */
export function normalizarTelefone(entrada: string): Validacao<string> {
  let d = entrada.replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  const invalido = { ok: false as const, motivo: 'Telefone inválido: informe DDD e número, ex.: (48) 99999-0000.' };
  if (d.length !== 10 && d.length !== 11) return invalido;
  const ddd = d.slice(0, 2);
  if (ddd[0] === '0' || ddd[1] === '0') return invalido;
  const numero = d.slice(2);
  if (numero.length === 9 && numero[0] !== '9') return invalido; // celular tem 9 dígitos começando com 9
  if (/^(\d)\1+$/.test(numero)) return invalido; // 99999-9999, 00000-0000
  const meio = numero.length - 4;
  return { ok: true, valor: `(${ddd}) ${numero.slice(0, meio)}-${numero.slice(meio)}` };
}

export function validarNome(entrada: string): Validacao<string> {
  const nome = entrada.trim().replace(/\s+/g, ' ');
  const letras = nome.match(/\p{L}/gu)?.length ?? 0;
  if (nome.length > 100 || letras < 2 || !/^[\p{L}][\p{L} .'-]*$/u.test(nome)) {
    return { ok: false, motivo: 'Nome inválido: informe o nome do responsável pela reserva.' };
  }
  return { ok: true, valor: nome };
}

/** Identidade da reserva: mesmos dados, mesmo hash, independente da ordem das chaves. */
export function hashReserva(lead: Lead): string {
  const canon = JSON.stringify([
    lead.nome.toLowerCase(),
    lead.telefone,
    lead.imovel_id,
    lead.checkin,
    lead.checkout,
    lead.hospedes,
    lead.valor_total,
  ]);
  return createHash('sha256').update(canon).digest('hex').slice(0, 32);
}

/** Casa qualquer um dos termos como palavra inteira (\b não entende acentos). */
function palavras(termos: string[]): RegExp {
  return new RegExp(`(^|[^\\p{L}])(${termos.join('|')})([^\\p{L}]|$)`, 'iu');
}

const AFIRMATIVO = palavras([
  'sim', 's', 'isso', 'exato', 'correto', 'certo', 'perfeito', 'claro', 'ok', 'okay', 'blz', 'beleza', 'show',
  'fechado', 'fechou', 'positivo', 'confirmo', 'confirmado', 'confirmada', 'confirma', 'pode', 'bora', 'vamos',
  'manda', 'mande', 'envia', 'envie', 'registra', 'registre', 'reserve', 'com certeza', 'tudo certo',
]);
const EMOJI_AFIRMATIVO = /👍|✅/u;
const MUDANCA = palavras([
  'mas', 'porém', 'muda', 'mudar', 'mude', 'troca', 'trocar', 'troque', 'altera', 'alterar', 'altere', 'corrige',
  'corrigir', 'corrija', 'espera', 'espere', 'aguarda', 'aguarde', 'errado', 'errada', 'na verdade', 'cancela',
  'cancelar', 'desisto',
]);
const NEGACAO_INICIAL = /^\s*(não|nao|nope|negativo)([^\p{L}]|$)/iu;

/**
 * A mensagem do hóspede confirma o resumo? Precisa afirmar e não pode pedir mudança nem começar
 * negando. Na dúvida, não confirma: o agente pergunta de novo, o que é melhor que um lead errado.
 */
export function confirmaReserva(mensagem: string): boolean {
  const afirma = AFIRMATIVO.test(mensagem) || EMOJI_AFIRMATIVO.test(mensagem);
  return afirma && !MUDANCA.test(mensagem) && !NEGACAO_INICIAL.test(mensagem);
}
