import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIG_QUERY = 'https://sigonline.cm-pvarzim.pt/arcgis/rest/services/Inter_Intra/TEMATICOS_Infraestruturas_RedeAguas/MapServer/218/query';
const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../data/hydrants-seed.json');

async function fetchAll() {
  const batch = 1000;
  let offset = 0;
  const all = [];

  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      orderByFields: 'OBJECTID ASC',
      resultOffset: String(offset),
      resultRecordCount: String(batch),
      f: 'json'
    });

    const response = await fetch(`${SIG_QUERY}?${params.toString()}`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`SIG HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Erro ArcGIS');

    const chunk = data.features || [];
    all.push(...chunk);
    if (chunk.length < batch || !data.exceededTransferLimit) break;
    if (!chunk.length) break;
    offset += chunk.length;
  }

  return all;
}

function flatten(feature) {
  const a = feature?.attributes || {};
  const g = feature?.geometry || {};
  const latitude = Number(g.y);
  const longitude = Number(g.x);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { ...a, latitude, longitude };
}

const raw = await fetchAll();
const features = raw.map(flatten).filter(Boolean);
if (!features.length) throw new Error('O SIG não devolveu hidrantes válidos. O ficheiro atual não será substituído.');

const payload = {
  source: 'SIG Câmara Municipal da Póvoa de Varzim — camada 218',
  generatedAt: new Date().toISOString(),
  count: features.length,
  features
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Atualizados ${features.length} hidrantes em ${output}`);
