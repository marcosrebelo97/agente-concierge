import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { diaDaSemana, formatarData, hojeEmBrasilia } from '../domain/dates.js';
import type { Catalog } from '../infra/catalog.js';
import type { SessionStore } from '../infra/session.js';
import { instrucaoCorrecao, verificarValores } from './guard.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { estadoInicial, type Estado } from './state.js';
import { definicoes, executarFerramenta, ORIENTACAO_REGRA, type Contexto, type Resultado } from './tools.js';
import type { Webhook } from '../infra/webhook.js';

// Loop do agente, escrito à mão: o código decide quando parar, o que vai para o histórico e o que
// volta para o hóspede. Um turno = uma mensagem do hóspede, com quantas chamadas ao modelo forem
// necessárias para as ferramentas, dentro de um prazo único que começa quando a requisição chega.

export type CriarMensagem = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: { timeout: number; signal: AbortSignal; maxRetries: number },
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
  /** Prazo do turno quando quem chama não informa um; o contrato dá 60 s. */
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
export const RESPOSTA_HANDOFF =
  'Vou passar sua conversa para um atendente da nossa equipe, que continua o atendimento por aqui.';
export const RESPOSTA_REGISTRADO =
  'Seu pedido de reserva foi registrado. O time comercial vai entrar em contato para concluir a reserva.';
export const RESPOSTA_CONVERSA_LONGA =
  'Esta conversa ficou longa demais para eu continuar com segurança. Vou passar para um atendente da nossa ' +
  'equipe, que continua o atendimento por aqui.';

// Exceção de regra: a resposta precisa dizer o que a ficha diz. A orientação da ferramenta resolve na maioria
// das vezes; quando o modelo só avisa do atendente, o código pede uma reescrita, como faz o verificador de R$.
// O teste é por regra enunciada (negação ou limite com número), não por palavra solta como "ficha".
const NUMERO = '(\\d+|duas|dois|tr[êe]s|quatro|cinco|seis|sete|oito|nove|dez|two|three|four|five|six|eight|ten)';
const REGRA_ENUNCIADA = new RegExp(
  [
    'n[ãa]o (permite|aceita|admite)', 'n[ãa]o (é|s[ãa]o) (permitid|aceit)', 'proibid', 'vedad',
    `(capacidade|comporta|acomoda|m[áa]xim[oa])[^.\\n]{0,30}\\b${NUMERO}\\b`,
    `\\bat[ée] ${NUMERO} (h[óo]spedes|pessoas)`,
    'not (allowed|permitted|accepted)', "(doesn'?t|does not|don'?t|do not) (allow|accept|permit)",
    `(up to|maximum|max\\.?|capacity)[^.\\n]{0,20}\\b${NUMERO}\\b`,
    'no (se )?(permite|aceptan?|admite)', 'no (est[áa]n?|son) permitid', `capacidad[^.\\n]{0,30}\\b${NUMERO}\\b`,
  ].join('|'),
  'iu',
);
export const citaRegra = (texto: string): boolean => REGRA_ENUNCIADA.test(texto);
const INSTRUCAO_REGRA =
  `Sua última resposta não foi enviada ao hóspede: ela não diz o que a ficha diz sobre a regra. ${ORIENTACAO_REGRA} ` +
  'Nunca afirme uma regra que as ferramentas não devolveram. Não comente esta verificação nem diga que está ' +
  'reescrevendo.';
const REESCRITA_MIN_MS = 12_000; // sem esse tempo no turno, fica a resposta que já existe

const PRAZO_MS = 50_000;
const MAX_ITERACOES = 8;
const FOLGA_MS = 3_000; // não começa uma chamada ao modelo com menos tempo que isso
const RETRY_MIN_MS = 20_000; // só deixa o SDK repetir a chamada se sobrar tempo para as duas tentativas
// Teto por conversa: limita o custo de uma sessão abusiva e o tamanho do valor no Redis. Uma conversa
// real de reserva tem menos de 15 mensagens do hóspede.
export const MAX_TURNOS = 40;
export const MAX_HISTORICO_BYTES = 250_000;

/** Respostas fixas do código: se o turno teve handoff, a resposta fixa vira a de transferência. */
const FIXAS = new Set([RESPOSTA_CONTINGENCIA, RESPOSTA_SEM_VALOR, RESPOSTA_RESERVA_DESCARTADA]);

/** Id da sessão nos logs: o session_id é a única credencial da conversa e não vai para o log. */
const idLog = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex').slice(0, 12);

