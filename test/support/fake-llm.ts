import type Anthropic from '@anthropic-ai/sdk';
import type { CriarMensagem } from '../../src/agent/loop.js';

// Modelo de mentira para testar o loop sem rede: cada chamada devolve o próximo passo do roteiro e
// guarda os parâmetros recebidos para o teste conferir.

export type Passo =
  | { texto: string }
  | { ferramentas: { nome: string; entrada: unknown }[] }
  | { recusa: true }
  | { vazio: true }
  | { cortado: true } // max_tokens no meio de uma chamada de ferramenta
  | { erro: Error };

export class ErroDaApi extends Error {
  readonly status = 400;
  override name = 'BadRequestError';
}

/** As regras do histórico que a API real cobra com 400: o fake cobra igual, para o teste não passar à toa. */
function validarHistorico(mensagens: Anthropic.MessageParam[]): void {
  mensagens.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    if (Array.isArray(m.content) ? m.content.length === 0 : !m.content) throw new ErroDaApi(`mensagem ${i} vazia`);
    const usos = Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use') : [];
    if (usos.length === 0) return;
    const seguinte = mensagens[i + 1];
    const blocos = Array.isArray(seguinte?.content) ? seguinte.content : [];
    const ids = blocos.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : []));
    for (const u of usos) {
      if (u.type === 'tool_use' && !ids.includes(u.id)) throw new ErroDaApi(`tool_use ${u.id} sem resultado`);
    }
  });
}

export function fakeLlm(roteiro: Passo[]) {
  const recebidos: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const opcoes: Parameters<CriarMensagem>[1][] = [];
  let n = 0;
  const llm: CriarMensagem = async (params, opts) => {
    recebidos.push(structuredClone(params));
    opcoes.push(opts);
    validarHistorico(params.messages);
    const passo = roteiro[n++];
    if (!passo) throw new Error('roteiro do fake acabou');
    if ('erro' in passo) throw passo.erro;
    const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 };
    const base = { id: `msg_${n}`, type: 'message', role: 'assistant', model: params.model, stop_sequence: null, usage };
    if ('texto' in passo) {
      return { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: passo.texto, citations: null }] } as unknown as Anthropic.Message;
    }
    if ('recusa' in passo) {
      return { ...base, stop_reason: 'refusal', content: [] } as unknown as Anthropic.Message;
    }
    if ('vazio' in passo) {
      return { ...base, stop_reason: 'end_turn', content: [] } as unknown as Anthropic.Message;
    }
    if ('cortado' in passo) {
      const content = [
        { type: 'text', text: 'Vou cotar', citations: null },
        { type: 'tool_use', id: `tu_${n}_0`, name: 'cotar', input: {} },
      ];
      return { ...base, stop_reason: 'max_tokens', content } as unknown as Anthropic.Message;
    }
    return {
      ...base,
      stop_reason: 'tool_use',
      content: passo.ferramentas.map((f, k) => ({ type: 'tool_use', id: `tu_${n}_${k}`, name: f.nome, input: f.entrada })),
    } as unknown as Anthropic.Message;
  };
  return { llm, recebidos, opcoes, get chamadas() { return n; } };
}
