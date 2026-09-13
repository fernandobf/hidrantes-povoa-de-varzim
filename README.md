# Hidrantes — Póvoa de Varzim · PWA v2.3

Versão preparada para publicar diretamente em:

`https://fernandobf.github.io/hidrantes-povoa-de-varzim/`

Os ficheiros principais estão na raiz do projeto e funcionam com GitHub Pages num subdiretório.

## O que mudou na v2.3

- `EstadoOperacional`, `CicloVida` e `EstadoConservacao` são tratados como conceitos independentes.
- A aplicação **nunca** deduz operacionalidade a partir de `CicloVida`, `EstadoConservacao` ou `Enabled`.
- O filtro de estado continua a usar **exclusivamente `EstadoOperacional`**:
  - Operacional
  - Não operacional
  - Estado não informado
- Nos detalhes de cada hidrante passam a aparecer, quando disponíveis:
  - Estado operacional
  - Ciclo de vida
  - Conservação
  - Data de entrada em serviço
  - Atualizado em
- `CicloVida = Servico` é apresentado como **Em serviço**, sem o transformar em “Operacional”.
- Datas ArcGIS em epoch/milisegundos são formatadas para data/hora de Portugal.
- Se a base local antiga ainda não tiver o campo `CicloVida`, a PWA tenta uma atualização direta do SIG mesmo que a última sincronização tenha menos de 7 dias.
- O script semanal valida a presença dos campos essenciais antes de substituir o JSON, reduzindo o risco de gravar uma base com esquema inesperado.
- O JSON gerado pela Action passa a incluir `schemaVersion`, `fieldsIncluded` e a data mais recente de atualização de registo encontrada no SIG.

## Importante: Estado operacional ≠ Ciclo de vida

Exemplo válido do próprio SIG:

- `CicloVida: "Servico"` → **Em serviço**
- `EstadoOperacional: null` → **Não informado**

Isto não é uma contradição. “Em serviço” indica a situação da infraestrutura no ciclo de vida da rede; não comprova que o hidrante esteja operacional no momento.

Por esse motivo, um hidrante com `CicloVida = Servico` e `EstadoOperacional = null` mantém o marcador vermelho normal e apresenta **Estado operacional: Não informado**.

## Atualização automática semanal no GitHub

O workflow encontra-se em:

`.github/workflows/update-hydrants.yml`

Executa à segunda-feira, às 04:17 UTC, e também pode ser executado manualmente em:

**Actions > Atualizar hidrantes do SIG > Run workflow**

Para permitir que a Action grave o JSON atualizado no repositório, confirme:

**Settings > Actions > General > Workflow permissions > Read and write permissions**

### Recomendação após publicar esta v2.3

A base inicial que veio das versões anteriores não continha todos os campos agora utilizados, sobretudo `CicloVida`. Depois de substituir os ficheiros no GitHub, execute **uma vez** o workflow manualmente. Assim `data/hydrants-seed.json` será recriado diretamente do SIG com `outFields=*` e os novos campos ficarão disponíveis também para quem abrir a PWA pela primeira vez.

A própria PWA também tenta atualizar diretamente o SIG quando deteta o esquema antigo, mas a Action semanal é a forma mais consistente de manter a base pública do repositório atualizada.

## Fonte

Camada oficial de hidrantes do SIG da Câmara Municipal da Póvoa de Varzim:

`Inter_Intra/TEMATICOS_Infraestruturas_RedeAguas/MapServer/218`

A consulta usa:

- `outFields=*`
- `returnGeometry=true`
- `outSR=4326`

## Offline

A PWA guarda a aplicação e a última lista de hidrantes em IndexedDB/cache. O GPS do dispositivo continua a funcionar sem dados móveis.

O fundo cartográfico OpenStreetMap não é descarregado em massa. Para navegação rodoviária sem rede, o utilizador pode descarregar previamente a área da Póvoa de Varzim no Google Maps; esse download serve o próprio Google Maps e não transfere o fundo cartográfico para esta PWA.

## Testar localmente

Não abra `index.html` via `file://`. Na raiz da pasta:

```bash
python -m http.server 8080
```

Depois abra:

`http://localhost:8080`

## Publicar no GitHub Pages

1. Extraia o ZIP.
2. Envie **o conteúdo da pasta** para a raiz do repositório `hidrantes-povoa-de-varzim`.
3. Em **Settings > Pages**, use `Deploy from a branch`, ramo `main`, pasta `/ (root)`.
4. Confirme as permissões de escrita das Actions.
5. Execute uma vez **Actions > Atualizar hidrantes do SIG > Run workflow**.
6. Aguarde a publicação e abra:

`https://fernandobf.github.io/hidrantes-povoa-de-varzim/`

## Nota operacional

O mapa é uma ferramenta de referência e pré-planeamento. Os dados SIG podem estar incompletos ou desatualizados e não garantem pressão, caudal, acessibilidade física ou operacionalidade real no local.


## Correções da v2.3

- `Última atualização do registo SIG` passou a **Atualizado em**.
- `Estado de conservação` passou a **Conservação**.
- Navegação do mapa corrigida: arrastar/pan, duplo clique para zoom, roda do rato, touch zoom, box zoom e teclado ficam explicitamente ativos.
- Removido o clique simples no mapa que definia automaticamente um ponto de ocorrência e podia contrariar pan/duplo clique. A pesquisa continua a definir o ponto de ocorrência.
- Halo do hidrante mais próximo corrigido para um círculo real de 42 × 42 px; o dourado do “mais próximo” tem precedência sobre o halo de seleção.
- Favicon do navegador agora usa PNG com transparência real (`favicon_hydrant_32.png` e `favicon_hydrant_64.png`).
