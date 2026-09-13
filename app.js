'use strict';

const SIG_QUERY = 'https://sigonline.cm-pvarzim.pt/arcgis/rest/services/Inter_Intra/TEMATICOS_Infraestruturas_RedeAguas/MapServer/218/query';
const SEED_URL = './data/hydrants-seed.json';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DB_NAME = 'hidrantes-povoa';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'latest';
const DEFAULT_CENTER = [41.4107, -8.7402];

const state = {
  points: [],
  filtered: [],
  map: null,
  markerLayer: null,
  markers: new Map(),
  markersVisible: true,
  userMarker: null,
  accuracyCircle: null,
  userPosition: null,
  watchId: null,
  locationPermission: 'prompt',
  searchMarker: null,
  searchPosition: null,
  searchLabel: '',
  nearest: null,
  selectedId: null,
  nearestExpanded: false,
  lastSyncAt: null,
  installPrompt: null,
  source: 'seed'
};

const $ = id => document.getElementById(id);
const els = {
  map: $('map'),
  mapFallback: $('mapFallback'),
  installBtn: $('installBtn'),
  refreshBtn: $('refreshBtn'),
  searchForm: $('searchForm'),
  searchInput: $('searchInput'),
  searchBtn: $('searchBtn'),
  clearSearchBtn: $('clearSearchBtn'),
  searchStatus: $('searchStatus'),
  typeFilter: $('typeFilter'),
  statusFilter: $('statusFilter'),
  statusNote: $('statusNote'),
  visibleCount: $('visibleCount'),
  sourceBadge: $('sourceBadge'),
  locateBtn: $('locateBtn'),
  visibilityBtn: $('visibilityBtn'),
  offlineBtn: $('offlineBtn'),
  networkBanner: $('networkBanner'),
  nearestCard: $('nearestCard'),
  nearestToggle: $('nearestToggle'),
  nearestLabel: $('nearestLabel'),
  nearestHeadline: $('nearestHeadline'),
  nearestSubline: $('nearestSubline'),
  nearestDetails: $('nearestDetails'),
  nearestData: $('nearestData'),
  focusNearestBtn: $('focusNearestBtn'),
  navigateNearestBtn: $('navigateNearestBtn'),
  copyNearestBtn: $('copyNearestBtn'),
  infoDialog: $('infoDialog'),
  prepareOfflineBtn: $('prepareOfflineBtn'),
  toast: $('toast')
};

function hasValue(v) {
  if (v === 0) return true;
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!s) return false;
  return !['null', 'none', 'nenhum valor', 'não informado', 'nao informado', 'undefined'].includes(s.toLowerCase());
}

function stripText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function mapType(v) {
  const n = stripText(v).replaceAll(' ', '');
  if (n === 'marcoincendio') return 'Marco de incêndio';
  if (n === 'bocaincendio') return 'Boca de incêndio';
  return hasValue(v) ? String(v) : 'Hidrante';
}

function normalizeStatusKey(v) {
  const n = stripText(v);
  if (!n) return 'unknown';
  if (
    n.includes('nao operacional') ||
    n.includes('naooperacional') ||
    n.includes('inoperacional') ||
    n.includes('fora de servico') ||
    n.includes('desativado') ||
    n.includes('avariado')
  ) return 'non_operational';
  if (
    n === 'operacional' ||
    n === 'operativo' ||
    n === 'ativo' ||
    n === 'funcional' ||
    n === 'em servico'
  ) return 'operational';
  return 'unknown';
}

function mapState(v) {
  const key = normalizeStatusKey(v);
  if (key === 'operational') return 'Operacional';
  if (key === 'non_operational') return 'Não operacional';
  return hasValue(v) ? String(v) : 'Não informado';
}

function mapLifecycle(v) {
  const n = stripText(v).replaceAll(' ', '');
  if (!n) return 'Não informado';
  if (n === 'servico' || n === 'emservico') return 'Em serviço';
  if (n === 'foraservico') return 'Fora de serviço';
  return String(v);
}

function formatSigDate(value) {
  if (!hasValue(value)) return 'Não informada';
  let raw = value;
  if (typeof value === 'string' && /^\d{10,13}$/.test(value.trim())) raw = Number(value);
  if (typeof raw === 'number' && raw > 0 && raw < 1e12) raw *= 1000;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Lisbon'
  }).format(d);
}

function mapHydrantLocation(v) {
  const dict = {
    pavimento: 'Pavimento',
    guiapasseio: 'Guia/passeio',
    interior: 'Interior',
    parede: 'Parede'
  };
  return dict[stripText(v).replaceAll(' ', '')] || (hasValue(v) ? String(v) : '');
}

