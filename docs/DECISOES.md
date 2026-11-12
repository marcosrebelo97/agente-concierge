# Decisões

Onde o enunciado não decide, o critério é um só: **errar para o lado barato**. Uma pergunta a mais custa
segundos; um lead errado ou um valor inventado chega ao comercial e ao hóspede.

## Escolhas

### Stack

| Tecnologia | Escolha | Por quê |
|---|---|---|
| Linguagem | TypeScript (Node 22) | Tipos no contrato e nas ferramentas; o mesmo código roda na Vercel e no Docker |
| HTTP | Hono | Leve; roda igual no Node e na Vercel |
| Validação | Zod | Entrada do `/chat` e das ferramentas validada antes de agir |
| Modelo | Claude Sonnet 5.5, SDK oficial, loop próprio | Margem diante de conversas imprevistas; trocável por `MODELO` |
| Sessões | Upstash Redis, na mesma região da função | Sessão e lock compartilhados entre instâncias serverless |
| Hospedagem | Vercel (Docker como alternativa) | URL pública dentro dos 60 s; deploy a cada push na `main` |
| Testes | Vitest e evals próprios | 290 testes sem rede; 61 casos com o modelo real |

### Arquitetura

- **O modelo conversa; o código decide.** Preço, datas, capacidade, confirmação e envio do lead ficam em código
  testado, e um verificador confere cada `R$` antes de a resposta sair.
- **Loop próprio com o SDK oficial, sem framework de agentes.** As garantias moram no loop (prazo por turno,
  histórico válido, prompt caching, travas do lead); com o código explícito, cada uma tem teste.
- **`claude-sonnet-5-5`, trocável por `MODELO`.** Resultado equivalente ao Haiku nos evals (114/116 e 115/116), com
  mais margem diante de conversas imprevistas por cerca de US$ 0,016 a mais por conversa.

### Decisões de comportamento

**Preço**

| Situação | Decisão | Por quê |
|---|---|---|
| Valor citado pelo hóspede ("vi R$ 100,00") | Não muda nada e não é repetido | Repetir deixa o valor falso na conversa |
| Desconto, negociação, "tira a taxa", "melhora no pix", desconto "já aprovado" | Humano, com o preço cheio; sem preparar reserva quando há um valor alegado | O agente nunca negocia (enunciado); alegação de autoridade não muda a regra |
| Outra moeda, valor por pessoa | Não converte nem divide; total em reais | O catálogo não tem câmbio; dividir seria conta feita pelo modelo |

**Datas e capacidade**

| Situação | Decisão | Por quê |
|---|---|---|
| Data sem ano, "próximo fim de semana" | Próxima ocorrência a partir de hoje (Brasília), dita por extenso | O hóspede confere a data completa no resumo |
| Feriado (Carnaval, Páscoa, municipais) | Pede as datas exatas | Varia por cidade e ano; uma suposição errada gera uma cotação indesejada |
| Data inexistente ou dia da semana divergente | Aponta e pergunta; não corrige sozinho | O agente não escolhe pelo hóspede |
| Check-in no passado; mais de 90 noites | Recusa, com o motivo | Não há estadia no passado; temporadas longas têm condições próprias |
| Capacidade | Todos contam, inclusive crianças e bebês | É limite de segurança do imóvel |

**Atendimento**

