import { confirmaReserva } from '../src/domain/lead.js';

// Travas da bateria em produção, onde o webhook é o oficial: nenhuma mensagem dela pode gerar um lead.
// O lead exige um resumo, que só sai com telefone válido, e depois uma confirmação que `confirmaReserva`
// aceite. A bateria não manda nenhum dos dois; a trava de confirmação usa a mesma função do agente.

export const PREFIXO_SESSAO = 'bateria-';

// Datas não contam como telefone: 2027-01-15, 15/01/2027, 15/01.
const DATAS = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?/g;
// Dígitos seguidos, aceitando os separadores de um telefone: "(48) 99999-0000", "+1 555 123 4567".
const SEQUENCIA = /\+?\d[\d\s().-]*/g;

/**
 * Motivo para não enviar a mensagem, ou `null` se ela pode ir para produção. A primeira mensagem de uma
 * sessão não tem resumo para confirmar, então pode abrir com "quero reservar".
 */
export function motivoBloqueio(mensagem: string, primeiraDaSessao: boolean): string | null {
  if (!primeiraDaSessao && confirmaReserva(mensagem)) {
    return 'parece uma confirmação de reserva; a bateria nunca confirma (use uma pergunta ou peça uma mudança)';
  }
  const semDatas = mensagem.replace(DATAS, ' ');
  // Conservador: 8 dígitos seguidos já bloqueiam, mesmo que não formem um telefone válido.
  const maior = Math.max(0, ...(semDatas.match(SEQUENCIA) ?? []).map((s) => s.replace(/\D/g, '').length));
  if (maior >= 8) return 'tem 8 dígitos seguidos ou mais fora de datas; a bateria nunca informa telefone';
  return null;
}
