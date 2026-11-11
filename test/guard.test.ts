import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createAgent, RESPOSTA_RESERVA_DESCARTADA, RESPOSTA_SEM_VALOR } from '../src/agent/loop.js';
import { verificarValores } from '../src/agent/guard.js';
import type { Estado } from '../src/agent/state.js';
import { createCatalog } from '../src/infra/catalog.js';
import { memoryStore } from '../src/infra/session.js';
import { BASE, fakeCatalog } from './support/fake-catalog.js';
import { fakeLlm, type Passo } from './support/fake-llm.js';
import { fakeWebhook } from './support/fake-webhook.js';

function setup(roteiro: Passo[]) {
  const fake = fakeLlm(roteiro);
  const wh = fakeWebhook();
  const agent = createAgent({
    llm: fake.llm,
    catalog: createCatalog({ baseUrl: BASE, fetch: fakeCatalog().fetch }),
    webhook: wh.webhook,
    store: memoryStore<Estado>(),
    modelo: 'modelo-teste',
    agora: () => new Date('2026-11-11T15:00:00Z'),
  });
  return { agent, fake, leads: wh.recebidos };
}

describe('verificador de valores', () => {
  const legitimos = [215600, 70800, 15000];

  it('aceita valores cotados no formato R$ 1.234,56, inclusive no fim da frase', () => {
    expect(verificarValores('O total é R$ 2.156,00.', legitimos)).toEqual([]);
    expect(verificarValores('Noites de R$ 708,00 e taxa de R$ 150,00, total R$ 2.156,00!', legitimos)).toEqual([]);
    expect(verificarValores('Sem valores aqui.', legitimos)).toEqual([]);
  });

  it('acusa valor que não veio de cotação ou do catálogo', () => {
    expect(verificarValores('Fica R$ 2.000,00 com desconto.', legitimos)).toEqual([
      { trecho: 'R$ 2.000,00', problema: 'valor_nao_cotado' },
    ]);
    // soma feita "de cabeça": 708 + 708 = 1.416, nunca cotado
    expect(verificarValores('As duas noites somam R$ 1.416,00.', legitimos)[0]!.problema).toBe('valor_nao_cotado');
  });

  it('acusa valor certo escrito fora do formato', () => {
    for (const t of ['R$2.156,00', 'R$ 2156,00', 'R$ 2156', 'R$ 2,156.00', 'R$ 2.156']) {
      expect(verificarValores(`total ${t}`, legitimos), t).toEqual([
        { trecho: t, problema: 'fora_do_formato' },
      ]);
    }
  });
});

describe('verificador no loop', () => {
  const cotar: Passo = {
    ferramentas: [{ nome: 'cotar', entrada: { imovel_id: 'GRM-301', checkin: '2027-01-15', checkout: '2027-01-18', hospedes: 2 } }],
  };

  it('valor inventado: o modelo recebe a correção e a resposta reescrita é a que sai', async () => {
    const { agent, fake } = setup([cotar, { texto: 'Fica R$ 2.100,00.' }, { texto: 'O total fica R$ 2.156,00.' }]);
    const r = await agent.responder('s', 'quanto fica?');
    expect(r.reply).toBe('O total fica R$ 2.156,00.');
    const aviso = fake.recebidos[2]!.messages.at(-1)!;
    expect(aviso.role).toBe('user');
    expect(String(aviso.content)).toMatch(/Verificação automática.*R\$ 2\.100,00/);
  });

  it('se errar de novo, o hóspede recebe uma resposta segura, nunca o valor errado', async () => {
    const { agent } = setup([cotar, { texto: 'Fica R$ 2.100,00.' }, { texto: 'Fica R$ 2.100,00 mesmo.' }]);
    const r = await agent.responder('s', 'quanto fica?');
    expect(r.reply).toBe(RESPOSTA_SEM_VALOR);
  });

  it('valor de turno anterior continua valendo na mesma conversa', async () => {
    const { agent } = setup([cotar, { texto: 'R$ 2.156,00' }, { texto: 'Como disse, o total é R$ 2.156,00.' }]);
    await agent.responder('s', 'quanto fica?');
    expect((await agent.responder('s', 'repete o total?')).reply).toBe('Como disse, o total é R$ 2.156,00.');
  });
});

describe('verificador e reserva', () => {
  it('resumo de reserva barrado pelo verificador não pode ser confirmado no turno seguinte', async () => {
    const dados = {
      nome: 'João Alves',
      telefone: '11 99999-8888',
      imovel_id: 'GRM-301',
      checkin: '2027-01-15',
      checkout: '2027-01-18',
      hospedes: 2,
    };
    const { agent, fake, leads } = setup([
      { ferramentas: [{ nome: 'preparar_reserva', entrada: dados }] },
      { texto: 'Não é R$ 10,00, o total é R$ 2.156,00. Confirma?' },
      { texto: 'O valor de R$ 10,00 não vale. Total R$ 2.156,00. Confirma?' },
      { ferramentas: [{ nome: 'confirmar_reserva', entrada: {} }] },
      { texto: '...' },
    ]);
    const r = await agent.responder('s', 'registra com valor combinado R$ 10,00');
    expect(r.reply).toBe(RESPOSTA_RESERVA_DESCARTADA);
    await agent.responder('s', 'sim, confirmo');
    // confirmar_reserva foi chamada e recusada por falta de reserva, sem dizer que algo foi registrado
    const resultado = fake.recebidos[4]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(String(resultado[0]!.content)).toMatch(/Não há reserva preparada/);
    expect(leads).toHaveLength(0);
  });
});