function normalizeFeature(feature) {
  if (!feature) return null;
  const a = feature.attributes || feature.properties || feature;
  let lat = Number(a.latitude ?? a.Latitude);
  let lon = Number(a.longitude ?? a.Longitude);

  if (feature.geometry?.type === 'Point' && Array.isArray(feature.geometry.coordinates)) {
    [lon, lat] = feature.geometry.coordinates.map(Number);
  } else if (feature.geometry && Number.isFinite(Number(feature.geometry.x)) && Number.isFinite(Number(feature.geometry.y))) {
    lon = Number(feature.geometry.x);
    lat = Number(feature.geometry.y);
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const id = String(a.IDEntidade ?? a.ID ?? a.OBJECTID ?? `${lat},${lon}`);
  const statusRaw = a.EstadoOperacional;

  return {
    ...a,
    id,
    latitude: lat,
    longitude: lon,
    TipoLabel: mapType(a.Tipo),
    EstadoKey: normalizeStatusKey(statusRaw),
    EstadoLabel: mapState(statusRaw),
    CicloVidaLabel: mapLifecycle(a.CicloVida),
    EstadoConservacaoLabel: hasValue(a.EstadoConservacao) ? String(a.EstadoConservacao) : 'Não informado',
    DataActualizacaoLabel: formatSigDate(a.DataActualizacao),
    LocalizacaoHidranteLabel: mapHydrantLocation(a.LocalizacaoHidrante)
  };
}

function dedupePoints(points) {
  const map = new Map();
  for (const p of points) {
    const key = p.IDEntidade || p.id || `${p.latitude.toFixed(7)},${p.longitude.toFixed(7)}`;
    map.set(String(key), p);
  }
  return [...map.values()];
}

function searchableText(p) {
  return stripText([
    p.IDEntidade, p.OBJECTID, p.TipoLabel, p.EstadoLabel, p.CicloVidaLabel,
    p.EstadoConservacaoLabel, p.Freguesia, p.Arruamento, p.Localizacao,
    p.Descricao, p.Observacoes
  ].filter(Boolean).join(' '));
}

function getPointId(p) {
  return String(p.IDEntidade || p.id || p.OBJECTID || `${p.latitude},${p.longitude}`);
}

function isVisibleByFilter(p) {
  const type = els.typeFilter.value;
  const status = els.statusFilter.value;
  if (type !== 'all' && p.Tipo !== type) return false;
  if (status !== 'all' && p.EstadoKey !== status) return false;
  return true;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDegrees(a, b) {
  const φ1 = a.lat * Math.PI / 180;
  const φ2 = b.lat * Math.PI / 180;
  const λ1 = a.lon * Math.PI / 180;
  const λ2 = b.lon * Math.PI / 180;
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function compassDirection(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(deg / 45) % 8];
}

function formatDistance(m) {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function pointAddress(p) {
  return [p.Arruamento, p.Localizacao].filter(hasValue).join(' — ') || p.Freguesia || 'Morada não informada';
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(d);
}

function timestampMs(ts) {
  const value = ts ? new Date(ts).getTime() : NaN;
  return Number.isFinite(value) ? value : 0;
}

function showToast(message, ms = 2800) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function setSearchStatus(message = '') {
  els.searchStatus.textContent = message;
  els.searchStatus.hidden = !message;
}

function updateOnlineUi() {
  const offline = !navigator.onLine;
  els.networkBanner.hidden = !offline;
  els.offlineBtn.classList.toggle('offline', offline);
  els.offlineBtn.title = offline ? 'Sem rede — ver dados offline' : 'Online — ver opções offline';
  els.offlineBtn.setAttribute('aria-label', els.offlineBtn.title);
}

function setLocateState(mode) {
  els.locateBtn.dataset.locationState = mode;
  els.locateBtn.classList.toggle('active', mode === 'active');
  els.locateBtn.classList.toggle('denied', mode === 'denied');
  if (mode === 'denied') {
    els.locateBtn.title = 'Localização não autorizada';
    els.locateBtn.setAttribute('aria-label', 'Localização não autorizada');
  } else if (mode === 'active') {
    els.locateBtn.title = 'Localização ativa — centrar no GPS';
    els.locateBtn.setAttribute('aria-label', 'Localização ativa — centrar no GPS');
  } else if (mode === 'loading') {
    els.locateBtn.title = 'A obter localização';
    els.locateBtn.setAttribute('aria-label', 'A obter localização');
  } else {
    els.locateBtn.title = 'Ativar localização';
    els.locateBtn.setAttribute('aria-label', 'Ativar localização');
  }
}

function createMarkerIcon(p) {
  if (!window.L) return null;
  const id = getPointId(p);
  const classes = ['hydrant-marker'];
  if (state.nearest && getPointId(state.nearest.point) === id) classes.push('nearest');
  if (state.nearestExpanded && state.nearest && getPointId(state.nearest.point) === id) classes.push('nearest-active');
  if (state.selectedId === id) classes.push('selected');
  if (p.EstadoKey === 'non_operational') classes.push('non-operational');

  return L.divIcon({
    className: 'hydrant-div-icon',
    html: `<div class="${classes.join(' ')}"><img src="./assets/hydrant_map.svg" alt=""></div>`,
    iconSize: [30, 44],
    iconAnchor: [15, 40],
    popupAnchor: [0, -36]
  });
}

function dataRowsForPoint(p, includeCoords = true) {
  const rows = [
    ['ID', p.IDEntidade || p.OBJECTID],
    ['Tipo', p.TipoLabel],
    ['Estado operacional', p.EstadoLabel],
    ['Ciclo de vida', p.CicloVidaLabel],
    ['Conservação', p.EstadoConservacaoLabel],
    ['Freguesia', p.Freguesia],
    ['Arruamento', p.Arruamento],
    ['Localização', p.Localizacao],
    ['Posição', p.LocalizacaoHidranteLabel],
    ['DN', hasValue(p.DN) ? `${p.DN} mm` : ''],
    ['N.º de bocas', p.NumeroBocas],
    ['Bocas', [p.DNBoca1, p.DNBoca2, p.DNBoca3].filter(hasValue).map(v => `${v} mm`).join(' / ')],
    ['Encaixe', p.TipoEncaixe],
    ['Coluna', p.TipoColuna],
    ['Torneira de corte', p.TorneiraCorte],
    ['Aberta', p.Aberta],
    ['Ano de instalação', p.AnoInstalacao],
    ['Entrada em serviço', hasValue(p.DataEntradaServico) ? formatSigDate(p.DataEntradaServico) : ''],
    ['Descrição', p.Descricao],
    ['Observações', p.Observacoes],
    ['Atualizado em', p.DataActualizacaoLabel]
  ];
  if (includeCoords) rows.push(['Coordenadas', `${p.latitude.toFixed(7)}, ${p.longitude.toFixed(7)}`]);
  const alwaysVisible = new Set([
    'Estado operacional',
    'Ciclo de vida',
    'Conservação',
    'Atualizado em'
  ]);
  return rows.filter(([label, value]) => alwaysVisible.has(label) || hasValue(value));
}

function directionsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${p.latitude},${p.longitude}`)}&travelmode=driving`;
}

const externalLinkIcon = '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';

function popupHtml(p) {
  const rows = dataRowsForPoint(p).slice(0, 10).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  return `
    <div class="popup-title"><img src="./assets/hydrant_map.svg" alt=""><strong>${escapeHtml(p.TipoLabel)}${hasValue(p.IDEntidade) ? ` — ${escapeHtml(p.IDEntidade)}` : ''}</strong></div>
    <dl class="popup-list">${rows}</dl>
    <div class="popup-actions">
      <button type="button" data-copy-coords="${escapeHtml(getPointId(p))}">Copiar</button>
      <a href="${directionsUrl(p)}" target="_blank" rel="noopener">Navegar ${externalLinkIcon}</a>
    </div>`;
}

function initMap() {
  if (!window.L) {
    els.mapFallback.hidden = false;
    return false;
  }

  state.map = L.map('map', {
    zoomControl: false,
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 20,
    dragging: true,
    doubleClickZoom: true,
    scrollWheelZoom: true,
    touchZoom: true,
    boxZoom: true,
    keyboard: true
  }).setView(DEFAULT_CENTER, 13);

  // Reforço explícito das interações: mantém o comportamento normal de um mapa
  // navegável mesmo se o browser/dispositivo alterar defaults do Leaflet.
  state.map.dragging?.enable();
  state.map.doubleClickZoom?.enable();
  state.map.scrollWheelZoom?.enable();
  state.map.touchZoom?.enable();
  state.map.boxZoom?.enable();
  state.map.keyboard?.enable();

  L.control.zoom({ position: 'topright' }).addTo(state.map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);

  state.markerLayer = L.layerGroup().addTo(state.map);
  // Não usamos o clique simples do mapa para criar uma ocorrência: isso interferia
  // com pan e duplo clique. O ponto de ocorrência continua a ser definido pela busca.
  state.map.on('popupopen', event => {
    const btn = event.popup.getElement()?.querySelector('[data-copy-coords]');
    if (btn) btn.addEventListener('click', () => {
      const p = state.points.find(x => getPointId(x) === btn.dataset.copyCoords);
      if (p) copyCoordinates(p);
    }, { once: true });
  });
  return true;
}

function renderMarkers({ fit = false } = {}) {
  updateStatusFilterUi();
  state.filtered = state.points.filter(isVisibleByFilter);
  els.visibleCount.textContent = `${state.filtered.length} de ${state.points.length}`;
  if (!state.map || !state.markerLayer) {
    updateNearest();
    return;
  }

  const visibleIds = new Set(state.filtered.map(getPointId));
  for (const [id, marker] of state.markers) {
    if (!visibleIds.has(id)) {
      state.markerLayer.removeLayer(marker);
      state.markers.delete(id);
    }
  }

  for (const p of state.filtered) {
    const id = getPointId(p);
    let marker = state.markers.get(id);
    if (!marker) {
      marker = L.marker([p.latitude, p.longitude], {
        icon: createMarkerIcon(p),
        title: `${p.TipoLabel} ${p.IDEntidade || ''}`.trim()
      });
      marker.bindPopup(() => popupHtml(p));
      marker.on('click', () => {
        state.selectedId = id;
        refreshMarkerIcons();
      });
      marker.addTo(state.markerLayer);
      state.markers.set(id, marker);
    } else {
      marker.setIcon(createMarkerIcon(p));
    }
  }

  setMarkersVisibility(state.markersVisible, { silent: true });
  updateNearest();
  if (fit && state.filtered.length) fitPoints(state.filtered);
}

function refreshMarkerIcons() {
  for (const p of state.filtered) {
    const marker = state.markers.get(getPointId(p));
    if (marker) marker.setIcon(createMarkerIcon(p));
  }
}

function fitPoints(points = state.filtered) {
  if (!state.map || !points.length) return;
  const bounds = L.latLngBounds(points.map(p => [p.latitude, p.longitude]));
  state.map.fitBounds(bounds.pad(.08), { paddingTopLeft: [20, 150], paddingBottomRight: [90, 150], maxZoom: 15 });
}

function setMarkersVisibility(visible, { silent = false } = {}) {
  state.markersVisible = visible;
  if (state.map && state.markerLayer) {
    if (visible && !state.map.hasLayer(state.markerLayer)) state.markerLayer.addTo(state.map);
    if (!visible && state.map.hasLayer(state.markerLayer)) state.map.removeLayer(state.markerLayer);
  }
  els.visibilityBtn.classList.toggle('markers-hidden', !visible);
  els.visibilityBtn.setAttribute('aria-pressed', String(visible));
  els.visibilityBtn.title = visible ? 'Ocultar hidrantes' : 'Mostrar hidrantes';
  els.visibilityBtn.setAttribute('aria-label', els.visibilityBtn.title);
  if (!silent) showToast(visible ? 'Hidrantes visíveis.' : 'Hidrantes ocultos.');
}

function updateStatusFilterUi() {
  const counts = { operational: 0, non_operational: 0, unknown: 0 };
  for (const p of state.points) counts[p.EstadoKey] = (counts[p.EstadoKey] || 0) + 1;

  const labels = {
    operational: `Operacional (${counts.operational})`,
    non_operational: `Não operacional (${counts.non_operational})`,
    unknown: `Estado não informado (${counts.unknown})`
  };

  for (const [value, label] of Object.entries(labels)) {
    const option = els.statusFilter.querySelector(`option[value="${value}"]`);
    if (!option) continue;
    option.textContent = label;
    option.disabled = counts[value] === 0;
  }

  const current = els.statusFilter.selectedOptions[0];
  if (current?.disabled) els.statusFilter.value = 'all';
  const allUnknown = state.points.length > 0 && counts.operational === 0 && counts.non_operational === 0;
  els.statusNote.hidden = !allUnknown;
  if (allUnknown) {
    els.statusNote.textContent = 'O campo EstadoOperacional não está preenchido nestes registos. O ciclo de vida é mostrado nos detalhes, mas não é usado como substituto da operacionalidade.';
  }
}

function applyFilters() {
  renderMarkers();
}

function setSourceBadge(source, syncAt) {
  state.source = source;
  state.lastSyncAt = syncAt || state.lastSyncAt;
  const t = formatTimestamp(state.lastSyncAt);
  if (source === 'sig') els.sourceBadge.textContent = `SIG atualizado${t ? ` • ${t}` : ''}`;
  else if (source === 'cache') els.sourceBadge.textContent = `Cache local${t ? ` • ${t}` : ''}`;
  else if (source === 'seed') els.sourceBadge.textContent = `SIG semanal${t ? ` • ${t}` : ''}`;
  else els.sourceBadge.textContent = 'Base local';
}

function setPoints(points, source, syncAt, { fit = false } = {}) {
  state.points = dedupePoints(points.map(normalizeFeature).filter(Boolean));
  setSourceBadge(source, syncAt);
  renderMarkers({ fit });
}

function needsSigSchemaRefresh(points = state.points) {
  if (!points.length) return false;
  return !points.some(p => Object.prototype.hasOwnProperty.call(p, 'CicloVida'));
}

async function fetchDirectSig() {
  const batch = 1000;
  let offset = 0;
  const out = [];
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
    const response = await fetch(`${SIG_QUERY}?${params.toString()}`, { cache: 'no-store', mode: 'cors' });
    if (!response.ok) throw new Error(`SIG HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Erro no SIG');
    const features = data.features || [];
    out.push(...features);
    if (features.length < batch || !data.exceededTransferLimit) break;
    offset += features.length;
    if (!features.length) break;
  }
  return out;
}

async function refreshFromSig({ quiet = false, force = false } = {}) {
  if (!navigator.onLine) {
    if (!quiet) showToast('Sem ligação à Internet. A usar os dados guardados.');
    return false;
  }

  if (!force && state.lastSyncAt && Date.now() - timestampMs(state.lastSyncAt) < WEEK_MS) return false;

  els.refreshBtn.disabled = true;
  els.refreshBtn.classList.add('loading');
  try {
    const features = await fetchDirectSig();
    const points = features.map(normalizeFeature).filter(Boolean);
    if (!points.length) throw new Error('O SIG não devolveu pontos válidos');
    const now = new Date().toISOString();
    setPoints(points, 'sig', now);
    await saveSnapshot({ features: points, fetchedAt: now });
    if (!quiet) showToast(`SIG atualizado: ${points.length} hidrantes.`);
    return true;
  } catch (err) {
    console.error(err);
    if (!quiet) showToast('Não foi possível atualizar diretamente o SIG. Mantive a última base disponível.', 4200);
    return false;
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.classList.remove('loading');
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB indisponível'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSnapshot(payload) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(payload, SNAPSHOT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('Não foi possível guardar snapshot', err);
  }
}

async function loadSnapshot() {
  try {
    const db = await openDb();
    const payload = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return payload;
  } catch (_) {
    return null;
  }
}

async function loadSeed() {
  const response = await fetch(SEED_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error('Base semanal indisponível');
  return response.json();
}

function getReferencePosition() {
  if (state.searchPosition) {
    return {
      latitude: state.searchPosition.latitude,
      longitude: state.searchPosition.longitude,
      mode: 'search',
      label: state.searchLabel || 'Local pesquisado'
    };
  }
  if (state.userPosition) return { ...state.userPosition, mode: 'gps', label: 'A sua posição' };
  return null;
}

function findNearest() {
  const ref = getReferencePosition();
  if (!ref || !state.filtered.length) return null;
  let best = null;
  const origin = { lat: ref.latitude, lon: ref.longitude };
  for (const p of state.filtered) {
    const d = haversineMeters(origin, { lat: p.latitude, lon: p.longitude });
    if (!best || d < best.distance) best = { point: p, distance: d };
  }
  if (best) {
    best.bearing = bearingDegrees(origin, { lat: best.point.latitude, lon: best.point.longitude });
    best.reference = ref;
  }
  return best;
}

function updateNearest() {
  const previousId = state.nearest?.point ? getPointId(state.nearest.point) : null;
  state.nearest = findNearest();
  const nextId = state.nearest?.point ? getPointId(state.nearest.point) : null;
  const ref = getReferencePosition();

  els.nearestLabel.textContent = ref?.mode === 'search' ? 'Mais próximo do local pesquisado' : 'Hidrante mais próximo';

  if (!state.nearest) {
    if (!ref) {
      els.nearestHeadline.textContent = 'Ative o GPS ou pesquise um local';
      els.nearestSubline.textContent = 'A posição é usada apenas no dispositivo.';
    } else if (!state.filtered.length) {
      els.nearestHeadline.textContent = 'Nenhum hidrante corresponde aos filtros';
      els.nearestSubline.textContent = 'Altere os filtros para calcular o mais próximo.';
    } else {
      els.nearestHeadline.textContent = 'Nenhum hidrante disponível';
      els.nearestSubline.textContent = 'Verifique os dados carregados.';
    }
    els.nearestData.innerHTML = '';
    els.navigateNearestBtn.disabled = true;
    els.focusNearestBtn.disabled = true;
    els.copyNearestBtn.disabled = true;
  } else {
    const { point: p, distance, bearing } = state.nearest;
    els.nearestHeadline.textContent = `${formatDistance(distance)} • ${p.TipoLabel}`;
    const address = pointAddress(p);
    els.nearestSubline.textContent = `${compassDirection(bearing)} • ${address}`;
    renderNearestDetails();
    els.navigateNearestBtn.disabled = false;
    els.focusNearestBtn.disabled = false;
    els.copyNearestBtn.disabled = false;
  }

  if (previousId !== nextId || state.nearestExpanded) refreshMarkerIcons();
}

function renderNearestDetails() {
  if (!state.nearest) return;
  const { point: p, distance, bearing, reference } = state.nearest;
  const rows = [
    ...(reference?.mode === 'search' ? [['Referência', reference.label]] : []),
    ['Distância', `${formatDistance(distance)} em linha reta`],
    ['Direção', `${compassDirection(bearing)} (${Math.round(bearing)}°)`],
    ...dataRowsForPoint(p)
  ];
  els.nearestData.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

function toggleNearest(force) {
  const next = typeof force === 'boolean' ? force : !state.nearestExpanded;
  state.nearestExpanded = next;
  els.nearestToggle.setAttribute('aria-expanded', String(next));
  els.nearestDetails.hidden = !next;
  refreshMarkerIcons();
  if (next && state.nearest) focusNearest({ openPopup: false });
}

function focusNearest({ openPopup = true } = {}) {
  if (!state.nearest || !state.map) return;
  const p = state.nearest.point;
  const id = getPointId(p);
  state.selectedId = id;
  if (!state.markersVisible) setMarkersVisibility(true, { silent: true });
  state.map.flyTo([p.latitude, p.longitude], Math.max(state.map.getZoom(), 17), { duration: .55 });
  refreshMarkerIcons();
  if (openPopup) setTimeout(() => state.markers.get(id)?.openPopup(), 500);
}

async function copyCoordinates(p) {
  const text = `${p.latitude.toFixed(7)}, ${p.longitude.toFixed(7)}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Coordenadas copiadas.');
  } catch (_) {
    window.prompt('Copiar coordenadas:', text);
  }
}

function updateUserMarker(position) {
  if (!state.map || !window.L) return;
  const latlng = [position.latitude, position.longitude];
  if (!state.userMarker) {
    const icon = L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    state.userMarker = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(state.map).bindTooltip('A sua posição');
  } else {
    state.userMarker.setLatLng(latlng);
  }
  if (!state.accuracyCircle) {
    state.accuracyCircle = L.circle(latlng, {
      radius: Math.max(position.accuracy || 0, 8), className: 'user-accuracy', weight: 1
    }).addTo(state.map);
  } else {
    state.accuracyCircle.setLatLng(latlng).setRadius(Math.max(position.accuracy || 0, 8));
  }
}

function clearSearchPosition({ keepInput = false } = {}) {
  state.searchPosition = null;
  state.searchLabel = '';
  if (state.searchMarker && state.map) state.map.removeLayer(state.searchMarker);
  state.searchMarker = null;
  if (!keepInput) els.searchInput.value = '';
  setSearchStatus('');
  updateNearest();
}

function setSearchPosition(latitude, longitude, label) {
  clearSearchPosition({ keepInput: true });
  state.searchPosition = { latitude, longitude };
  state.searchLabel = label || 'Local pesquisado';

  if (state.map && window.L) {
    const html = '<div class="reference-pin"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg></div>';
    const icon = L.divIcon({ className: 'reference-div-icon', html, iconSize: [36, 42], iconAnchor: [18, 40] });
    state.searchMarker = L.marker([latitude, longitude], { icon, zIndexOffset: 1200 })
      .addTo(state.map)
      .bindTooltip(`Local pesquisado: ${label}`, { direction: 'top' });
  }

  updateNearest();
  if (state.map) {
    const nearestPoint = state.nearest?.point;
    if (nearestPoint) {
      const bounds = L.latLngBounds([
        [latitude, longitude],
        [nearestPoint.latitude, nearestPoint.longitude]
      ]);
      state.map.fitBounds(bounds.pad(.55), { paddingTopLeft: [30, 180], paddingBottomRight: [90, 170], maxZoom: 17 });
    } else {
      state.map.flyTo([latitude, longitude], 16, { duration: .55 });
    }
  }
}

function parseCoordinates(query) {
  const match = query.trim().match(/^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/);
  if (!match) return null;
  const lat = Number(match[1].replace(',', '.'));
  const lon = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latitude: lat, longitude: lon };
}

function findExactHydrant(query) {
  const q = stripText(query).replaceAll(' ', '');
  if (!q) return null;
  return state.points.find(p => {
    const ids = [p.IDEntidade, p.id, p.OBJECTID].filter(hasValue).map(v => stripText(v).replaceAll(' ', ''));
    return ids.includes(q);
  }) || null;
}

function geocodeViewbox() {
  if (!state.points.length) return '-8.83,41.49,-8.57,41.34';
  const lats = state.points.map(p => p.latitude);
  const lons = state.points.map(p => p.longitude);
  const padLat = .025;
  const padLon = .035;
  const minLat = Math.min(...lats) - padLat;
  const maxLat = Math.max(...lats) + padLat;
  const minLon = Math.min(...lons) - padLon;
  const maxLon = Math.max(...lons) + padLon;
  return `${minLon},${maxLat},${maxLon},${minLat}`;
}

async function geocodeLocation(query) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    q: `${query}, Póvoa de Varzim, Portugal`,
    countrycodes: 'pt',
    limit: '5',
    bounded: '1',
    viewbox: geocodeViewbox(),
    addressdetails: '1',
    'accept-language': 'pt-PT'
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Geocodificação HTTP ${response.status}`);
  const results = await response.json();
  const item = Array.isArray(results) ? results[0] : null;
  if (!item) return null;
  const latitude = Number(item.lat);
  const longitude = Number(item.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const label = item.display_name || query;
  return { latitude, longitude, label };
}

async function runSearch() {
  const query = els.searchInput.value.trim();
  if (!query) {
    clearSearchPosition();
    els.searchInput.focus();
    return;
  }

  const exact = findExactHydrant(query);
  if (exact) {
    clearSearchPosition({ keepInput: true });
    els.typeFilter.value = 'all';
    els.statusFilter.value = 'all';
    renderMarkers();
    state.selectedId = getPointId(exact);
    if (!state.markersVisible) setMarkersVisibility(true, { silent: true });
    refreshMarkerIcons();
    state.map?.flyTo([exact.latitude, exact.longitude], 18, { duration: .55 });
    setTimeout(() => state.markers.get(getPointId(exact))?.openPopup(), 500);
    setSearchStatus(`Hidrante ${exact.IDEntidade || exact.OBJECTID} localizado.`);
    return;
  }

  const coords = parseCoordinates(query);
  if (coords) {
    setSearchPosition(coords.latitude, coords.longitude, `Coordenadas ${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`);
    setSearchStatus('Ponto de ocorrência definido pelas coordenadas. O hidrante mais próximo foi recalculado.');
    return;
  }

  if (!navigator.onLine) {
    showToast('A pesquisa por endereço precisa de Internet. Pode pesquisar um ID ou introduzir coordenadas.', 4300);
    return;
  }

  els.searchBtn.disabled = true;
  setSearchStatus('A localizar…');
  try {
    const result = await geocodeLocation(query);
    if (!result) {
      setSearchStatus('Local não encontrado na área da Póvoa de Varzim. Tente indicar rua e freguesia.');
      return;
    }
    setSearchPosition(result.latitude, result.longitude, result.label);
    setSearchStatus('Local de ocorrência definido. Os hidrantes permanecem visíveis e o mais próximo foi recalculado.');
  } catch (err) {
    console.error(err);
    setSearchStatus('Não foi possível pesquisar o endereço agora. Pode usar coordenadas ou um ID de hidrante.');
  } finally {
    els.searchBtn.disabled = false;
  }
}

function startGps() {
  if (!('geolocation' in navigator)) {
    showToast('Este dispositivo/navegador não disponibiliza geolocalização.');
    return;
  }

  if (state.watchId !== null) {
    setLocateState('active');
    clearSearchPosition({ keepInput: false });
    if (state.userPosition && state.map) state.map.flyTo([state.userPosition.latitude, state.userPosition.longitude], 16);
    updateNearest();
    return;
  }

  setLocateState('loading');
  clearSearchPosition({ keepInput: false });
  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      state.userPosition = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp
      };
      state.locationPermission = 'granted';
      updateUserMarker(state.userPosition);
      updateNearest();
      setLocateState('active');
      if (!startGps._centered && state.map) {
        startGps._centered = true;
        state.map.flyTo([state.userPosition.latitude, state.userPosition.longitude], 16, { duration: .6 });
      }
    },
    err => {
      console.warn(err);
      state.locationPermission = err.code === 1 ? 'denied' : 'prompt';
      setLocateState(err.code === 1 ? 'denied' : 'ready');
      if (err.code === 1) showToast('Permissão de localização recusada. Pode ativá-la nas definições do navegador.', 4400);
      else showToast('Não foi possível obter a localização GPS.', 3400);
      if (state.watchId !== null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

async function detectLocationPermission() {
  if (!navigator.permissions?.query) return;
  try {
    const permission = await navigator.permissions.query({ name: 'geolocation' });
    state.locationPermission = permission.state;
    if (permission.state === 'denied') setLocateState('denied');
    permission.addEventListener('change', () => {
      state.locationPermission = permission.state;
      if (permission.state === 'denied') setLocateState('denied');
      else if (state.watchId !== null) setLocateState('active');
      else setLocateState('ready');
    });
  } catch (_) {}
}

async function prepareOffline() {
  els.prepareOfflineBtn.disabled = true;
  try {
    if (state.points.length) {
      await saveSnapshot({ features: state.points, fetchedAt: state.lastSyncAt || new Date().toISOString() });
    }
    if ('storage' in navigator && 'persist' in navigator.storage) {
      try { await navigator.storage.persist(); } catch (_) {}
    }
    if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
    showToast('Aplicação e lista de hidrantes guardadas para uso offline.');
  } finally {
    els.prepareOfflineBtn.disabled = false;
  }
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.installPrompt = event;
    els.installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    els.installBtn.hidden = true;
    state.installPrompt = null;
    showToast('Aplicação instalada.');
  });
  els.installBtn.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    els.installBtn.hidden = true;
  });
}

function bindUi() {
  els.searchForm.addEventListener('submit', event => {
    event.preventDefault();
    runSearch();
  });
  els.clearSearchBtn.addEventListener('click', () => {
    clearSearchPosition();
    els.searchInput.focus();
  });
  els.typeFilter.addEventListener('change', applyFilters);
  els.statusFilter.addEventListener('change', applyFilters);
  els.refreshBtn.addEventListener('click', () => refreshFromSig({ force: true }));
  els.locateBtn.addEventListener('click', startGps);
  els.visibilityBtn.addEventListener('click', () => setMarkersVisibility(!state.markersVisible));
  els.offlineBtn.addEventListener('click', () => els.infoDialog.showModal());
  els.prepareOfflineBtn.addEventListener('click', prepareOffline);
  els.nearestToggle.addEventListener('click', () => toggleNearest());
  els.focusNearestBtn.addEventListener('click', () => focusNearest());
  els.navigateNearestBtn.addEventListener('click', () => {
    if (!state.nearest) return;
    window.open(directionsUrl(state.nearest.point), '_blank', 'noopener');
  });
  els.copyNearestBtn.addEventListener('click', () => {
    if (state.nearest) copyCoordinates(state.nearest.point);
  });
  window.addEventListener('online', () => {
    updateOnlineUi();
    refreshFromSig({ quiet: true });
  });
  window.addEventListener('offline', updateOnlineUi);
}

async function bootstrapData() {
  const [cached, seedResult] = await Promise.all([
    loadSnapshot(),
    loadSeed().catch(err => {
      console.warn(err);
      return null;
    })
  ]);

  const seedAt = seedResult?.generatedAt || seedResult?.fetchedAt;
  const cacheAt = cached?.fetchedAt;
  const seedValid = seedResult?.features?.length;
  const cacheValid = cached?.features?.length;

  if (seedValid && (!cacheValid || timestampMs(seedAt) >= timestampMs(cacheAt))) {
    setPoints(seedResult.features, 'seed', seedAt, { fit: true });
    await saveSnapshot({ features: state.points, fetchedAt: seedAt || new Date().toISOString() });
  } else if (cacheValid) {
    setPoints(cached.features, 'cache', cacheAt, { fit: true });
  } else if (seedValid) {
    setPoints(seedResult.features, 'seed', seedAt, { fit: true });
  } else {
    els.sourceBadge.textContent = 'Sem dados';
    showToast('Não foi possível carregar a base inicial de hidrantes.', 4500);
  }

  if (navigator.onLine) {
    await refreshFromSig({ quiet: true, force: needsSigSchemaRefresh() });
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('Service worker não registado', err);
  }
}

async function init() {
  bindUi();
  setupInstallPrompt();
  updateOnlineUi();
  setLocateState('ready');
  initMap();
  registerServiceWorker();
  detectLocationPermission();
  await bootstrapData();
}

document.addEventListener('DOMContentLoaded', init);
