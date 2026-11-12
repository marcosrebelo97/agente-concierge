import type Anthropic from '@anthropic-ai/sdk';
import type { Lead } from '../domain/lead.js';

// Estado de uma conversa. O histórico vai inteiro para o modelo; o resto é o que o código usa
// para decidir sozinho: valores que podem aparecer na resposta, reserva pendente, leads enviados.

export interface CotacaoGuardada {
  imovelId: string;
  checkin: string;
  checkout: string;
  hospedes: number;
  totalCentavos: number;
}

export interface ReservaPendente {
  /** Turno em que o resumo foi mostrado: a confirmação só vale num turno posterior. */
  turno: number;
  hash: string;
  lead: Lead;
  /** Já houve um envio ao webhook que pode ter chegado: a próxima tentativa confere antes de enviar. */
  envioIniciado?: boolean;
}

export interface Estado {
  mensagens: Anthropic.MessageParam[];
  /** Número da mensagem do hóspede, começando em 1. */
  turno: number;
  /** Valores em centavos vindos do catálogo ou de uma cotação: os únicos que a resposta pode citar. */
  valoresLegitimos: number[];
  /** Cotações feitas na conversa: registro para o atendente e para auditoria; o agente não lê. */
  cotacoes: CotacaoGuardada[];
  pendente: ReservaPendente | null;
  /** Hashes das reservas já enviadas ao webhook: um lead por reserva. */
  leadsEnviados: string[];
  /**
   * Hashes de reservas cujo envio pode ter chegado ao webhook sem confirmação. Sobrevivem ao descarte da
   * pendente: se a mesma reserva for preparada de novo, a confirmação confere o webhook antes de enviar.
   * Opcional para aceitar sessões gravadas antes deste campo.
   */
  enviosIncertos?: string[];
  /** Se a conversa já foi passada a um humano: registro para o atendimento; não muda o comportamento. */
  humanoAcionado: boolean;
}

export function estadoInicial(): Estado {
  return {
    mensagens: [],
    turno: 0,
    valoresLegitimos: [],
    cotacoes: [],
    pendente: null,
    leadsEnviados: [],
    humanoAcionado: false,
  };
}

export function registrarValores(estado: Estado, ...centavos: number[]): void {
  for (const v of centavos) if (!estado.valoresLegitimos.includes(v)) estado.valoresLegitimos.push(v);
}
