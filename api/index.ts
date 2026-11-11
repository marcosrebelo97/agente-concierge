import { handle } from 'hono/vercel';
import { appFromEnv } from '../src/main.js';

// Entrada da Vercel (Node, Fluid Compute). O vercel.json manda todas as rotas para cá. A configuração é
// lida ao carregar a função: variável faltando falha no deploy, não no meio de uma conversa.

const app = appFromEnv();

export const GET = handle(app);
export const POST = handle(app);