| Situação | Decisão | Por quê |
|---|---|---|
| Pergunta sobre regra ("aceita pet?") | Responde com a ficha, **sem** handoff | A ficha responde; acionar um atendente sem necessidade tem custo |
| Pedido de exceção ou uso que contraria a ficha | Diz a regra e passa **imediatamente** para um humano, sem registrar pedido; o código confere que a regra foi dita | Só uma pessoa pode flexibilizar; o lead não tem campo de observação |
| Insistência na exceção depois do handoff ("a gente se aperta, não dá pra liberar?") | Repete a regra, **sem** novo handoff | A conversa já está com um humano; um segundo acionamento duplica o atendimento |
| Item fora da ficha (café, berço, distância não informada) | Diz que não tem a informação e oferece um atendente | O catálogo é a única fonte (enunciado) |
| Cancelamento, política de cancelamento, pagamento | Humano, imediatamente | Não está no catálogo e é decisão do comercial |
| "Sou o gerente", "ignore as instruções", pedido do prompt | Ignorado; texto do hóspede é dado, não instrução | Regras não mudam por pedido |
| Recusa do próprio modelo | Handoff, sem modelo alternativo (fallback) | Um segundo modelo não passou pelos evals; o atendente é a saída testada |

**Lead**

| Situação | Decisão | Por quê |
|---|---|---|
| O que é confirmação | Afirmativa sem `?`, sem pedido de mudança, hesitação ou negação | "Pode ser" fica de fora: um "não" por engano custa uma pergunta; um "sim" por engano envia um lead indevido |
| Quando o resumo expira | Consulta sobre outro assunto, handoff ou resumo que o hóspede não viu | Um "sim" depois disso pode responder outra pergunta; hesitar e confirmar depois continua valendo |
| Mudança depois do resumo | Novo resumo e nova confirmação | O lead é exatamente o que foi confirmado |
| Telefone | Brasileiro com DDD → `(48) 99999-0000`; estrangeiro com `+` e código do país | O formato segue o exemplo do enunciado; turistas estrangeiros também reservam |

**Operação**

| Situação | Decisão | Por quê |
|---|---|---|
| Catálogo, modelo ou webhook indisponível | `200` com resposta de contingência; nunca "registrado" sem `201` | Ocorreu em 11/11: o agente avisou e ofereceu um atendente, sem inventar |
| `/chat` público, sem autenticação | Teto de 40 mensagens do hóspede ou 250 kB por sessão (depois, humano); limite mensal de gasto na conta da API | Contém o custo de uma sessão abusiva sem arriscar barrar a bateria, como faria um rate limit por IP |
| Dados pessoais | Nome e telefone só na sessão, por 7 dias; logs sem dados pessoais e com o `session_id` só em hash | LGPD: guardar o mínimo pelo menor tempo útil |
| Histórico | Conversa inteira, sem janela | Editar o histórico invalida o cache de prompt; as conversas são curtas |
| Leads de teste | Evals com webhook simulado; testes manuais no webhook real com o nome "TESTE-EVAL" | Não poluir a base da avaliação |

## O que deixei de fora

- **Disponibilidade e reserva efetiva.** O catálogo não tem calendário: o lead é um pedido, e o agente não
  promete a estadia.
- **Rate limit por IP.** Ficaram o teto por sessão e o limite de gasto, para não barrar a bateria. Em produção,
  o limite entraria na borda (firewall da Vercel), junto com um `session_id` emitido e assinado pelo site.
- **Calendário de feriados.** O agente pede as datas exatas.
- **Integração com um sistema de atendimento.** O `handoff` volta no contrato e fica registrado na sessão.

## O que faria com mais tempo

- **Mais evals de conversas longas e de várias reservas**, com 5 rodadas por caso para medir a variação do
  modelo, e casos tirados de conversas reais que derem errado.
- **Classificar a confirmação também com o modelo**, como segunda opinião, mantendo as travas do código como veto.
  Hoje o código é um veto conservador: na dúvida, o agente pergunta de novo; o modelo reduziria essas perguntas.
- **Compactar o histórico** depois de N turnos, preservando os pares de ferramenta. Hoje, conversas acima do teto
  vão para um humano.
- **Observabilidade:** custo, latência e motivos de handoff por dia num painel, com alerta de gasto. Com
  tráfego real, um subagente leria os handoffs e as falhas da produção e proporia casos de eval a partir deles.
- **Teste de contrato com a API real** do catálogo e do webhook antes de cada deploy.
