import type Anthropic from '@anthropic-ai/sdk';
import { diaDaSemana, formatarData, hojeEmBrasilia } from '../domain/dates.js';
import type { Catalog } from '../infra/catalog.js';
import type { SessionStore } from '../infra/session.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { estadoInicial, type Estado } from './state.js';
import { definicoes, executarFerramenta } from './tools.js';

// Loop do agente, escrito à mão: o código decide quando parar, o que vai para o histórico e o que
// volta para o hóspede. Um turno = uma mensagem do hóspede, com quantas chamadas ao modelo forem
// necessárias para as ferramentas, dentro de um prazo menor que os 60 s do contrato.

export type CriarMensagem = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: { timeout: number },
) => Promise<Anthropic.Message>;

export type Esforco = 'low' | 'medium' | 'high';

export interface AgentDeps {
  llm: CriarMensagem;
  catalog: Catalog;
  store: SessionStore<Estado>;
  modelo: string;
  esforco?: Esforco;
  agora?: () => Date;
  /** Prazo total do turno; o contrato dá 60 s. */
  prazoMs?: number;
  maxIteracoes?: number;
}

export interface Uso {
  chamadas: number;
  input: number;
  cacheEscrita: number;
  cacheLeitura: number;
  output: number;
}

export interface RespostaTurno {
  reply: string;
  handoff: boolean;
  uso: Uso;
  ms: number;
}

export const RESPOSTA_CONTINGENCIA =
  'Desculpe, tive um problema para concluir sua solicitação agora. Pode repetir, por favor?';
const RESPOSTA_RECUSA =
  'Não consigo ajudar com isso por aqui. Vou passar sua conversa para um atendente da nossa equipe.';

const PRAZO_MS = 50_000;
const MAX_ITERACOES = 8;
const FOLGA_MS = 3_000; // não começa uma chamada ao modelo com menos tempo que isso

export function createAgent(deps: AgentDeps) {
  const prazoMs = deps.prazoMs ?? PRAZO_MS;
  const maxIteracoes = deps.maxIteracoes ?? MAX_ITERACOES;
  const agora = deps.agora ?? (() => new Date());

  async function turno(estado: Estado, mensagem: string): Promise<RespostaTurno> {
    const inicio = Date.now();
    const uso: Uso = { chamadas: 0, input: 0, cacheEscrita: 0, cacheLeitura: 0, output: 0 };
    const base = estado.mensagens.length;
    const hoje = hojeEmBrasilia(agora());
    estado.turno++;
    estado.mensagens.push({ role: 'user', content: mensagem });
    // Mensagem de sistema no fim do histórico: não altera o prefixo em cache (system + tools + turnos anteriores).
    estado.mensagens.push({
      role: 'system',
      content: `Hoje é ${formatarData(hoje)} (${diaDaSemana(hoje)}), horário de Brasília.`,
    });

    let handoff = false;
    let reply: string | null = null;

    try {
      for (let i = 0; i < maxIteracoes && reply === null; i++) {
        const restante = prazoMs - (Date.now() - inicio);
        if (restante < FOLGA_MS) break;

        const resposta = await deps.llm(
          {
            model: deps.modelo,
            max_tokens: 8_000,
            system: SYSTEM_PROMPT,
            tools: definicoes,
            messages: estado.mensagens,
            cache_control: { type: 'ephemeral' },
            output_config: { effort: deps.esforco ?? 'medium' },
          },
          { timeout: restante },
        );
        uso.chamadas++;
        uso.input += resposta.usage.input_tokens;
        uso.cacheEscrita += resposta.usage.cache_creation_input_tokens ?? 0;
        uso.cacheLeitura += resposta.usage.cache_read_input_tokens ?? 0;
        uso.output += resposta.usage.output_tokens;

        // O conteúdo vai inteiro (inclusive blocos de raciocínio): editar o histórico invalida o cache.
        estado.mensagens.push({ role: 'assistant', content: resposta.content });

        if (resposta.stop_reason === 'refusal') {
          reply = RESPOSTA_RECUSA;
          handoff = true;
          estado.humanoAcionado = true;
          break;
        }

        const chamadas = resposta.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (resposta.stop_reason === 'tool_use' && chamadas.length > 0) {
          const ctx = { estado, catalog: deps.catalog, hoje };
          const resultados = await Promise.all(chamadas.map((c) => executarFerramenta(c.name, c.input, ctx)));
          // Todos os resultados numa única mensagem, na ordem das chamadas.
          estado.mensagens.push({
            role: 'user',
            content: chamadas.map((c, k) => ({
              type: 'tool_result' as const,
              tool_use_id: c.id,
              content: JSON.stringify(resultados[k]!.conteudo),
              ...(resultados[k]!.erro ? { is_error: true } : {}),
            })),
          });
          if (resultados.some((r) => r.handoff)) {
            handoff = true;
            estado.humanoAcionado = true;
          }
          continue;
        }

        const texto = resposta.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        reply = texto || RESPOSTA_CONTINGENCIA;
      }
    } catch (erro) {
      // Falha no meio do turno (API do modelo fora, prazo estourado): o histórico volta ao início do
      // turno e guarda só a pergunta e a resposta de contingência, para a próxima mensagem seguir limpa.
      console.error(JSON.stringify({ evento: 'erro_turno', erro: String(erro) }));
      estado.mensagens.splice(base);
      estado.mensagens.push({ role: 'user', content: mensagem });
      estado.mensagens.push({ role: 'assistant', content: RESPOSTA_CONTINGENCIA });
      return { reply: RESPOSTA_CONTINGENCIA, handoff, uso, ms: Date.now() - inicio };
    }

    if (reply === null) {
      // Prazo ou limite de iterações: fecha o turno com uma resposta, para o histórico continuar válido.
      reply = RESPOSTA_CONTINGENCIA;
      estado.mensagens.push({ role: 'assistant', content: reply });
    }
    return { reply, handoff, uso, ms: Date.now() - inicio };
  }

  return {
    async responder(sessionId: string, mensagem: string): Promise<RespostaTurno> {
      return deps.store.withLock(sessionId, async () => {
        const estado = (await deps.store.get(sessionId)) ?? estadoInicial();
        const r = await turno(estado, mensagem);
        await deps.store.set(sessionId, estado);
        const log = { evento: 'turno', sessao: sessionId, turno: estado.turno, handoff: r.handoff, ms: r.ms, uso: r.uso };
        console.log(JSON.stringify(log));
        return r;
      });
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
