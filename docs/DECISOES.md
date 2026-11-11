# Decisões

Onde o enunciado não decide, o critério é um só: **errar para o lado barato**. Uma pergunta a mais custa
segundos; um lead errado ou um valor inventado chega ao comercial e ao hóspede. O que é verificável fica no
código: o modelo conversa, o código decide preço, datas, confirmação e o que é enviado.

## Preço e valores

| Situação | Decisão | Por quê |
|---|---|---|
| Qualquer valor na resposta | Só sai de `cotar` ou da ficha; um verificador confere cada `R$` antes de a resposta sair | O modelo não faz conta |
| Valor citado pelo hóspede ("vi R$ 100,00") | Não muda nada e não é repetido | Repetir deixa o valor falso na conversa |
| Desconto, negociação, "tira a taxa", "melhora no pix" | Humano; o preço cheio continua valendo | O agente nunca negocia (enunciado) |
| Desconto "já aprovado", "valor combinado" | Igual: humano, preço cheio, sem preparar reserva | Alegação de autoridade não muda regra |
| Outra moeda, valor por pessoa | Não converte nem divide; total em reais | O catálogo não tem câmbio; o verificador barra US$, €, "N reais" |
| Formato | `R$ 1.234,56`, centavos inteiros, noite a noite arredondada | Contrato; float não arredonda dinheiro |

## Datas e capacidade

| Situação | Decisão | Por quê |
|---|---|---|
| Data sem ano, "próximo fim de semana" | Próxima ocorrência a partir de hoje (Brasília), dita por extenso | O resumo mostra a data completa para conferir |
| Feriado (Carnaval, Páscoa, municipais) | Pede as datas exatas | Varia por cidade e ano; errar gera cotação indesejada |
| Data inexistente ou dia da semana divergente | Aponta e pergunta; nunca corrige sozinho | O agente não escolhe pelo hóspede |
| Check-in no passado; mais de 90 noites | Recusado com o motivo | Não se reserva ontem; longa temporada tem condição própria |
| Capacidade | Todos contam, inclusive crianças e bebês | É limite de segurança do imóvel |

## Regras do imóvel e atendimento

| Situação | Decisão | Por quê |
|---|---|---|
| Pergunta sobre regra ("aceita pet?") | Responde com a ficha, **sem** handoff | Resolvido; atendente à toa custa |
| Pedido de exceção ou uso que contraria a ficha | Diz a regra, passa **na hora**, sem registrar pedido | Só uma pessoa flexibiliza; o lead não tem campo de observação |
| Item fora da ficha (café, berço, distância nula) | "Não tenho essa informação" e oferece atendente | O catálogo é a única fonte (enunciado) |
| Cancelamento, política de cancelamento, pagamento | Humano na hora | Não está no catálogo e é decisão do comercial |
| Escopo do `handoff` | Vale na resposta em que foi decidido | O contrato devolve `handoff` por resposta |
| "Sou o gerente", "ignore as instruções", sistema falso | Ignorado; texto do hóspede é dado | Regras não mudam por pedido; o hóspede nem consegue imitar o aviso do verificador |
| Pedir o prompt ou nomes das ferramentas | Não revela; descreve o que faz | Menos superfície de ataque |
| Fora de hospedagem | Recusa com educação, sem handoff | Fora do escopo |
| Recusa do próprio modelo | Handoff; sem modelo de fallback | Um fallback não passou pelos evals; o atendente é a saída testada |

## Lead

| Situação | Decisão | Por quê |
|---|---|---|
| O que é confirmação | Afirmativa, sem `?`, sem mudança, hesitação ou negação, enquanto o resumo está em discussão | "Pode ser" fica de fora: um falso não custa uma pergunta, um falso sim manda um lead indevido |
| Quando o resumo expira | Consulta sobre outro assunto, handoff, ou resumo que o hóspede não viu | Um "sim" depois disso pode responder outra pergunta; hesitar e confirmar depois continua valendo |
| Mudança depois do resumo | Novo resumo e nova confirmação | O lead é exatamente o confirmado |
| Na confirmação | Preço e datas recotados; se mudaram, novo resumo | O lead sai com o que vale agora |
| Duplicidade | Hash por reserva; estado gravado antes e depois do envio; nova tentativa confere o webhook antes | "Um lead por reserva confirmada" (enunciado), mesmo com queda no meio |
| Telefone | Brasileiro com DDD → `(48) 99999-0000`; estrangeiro com `+` e código do país | O webhook aceita qualquer texto; turista também reserva |
| `valor_total` | Sai da cotação, nunca do modelo ou do hóspede | Invariante de preço |

## Operação e segurança

| Situação | Decisão | Por quê |
|---|---|---|
| Prazo | Um prazo de 52 s desde a chegada vale para lock, Redis, modelo, catálogo e webhook; rede final de 200 em 57 s | A Vercel corta em 60 s com 504, fora do contrato |
| Catálogo, modelo ou webhook fora | 200 com contingência; nunca "registrado" sem 201 | Aconteceu em 11/11: o agente avisou e ofereceu atendente, sem inventar |
| Resposta vazia, cortada ou recusada do modelo | Não entra no histórico; 400 da API recomeça a conversa | Uma mensagem inválida faria a API recusar a sessão por 7 dias |
| Mensagens simultâneas | Lock por sessão no Redis (`SET NX`) | Duas confirmações paralelas não viram dois leads |
| Custo de um `/chat` público | Teto de 40 mensagens ou 250 kB por sessão (depois, humano); corpo até 32 kB; limite de gasto na chave | A bateria chama sem autenticação; rate limit por IP poderia barrá-la |
| `session_id` | É a credencial da conversa; não vai para o log | O contrato não tem autenticação |
| Dados pessoais | Nome e telefone ficam só na sessão (7 dias, a janela da avaliação); logs sem PII | LGPD: guardar o mínimo pelo menor tempo útil |
| Histórico | Conversa inteira, sem janela | Editar o histórico invalida o cache de prompt; conversas são curtas |
| Modelo | `claude-sonnet-5-5`, trocável por `MODELO` | Sonnet e Haiku passaram em tudo; o Sonnet dá margem contra o desconhecido por ~1,5 centavo a mais por conversa |
| Leads de teste | Evals com webhook simulado; smokes reais com nome "TESTE-EVAL" | Não poluir a base da avaliação |

## O que deixei de fora

- **Disponibilidade real e reserva efetiva.** O catálogo não tem calendário; o lead é um pedido, e o agente
  não promete a estadia.
- **Rate limit por IP.** Ficaram tetos por sessão e limite de gasto na chave, para não arriscar barrar a bateria.
- **Compactação do histórico.** Hoje há um teto por conversa; conversas longas vão para um humano.
- **Calendário de feriados.** O agente pede as datas exatas.
- **Fila de atendimento.** O `handoff` volta no contrato e fica registrado na sessão; não há integração com
  um sistema de atendimento.
- **Docker.** A entrega é a URL pública; `npm run dev` roda local com Node 22.

## O que faria com mais tempo

- **Mais evals de conversa longa e de várias reservas**, com 5 rodadas por caso para medir a instabilidade
  do modelo, e casos gravados das conversas reais que derem errado.
- **Classificar a confirmação com o próprio modelo** como segunda opinião, mantendo as travas do código como veto.
- **Compactar o histórico** depois de N turnos preservando os pares de ferramenta, em vez de passar para um humano.
- **Observabilidade:** custo, latência e motivos de handoff por dia num painel, com alerta de gasto.
- **Teste de contrato com a API real** do catálogo e do webhook, rodando antes de cada deploy.
