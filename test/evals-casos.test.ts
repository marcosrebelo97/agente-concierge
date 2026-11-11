import { describe, expect, it } from 'vitest';
import { cotar, formatarReais, reaisParaCentavos } from '../src/domain/pricing.js';
import { CASOS_ADVERSARIO } from '../evals/casos-adversario.js';
import { CASOS, type Caso } from '../evals/casos.js';
import { FICHAS } from './support/fake-catalog.js';

// Integridade dos casos de eval, manuais e gerados: um eval com expectativa errada reprova o agente
// certo (ou aprova o errado). Nada aqui chama modelo ou rede.

const TODOS: Caso[] = [...CASOS, ...CASOS_ADVERSARIO];
// "Hoje" fixo antes de todas as datas dos casos: a integridade não pode depender do dia em que roda.
const HOJE = '2026-11-11';
const DINHEIRO = /R\$\s*\d[\d.,]*\d/g;
const FORMATO = /^R\$ \d{1,3}(\.\d{3})*,\d{2}$/;

const doCatalogo = new Set(
  FICHAS.flatMap((f) => [reaisParaCentavos(f.diaria), reaisParaCentavos(f.taxa_limpeza)]).map(formatarReais),
);

function valoresLegitimos(caso: Caso): Set<string> {
  const v = new Set(doCatalogo);
  for (const p of caso.cotacoes ?? []) {
    const ficha = FICHAS.find((f) => f.id === p.imovel_id);
    if (!ficha) throw new Error(`${caso.id}: imóvel ${p.imovel_id} não existe`);
    const c = cotar(ficha, p, HOJE);
    if (!c.ok) throw new Error(`${caso.id}: cotação recusada (${c.recusas.map((r) => r.codigo).join(', ')})`);
    v.add(formatarReais(c.totalCentavos));
    v.add(formatarReais(c.taxaLimpezaCentavos));
    for (const n of c.noites) v.add(formatarReais(n.valorCentavos));
  }
  return v;
}

describe('casos de eval', () => {
  it('ids únicos, e só os casos gerados usam o prefixo ha-', () => {
    const ids = TODOS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CASOS) expect(c.id.startsWith('ha-'), c.id).toBe(false);
    for (const c of CASOS_ADVERSARIO) expect(c.id, c.id).toMatch(/^ha-[a-z0-9-]+$/);
  });

  it.each(TODOS.map((c) => [c.id, c] as const))('%s: tem o que conferir e leads só crescem', (_id, caso) => {
    expect(caso.turnos.length).toBeGreaterThan(0);
    const confere = caso.turnos.some((t) => t.espera && Object.keys(t.espera).length > 0);
    expect(confere || caso.juiz !== undefined || caso.leadsFinais !== undefined).toBe(true);
    const leads = caso.turnos.map((t) => t.espera?.leads).filter((n) => n !== undefined);
    expect(leads).toEqual([...leads].sort((a, b) => a - b));
    for (const l of caso.leadsFinais ?? []) {
      if (l.valor_total !== undefined) {
        const legit = valoresLegitimos(caso);
        expect(legit.has(formatarReais(Math.round(l.valor_total * 100))), `valor_total ${l.valor_total}`).toBe(true);
      }
    }
  });

  it.each(TODOS.map((c) => [c.id, c] as const))('%s: todo R$ esperado sai de cotar() ou do catálogo', (_id, caso) => {
    const legit = valoresLegitimos(caso);
    for (const t of caso.turnos) {
      for (const item of t.espera?.contem ?? []) {
        if (typeof item !== 'string') continue;
        for (const [valor] of item.matchAll(DINHEIRO)) {
          expect(valor, 'formato').toMatch(FORMATO);
          expect(legit.has(valor), `${valor} não vem de cotar() nem do catálogo; declare em cotacoes`).toBe(true);
        }
      }
    }
  });
});
