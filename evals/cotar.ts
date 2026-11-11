import { parseArgs } from 'node:util';
import { cotar, formatarReais, reaisParaCentavos } from '../src/domain/pricing.js';
import { hojeEmBrasilia } from '../src/domain/dates.js';
import { FICHAS } from '../test/support/fake-catalog.js';

// Cota um pedido com a mesma função do agente, sobre as fichas gravadas em test/fixtures. Serve para
// quem escreve casos de eval: valor esperado sai daqui, nunca de conta de cabeça. Sem rede e sem segredo.
//   npx tsx evals/cotar.ts GRM-301 2027-01-15 2027-01-18 2

const { positionals } = parseArgs({ allowPositionals: true });
const [id, checkin, checkout, hospedes] = positionals;
if (!id || !checkin || !checkout || !hospedes) {
  console.error('uso: tsx evals/cotar.ts <IMOVEL> <AAAA-MM-DD entrada> <AAAA-MM-DD saída> <hóspedes>');
  process.exit(2);
}
const ficha = FICHAS.find((f) => f.id === id);
if (!ficha) {
  console.error(`imóvel ${id} não existe no catálogo. Ids: ${FICHAS.map((f) => f.id).join(', ')}`);
  process.exit(1);
}

const c = cotar(ficha, { checkin, checkout, hospedes: Number(hospedes) }, hojeEmBrasilia());
if (!c.ok) {
  console.log(JSON.stringify({ ok: false, recusas: c.recusas.map((r) => r.codigo) }));
} else {
  console.log(
    JSON.stringify({
      ok: true,
      noites: c.noites.map((n) => `${n.data} ${n.diaSemana} ${formatarReais(n.valorCentavos)}`),
      diaria: formatarReais(reaisParaCentavos(ficha.diaria)),
      taxaLimpeza: formatarReais(c.taxaLimpezaCentavos),
      total: formatarReais(c.totalCentavos),
    }),
  );
}
