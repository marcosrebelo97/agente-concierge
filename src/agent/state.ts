import type Anthropic from '@anthropic-ai/sdk';

// Estado de uma conversa. O histórico vai inteiro para o modelo; o resto é o que o código usa
// para decidir sozinho: valores que podem aparecer na resposta, reserva pendente, leads enviados.

export interface CotacaoGuardada {
  imovelId: string;
  checkin: string;
  checkout: string;
  hospedes: number;
  totalCentavos: number;
}

export interface Estado {
  mensagens: Anthropic.MessageParam[];
  /** Número da mensagem do hóspede, começando em 1. */
  turno: number;
  /** Valores em centavos vindos do catálogo ou de uma cotação: os únicos que a resposta pode citar. */
  valoresLegitimos: number[];
  cotacoes: CotacaoGuardada[];
  humanoAcionado: boolean;
}

export function estadoInicial(): Estado {
  return { mensagens: [], turno: 0, valoresLegitimos: [], cotacoes: [], humanoAcionado: false };
}

export function registrarValores(estado: Estado, ...centavos: number[]): void {
  for (const v of centavos) if (!estado.valoresLegitimos.includes(v)) estado.valoresLegitimos.push(v);
}
