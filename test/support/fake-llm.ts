import type Anthropic from '@anthropic-ai/sdk';
import type { CriarMensagem } from '../../src/agent/loop.js';

// Modelo de mentira para testar o loop sem rede: cada chamada devolve o próximo passo do roteiro e
// guarda os parâmetros recebidos para o teste conferir.

export type Passo =
  | { texto: string }
  | { ferramentas: { nome: string; entrada: unknown }[] }
  | { recusa: true }
  | { erro: Error };

export function fakeLlm(roteiro: Passo[]) {
  const recebidos: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let n = 0;
  const llm: CriarMensagem = async (params) => {
    recebidos.push(structuredClone(params));
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
    return {
      ...base,
      stop_reason: 'tool_use',
      content: passo.ferramentas.map((f, k) => ({ type: 'tool_use', id: `tu_${n}_${k}`, name: f.nome, input: f.entrada })),
    } as unknown as Anthropic.Message;
  };
  return { llm, recebidos, get chamadas() { return n; } };
}
