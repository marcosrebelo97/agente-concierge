import { describe, expect, it } from 'vitest';
import { confirmaReserva, hashReserva, normalizarTelefone, validarNome, type Lead } from '../src/domain/lead.js';

describe('telefone', () => {
  it('normaliza para o formato do enunciado', () => {
    for (const t of ['(48) 99999-0000', '48999990000', '+55 48 99999-0000', '55 (48) 9 9999-0000']) {
      expect(normalizarTelefone(t)).toEqual({ ok: true, valor: '(48) 99999-0000' });
    }
    expect(normalizarTelefone('11 3333-4444')).toEqual({ ok: true, valor: '(11) 3333-4444' });
  });

  it('recusa sem DDD, curto, longo, DDD com zero, celular sem 9 e número repetido', () => {
    for (const t of ['99999-0000', '4899999', '489999900001', '(08) 99999-0000', '(48) 89999-0000', '(48) 99999-9999', 'abc']) {
      expect(normalizarTelefone(t).ok).toBe(false);
    }
  });
});

describe('nome', () => {
  it('aceita nomes com acento, hífen e apóstrofo, e tira espaços sobrando', () => {
    expect(validarNome('  Maria   Souza ')).toEqual({ ok: true, valor: 'Maria Souza' });
    expect(validarNome("João D'Ávila-Neto").ok).toBe(true);
  });

  it('recusa vazio, uma letra, dígitos e texto longo demais', () => {
    for (const n of ['', ' ', 'M', 'Maria 123', '<script>', 'a'.repeat(101)]) expect(validarNome(n).ok).toBe(false);
  });
});

describe('hash da reserva', () => {
  const lead: Lead = {
    nome: 'Maria Souza',
    telefone: '(48) 99999-0000',
    imovel_id: 'GRM-301',
    checkin: '2027-01-15',
    checkout: '2027-01-18',
    hospedes: 2,
    valor_total: 2156,
  };

  it('é estável para os mesmos dados, ignora maiúsculas no nome, e muda com qualquer outro dado', () => {
    expect(hashReserva({ ...lead })).toBe(hashReserva(lead));
    expect(hashReserva({ ...lead, nome: 'maria souza' })).toBe(hashReserva(lead));
    expect(hashReserva({ ...lead, hospedes: 3 })).not.toBe(hashReserva(lead));
    expect(hashReserva({ ...lead, checkout: '2027-01-19' })).not.toBe(hashReserva(lead));
  });
});

describe('confirmação do hóspede', () => {
  it('reconhece confirmações comuns', () => {
    for (const m of ['sim', 'Sim!', 'pode enviar', 'confirmo', 'ok, pode registrar', 'isso mesmo', 'fechado', 'tá certo, pode mandar', 'Perfeito 👍', 'S']) {
      expect(confirmaReserva(m), m).toBe(true);
    }
  });

  it('não confirma pedido de mudança, negação, dúvida ou mensagem sem afirmação', () => {
    for (const m of [
      'não',
      'Não, espera',
      'sim, mas muda para 3 hóspedes',
      'na verdade são 4 pessoas',
      'pode trocar a data?',
      'quanto fica com 3 pessoas?',
      'tem wifi?',
      'deixa eu pensar',
      'sim... na verdade não',
      'cancela',
    ]) {
      expect(confirmaReserva(m), m).toBe(false);
    }
  });
});
