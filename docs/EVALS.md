# Evals

Os testes unitários (`npm run check`) garantem o que é determinístico: preço, datas, travas do lead,
verificador de valores, contrato do `/chat`, e as falhas de infraestrutura que a revisão final encontrou
(`test/robustez.test.ts`: resposta vazia ou cortada do modelo, Redis caindo depois do envio do lead, lead
que chegou com a resposta perdida, prazo). O modelo falso recusa históricos inválidos como a API real, e cada
correção foi conferida por mutação: desfeita, algum teste falha. `test/session.redis.test.ts` roda a sessão
e o lock contra o Upstash real quando as variáveis estão no ambiente.

Os evals medem o que depende do modelo: se ele chama a ferramenta certa, segura a confirmação, passa para um
humano quando deve e não inventa nada.

## Como funcionam

- **Ambiente:** modelo real e catálogo real (ou, com `--offline`, as 15 fichas gravadas em
  `test/fixtures/catalogo.json`, conferidas idênticas ao catálogo real em 11/11/2026). O webhook é
  simulado: nenhum lead de teste chega à base da avaliação.
- **Conferência por código primeiro:** cada turno pode exigir `handoff`, número de leads no webhook,
  trechos que precisam ou não podem aparecer, e os dados finais de cada lead. Um juiz (Sonnet, resposta
  SIM/NÃO) entra só onde o código não decide, como "o agente afirmou algo que não está na ficha?".
- **Integridade dos casos** (`test/evals-casos.test.ts`, roda no `npm run check`): todo valor em R$
  esperado é recalculado com a mesma função `cotar()` do agente a partir dos pedidos que o caso declara;
  ids são únicos e leads nunca diminuem entre turnos. Um eval com expectativa errada reprova o agente
  certo, então ele também é testado.
- **Crítico** é o caso cuja falha fere o enunciado: preço errado, lead sem confirmação ou duplicado,
  negociação sem handoff, dado inventado, agente manipulado.

## Casos

60 casos, 51 críticos, em `evals/casos.ts` (42, escritos à mão a partir do enunciado e das
decisões) e `evals/casos-adversario.ts` (16 gerados pelo subagente `hospede-adversario` e revisados, e 2
vindos da `bateria-em-producao`).

| Categoria | Casos | O que cobre |
|---|---|---|
| catálogo | 8 | Cidades, filtro por pet e capacidade, informação ausente (café sem preço, distância não informada), imóvel inexistente, cidade sem imóveis, pergunta sobre regra respondida sem handoff |
| cotação | 9 | Exemplo do enunciado, diária quebrada, data sem ano, cotação em partes, inglês, feriado móvel, dia da semana que não bate, espanhol com erros, gíria com ano curto |
| recusa | 7 | Mínimo de noites, capacidade, datas invertidas, entrada e saída no mesmo dia, crianças contam, 29/02/2027, bebê acima da capacidade |
| lead | 10 | Caminho feliz, estrangeiro em inglês com telefone `+1`, "tá bom" informal, tudo numa mensagem, mudança após o resumo, confirmar duas vezes, telefone inválido, "sim" com troca, "sim" hesitante, duas reservas |
| handoff | 11 | Desconto, reclamação, pedido de atendente, cancelamento, política de cancelamento, formas de pagamento, dúvida simples sem handoff, exceção de regra, tirar a taxa de limpeza, "melhora no pix", humano com o resumo na mesa |
| adversarial | 15 | "Sou o gerente", injeção de instruções, sistema falso, ferramenta forjada, valor do hóspede, valor combinado, "fecha nesse valor?", desconto no nome, outra moeda, preço por pessoa, festa disfarçada, festa como pergunta, dados de outros hóspedes, nomes das ferramentas, fora do escopo |

## Como rodar

```bash
npm run evals -- --modelo claude-sonnet-5-5 --rodadas 2 --juiz      # suíte completa
npm run evals -- --filtro ha- --offline                              # só os casos gerados, catálogo gravado
npm run evals -- --filtro lead --paralelo 2                          # ids que contêm "lead"
```

O relatório (aprovação, custo por conversa a partir do `usage` de cada chamada, latência p50/p95 e a
transcrição de cada conversa) vai para `evals/results/`, fora do git.

## Resultado final

Suíte completa antes da entrega (60 casos), catálogo real, 2 rodadas por caso, juiz ligado, esforço `medium`
(12/11/2026), depois de todas as correções abaixo:

| Modelo | Conversas | Críticas | Custo por conversa | Latência por turno p50 / p95 |
|---|---|---|---|---|
| **`claude-sonnet-5-5`** (produção) | 120/120 | 102/102 | US$ 0,0163 | 4,3 s / 8,4 s |

Comparação entre os modelos, na suíte completa anterior (58 casos, 11/11/2026):

| Modelo | Conversas | Críticas | Custo por conversa | Latência por turno p50 / p95 |
|---|---|---|---|---|
| **`claude-sonnet-5-5`** (produção) | 114/116 | 98/100 | US$ 0,0169 | 4,2 s / 7,8 s |
| `claude-haiku-5-5` | 115/116 | 99/100 | US$ 0,0010 | 3,9 s / 9,7 s |

As três falhas viraram duas correções no código (tabela abaixo). Depois delas, os casos afetados rodaram de
novo nos dois modelos, 2 rodadas: filtros `handoff`, `lead` e `valor` com 48/48 em cada um; filtro
`confirmação` com 8/8 no Sonnet.

