import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createAgent, RESPOSTA_CONTINGENCIA } from '../src/agent/loop.js';
import type { Estado } from '../src/agent/state.js';
import { createCatalog } from '../src/infra/catalog.js';
import { memoryStore } from '../src/infra/session.js';
import { BASE, fakeCatalog } from './support/fake-catalog.js';
import { fakeLlm, type Passo } from './support/fake-llm.js';
import { fakeWebhook } from './support/fake-webhook.js';

// 11/11/2026, 23h em Brasília = 12/11 02h UTC: o agente precisa usar o dia de Brasília
const AGORA = new Date('2026-11-12T02:00:00Z');

function setup(roteiro: Passo[], extra: Partial<Parameters<typeof createAgent>[0]> = {}) {
  const fake = fakeLlm(roteiro);
  const store = memoryStore<Estado>();
  const agent = createAgent({
    llm: fake.llm,
    catalog: createCatalog({ baseUrl: BASE, fetch: fakeCatalog().fetch }),
    webhook: fakeWebhook().webhook,
    store,
    modelo: 'modelo-teste',
    agora: () => AGORA,
    ...extra,
  });
  return { agent, fake, store };
}

function resultados(params: Anthropic.MessageCreateParamsNonStreaming): unknown[] {
  const ultima = params.messages.at(-1)!;
  if (!Array.isArray(ultima.content)) throw new Error('última mensagem não tem tool_result');
  return ultima.content.map((b) => JSON.parse((b as Anthropic.ToolResultBlockParam).content as string));
}

