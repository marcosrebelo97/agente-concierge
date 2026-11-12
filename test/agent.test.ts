import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { citaRegra, createAgent, RESPOSTA_CONTINGENCIA } from '../src/agent/loop.js';
import type { Estado } from '../src/agent/state.js';
import { proximoPassoHandoff } from '../src/agent/tools.js';
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

describe('passar para humano', () => {
  // Achado da bateria em produção: festa acima da capacidade passava para o atendente sem dizer a regra.
  it('na exceção de regra, orienta a dizer a regra da ficha antes do aviso de atendente', () => {
    const passo = proximoPassoHandoff('excecao_a_regra');
    expect(passo).toMatch(/^Primeiro diga .* o que a ficha/);
    expect(passo.indexOf('ficha')).toBeLessThan(passo.indexOf('atendente'));
    expect(passo).not.toMatch(/poucas palavras/);
  });

  const FICHA = { ferramentas: [{ nome: 'ver_imovel', entrada: { imovel_id: 'GRM-301' } }] };
  const EXCECAO = { ferramentas: [{ nome: 'passar_para_humano', entrada: { motivo: 'excecao_a_regra', resumo: 'festa' } }] };
  const SEM_REGRA = { texto: 'Já passei seu pedido para um atendente.' };
  const COM_REGRA = { texto: 'Pela ficha, festas não são permitidas. Um atendente vai avaliar o pedido.' };

  it('exceção de regra sem a regra na resposta: o código pede uma reescrita', async () => {
    const { agent, fake } = setup([FICHA, EXCECAO, SEM_REGRA, COM_REGRA]);
    const r = await agent.responder('s1', 'quero fazer uma festa com 15 amigos no GRM-301');
    expect(r.reply).toBe(COM_REGRA.texto);
    expect(r.handoff).toBe(true);
    expect(fake.chamadas).toBe(4);
    expect(JSON.stringify(fake.recebidos[3]!.messages.at(-1))).toMatch(/não diz o que a ficha diz sobre a regra/);
  });

  it('exceção de regra com a regra na resposta: sem reescrita', async () => {
    const { agent, fake } = setup([FICHA, EXCECAO, COM_REGRA]);
    expect((await agent.responder('s1', 'quero fazer uma festa')).handoff).toBe(true);
    expect(fake.chamadas).toBe(3);
  });

  it('a reescrita é pedida uma vez só', async () => {
    const { agent, fake } = setup([FICHA, EXCECAO, SEM_REGRA, { texto: 'Um atendente vai continuar.' }]);
    expect((await agent.responder('s1', 'quero fazer uma festa')).reply).toBe('Um atendente vai continuar.');
    expect(fake.chamadas).toBe(4);
  });

  // Sem ficha consultada, cobrar a regra empurraria o modelo a inventar uma (invariante 2).
  it('sem ficha consultada no turno, não cobra a regra', async () => {
    const { agent, fake } = setup([EXCECAO, SEM_REGRA]);
    await agent.responder('s1', 'aceitam festa em algum imóvel? quero falar com alguém');
    expect(fake.chamadas).toBe(2);
  });

  it('sem tempo no turno, fica a resposta que já existe', async () => {
    const { agent, fake } = setup([FICHA, EXCECAO, SEM_REGRA, COM_REGRA]);
    const r = await agent.responder('s1', 'quero fazer uma festa', Date.now() + 8_000);
    expect(r.reply).toBe(SEM_REGRA.texto);
    expect(fake.chamadas).toBe(3);
  });

  it('chamada de exceção recusada na validação não conta: handoff por outro motivo não cobra regra', async () => {
    const { agent, fake } = setup([
      FICHA,
      { ferramentas: [{ nome: 'passar_para_humano', entrada: { motivo: 'excecao_a_regra', resumo: 'x'.repeat(600) } }] },
      { ferramentas: [{ nome: 'passar_para_humano', entrada: { motivo: 'reclamacao', resumo: 'x' } }] },
      SEM_REGRA,
    ]);
    expect((await agent.responder('s1', 'péssimo, quero falar com alguém')).reply).toBe(SEM_REGRA.texto);
    expect(fake.chamadas).toBe(4);
  });

  it('outros motivos de handoff não cobram regra', async () => {
    const { agent, fake } = setup([
      FICHA,
      { ferramentas: [{ nome: 'passar_para_humano', entrada: { motivo: 'reclamacao', resumo: 'x' } }] },
      SEM_REGRA,
    ]);
    await agent.responder('s1', 'péssimo atendimento');
    expect(fake.chamadas).toBe(3);
  });

  it.each([
    'Pela ficha, festas não são permitidas.',
    'O chalé comporta até 4 pessoas.',
    'Pets não são aceitos e a capacidade máxima é de 4 hóspedes.',
    'O imóvel não aceita pets.',
    'Recebe no máximo quatro hóspedes.',
    'Acomoda até 4 hóspedes.',
    "Parties aren't allowed there; it doesn't allow pets.",
    'The cabin sleeps up to 4 guests.',
    'No se aceptan mascotas.',
  ])('reconhece a regra enunciada: %s', (t) => expect(citaRegra(t)).toBe(true));

  it.each([
    'Já passei seu pedido para um atendente.',
    'Passei seu pedido para um atendente, que vai analisar a ficha e a capacidade do imóvel.',
    'O check-out é até as 12:00. Um atendente vai continuar.',
  ])('não confunde aviso de atendente com regra: %s', (t) => expect(citaRegra(t)).toBe(false));

  it('nos outros motivos, só avisa que um atendente vai continuar', () => {
    for (const motivo of ['reclamacao', 'desconto_ou_negociacao', 'pedido_de_atendente', 'fora_do_alcance'] as const) {
      expect(proximoPassoHandoff(motivo)).toMatch(/^Diga ao hóspede, em poucas palavras/);
    }
  });

  it('liga handoff na resposta do turno e marca a sessão', async () => {
    const { agent, store } = setup([
      { ferramentas: [{ nome: 'passar_para_humano', entrada: { motivo: 'desconto_ou_negociacao', resumo: 'quer 30%' } }] },
      { texto: 'Um atendente vai continuar.' },
    ]);
    expect(await agent.responder('s1', 'me dá 30% de desconto?')).toMatchObject({ reply: 'Um atendente vai continuar.', handoff: true });
    expect((await store.get('s1'))!.humanoAcionado).toBe(true);
  });

  it('vale só no turno em que foi decidido', async () => {
    const { agent } = setup([
      { ferramentas: [{ nome: 'passar_para_humano', entrada: { motivo: 'reclamacao', resumo: 'x' } }] },
      { texto: 'Um atendente vai continuar.' },
      { texto: 'O wifi é incluso.' },
    ]);
    await agent.responder('s1', 'péssimo atendimento');
    expect((await agent.responder('s1', 'tem wifi?')).handoff).toBe(false);
  });

  it('motivo fora da lista é recusado e não liga handoff', async () => {
    const { agent } = setup([
      { ferramentas: [{ nome: 'passar_para_humano', entrada: { motivo: 'qualquer', resumo: 'x' } }] },
      { texto: 'ok' },
    ]);
    expect((await agent.responder('s1', 'oi')).handoff).toBe(false);
  });
});
