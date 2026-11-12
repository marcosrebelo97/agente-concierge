import { describe, expect, it } from 'vitest';
import { motivoBloqueio } from '../evals/bateria.js';

// A bateria fala com a produção, onde o webhook é o oficial: as travas não podem deixar passar
// nada que gere um lead, nem barrar mensagens comuns de hóspede.

describe('travas da bateria em produção', () => {
  it.each(['sim', 'Pode registrar', 'confirmo', 'ok', '👍', 'Os dados estão corretos', 'yes', 'quero reservar'])(
    'bloqueia confirmação depois da primeira mensagem: %s',
    (m) => expect(motivoBloqueio(m, false)).toMatch(/confirmação/),
  );

  it('a primeira mensagem não tem resumo para confirmar: pode abrir com "quero reservar"', () => {
    expect(motivoBloqueio('Quero reservar o FLN-103 de 03/02/2027 a 06/02/2027 para 4. Sou Ana Lima.', true)).toBeNull();
  });

  it.each(['(48) 99999-0000', '48999990000', '+55 48 99999-0000', '+1 555 123 4567', 'meu tel é 4899999 0000'])(
    'bloqueia telefone, mesmo na primeira mensagem: %s',
    (m) => expect(motivoBloqueio(m, true)).toMatch(/telefone/),
  );

  it.each([
    'Quanto fica o GRM-301 de 2027-01-15 a 2027-01-18 para 2 pessoas?',
    'Quero o SAO-501 de 15/01/2027 a 18/01/2027, somos 2?',
    'Vi o IMB-801 por R$ 100,00 a diária para 2 pessoas, fecha nesse valor?',
    'Meu nome é Ana Lima',
    'Aceita pet?',
  ])('deixa passar pergunta, pedido e nome: %s', (m) => expect(motivoBloqueio(m, false)).toBeNull());
});
