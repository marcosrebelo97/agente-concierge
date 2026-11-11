import type { Lead } from '../domain/lead.js';

// Cliente do webhook de leads. "Um lead por reserva confirmada": em falha de rede ou 5xx, antes de
// tentar de novo, confere com GET se o lead já chegou, para a nova tentativa não duplicar.

export type ResultadoEnvio =
  | { status: 'criado' }
  | { status: 'invalido'; erros: string[] }
  | { status: 'falha'; motivo: string };

export interface Webhook {
  /** `signal` corta as tentativas no prazo do turno. */
  enviar(lead: Lead, signal?: AbortSignal): Promise<ResultadoEnvio>;
  listar(signal?: AbortSignal): Promise<Lead[]>;
  /** O lead já está no webhook? Lança se não for possível conferir. */
  recebido(lead: Lead, signal?: AbortSignal): Promise<boolean>;
}

export interface WebhookOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function mesmoLead(a: Lead, b: Lead): boolean {
  return (
    a.nome === b.nome &&
    a.telefone === b.telefone &&
    a.imovel_id === b.imovel_id &&
    a.checkin === b.checkin &&
    a.checkout === b.checkout &&
    a.hospedes === b.hospedes &&
    Math.round(a.valor_total * 100) === Math.round(b.valor_total * 100)
  );
}

export function createWebhook(opts: WebhookOptions): Webhook {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;

  const limite = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);

  async function listar(signal?: AbortSignal): Promise<Lead[]> {
    const res = await doFetch(opts.url, { signal: limite(signal) });
    if (!res.ok) throw new Error(`webhook GET ${res.status}`);
    const corpo = (await res.json()) as { leads?: unknown };
    // Formato inesperado não pode virar "lista vazia": isso faria uma nova tentativa duplicar o lead.
    if (!Array.isArray(corpo.leads)) throw new Error('webhook GET em formato inesperado');
    return corpo.leads as Lead[];
  }

  async function postar(lead: Lead, signal?: AbortSignal): Promise<ResultadoEnvio | null> {
    try {
      const res = await doFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(lead),
        signal: limite(signal),
      });
      if (res.status === 201 || res.status === 200) return { status: 'criado' };
      if (res.status === 422 || res.status === 400) {
        const corpo = (await res.json().catch(() => ({}))) as { detalhes?: unknown };
        const erros = Array.isArray(corpo.detalhes) ? corpo.detalhes.map(String) : [`webhook respondeu ${res.status}`];
        return { status: 'invalido', erros };
      }
      if (res.status < 500) return { status: 'falha', motivo: `webhook respondeu ${res.status}` };
      return null; // 5xx: pode tentar de novo
    } catch {
      return null; // rede ou timeout: o lead pode ter chegado
    }
  }

  async function recebido(lead: Lead, signal?: AbortSignal): Promise<boolean> {
    return (await listar(signal)).some((l) => mesmoLead(l, lead));
  }

  return {
    listar,
    recebido,
    async enviar(lead, signal) {
      const primeira = await postar(lead, signal);
      if (primeira) return primeira;
      const indisponivel = { status: 'falha', motivo: 'webhook indisponível' } as const;
      if (signal?.aborted) return indisponivel; // sem tempo para conferir nem tentar de novo
      try {
        if (await recebido(lead, signal)) return { status: 'criado' };
      } catch {
        return indisponivel; // sem como conferir: não arrisca duplicar
      }
      return (await postar(lead, signal)) ?? indisponivel;
    },
  };
}
