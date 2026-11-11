// Verificador da resposta, depois do modelo e antes do hóspede. Todo valor em reais que aparece no
// texto precisa ter vindo do catálogo ou de uma cotação nesta conversa, e estar no formato
// "R$ 1.234,56". É a rede de segurança para o caso em que o modelo some, arredonda ou repete um
// valor que o hóspede inventou.

export interface Achado {
  trecho: string;
  problema: 'fora_do_formato' | 'valor_nao_cotado';
}

// "R$" seguido de um número nos formatos que um modelo costuma escrever: 2156, 2.156, 2156,00, 2,156.00.
// O grupo captura o número para conferência.
const DINHEIRO = /R\$\s*(\d[\d.,]*\d|\d)/g;
const FORMATO = /^R\$ \d{1,3}(\.\d{3})*,\d{2}$/;

/** Converte o número escrito num valor em centavos, se der para interpretar sem ambiguidade. */
function paraCentavos(numero: string): number | null {
  const n = numero.replace(/\s/g, '');
  // pt-BR: 2.156,00 / 2156,00 / 2156,5
  let m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(n);
  if (m) return Number(m[1]!.replace(/\./g, '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  // en-US: 2,156.00 / 2156.00
  m = /^(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})$/.exec(n);
  if (m) return Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2]);
  return null;
}

export function verificarValores(texto: string, legitimos: readonly number[]): Achado[] {
  const achados: Achado[] = [];
  for (const m of texto.matchAll(DINHEIRO)) {
    const trecho = m[0].trimEnd();
    // o padrão pode engolir pontuação do fim da frase ("R$ 2.156,00.")
    const limpo = trecho.replace(/[.,\s]+$/, '');
    const centavos = paraCentavos(limpo.slice(2));
    if (centavos === null || !legitimos.includes(centavos)) {
      achados.push({ trecho: limpo, problema: 'valor_nao_cotado' });
    } else if (!FORMATO.test(limpo)) {
      achados.push({ trecho: limpo, problema: 'fora_do_formato' });
    }
  }
  return achados;
}

export function instrucaoCorrecao(achados: Achado[]): string {
  const itens = achados.map((a) =>
    a.problema === 'fora_do_formato'
      ? `"${a.trecho}" está fora do formato: escreva como R$ 1.234,56.`
      : `"${a.trecho}" não veio de uma cotação nem do catálogo nesta conversa.`,
  );
  const naoCotado = achados.some((a) => a.problema === 'valor_nao_cotado');
  return (
    'Sua última resposta não foi enviada ao hóspede. ' +
    itens.join(' ') +
    ' Reescreva a resposta usando só valores devolvidos pelas ferramentas (chame cotar ou ver_imovel se ' +
    'precisar), sem calcular nada por conta própria.' +
    (naoCotado ? ' Não repita valores citados pelo hóspede, nem para negá-los: diga apenas o valor correto.' : '')
  );
}