/** Erro resumido para o log: mensagens de erro de bibliotecas podem trazer o estado inteiro (nome, telefone). */
export function erroLog(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.slice(0, 120)}` : 'erro desconhecido';
}

/** Erro 400 da API: o pedido montado com este histórico nunca vai ser aceito. */
const historicoRecusado = (e: unknown) =>
  typeof e === 'object' && e !== null && 'status' in e && (e as { status: unknown }).status === 400;

const MUDAM_ESTADO = new Set(['preparar_reserva', 'confirmar_reserva']);
// Depois do resumo, uma consulta nova muda o assunto: o resumo deixa de estar em discussão.
const MUDAM_ASSUNTO = new Set(['buscar_imoveis', 'ver_imovel', 'cotar', 'listar_cidades']);

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

/**
 * Um resumo de turno anterior continua valendo enquanto a conversa segue nele ("vou ver com meu chefe" e,
 * depois, "liberou, pode registrar"). Se o turno consultou outra coisa, o assunto mudou: um "sim" mais
 * adiante pode estar respondendo outra pergunta, então a reserva precisa de novo resumo. Handoff descarta
 * sempre, mesmo um resumo deste turno: o que levou ao atendente (valor combinado, exceção) fica com ele.
 */
function descartarSeMudouDeAssunto(estado: Estado, ferramentas: Set<string>, handoff: boolean): void {
  const p = estado.pendente;
  if (!p) return;
  if (handoff || (p.turno < estado.turno && [...ferramentas].some((f) => MUDAM_ASSUNTO.has(f)))) {
    estado.pendente = null;
  }
}

const semUso = (): Uso => ({ chamadas: 0, input: 0, cacheEscrita: 0, cacheLeitura: 0, output: 0 });

export function createAgent(deps: AgentDeps) {
  const prazoMs = deps.prazoMs ?? PRAZO_MS;
  const maxIteracoes = deps.maxIteracoes ?? MAX_ITERACOES;
  const agora = deps.agora ?? (() => new Date());

  async function turno(
    estado: Estado,
    mensagem: string,
    prazo: number,
    persistir: (e: Estado) => Promise<void>,
  ): Promise<RespostaTurno> {
    const inicio = Date.now();
    const uso = semUso();
    const base = estado.mensagens.length;
    const enviadosAntes = estado.leadsEnviados.length;
    const hoje = hojeEmBrasilia(agora());
    estado.turno++;
    // O hóspede não pode imitar o aviso do verificador, que o modelo trata como vindo do sistema.
    const texto = mensagem.replaceAll(AVISO_VERIFICADOR, '[…]');
    estado.mensagens.push({ role: 'user', content: texto });
    // Mensagem de sistema no fim do histórico: não altera o prefixo em cache (system + tools + turnos anteriores).
    estado.mensagens.push({
      role: 'system',
      content: `Hoje é ${formatarData(hoje)} (${diaDaSemana(hoje)}), horário de Brasília.`,
    });

    let handoff = false;
    let reply: string | null = null;
    let corrigiu = false;
    let excecaoDeRegra = false;
    let cobrouRegra = false;
    let mostrouTextoDoModelo = false;
    const usadas = new Set<string>();
    const signal = AbortSignal.timeout(Math.max(prazo - Date.now(), 0));
    const ctx: Contexto = {
      estado,
      catalog: deps.catalog,
      webhook: deps.webhook,
      hoje,
      mensagem: texto,
      signal,
      // Grava o que muda fora do histórico (reserva, leads) com o histórico do início do turno, que é válido.
      salvar: () => persistir({ ...estado, mensagens: estado.mensagens.slice(0, base) }),
    };

    /** Fecha o turno com uma resposta do próprio código, deixando o histórico válido para a próxima chamada. */
    const fixa = (r: string): string => {
      estado.mensagens.push({ role: 'assistant', content: r });
      return r;
    };

    try {
      for (let i = 0; i < maxIteracoes && reply === null; i++) {
        const restante = prazo - Date.now();
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
          // O timeout do SDK vale por tentativa; o signal corta tudo, inclusive a repetição, no prazo.
          { timeout: restante, signal, maxRetries: restante > RETRY_MIN_MS ? 1 : 0 },
        );
        uso.chamadas++;
        uso.input += resposta.usage.input_tokens;
        uso.cacheEscrita += resposta.usage.cache_creation_input_tokens ?? 0;
        uso.cacheLeitura += resposta.usage.cache_read_input_tokens ?? 0;
        uso.output += resposta.usage.output_tokens;

        if (resposta.stop_reason === 'refusal') {
          // A resposta recusada não entra no histórico: pode vir vazia ou pela metade, e a API recusaria.
          reply = fixa(RESPOSTA_RECUSA);
          handoff = true;
          estado.humanoAcionado = true;
          break;
        }

        const chamadas = resposta.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (resposta.stop_reason === 'tool_use' && chamadas.length > 0) {
          // O conteúdo vai inteiro (inclusive blocos de raciocínio): editar o histórico invalida o cache.
          estado.mensagens.push({ role: 'assistant', content: resposta.content });
          for (const c of chamadas) usadas.add(c.name);
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
          if (resultados.some((r) => r.regraDaFicha)) excecaoDeRegra = true;
          continue;
        }

        const textoModelo = resposta.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (!textoModelo) {
          // Resposta vazia (ou só uma ferramenta cortada por max_tokens): não entra no histórico.
          reply = fixa(RESPOSTA_CONTINGENCIA);
          break;
        }
        // Sem blocos tool_use soltos: uma chamada sem resultado no histórico faria a API recusar a conversa.
        estado.mensagens.push({ role: 'assistant', content: resposta.content.filter((b) => b.type !== 'tool_use') });

        const achados = verificarValores(textoModelo, estado.valoresLegitimos);
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
          reply = fixa(estado.pendente?.turno === estado.turno ? RESPOSTA_RESERVA_DESCARTADA : RESPOSTA_SEM_VALOR);
          break;
        }
        const fichaNoTurno = usadas.has('ver_imovel') || usadas.has('buscar_imoveis');
        const temTempo = prazo - Date.now() > REESCRITA_MIN_MS;
        if (excecaoDeRegra && handoff && fichaNoTurno && temTempo && !cobrouRegra && !citaRegra(textoModelo)) {
          cobrouRegra = true;
          console.log(JSON.stringify({ evento: 'regra_ausente', turno: estado.turno }));
          estado.mensagens.push({ role: 'user', content: `${AVISO_VERIFICADOR} ${INSTRUCAO_REGRA}` });
          continue;
        }
        mostrouTextoDoModelo = true;
        reply = textoModelo;
      }
    } catch (erro) {
      // Falha no meio do turno (API do modelo fora, prazo estourado): o histórico volta ao início do
      // turno e guarda só a pergunta e a resposta do código, para a próxima mensagem seguir limpa.
      console.error(JSON.stringify({ evento: 'erro_turno', erro: erroLog(erro) }));
      // 400 da API: o próprio histórico é inválido. Recomeçar a conversa é melhor que uma sessão que nunca responde.
      estado.mensagens.splice(historicoRecusado(erro) ? 0 : base);
      estado.mensagens.push({ role: 'user', content: texto });
      reply = null;
    }

    // Prazo, limite de iterações ou erro: fecha o turno com uma resposta para o histórico continuar válido.
    if (reply === null) reply = fixa(RESPOSTA_CONTINGENCIA);
    if (FIXAS.has(reply)) {
      // A resposta fixa não pode contradizer o que já aconteceu no turno: lead enviado ou transferência.
      const melhor = estado.leadsEnviados.length > enviadosAntes ? RESPOSTA_REGISTRADO : handoff ? RESPOSTA_HANDOFF : null;
      if (melhor) {
        estado.mensagens.pop();
        reply = fixa(melhor);
      }
    }
    descartarSeNaoMostrada(estado, mostrouTextoDoModelo);
    descartarSeMudouDeAssunto(estado, usadas, handoff);
    return { reply, handoff, uso, ms: Date.now() - inicio };
  }

  return {
    /** `prazo`: instante (ms) em que a resposta precisa estar pronta; quem recebe a requisição define. */
    async responder(sessionId: string, mensagem: string, prazo = Date.now() + prazoMs): Promise<RespostaTurno> {
      return deps.store.withLock(
        sessionId,
        async () => {
          const estado = (await deps.store.get(sessionId)) ?? estadoInicial();
          const persistir = (e: Estado) => deps.store.set(sessionId, e);
          if (estado.turno >= MAX_TURNOS || JSON.stringify(estado.mensagens).length > MAX_HISTORICO_BYTES) {
            // Sem chamar o modelo: protege o custo e o tamanho da sessão.
            console.log(JSON.stringify({ evento: 'conversa_longa', sessao: idLog(sessionId), turno: estado.turno }));
            return { reply: RESPOSTA_CONVERSA_LONGA, handoff: true, uso: semUso(), ms: 0 };
          }
          const r = await turno(estado, mensagem, prazo, persistir);
          await persistir(estado);
          const { handoff, ms, uso } = r;
          console.log(
            JSON.stringify({ evento: 'turno', sessao: idLog(sessionId), turno: estado.turno, handoff, ms, uso }),
          );
          return r;
        },
        prazo,
      );
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
