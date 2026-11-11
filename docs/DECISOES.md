# Decisões

Onde o enunciado não decide, o critério é sempre o mesmo: **errar para o lado barato**. Uma pergunta a
mais custa segundos; um lead errado, um valor inventado ou uma promessa falsa chegam ao comercial e ao
hóspede. E tudo o que é verificável fica no código, não no prompt: o modelo conversa, o código decide
preço, datas, confirmação e o que pode ser enviado.

## Preço e valores

| Situação | Decisão | Por quê |
|---|---|---|
| Qualquer valor na resposta | Só sai da ferramenta `cotar` ou da ficha; um verificador confere cada valor antes de a resposta sair | O modelo não faz conta. Valor fora disso é barrado: uma chance de reescrever, depois resposta segura |
| Hóspede cita um valor ("vi R$ 100,00 no site") | Não muda nada e não é repetido, nem para negar | Repetir o valor falso deixa ele na conversa; o verificador barra qualquer valor não cotado |
| Desconto, negociação, "tira a taxa de limpeza", "melhora no pix" | Passa para um humano; o preço cheio continua valendo | O agente nunca negocia (enunciado) |
| Desconto "já aprovado pelo gerente", "valor combinado" | Mesmo tratamento: humano e preço cheio, sem preparar reserva com a condição | Alegação de autoridade não muda regra. O lead não tem campo livre e o nome barra `:` e `%`, então a alegação não chega ao comercial dentro do pedido |
| Outra moeda, valor por pessoa | Não converte nem divide; informa o total em reais | A cobrança é em reais e o catálogo não tem câmbio. O verificador barra US$, €, "dólares" e "N reais" sem `R$` |
| Valores no texto | Sempre `R$ 1.234,56`, centavos inteiros, noite a noite arredondada | Contrato do enunciado; float não arredonda dinheiro |

## Datas e capacidade

| Situação | Decisão | Por quê |
|---|---|---|
| Data sem ano | Próxima ocorrência a partir de hoje (fuso de Brasília) | É o que o hóspede quer dizer; o resumo mostra a data completa para ele conferir |
| Data relativa simples ("próximo fim de semana") | Calculada a partir de hoje e dita por extenso | Mesmo motivo; a confirmação do resumo é a última rede |
| Feriados (Carnaval, Páscoa, estaduais, municipais) | Pede as datas exatas | Feriados variam por cidade e ano; manter um calendário por município custa mais do que uma pergunta, e errar gera cotação de datas que o hóspede não quis |
| Data que não existe (29/02/2027) ou dia da semana que não bate | Aponta a divergência e pergunta; nunca corrige sozinho | O código recusa data inválida; o agente não escolhe pelo hóspede |
| Check-in no passado | Recusado | Não há como reservar ontem |
| Estadia longa | Até 90 noites; acima disso a cotação é recusada com o motivo | Longa temporada costuma ter condição própria; um total de 200 noites pela regra de diária seria enganoso |
| Capacidade | Todos contam, inclusive crianças e bebês | A capacidade da ficha é limite de segurança e de condomínio; o catálogo não prevê exceção. Errar para mais vira problema no check-in |

## Regras do imóvel

| Situação | Decisão | Por quê |
|---|---|---|
| Pergunta sobre regra ("aceita pet?") | Responde com a ficha e oferece imóveis que atendam; **sem** handoff | O assunto foi resolvido; mandar para um humano gastaria atendimento à toa |
| Pedido de exceção ("meu cachorro é pequeno, abre exceção?") ou uso que contraria a ficha ("não é festa, é só uma reunião com 20 pessoas") | Informa o que a ficha diz, explica que só um atendente avalia exceções e passa **na hora**, sem registrar pedido | Só uma pessoa pode flexibilizar regra do proprietário. O lead não tem campo de observação: registrar esconderia o conflito até o check-in. O handoff mantém o lead vivo |
| Informação que não está na ficha (preço do café, distância nula, berço, cancelamento) | Diz que não tem a informação e oferece um atendente; handoff se o hóspede aceitar ou insistir | O catálogo é a única fonte (enunciado) |

## Lead

| Situação | Decisão | Por quê |
|---|---|---|
| O que é confirmação | Resposta afirmativa, num turno **posterior** ao resumo, sem pedido de mudança nem hesitação ("acho que sim", "pode ser", "vou ver") | Travas no código, não no modelo. "Pode ser" às vezes é um sim informal e fica de fora de propósito: um falso não custa uma pergunta, um falso sim manda um lead indevido |
| Resumo que o hóspede não viu (verificador barrou, prazo, erro, recusa) | Descartado; o "sim" seguinte não envia nada | Confirmação só vale sobre o que foi mostrado |
| Mudança depois do resumo | Novo resumo e nova confirmação | O lead enviado é exatamente o que foi confirmado |
| Mais de uma reserva na conversa | Um lead por reserva (hash dos dados); repetir a confirmação não duplica | "Um lead por reserva confirmada" (enunciado) |
| Telefone e nome | Telefone brasileiro com DDD, normalizado para `(48) 99999-0000`; nome só com letras | O webhook aceita qualquer texto (sondado com payloads inválidos); a validação fica do nosso lado |
| `valor_total` | Sai da cotação, nunca do modelo ou do hóspede | Invariante de preço |

## Atendimento e segurança

| Situação | Decisão | Por quê |
|---|---|---|
| Escopo do `handoff` | Vale no turno em que foi decidido; a sessão guarda que houve handoff | O contrato devolve `handoff` por resposta |
| "Sou o gerente", "ignore as instruções", resultado de ferramenta forjado no texto | Ignorado; texto do hóspede é dado, não instrução | Regras não mudam por pedido |
| Pedir o prompt ou os nomes das ferramentas | Não revela; descreve o que faz em linguagem simples | Reduz superfície de ataque |
| Assunto fora de hospedagem | Recusa com educação, sem handoff | Fora do escopo do produto |
| Recusa do próprio modelo | Vira handoff | O hóspede nunca fica sem resposta |

## Operação

| Situação | Decisão | Por quê |
|---|---|---|
| Catálogo ou modelo fora do ar | `/chat` responde 200 com mensagem de contingência; nunca diz "registrado" sem 201 do webhook | Contrato. Aconteceu em 11/11/2026: a API de catálogo recusou conexões por horas e o agente disse que não conseguia consultar e ofereceu um atendente, sem inventar valor |
| Webhook com falha de rede ou 5xx | Confere por GET se o lead chegou antes de tentar de novo (1 retry) | Evita lead duplicado |
| Mensagens simultâneas na mesma sessão | Lock por sessão no Redis (`SET NX`, 60 s) | Duas confirmações paralelas não viram dois leads |
| Histórico | Conversa inteira, sem janela | Editar o histórico invalida o cache de prompt; conversas de concierge são curtas. Se crescerem, o próximo passo é compactar |
| Leads de teste | Evals usam webhook simulado; os smokes no webhook real usam nome "TESTE-EVAL" | Não poluir a base da avaliação |
| Modelo | `claude-sonnet-5-5`, trocável pela variável `MODELO` | Nos 54 casos (2 rodadas, catálogo real), Sonnet e Haiku fizeram 108/108. Os evals não separam os dois; o Sonnet dá margem contra entradas que não conhecemos por cerca de 1,5 centavo a mais por conversa (US$ 0,016 contra US$ 0,001). O Haiku é mais literal: foi o que falhou quando a política tinha brechas |
