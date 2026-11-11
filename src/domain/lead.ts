import { createHash } from 'node:crypto';

// Regras do lead que o webhook não confere (ele só exige presença, tipo e formato das datas):
// nome de gente, telefone válido, e uma identidade estável da reserva para nunca
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

const TELEFONE_INVALIDO =
  'Telefone inválido: informe DDD e número, ex.: (48) 99999-0000, ou o número internacional com +, ex.: +1 555 123 4567.';

/**
 * Brasileiro: aceita "(48) 99999-0000", "48999990000", "048 99999-0000", "+55 48 99999-0000" e devolve no
 * formato do exemplo do enunciado. Estrangeiro: "+" e código do país, 8 a 15 dígitos (E.164), devolvido
 * como "+15551234567".
 */
export function normalizarTelefone(entrada: string): Validacao<string> {
  let d = entrada.replace(/\D/g, '');
  const internacional = entrada.trim().startsWith('+') || entrada.trim().startsWith('00');
  if (entrada.trim().startsWith('00')) d = d.slice(2);
  if (internacional && !d.startsWith('55')) {
    const valido = d.length >= 8 && d.length <= 15 && d[0] !== '0' && !/^(\d)\1+$/.test(d);
    return valido ? { ok: true, valor: `+${d}` } : { ok: false, motivo: TELEFONE_INVALIDO };
  }
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  else if (d.length === 12 && d.startsWith('0')) d = d.slice(1); // 0 de discagem antes do celular: 048 9...
  const invalido = { ok: false as const, motivo: TELEFONE_INVALIDO };
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

// Afirmações que não deixam dúvida em resposta a "posso registrar?". Inclui inglês e espanhol: o agente
// responde no idioma do hóspede.
const AFIRMATIVO = palavras([
  'sim', 's', 'isso mesmo', 'isso aí', 'isso ai', 'exato', 'exatamente', 'correto', 'certo', 'certinho', 'perfeito',
  'claro', 'ok', 'okay', 'blz', 'beleza', 'show', 'fechado', 'fechou', 'fecha', 'combinado', 'positivo', 'confirmo',
  'confirmado', 'confirmada', 'confirma', 'confere', 'tá bom', 'ta bom', 'tá certo', 'ta certo', 'ótimo', 'otimo',
  'aham', 'uhum', 'com certeza', 'tudo certo', 'bora', 'registra', 'registre', 'reserve', 'pode registrar',
  'pode confirmar', 'pode enviar', 'pode mandar', 'pode fechar', 'pode seguir', 'pode reservar', 'quero fechar',
  'quero reservar', 'manda ver', 'yes', 'yep', 'sure', 'confirmed', 'go ahead', 'sí', 'si', 'dale', 'de acuerdo',
]);
// Palavras que confirmam sozinhas ("Pode!", "Manda."), mas numa frase maior pedem outra coisa
// ("pode me dizer o horário", "manda o endereço", "isso inclui toalhas").
const AFIRMATIVO_CURTO = palavras(['isso', 'pode', 'manda', 'mande', 'envia', 'envie', 'vamos', 'quero']);
const EMOJI_AFIRMATIVO = /👍|✅/u;
const MUDANCA = palavras([
  'mas', 'porém', 'muda', 'mudar', 'mude', 'troca', 'trocar', 'troque', 'altera', 'alterar', 'altere', 'corrige',
  'corrigir', 'corrija', 'espera', 'espere', 'aguarda', 'aguarde', 'errado', 'errada', 'na verdade', 'cancela',
  'cancelar', 'desisto', 'but', 'wait', 'change', 'pero', 'cambiar',
]);
const NEGACAO_INICIAL = /^\s*(não|nao|nope|negativo|no|not)([^\p{L}]|$)/iu;
// "Não" no meio só passa depois de um sim inequívoco no começo ("sim, não tenho mais dúvidas");
// sem isso, "isso não está certo" seria lido como "isso".
const NEGACAO = palavras(['não', 'nao', 'not', "don't", 'nunca']);
const SIM_INICIAL = /^\s*(sim|confirmo|ok|okay|yes|sí|pode registrar|pode confirmar)([^\p{L}]|$)/iu;
// Hesitação não é confirmação, mesmo com "sim" ou "pode" no meio ("pode ser que sim, vou ver"). "Pode ser"
// às vezes é um sim informal; mesmo assim fica de fora: o custo é uma pergunta a mais, o do erro é um lead indevido.
const HESITACAO = palavras([
  'acho', 'talvez', 'pode ser', 'provavelmente', 'quem sabe', 'não sei', 'nao sei', 'vou ver', 'vou pensar',
  'deixa eu ver', 'deixa eu pensar', 'te falo', 'te aviso', 'mais tarde', 'ainda não', 'ainda nao', 'hmm', 'hum',
  'maybe', 'quizás', 'quizas',
]);

/**
 * A mensagem do hóspede confirma o resumo? Precisa afirmar e não pode perguntar, pedir mudança, hesitar
 * nem negar. Na dúvida, não confirma: o agente pergunta de novo, o que é melhor que um lead errado.
 */
export function confirmaReserva(mensagem: string): boolean {
  if (mensagem.includes('?')) return false; // pergunta não é confirmação, mesmo com "pode" ou "isso"
  if (MUDANCA.test(mensagem) || HESITACAO.test(mensagem) || NEGACAO_INICIAL.test(mensagem)) return false;
  if (NEGACAO.test(mensagem) && !SIM_INICIAL.test(mensagem)) return false;
  const curta = mensagem.trim().split(/\s+/).length <= 2;
  return AFIRMATIVO.test(mensagem) || EMOJI_AFIRMATIVO.test(mensagem) || (curta && AFIRMATIVO_CURTO.test(mensagem));
}
