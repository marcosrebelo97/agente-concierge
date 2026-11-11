import type { Lead } from '../domain/lead.js';

// Cliente do webhook de leads. "Um lead por reserva confirmada": em falha de rede ou 5xx, antes de
// tentar de novo, confere com GET se o lead já chegou, para a nova tentativa não duplicar.

export type ResultadoEnvio =
  | { status: 'criado' }
  | { status: 'invalido'; erros: string[] }
  | { status: 'falha'; motivo: string };

export interface Webhook {
  enviar(lead: Lead): Promise<ResultadoEnvio>;
  listar(): Promise<Lead[]>;
}

export interface WebhookOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function mesmoLead(a: Lead, b: Lead): boolean {
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

  async function listar(): Promise<Lead[]> {
    const res = await doFetch(opts.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`webhook GET ${res.status}`);
    const corpo = (await res.json()) as { leads?: Lead[] };
    return corpo.leads ?? [];
  }

  async function postar(lead: Lead): Promise<ResultadoEnvio | null> {
    try {
      const res = await doFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(lead),
        signal: AbortSignal.timeout(timeoutMs),
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

  return {
    listar,
    async enviar(lead) {
      const primeira = await postar(lead);
      if (primeira) return primeira;
      try {
        if ((await listar()).some((l) => mesmoLead(l, lead))) return { status: 'criado' };
      } catch {
        // sem como conferir: não arrisca duplicar
        return { status: 'falha', motivo: 'webhook indisponível' };
      }
      return (await postar(lead)) ?? { status: 'falha', motivo: 'webhook indisponível' };
    },
  };
}
