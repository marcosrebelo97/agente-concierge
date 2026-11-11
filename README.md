# agente-concierge

Agente concierge de hospedagem. Tira dúvidas só com o catálogo, cota estadias pela regra de preço,
registra o pedido de reserva depois da confirmação do hóspede e passa a conversa para um humano em
reclamação, desconto, negociação ou assunto que não resolve.

**Princípio:** o modelo conversa e escolhe a ferramenta; o código decide tudo o que é verificável.
Preço, datas, capacidade, confirmação, envio do lead e o formato dos valores não dependem do modelo.

## Contrato

```http
POST /chat
{"session_id": "abc-123", "message": "Quanto fica o GRM-301 de 15/01/2027 a 18/01/2027 para 2 pessoas?"}

200 OK
{"reply": "... O total fica R$ 2.156,00 ...", "handoff": false}
```

- A memória é por `session_id` (7 dias). `handoff: true` vale para a resposta em que o agente passou a
  conversa para um humano.
- Sempre `200` com `{reply, handoff}`, inclusive quando o modelo ou o catálogo falham (resposta de
  contingência). `400` só para corpo inválido.
- Cada turno termina em até 50 s, abaixo dos 60 s do contrato.
- `GET /health` para monitoramento.

## Como rodar

Requer Node 22 ou mais novo.

```bash
cp .env.example .env    # preencha ANTHROPIC_API_KEY e SEAZONE_TOKEN
npm install
npm run dev             # http://127.0.0.1:3000

curl -s 127.0.0.1:3000/chat -H 'content-type: application/json' \
  -d '{"session_id":"teste","message":"Quanto fica o GRM-301 de 15/01/2027 a 18/01/2027 para 2 pessoas?"}'
```

Sem `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, as sessões ficam em memória (só para
desenvolvimento). Configuração inválida falha ao subir, não no meio de uma conversa. As variáveis
opcionais (`MODELO`, `ESFORCO`, `HOST`, `PORT`) estão no `.env.example`.

| Comando | O que faz |
|---|---|
| `npm run check` | Typecheck e testes unitários (sem rede, sem modelo) |
| `npm run evals -- --rodadas 2 --juiz` | Conversas reais contra o modelo; ver `docs/EVALS.md` |

## Como funciona

```
hóspede ── POST /chat ──> app.ts (Zod, sempre 200)
                            │  lock por sessão (Redis)
                            v
                         loop.ts ── modelo (Sonnet 5.5, tool use, prompt em cache)
                            │
              ┌─────────────┼──────────────────────────────┐
              v             v                              v
       buscar_imoveis    cotar ── pricing.ts        preparar_reserva / confirmar_reserva
       ver_imovel           (centavos inteiros)       (travas no código) ── webhook de leads
       listar_cidades                                passar_para_humano ── handoff: true
              │
              v
        catálogo (cache 10 min, 1 retry)
                            │
                            v
                         guard.ts: todo R$ da resposta veio de uma cotação ou da ficha?
```

| Garantia | Onde |
|---|---|
| O modelo nunca calcula dinheiro: `cotar` recebe só imóvel, datas e hóspedes e busca a ficha no servidor | `src/domain/pricing.ts`, `src/agent/tools.ts` |
| Nenhum valor sai sem conferência: valor não cotado, fora do formato `R$ 1.234,56` ou em outra moeda volta ao modelo uma vez; na segunda, a resposta é trocada por uma segura | `src/agent/guard.ts` |
| Lead só com resumo mostrado num turno anterior, confirmação explícita no turno atual (sem mudança nem hesitação) e um por reserva; `valor_total` sai da cotação | `src/agent/tools.ts`, `src/domain/lead.ts` |
| Resumo que o hóspede não viu (prazo, erro, recusa, verificador) é descartado | `src/agent/loop.ts` |
| Duas mensagens simultâneas da mesma sessão não viram dois leads | `src/infra/session.ts` |
| Falha de rede no webhook confere por GET antes de tentar de novo | `src/infra/webhook.ts` |

As decisões sobre o que o enunciado não define (desconto, exceção de regra, datas, capacidade,
confirmação, falhas) estão em [`docs/DECISOES.md`](docs/DECISOES.md).

## Custo por conversa

Medido com o `usage` de cada chamada nos evals (54 conversas, 2 rodadas, catálogo real), com os preços
oficiais por milhão de tokens: Sonnet 5.5 US$ 2 entrada, US$ 10 saída, US$ 0,10 leitura de cache;
Haiku 5.5 US$ 0,10, US$ 0,50 e US$ 0,01; escrita de cache a 1,25× a entrada.

| | **Sonnet 5.5** (produção) | Haiku 5.5 |
|---|---|---|
| Conversa média dos evals (1,5 turno) | **US$ 0,016** | US$ 0,001 |
| Por turno | US$ 0,011 | US$ 0,0007 |
| Reserva completa: cotação, dados, resumo e confirmação (4 turnos, 8 chamadas) | **US$ 0,018** | US$ 0,0014 |
| Conversas de 4 turnos, média | US$ 0,026 | US$ 0,0016 |

- **Prompt caching:** prompt do sistema e ferramentas ficam em cache, e cerca de 77% dos tokens de
  entrada são lidos do cache. A data de hoje entra como mensagem de sistema no fim do histórico para não
  quebrar o prefixo.
- **Cache frio:** a primeira conversa depois de 5 minutos sem tráfego paga a escrita do prefixo
  (cerca de 6,5 mil tokens, US$ 0,016 no Sonnet) uma vez.
- **Ordem de grandeza:** mil conversas por dia custam cerca de US$ 16 a 26 com o Sonnet, ou US$ 1 a 2 com
  o Haiku, que também passou em todos os evals e entra trocando `MODELO`.

## Como foi feito

- [`CLAUDE.md`](CLAUDE.md): os invariantes que nenhuma mudança pode quebrar e o fluxo de trabalho.
- [`.claude/agents/`](.claude/agents): dois subagentes da software factory.
  - `hospede-adversario` escreve casos de eval como um hóspede real ou mal-intencionado. Só edita
    `evals/casos-adversario.ts`, tira valores de `evals/cotar.ts` e não acessa rede nem `.env`.
  - `revisor-de-evals` lê as falhas, classifica (bug do agente, eval errado, lacuna de política) e propõe
    a correção mínima, sem alterar arquivos.
- `/code-review` antes de fechar cada etapa; os achados viraram commits `fix:`.
- [`docs/EVALS.md`](docs/EVALS.md): metodologia, resultados e o que cada rodada encontrou.
- [`docs/DECISOES.md`](docs/DECISOES.md): as lacunas do enunciado e o porquê de cada decisão.
- O histórico do git conta a ordem real: cada commit é pequeno e cita o achado que o motivou.

## Estrutura

```
src/
  app.ts, main.ts, server.ts   HTTP, configuração, entrada do Node
  agent/                       loop, prompt, ferramentas, verificador, estado da sessão
  domain/                      preço, datas, lead (sem I/O)
  infra/                       catálogo, sessões (Redis/memória), webhook
test/                          unitários com modelo, catálogo e webhook falsos
evals/                         casos, runner e cotar.ts
docs/                          DECISOES.md, EVALS.md
```

Licença MIT.
