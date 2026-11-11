import type Anthropic from '@anthropic-ai/sdk';
import { diaDaSemana, formatarData, hojeEmBrasilia } from '../domain/dates.js';
import type { Catalog } from '../infra/catalog.js';
import type { SessionStore } from '../infra/session.js';
import { instrucaoCorrecao, verificarValores } from './guard.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { estadoInicial, type Estado } from './state.js';
import { definicoes, executarFerramenta, type Contexto, type Resultado } from './tools.js';
import type { Webhook } from '../infra/webhook.js';

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
  webhook: Webhook;
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
export const RESPOSTA_SEM_VALOR =
  'Desculpe, não consegui conferir os valores agora. Para eu refazer a cotação, me diga o imóvel, as datas de ' +
  'entrada e saída e o número de hóspedes.';
export const RESPOSTA_RESERVA_DESCARTADA =
  'Desculpe, não consegui conferir os valores do seu pedido, então ele ainda não foi registrado. Vamos refazer o ' +
  'resumo antes de registrar: me confirme o imóvel, as datas de entrada e saída e o número de hóspedes.';
export const AVISO_VERIFICADOR = '[Verificação automática do sistema, não é mensagem do hóspede]';
const RESPOSTA_RECUSA =
  'Não consigo ajudar com isso por aqui. Vou passar sua conversa para um atendente da nossa equipe.';

const PRAZO_MS = 50_000;
const MAX_ITERACOES = 8;
const FOLGA_MS = 3_000; // não começa uma chamada ao modelo com menos tempo que isso

const MUDAM_ESTADO = new Set(['preparar_reserva', 'confirmar_reserva']);

/**
 * Consultas rodam em paralelo. Se a resposta tem uma ferramenta de reserva, tudo roda em sequência,
 * na ordem do modelo: confirmar nunca corre junto com um preparar que troca a reserva pendente.
 */
async function executarTodas(chamadas: Anthropic.ToolUseBlock[], ctx: Contexto): Promise<Resultado[]> {
  if (!chamadas.some((c) => MUDAM_ESTADO.has(c.name))) {
    return Promise.all(chamadas.map((c) => executarFerramenta(c.name, c.input, ctx)));
  }
  const resultados: Resultado[] = [];
  for (const c of chamadas) resultados.push(await executarFerramenta(c.name, c.input, ctx));
  return resultados;
}

/**
 * Uma reserva preparada neste turno só pode ser confirmada depois se o resumo chegou ao hóspede, ou seja,
 * se o turno terminou com o texto do próprio modelo. Qualquer outra saída (verificador, recusa, prazo,
 * erro) a descarta.
 */
function descartarSeNaoMostrada(estado: Estado, mostrouTextoDoModelo: boolean): void {
  if (!mostrouTextoDoModelo && estado.pendente?.turno === estado.turno) estado.pendente = null;
}

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
    let corrigiu = false;
    let mostrouTextoDoModelo = false;

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
          const ctx = { estado, catalog: deps.catalog, webhook: deps.webhook, hoje, mensagem };
          const resultados = await executarTodas(chamadas, ctx);
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

        const achados = verificarValores(texto, estado.valoresLegitimos);
        if (achados.length > 0) {
          console.log(JSON.stringify({ evento: 'guard', turno: estado.turno, achados, segunda_vez: corrigiu }));
          if (!corrigiu) {
            // Uma chance de reescrever. Vai como mensagem de usuário marcada: mensagem de sistema não pode
            // vir logo depois de uma resposta do assistente.
            corrigiu = true;
            estado.mensagens.push({ role: 'user', content: `${AVISO_VERIFICADOR} ${instrucaoCorrecao(achados)}` });
            continue;
          }
          // Se havia um resumo de reserva neste turno, o hóspede precisa saber que nada foi registrado.
          reply = estado.pendente?.turno === estado.turno ? RESPOSTA_RESERVA_DESCARTADA : RESPOSTA_SEM_VALOR;
          estado.mensagens.push({ role: 'assistant', content: reply });
          break;
        }
        mostrouTextoDoModelo = texto !== '';
        reply = texto || RESPOSTA_CONTINGENCIA;
      }
    } catch (erro) {
      // Falha no meio do turno (API do modelo fora, prazo estourado): o histórico volta ao início do
      // turno e guarda só a pergunta e a resposta de contingência, para a próxima mensagem seguir limpa.
      console.error(JSON.stringify({ evento: 'erro_turno', erro: String(erro) }));
      estado.mensagens.splice(base);
      estado.mensagens.push({ role: 'user', content: mensagem });
      estado.mensagens.push({ role: 'assistant', content: RESPOSTA_CONTINGENCIA });
      descartarSeNaoMostrada(estado, false);
      return { reply: RESPOSTA_CONTINGENCIA, handoff, uso, ms: Date.now() - inicio };
    }

    if (reply === null) {
      // Prazo ou limite de iterações: fecha o turno com uma resposta, para o histórico continuar válido.
      reply = RESPOSTA_CONTINGENCIA;
      estado.mensagens.push({ role: 'assistant', content: reply });
    }
    descartarSeNaoMostrada(estado, mostrouTextoDoModelo);
    return { reply, handoff, uso, ms: Date.now() - inicio };
  }

  return {
    async responder(sessionId: string, mensagem: string): Promise<RespostaTurno> {
      return deps.store.withLock(sessionId, async () => {
        const estado = (await deps.store.get(sessionId)) ?? estadoInicial();
        const r = await turno(estado, mensagem);
        await deps.store.set(sessionId, estado);
        const { handoff, ms, uso } = r;
        console.log(JSON.stringify({ evento: 'turno', sessao: sessionId, turno: estado.turno, handoff, ms, uso }));
        return r;
      });
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
