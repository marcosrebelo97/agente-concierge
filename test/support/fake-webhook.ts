import type { Lead } from '../../src/domain/lead.js';
import { mesmoLead, type ResultadoEnvio, type Webhook } from '../../src/infra/webhook.js';

/**
 * Webhook em memória: guarda o que recebeu e, opcionalmente, responde com o resultado escolhido.
 * `gravaMesmoComFalha` imita o pior caso de rede: o lead chegou, mas quem enviou recebeu erro.
 */
export function fakeWebhook(resposta: () => ResultadoEnvio = () => ({ status: 'criado' }), gravaMesmoComFalha = false) {
  const recebidos: Lead[] = [];
  let posts = 0;
  const webhook: Webhook = {
    async enviar(lead) {
      posts++;
      const r = resposta();
      if (r.status === 'criado' || (gravaMesmoComFalha && r.status === 'falha')) recebidos.push(structuredClone(lead));
      return r;
    },
    async listar() {
      return structuredClone(recebidos);
    },
    async recebido(lead) {
      return recebidos.some((l) => mesmoLead(l, lead));
    },
  };
  return { webhook, recebidos, get posts() { return posts; } };
}
