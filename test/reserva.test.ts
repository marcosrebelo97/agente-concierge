import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent/loop.js';
import type { Estado } from '../src/agent/state.js';
import { createCatalog } from '../src/infra/catalog.js';
import { memoryStore } from '../src/infra/session.js';
import type { ResultadoEnvio } from '../src/infra/webhook.js';
import { BASE, fakeCatalog } from './support/fake-catalog.js';
import { fakeLlm, type Passo } from './support/fake-llm.js';
import { fakeWebhook } from './support/fake-webhook.js';

// A confirmação antes do lead não depende do modelo: estes testes fazem o modelo falso tentar
// atalhos (confirmar no mesmo turno, sem confirmação, duas vezes) e conferem que o código segura.

const DADOS = {
  nome: 'Maria Souza',
  telefone: '48 99999-0000',
  imovel_id: 'GRM-301',
  checkin: '2027-01-15',
  checkout: '2027-01-18',
  hospedes: 2,
};
const preparar = (dados: Partial<typeof DADOS> = {}): Passo => ({
  ferramentas: [{ nome: 'preparar_reserva', entrada: { ...DADOS, ...dados } }],
});
const confirmar: Passo = { ferramentas: [{ nome: 'confirmar_reserva', entrada: {} }] };
const texto = (t: string): Passo => ({ texto: t });

function setup(roteiro: Passo[], resposta?: () => ResultadoEnvio) {
  const fake = fakeLlm(roteiro);
  const wh = fakeWebhook(resposta);
  const store = memoryStore<Estado>();
  const agent = createAgent({
    llm: fake.llm,
    catalog: createCatalog({ baseUrl: BASE, fetch: fakeCatalog().fetch }),
    webhook: wh.webhook,
    store,
    modelo: 'modelo-teste',
    agora: () => new Date('2026-11-11T15:00:00Z'),
  });
  return { agent, fake, leads: wh.recebidos, store };
}

/** Resultados das ferramentas que o modelo recebeu na chamada `n` (0-based). */
function resultados(fake: ReturnType<typeof fakeLlm>, n: number): Record<string, unknown>[] {
  const ultima = fake.recebidos[n]!.messages.at(-1)!;
  return (ultima.content as Anthropic.ToolResultBlockParam[]).map((b) => ({
    erro: b.is_error === true,
    ...(JSON.parse(b.content as string) as Record<string, unknown>),
  }));
}

