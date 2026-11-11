import type { Lead } from '../../src/domain/lead.js';
import type { ResultadoEnvio, Webhook } from '../../src/infra/webhook.js';

/** Webhook em memória: guarda o que recebeu e, opcionalmente, responde com o resultado escolhido. */
export function fakeWebhook(resposta: () => ResultadoEnvio = () => ({ status: 'criado' })) {
  const recebidos: Lead[] = [];
  const webhook: Webhook = {
    async enviar(lead) {
      const r = resposta();
      if (r.status === 'criado') recebidos.push(structuredClone(lead));
      return r;
    },
    async listar() {
      return structuredClone(recebidos);
    },
  };
  return { webhook, recebidos };
}
