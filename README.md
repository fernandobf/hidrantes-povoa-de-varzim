# Hidrantes — Póvoa de Varzim · PWA v2

Versão preparada para publicar diretamente em:

`https://fernandobf.github.io/hidrantes-povoa-de-varzim/`

Os ficheiros `index.html`, `app.js`, `styles.css`, `sw.js` e `manifest.webmanifest` estão na raiz do projeto, por isso funcionam corretamente quando o repositório é publicado pelo GitHub Pages num subdiretório.

## Principais alterações da v2

- Marcadores do mapa substituídos por **hidrantes vermelhos clássicos**.
- Ícones da interface uniformizados no mesmo estilo visual (traço simples/round).
- Botão de localização usa **pin**; quando a permissão está bloqueada apresenta o pin cortado.
- Botão antigo de “mostrar todos” passou a **olho / olho cortado** e agora mostra/oculta realmente os hidrantes.
- Botão de offline usa **Wi-Fi / Wi-Fi off** conforme o estado da ligação.
- Controlos `+`/`−` do Leaflet foram deslocados para a direita, abaixo dos botões rápidos, evitando sobreposição com o painel de pesquisa.
- A pesquisa deixou de esconder hidrantes por texto.
  - Se for introduzido um **ID exato**, o hidrante é localizado.
  - Se forem introduzidas **coordenadas**, esse ponto passa a ser a referência da ocorrência.
  - Se for introduzido um **endereço/local**, a app geocodifica a área da Póvoa de Varzim, marca o ponto da ocorrência e recalcula o hidrante mais próximo.
- O hidrante mais próximo mantém o ícone vermelho; o destaque é feito por **anel/halo**, sem mudar a semântica da cor.
- Botão **Navegar** inclui ícone de ligação externa e abre o Google Maps.
- Estados operacionais são normalizados antes de filtrar.
- Quando a fonte não contém qualquer estado operacional, as opções `Operacional` e `Não operacional` ficam desativadas e é apresentada uma nota explicativa, em vez de parecer que o filtro está avariado.
- A base é considerada atual durante **7 dias**. A app não faz atualizações automáticas mais frequentes.
- Foi adicionada uma **GitHub Action semanal** que atualiza `data/hydrants-seed.json` diretamente a partir do SIG municipal.

## Atualização automática semanal no GitHub

O workflow encontra-se em:

`.github/workflows/update-hydrants.yml`

Executa à segunda-feira, às 04:17 UTC, e também pode ser executado manualmente em **Actions > Atualizar hidrantes do SIG > Run workflow**.

Para permitir que a Action grave o JSON atualizado no repositório, confirme em:

**Settings > Actions > General > Workflow permissions > Read and write permissions**

Se o repositório tiver regras de proteção do ramo que impeçam `git push` por Actions, será necessário permitir essa escrita ou adaptar o workflow para Pull Request.

## Fonte

Camada oficial de hidrantes do SIG da Câmara Municipal da Póvoa de Varzim:

`Inter_Intra/TEMATICOS_Infraestruturas_RedeAguas/MapServer/218`

A atualização pede `outFields=*`, geometria e `outSR=4326`.

## Estados operacionais

Na base inicial incluída nesta v2, os 589 registos têm `EstadoOperacional` vazio. Por isso a interface mostra `Operacional (0)` e `Não operacional (0)` desativados, e `Estado não informado (589)`. Isso reflete a fonte atual; não é inferido a partir de outros campos como `EstadoConservacao` ou `Enabled`.

Se futuramente o SIG passar a preencher `EstadoOperacional`, a app normaliza automaticamente valores equivalentes e ativa os filtros correspondentes.

## Offline

A PWA guarda a aplicação e a última lista de hidrantes em IndexedDB/cache. O GPS do dispositivo continua a funcionar sem dados móveis.

O fundo cartográfico OpenStreetMap **não é descarregado em massa** nesta versão. Para navegação rodoviária sem rede, o utilizador pode descarregar previamente a área da Póvoa de Varzim no Google Maps. Esse download não torna o fundo desta PWA offline; serve a navegação dentro do próprio Google Maps.

## Testar localmente

Não abra `index.html` via `file://`. Na raiz da pasta:

```bash
python -m http.server 8080
```

Depois aceda a:

`http://localhost:8080`

## Publicar no GitHub Pages

1. Extraia o ZIP.
2. Envie **o conteúdo da pasta** para a raiz do repositório `hidrantes-povoa-de-varzim`.
3. Em **Settings > Pages**, escolha `Deploy from a branch`, ramo `main`, pasta `/ (root)`.
4. Aguarde a publicação e abra:

`https://fernandobf.github.io/hidrantes-povoa-de-varzim/`
