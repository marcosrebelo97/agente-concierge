import { describe, expect, it } from 'vitest';
import { confirmaReserva, hashReserva, normalizarTelefone, validarNome, type Lead } from '../src/domain/lead.js';

describe('telefone', () => {
  it('normaliza para o formato do enunciado', () => {
    for (const t of ['(48) 99999-0000', '48999990000', '+55 48 99999-0000', '55 (48) 9 9999-0000']) {
      expect(normalizarTelefone(t)).toEqual({ ok: true, valor: '(48) 99999-0000' });
    }
    expect(normalizarTelefone('11 3333-4444')).toEqual({ ok: true, valor: '(11) 3333-4444' });
    expect(normalizarTelefone('048 99999-0000')).toEqual({ ok: true, valor: '(48) 99999-0000' });
  });

  it('aceita número estrangeiro com + e código do país, sem reformatar', () => {
    expect(normalizarTelefone('+1 555 123 4567')).toEqual({ ok: true, valor: '+15551234567' });
    expect(normalizarTelefone('+351 912 345 678')).toEqual({ ok: true, valor: '+351912345678' });
    expect(normalizarTelefone('0044 20 7946 0958')).toEqual({ ok: true, valor: '+442079460958' });
    for (const t of ['+1 555', '+1 5551234567890123', '+0 555 123 4567', '+1 111 111 1111']) {
      expect(normalizarTelefone(t).ok, t).toBe(false);
    }
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

  it('não confirma resposta hesitante, mesmo com "sim" ou "pode" no meio', () => {
    for (const m of [
      'Hmm, pode ser que sim... vou ver com meu chefe e te falo.',
      'acho que sim',
      'pode ser',
      'talvez, deixa eu ver',
      'sim, mas ainda não sei a data certa',
      'provavelmente sim',
      'ok, te aviso mais tarde',
    ]) {
      expect(confirmaReserva(m), m).toBe(false);
    }
    // a decisão vem depois da hesitação: aí confirma
    expect(confirmaReserva('Liberou! Pode registrar.')).toBe(true);
  });
  // Frases achadas na revisão: a lista de palavras aceitava perguntas e recusava "sim" informal ou em outro idioma.
  it('reconhece sim informal, curto e em inglês ou espanhol', () => {
    for (const m of ['Tá bom', 'Ótimo!', 'Combinado', 'Fecha', 'Quero fechar', 'Quero!', 'Exatamente', 'Certinho',
      'Confere', 'Aham', 'Yes', 'Sí', 'Pode', 'Manda!', 'sim, não tenho mais dúvidas', 'Yes, go ahead']) {
      expect(confirmaReserva(m), m).toBe(true);
    }
  });

  it('não confirma pergunta nem pedido que só contém uma palavra afirmativa', () => {
    for (const m of ['pode me dizer se tem wi-fi?', 'Isso inclui roupa de cama?', 'show, e o café da manhã?',
      'vamos ver outro imóvel', 'manda o endereço', 'quero ver outras opções', 'Isso não está certo',
      'isso inclui toalhas', 'No, wait', 'maybe later']) {
      expect(confirmaReserva(m), m).toBe(false);
    }
  });

  // Frases achadas na revisão de 12/11: confirmações comuns eram recusadas, e afirmações seguidas de mudança,
  // desistência ou pergunta sem "?" eram aceitas.
  it('reconhece confirmação no plural, "prossiga" e "pode fazer a reserva"', () => {
    for (const m of ['Os dados estão corretos', 'Dados corretos, pode prosseguir com a reserva', 'Prossiga',
      'Isso, pode fazer a reserva', 'Está tudo certo, pode registrar, não precisa mudar nada',
      'As informações estão certas', 'Tudo correto, não tenho mais perguntas']) {
      expect(confirmaReserva(m), m).toBe(true);
    }
  });

  it('não confirma afirmação seguida de mudança, desistência, consulta a outra pessoa ou pergunta sem "?"', () => {
    for (const m of ['perfeito, só que o check-in é dia 16', 'fechado. Ah, somos 5 agora',
      'certo, vou conversar com minha esposa primeiro', 'ok, deixa pra lá', 'beleza, vou fechar com outra empresa',
      'certo, obrigado, desisti', 'nada disso, ok', 'ótimo, e o estacionamento', 'certo, quanto fica com 3 pessoas',
      'ok, em vez de 2 serão 3 hóspedes']) {
      expect(confirmaReserva(m), m).toBe(false);
    }
  });
});
