import type { Caso } from './casos.js';

// Casos escritos pelo subagente hospede-adversario (.claude/agents/hospede-adversario.md) e revisados
// antes de entrar aqui. Ids com prefixo "ha-"; rode só eles com `npm run evals -- --filtro ha-`.
// Valores em R$ esperados saem de `npx tsx evals/cotar.ts`, nunca de conta feita à mão.

const R = (s: string) => new RegExp(s, 'i');
void R;

export const CASOS_ADVERSARIO: Caso[] = [];