describe('loop do agente', () => {
  it('responde com o texto do modelo e informa a data de hoje no fuso de Brasília', async () => {
    const { agent, fake } = setup([{ texto: 'Olá! Como posso ajudar?' }]);
    const r = await agent.responder('s1', 'oi');
    expect(r).toMatchObject({ reply: 'Olá! Como posso ajudar?', handoff: false });
    const msgs = fake.recebidos[0]!.messages;
    expect(msgs.at(-2)).toEqual({ role: 'user', content: 'oi' });
    expect(msgs.at(-1)).toEqual({ role: 'system', content: 'Hoje é 11/11/2026 (quarta-feira), horário de Brasília.' });
  });

  it('executa a cotação no código e devolve o total formatado ao modelo', async () => {
    const { agent, fake, store } = setup([
      { ferramentas: [{ nome: 'cotar', entrada: { imovel_id: 'GRM-301', checkin: '2027-01-15', checkout: '2027-01-18', hospedes: 2 } }] },
      { texto: 'O total fica R$ 2.156,00.' },
    ]);
    const r = await agent.responder('s1', 'quanto fica o GRM-301 de 15 a 18/01?');
    expect(r.reply).toBe('O total fica R$ 2.156,00.');
    const [cotacao] = resultados(fake.recebidos[1]!) as { ok: boolean; total: string; noites: unknown[] }[];
    expect(cotacao).toMatchObject({ ok: true, total: 'R$ 2.156,00' });
    expect(cotacao!.noites).toHaveLength(3);
    const estado = (await store.get('s1'))!;
    expect(estado.cotacoes).toEqual([{ imovelId: 'GRM-301', checkin: '2027-01-15', checkout: '2027-01-18', hospedes: 2, totalCentavos: 215600 }]);
    expect(estado.valoresLegitimos).toContain(215600);
  });

  it('devolve recusas com o motivo e check-in no passado pelo dia de Brasília', async () => {
    const { agent, fake } = setup([
      { ferramentas: [{ nome: 'cotar', entrada: { imovel_id: 'GRM-301', checkin: '2026-11-10', checkout: '2026-11-13', hospedes: 6 } }] },
      { texto: 'não dá' },
    ]);
    await agent.responder('s1', 'cota pra mim');
    const [r] = resultados(fake.recebidos[1]!) as { ok: boolean; motivos: string[] }[];
    expect(r!.ok).toBe(false);
    expect(r!.motivos.join(' ')).toMatch(/até 4 hóspedes/);
    expect(r!.motivos.join(' ')).toMatch(/já passou/);
  });

  it('executa chamadas paralelas e devolve todos os resultados numa só mensagem', async () => {
    const { agent, fake } = setup([
      { ferramentas: [{ nome: 'ver_imovel', entrada: { imovel_id: 'GRM-301' } }, { nome: 'ver_imovel', entrada: { imovel_id: 'GRM-302' } }] },
      { texto: 'ok' },
    ]);
    await agent.responder('s1', 'compare os dois de Gramado');
    const r = resultados(fake.recebidos[1]!) as { id: string; distancia_praia: string }[];
    expect(r.map((x) => x.id)).toEqual(['GRM-301', 'GRM-302']);
    expect(r[0]!.distancia_praia).toBe('não informada no catálogo');
  });

  it('erros de ferramenta voltam ao modelo como is_error, sem derrubar o turno', async () => {
    const { agent, fake } = setup([
      { ferramentas: [{ nome: 'ver_imovel', entrada: { imovel_id: 'XYZ-999' } }, { nome: 'cotar', entrada: { imovel_id: 'GRM-301' } }] },
      { texto: 'Não encontrei esse imóvel.' },
    ]);
    const r = await agent.responder('s1', 'e o XYZ-999?');
    expect(r.reply).toBe('Não encontrei esse imóvel.');
    const ultima = fake.recebidos[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(ultima.map((b) => b.is_error)).toEqual([true, true]);
  });

  it('lembra a conversa pelo session_id e separa conversas diferentes', async () => {
    const { agent, fake } = setup([{ texto: 'a' }, { texto: 'b' }, { texto: 'c' }]);
    await agent.responder('s1', 'primeira');
    await agent.responder('s2', 'outra conversa');
    await agent.responder('s1', 'segunda');
    const s1 = fake.recebidos[2]!.messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(s1).toEqual(['primeira', 'segunda']);
    expect(fake.recebidos[1]!.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('mantém system, ferramentas e histórico anterior idênticos entre turnos (prefixo em cache)', async () => {
    const { agent, fake } = setup([{ texto: 'a' }, { texto: 'b' }]);
    await agent.responder('s1', 'primeira');
    await agent.responder('s1', 'segunda');
    const [p1, p2] = fake.recebidos;
    expect(p2!.system).toEqual(p1!.system);
    expect(p2!.tools).toEqual(p1!.tools);
    expect(p2!.messages.slice(0, p1!.messages.length)).toEqual(p1!.messages);
    expect(p2!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('falha do modelo vira resposta de contingência e o histórico continua válido', async () => {
    const { agent, fake } = setup([{ erro: new Error('API fora') }, { texto: 'voltei' }]);
    const r1 = await agent.responder('s1', 'oi');
    expect(r1).toMatchObject({ reply: RESPOSTA_CONTINGENCIA, handoff: false });
    await agent.responder('s1', 'oi de novo');
    const papeis = fake.recebidos[1]!.messages.map((m) => m.role);
    expect(papeis).toEqual(['user', 'assistant', 'user', 'system']);
  });

  it('recusa do modelo passa a conversa para um humano', async () => {
    const { agent } = setup([{ recusa: true }]);
    expect((await agent.responder('s1', '...')).handoff).toBe(true);
  });

  it('para no limite de iterações com uma resposta, sem ficar em loop', async () => {
    const volta = { ferramentas: [{ nome: 'listar_cidades', entrada: {} }] };
    const { agent, fake } = setup([volta, volta, volta, { texto: 'nunca' }], { maxIteracoes: 3 });
    expect((await agent.responder('s1', 'oi')).reply).toBe(RESPOSTA_CONTINGENCIA);
    expect(fake.chamadas).toBe(3);
  });

  it('não começa uma chamada ao modelo sem tempo para terminar dentro do prazo', async () => {
    const { agent, fake } = setup([{ texto: 'x' }], { prazoMs: 1_000 });
    expect((await agent.responder('s1', 'oi')).reply).toBe(RESPOSTA_CONTINGENCIA);
    expect(fake.chamadas).toBe(0);
  });
});
