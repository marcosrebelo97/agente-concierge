import { describe, expect, it } from 'vitest';
import { cotar, diaDoCalendario, formatarReais, MAX_NOITES, type ImovelPreco } from '../src/domain/pricing.js';

// Valores das fichas reais do catálogo
const GRM301: ImovelPreco = { id: 'GRM-301', diaria: 590, taxa_limpeza: 150, minimo_noites: 2, capacidade: 4 };
const NAT601: ImovelPreco = { id: 'NAT-601', diaria: 365.9, taxa_limpeza: 95, minimo_noites: 2, capacidade: 3 };
const RIO402: ImovelPreco = { id: 'RIO-402', diaria: 245.5, taxa_limpeza: 75, minimo_noites: 1, capacidade: 2 };

function ok(c: ReturnType<typeof cotar>) {
  if (!c.ok) throw new Error(`esperava cotação, veio recusa: ${JSON.stringify(c.recusas)}`);
  return c;
}

function codigos(c: ReturnType<typeof cotar>) {
  if (c.ok) throw new Error('esperava recusa, veio cotação');
  return c.recusas.map((r) => r.codigo);
}

describe('regra de preço', () => {
  it('reproduz o exemplo do enunciado: GRM-301, sex 15/01 → seg 18/01/2027, 2 hóspedes = R$ 2.156,00', () => {
    const c = ok(cotar(GRM301, { checkin: '2027-01-15', checkout: '2027-01-18', hospedes: 2 }));
    expect(c.noites.map((n) => [n.data, n.diaSemana, n.valorCentavos])).toEqual([
      ['2027-01-15', 'sexta', 70800],
      ['2027-01-16', 'sábado', 70800],
      ['2027-01-17', 'domingo', 59000],
    ]);
    expect(c.taxaLimpezaCentavos).toBe(15000);
    expect(c.totalCentavos).toBe(215600);
    expect(formatarReais(c.totalCentavos)).toBe('R$ 2.156,00');
  });

  it('acrescenta 20% só nas noites que começam na sexta ou no sábado', () => {
    // qui 14/01 → seg 18/01: quinta, sexta, sábado, domingo
    const c = ok(cotar(GRM301, { checkin: '2027-01-14', checkout: '2027-01-18', hospedes: 1 }));
    expect(c.noites.map((n) => [n.diaSemana, n.acrescimoFimDeSemana])).toEqual([
      ['quinta', false],
      ['sexta', true],
      ['sábado', true],
      ['domingo', false],
    ]);
  });

  it('a noite de domingo para segunda não tem acréscimo, mesmo saindo na segunda', () => {
    const c = ok(cotar(GRM301, { checkin: '2027-01-17', checkout: '2027-01-19', hospedes: 2 }));
    expect(c.totalCentavos).toBe(59000 * 2 + 15000);
  });

  it('calcula em centavos com diária quebrada: NAT-601 (365,90 × 1,2 = 439,08)', () => {
    const c = ok(cotar(NAT601, { checkin: '2027-01-15', checkout: '2027-01-17', hospedes: 3 }));
    expect(c.noites.map((n) => n.valorCentavos)).toEqual([43908, 43908]);
    expect(formatarReais(c.totalCentavos)).toBe('R$ 973,16');
  });

  it('arredonda cada noite ao centavo antes de somar', () => {
    // 100,01 × 1,2 = 120,012. Por noite: 4 × 120,01 = 480,04. Arredondar só no fim daria 480,05.
    const imovel = { ...GRM301, diaria: 100.01, taxa_limpeza: 0, minimo_noites: 1 };
    // sex 08 → dom 10 e sex 15 → dom 17/01/2027: quatro noites de fim de semana
    const a = ok(cotar(imovel, { checkin: '2027-01-08', checkout: '2027-01-10', hospedes: 1 }));
    const b = ok(cotar(imovel, { checkin: '2027-01-15', checkout: '2027-01-17', hospedes: 1 }));
    expect([...a.noites, ...b.noites].map((n) => n.valorCentavos)).toEqual([12001, 12001, 12001, 12001]);
    expect(a.subtotalCentavos + b.subtotalCentavos).toBe(48004);
  });

  it('cobra a taxa de limpeza uma vez por estadia, qualquer que seja o número de noites', () => {
    const curta = ok(cotar(RIO402, { checkin: '2027-01-12', checkout: '2027-01-13', hospedes: 1 }));
    const longa = ok(cotar(RIO402, { checkin: '2027-01-12', checkout: '2027-01-15', hospedes: 1 }));
    expect(curta.totalCentavos - curta.subtotalCentavos).toBe(7500);
    expect(longa.totalCentavos - longa.subtotalCentavos).toBe(7500);
  });

  it('número de noites é a saída menos a entrada, inclusive virando o mês e o ano', () => {
    const c = ok(cotar(GRM301, { checkin: '2026-12-30', checkout: '2027-01-02', hospedes: 2 }));
    expect(c.noites.map((n) => n.data)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
  });

  it('aceita uma noite quando o mínimo do imóvel é 1: RIO-402 num sábado', () => {
    const c = ok(cotar(RIO402, { checkin: '2027-01-16', checkout: '2027-01-17', hospedes: 2 }));
    expect(c.totalCentavos).toBe(29460 + 7500);
  });

  it('aceita a capacidade exata do imóvel', () => {
    expect(cotar(GRM301, { checkin: '2027-01-15', checkout: '2027-01-18', hospedes: 4 }).ok).toBe(true);
  });
});

describe('recusas', () => {
  it('recusa saída no mesmo dia da entrada', () => {
    expect(codigos(cotar(RIO402, { checkin: '2027-01-15', checkout: '2027-01-15', hospedes: 1 }))).toEqual([
      'checkout_nao_posterior',
    ]);
  });

  it('recusa saída antes da entrada', () => {
    expect(codigos(cotar(GRM301, { checkin: '2027-01-18', checkout: '2027-01-15', hospedes: 2 }))).toEqual([
      'checkout_nao_posterior',
    ]);
  });

  it('recusa estadia abaixo do mínimo de noites, explicando o mínimo', () => {
    const c = cotar(GRM301, { checkin: '2027-01-15', checkout: '2027-01-16', hospedes: 2 });
    expect(codigos(c)).toEqual(['abaixo_minimo_noites']);
    expect(!c.ok && c.recusas[0]!.mensagem).toContain('2 noites');
  });

  it('recusa hóspedes acima da capacidade, explicando a capacidade', () => {
    const c = cotar(GRM301, { checkin: '2027-01-15', checkout: '2027-01-18', hospedes: 5 });
    expect(codigos(c)).toEqual(['acima_capacidade']);
    expect(!c.ok && c.recusas[0]!.mensagem).toContain('até 4 hóspedes');
  });

  it('acumula os motivos para explicar tudo de uma vez', () => {
    expect(codigos(cotar(GRM301, { checkin: '2027-01-15', checkout: '2027-01-16', hospedes: 9 }))).toEqual([
      'acima_capacidade',
      'abaixo_minimo_noites',
    ]);
  });

  it('recusa data que não existe', () => {
    expect(codigos(cotar(GRM301, { checkin: '2027-02-30', checkout: '2027-03-03', hospedes: 2 }))).toEqual([
      'data_invalida',
    ]);
  });

  it('recusa check-in no passado quando sabe a data de hoje', () => {
    const pedido = { checkin: '2026-11-01', checkout: '2026-11-05', hospedes: 2 };
    expect(codigos(cotar(GRM301, pedido, '2026-11-11'))).toEqual(['checkin_no_passado']);
    expect(cotar(GRM301, { checkin: '2026-11-11', checkout: '2026-11-13', hospedes: 2 }, '2026-11-11').ok).toBe(true);
  });

  it(`recusa estadia acima de ${MAX_NOITES} noites`, () => {
    expect(codigos(cotar(GRM301, { checkin: '2027-01-01', checkout: '2027-05-01', hospedes: 2 }))).toEqual([
      'estadia_longa_demais',
    ]);
  });

  it('recusa número de hóspedes que não é inteiro positivo', () => {
    for (const hospedes of [0, -1, 2.5]) {
      expect(codigos(cotar(GRM301, { checkin: '2027-01-15', checkout: '2027-01-18', hospedes }))).toEqual([
        'hospedes_invalido',
      ]);
    }
  });
});

describe('datas e formatação', () => {
  it('reconhece só datas reais no formato AAAA-MM-DD', () => {
    expect(diaDoCalendario('2028-02-29')).not.toBeNull();
    for (const d of ['2027-02-29', '2027-13-01', '15/01/2027', '2027-1-5', '']) expect(diaDoCalendario(d)).toBeNull();
  });

  it('formata em reais com milhar e vírgula, sem espaço especial', () => {
    expect(formatarReais(215600)).toBe('R$ 2.156,00');
    expect(formatarReais(123456780)).toBe('R$ 1.234.567,80');
    expect(formatarReais(50)).toBe('R$ 0,50');
    expect(formatarReais(99999)).toBe('R$ 999,99');
  });
});