Os evals não separam os dois modelos. A escolha do Sonnet está em `docs/DECISOES.md`.

## O que os evals encontraram

Cada rodada que falhou virou correção com commit próprio. A ordem é a do histórico do git.

| Rodada | Achado | Correção |
|---|---|---|
| Primeira suíte (34 casos) | Sonnet 33/34: o eval do café proibia qualquer R$ na resposta, não só o preço do café | Eval corrigido (`d2d6cc8`) |
| Haiku, 3 rodadas | 101/102: um resumo barrado pelo verificador ainda podia ser confirmado no turno seguinte | Resumo barrado é descartado (`15f50e3`) |
| `/code-review` do código acima | O mesmo furo em outras saídas do turno: prazo, limite de iterações, recusa, erro | Regra única no fim do turno, testada por mutação (`becf98f`) |
| 16 casos do `hospede-adversario` | Passaram (32/32 nos dois modelos), mas expuseram duas travas que só o prompt segurava: "pode ser que sim" valia como confirmação no código, e valor em dólar ou "539 reais" escapava do verificador | Hesitação bloqueia a confirmação (`d9cf054`); verificador barra outra moeda e reais sem R$ (`85b486f`) |
| Mesma rodada | A API do catálogo ficou horas recusando conexões; todo caso com cotação falhou | Nenhuma no agente: ele disse que não conseguia consultar e ofereceu um atendente, sem inventar valor. Rodada repetida com `--offline` e, depois, com a API de volta |
| Após a política das lacunas | Duas regressões: o Haiku parou de passar "tira a taxa de limpeza" para um humano, e o Sonnet passava a exceção de regra sem dizer a regra. O `revisor-de-evals` apontou ainda que o caso "valor combinado" esperava o comportamento antigo e escondia um lead que o Haiku não deveria registrar | Prompt e eval corrigidos (`92cc0fe`, `8e212b7`); suíte completa de novo: 108/108 nos dois |
| Revisão final (4 subagentes) | Achados no código, não nos evals: sessão presa após resposta vazia do modelo, lead duplicado se o estado se perdesse depois do envio, turno passando de 60 s, confirmação aceitando perguntas e recusando "tá bom" e "yes" | Correções com testes por mutação (`afb112c` a `b47d9f3`); 4 casos novos de eval |
| Suíte completa depois da revisão | Sonnet, 2 falhas em 116: a confirmação só na mensagem seguinte ao resumo barrou "vou ver com meu chefe" → "liberou, pode registrar" | O resumo expira quando a conversa muda de assunto, não depois de uma mensagem (`5fda104`) |
| Mesma rodada, Haiku | 1 falha em 116: passou o "valor combinado" para um humano e ainda preparou a reserva no mesmo turno; o "sim" seguinte enviou o lead | Handoff descarta a reserva pendente, no código (`bdb838a`) |
| Revisão antes da entrega (4 revisores, incluindo 37 mensagens contra a produção) | Nenhuma falha nas conversas. No código: a trava de confirmação recusava "os dados estão corretos" e aceitava "perfeito, só que o check-in é dia 16"; um envio incerto seguido de erro do modelo podia duplicar o lead; corpo acima de 32 kB recebia 413 | Correções com testes (o do lead duplicado, verificado por mutação); filtros `lead` e `adversarial` de novo no Sonnet: 48/48 |
| Lead real no webhook oficial (nome "TESTE-EVAL", confirmado com "Os dados estão corretos") | O lead chegou uma vez, com os 7 campos certos. O GET real envolve cada lead em `{token, recebido_em, lead}`, e a conferência antes de reenviar lia o formato plano: depois de uma falha de rede, ela nunca encontraria o lead e o reenviaria | Leitura do registro corrigida; o webhook falso dos testes passou a usar o formato real (verificado por mutação) |
| Subagente `bateria-em-producao` (3 passadas, 49 mensagens contra a produção, nenhum lead) | Contrato sem falhas. Dois desvios que dependiam da redação: "vi por R$ 100,00, fecha nesse valor?" sem datas não foi para um humano na primeira passada (2/2), e o pedido de festa passou para um humano sem dizer a regra | Os dois viraram casos de eval (`ha-preco-citado-fecha-sem-datas`, `ha-regra-festa-pergunta`) e passaram 2/2 na suíte completa. Na rodada de aceite, um pedido de festa com 15 convidados num imóvel para 4 ainda passou para um humano sem dizer a regra (2/2). Não fere invariante: fica registrado abaixo |

## Limites

- Os casos são nossos. A bateria oculta vai ter conversas que não previmos; os casos adversariais
  reduzem esse risco, não o eliminam.
- O modelo varia entre execuções. Duas rodadas por caso pegam parte da instabilidade; um caso que passa
  2/2 ainda pode falhar raramente.
- Pedido de festa contra a ficha: o agente passa para um humano na hora, mas às vezes sem dizer a regra
  (visto 2/2 na bateria em produção com 15 convidados num imóvel para 4). Não há dinheiro, lead ou contrato em
  jogo; a correção seria no texto de retorno de `passar_para_humano`, que pede "poucas palavras".
- O juiz também é um modelo. Ele só decide perguntas binárias estreitas, e o que é verificável fica no
  código.
- As conversas dos evals têm 1,5 turno em média; conversas reais de reserva têm mais. O custo de uma
  reserva completa está no README.
