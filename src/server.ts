import { serve } from '@hono/node-server';
import { appFromEnv } from './main.js';

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '127.0.0.1';

serve({ fetch: appFromEnv().fetch, port, hostname }, (info) => {
  console.log(`agente-concierge em http://${info.address}:${info.port}`);
});