describe('fluxo do lead', () => {
  it('prepara, mostra o resumo e só envia depois da confirmação, com o valor da cotação', async () => {
    const { agent, fake, leads } = setup([preparar(), texto('Confere?'), confirmar, texto('Registrado!')]);
    await agent.responder('s', 'quero fechar');
    const [prep] = resultados(fake, 1);
    expect(prep).toMatchObject({ ok: true, resumo: { telefone: '(48) 99999-0000', total: 'R$ 2.156,00' } });
    expect(leads).toHaveLength(0);

    await agent.responder('s', 'sim, pode enviar');
    expect(resultados(fake, 3)[0]).toMatchObject({ ok: true, registrado: true });
    expect(leads).toEqual([
      {
        nome: 'Maria Souza',
        telefone: '(48) 99999-0000',
        imovel_id: 'GRM-301',
        checkin: '2027-01-15',
        checkout: '2027-01-18',
        hospedes: 2,
        valor_total: 2156,
      },
    ]);
  });

  it('não envia se o modelo tenta confirmar no mesmo turno do resumo', async () => {
    const { agent, fake, leads } = setup([
      { ferramentas: [{ nome: 'preparar_reserva', entrada: DADOS }, { nome: 'confirmar_reserva', entrada: {} }] },
      texto('...'),
    ]);
    await agent.responder('s', 'quero fechar, Maria Souza, 48 99999-0000, GRM-301 de 15 a 18/01, 2 pessoas, confirmo');
    const [prep, conf] = resultados(fake, 1);
    expect(prep!.ok).toBe(true);
    expect(conf).toMatchObject({ ok: false, erro: true });
    expect(leads).toHaveLength(0);
  });

  it('não envia se a mensagem do hóspede não confirma, mesmo que o modelo chame confirmar', async () => {
    const { agent, leads } = setup([preparar(), texto('Confere?'), confirmar, texto('...')]);
    await agent.responder('s', 'quero fechar');
    await agent.responder('s', 'sim, mas muda para 3 hóspedes');
    expect(leads).toHaveLength(0);
  });

  it('não envia sem reserva preparada', async () => {
    const { agent, fake, leads } = setup([confirmar, texto('...')]);
    await agent.responder('s', 'confirmo');
    expect(resultados(fake, 1)[0]).toMatchObject({ ok: false, erro: true });
    expect(leads).toHaveLength(0);
  });

  it('mudança depois do resumo exige novo resumo e nova confirmação, e envia os dados novos', async () => {
    const { agent, leads } = setup([
      preparar(),
      texto('Confere?'),
      preparar({ hospedes: 3 }),
      texto('Novo resumo, confere?'),
      confirmar,
      texto('Registrado'),
    ]);
    await agent.responder('s', 'quero fechar');
    await agent.responder('s', 'na verdade somos 3');
    await agent.responder('s', 'agora sim, pode registrar');
    expect(leads).toHaveLength(1);
    expect(leads[0]!.hospedes).toBe(3);
  });

  it('um lead por reserva: confirmar de novo não duplica', async () => {
    const { agent, fake, leads } = setup([preparar(), texto('Confere?'), confirmar, texto('ok'), confirmar, texto('ok')]);
    await agent.responder('s', 'quero fechar');
    await agent.responder('s', 'sim');
    await agent.responder('s', 'sim, confirmo de novo');
    expect(leads).toHaveLength(1);
    expect(resultados(fake, 5)[0]).toMatchObject({ erro: true });
  });

  it('a mesma reserva preparada de novo depois de enviada é recusada como já registrada', async () => {
    const { agent, fake, leads } = setup([preparar(), texto('?'), confirmar, texto('ok'), preparar(), texto('...')]);
    await agent.responder('s', 'quero fechar');
    await agent.responder('s', 'sim');
    await agent.responder('s', 'manda de novo');
    expect(resultados(fake, 5)[0]).toMatchObject({ ok: false });
    expect(leads).toHaveLength(1);
  });

  it('valida nome, telefone e a estadia antes de preparar', async () => {
    const { agent, fake } = setup([preparar({ nome: 'X', telefone: '123', hospedes: 9 }), texto('...')]);
    await agent.responder('s', 'quero fechar');
    const [r] = resultados(fake, 1) as unknown as { ok: boolean; problemas: string[] }[];
    expect(r!.ok).toBe(false);
    expect(r!.problemas.join(' ')).toMatch(/Nome inválido.*Telefone inválido.*até 4 hóspedes/);
  });

  it('webhook recusando (422) não marca como enviado e devolve os erros ao modelo', async () => {
    const { agent, fake, store } = setup([preparar(), texto('?'), confirmar, texto('...')], () => ({
      status: 'invalido',
      erros: ['tipo invalido em valor_total'],
    }));
    await agent.responder('s', 'quero fechar');
    await agent.responder('s', 'sim');
    expect(resultados(fake, 3)[0]).toMatchObject({ ok: false, erros: ['tipo invalido em valor_total'] });
    const estado = (await store.get('s'))!;
    expect(estado.leadsEnviados).toHaveLength(0);
    expect(estado.pendente).not.toBeNull();
  });

  it('webhook fora do ar: não diz que registrou e mantém a reserva pendente', async () => {
    const { agent, fake } = setup([preparar(), texto('?'), confirmar, texto('...')], () => ({
      status: 'falha',
      motivo: 'webhook indisponível',
    }));
    await agent.responder('s', 'quero fechar');
    await agent.responder('s', 'sim');
    expect(resultados(fake, 3)[0]).toMatchObject({ ok: false, erro: true });
  });
});
