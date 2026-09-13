'use strict';

const SIG_QUERY = 'https://sigonline.cm-pvarzim.pt/arcgis/rest/services/Inter_Intra/TEMATICOS_Infraestruturas_RedeAguas/MapServer/218/query';
const PROXY_QUERY = './api/hydrants';
const SEED_URL = './data/hydrants-seed.json';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const STALE_AFTER_MS = 5 * 60 * 1000;
const DB_NAME = 'hidrantes-povoa';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'latest';

const state = {
  points: [],
  filtered: [],
  map: null,
  markerLayer: null,
  markers: new Map(),
  userMarker: null,
  accuracyCircle: null,
  userPosition: null,
  watchId: null,
  nearest: null,
  selectedId: null,
  nearestExpanded: false,
  lastSyncAt: null,
  refreshTimer: null,
  installPrompt: null,
  source: 'seed'
};

const $ = id => document.getElementById(id);
const els = {
  map: $('map'),
  mapFallback: $('mapFallback'),
  installBtn: $('installBtn'),
  refreshBtn: $('refreshBtn'),
  searchInput: $('searchInput'),
  clearSearchBtn: $('clearSearchBtn'),
  typeFilter: $('typeFilter'),
  statusFilter: $('statusFilter'),
  visibleCount: $('visibleCount'),
  sourceBadge: $('sourceBadge'),
  locateBtn: $('locateBtn'),
  fitBtn: $('fitBtn'),
  offlineBtn: $('offlineBtn'),
  networkBanner: $('networkBanner'),
  nearestCard: $('nearestCard'),
  nearestToggle: $('nearestToggle'),
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function mapType(v) {
  if (v === 'MarcoIncendio') return 'Marco de incêndio';
  if (v === 'BocaIncendio') return 'Boca de incêndio';
  return hasValue(v) ? String(v) : 'Hidrante';
}

function mapState(v) {
  if (v === 'Operacional') return 'Operacional';
  if (v === 'NaoOperacional') return 'Não operacional';
  return hasValue(v) ? String(v) : 'Não informado';
}

function mapHydrantLocation(v) {
  const dict = {
    Pavimento: 'Pavimento',
    GuiaPasseio: 'Guia/passeio',
    Interior: 'Interior',
    Parede: 'Parede'
  };
  return dict[v] || (hasValue(v) ? String(v) : '');
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

  return {
    ...a,
    id,
    latitude: lat,
    longitude: lon,
    TipoLabel: mapType(a.Tipo),
    EstadoLabel: mapState(a.EstadoOperacional),
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
  return [
    p.IDEntidade, p.OBJECTID, p.TipoLabel, p.EstadoLabel, p.Freguesia,
    p.Arruamento, p.Localizacao, p.Descricao, p.Observacoes
  ].filter(Boolean).join(' ').toLocaleLowerCase('pt-PT');
}

function getPointId(p) {
  return String(p.IDEntidade || p.id || p.OBJECTID || `${p.latitude},${p.longitude}`);
}

function isVisibleByFilter(p) {
  const q = els.searchInput.value.trim().toLocaleLowerCase('pt-PT');
  const type = els.typeFilter.value;
  const status = els.statusFilter.value;
  if (q && !searchableText(p).includes(q)) return false;
  if (type !== 'all' && p.Tipo !== type) return false;
  if (status === 'unknown' && hasValue(p.EstadoOperacional)) return false;
  if (status !== 'all' && status !== 'unknown' && p.EstadoOperacional !== status) return false;
  return true;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat/2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDegrees(a, b) {
  const φ1 = a.lat * Math.PI/180;
  const φ2 = b.lat * Math.PI/180;
  const λ1 = a.lon * Math.PI/180;
  const λ2 = b.lon * Math.PI/180;
  const y = Math.sin(λ2-λ1) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
  return (Math.atan2(y, x) * 180/Math.PI + 360) % 360;
}

function compassDirection(deg) {
  const dirs = ['N','NE','E','SE','S','SO','O','NO'];
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
  return new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

function showToast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function updateOnlineUi() {
  const offline = !navigator.onLine;
  els.networkBanner.hidden = !offline;
  if (!offline && state.source === 'cache') {
    els.sourceBadge.textContent = `Cache local • ${formatTimestamp(state.lastSyncAt)}`;
  }
}

function createMarkerIcon(p) {
  if (!window.L) return null;
  const id = getPointId(p);
  const classes = ['hydrant-marker'];
  if (state.nearest && getPointId(state.nearest.point) === id) classes.push('nearest');
  if (state.nearestExpanded && state.nearest && getPointId(state.nearest.point) === id) classes.push('nearest-active');
  if (state.selectedId === id) classes.push('selected');
  if (p.EstadoOperacional === 'NaoOperacional') classes.push('non-operational');

  return L.divIcon({
    className: 'hydrant-div-icon',
    html: `<div class="${classes.join(' ')}"><img src="./assets/hydrant_drop.png" alt=""></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -16]
  });
}

function dataRowsForPoint(p, includeCoords = true) {
  const rows = [
    ['ID', p.IDEntidade || p.OBJECTID],
    ['Tipo', p.TipoLabel],
    ['Estado', p.EstadoLabel],
    ['Freguesia', p.Freguesia],
    ['Arruamento', p.Arruamento],
    ['Localização', p.Localizacao],
    ['Posição', p.LocalizacaoHidranteLabel],
    ['DN', hasValue(p.DN) ? `${p.DN} mm` : ''],
    ['N.º de bocas', p.NumeroBocas],
    ['Bocas', [p.DNBoca1, p.DNBoca2, p.DNBoca3].filter(hasValue).map(v => `${v} mm`).join(' / ')],
    ['Encaixe', p.TipoEncaixe],
    ['Coluna', p.TipoColuna],
    ['Conservação', p.EstadoConservacao],
    ['Torneira de corte', p.TorneiraCorte],
    ['Aberta', p.Aberta],
    ['Ano', p.AnoInstalacao],
    ['Descrição', p.Descricao],
    ['Observações', p.Observacoes],
    ['Atualização SIG', p.DataActualizacao]
  ];
  if (includeCoords) rows.push(['Coordenadas', `${p.latitude.toFixed(7)}, ${p.longitude.toFixed(7)}`]);
  return rows.filter(([,v]) => hasValue(v));
}

function directionsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${p.latitude},${p.longitude}`)}&travelmode=driving`;
}

function popupHtml(p) {
  const rows = dataRowsForPoint(p).slice(0, 9).map(([k,v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  return `
    <div class="popup-title"><img src="./assets/hydrant_drop.png" alt=""><strong>${escapeHtml(p.TipoLabel)}${hasValue(p.IDEntidade) ? ` — ${escapeHtml(p.IDEntidade)}` : ''}</strong></div>
    <dl class="popup-list">${rows}</dl>
    <div class="popup-actions">
      <button type="button" data-copy-coords="${escapeHtml(getPointId(p))}">Copiar</button>
      <a href="${directionsUrl(p)}" target="_blank" rel="noopener">Navegar</a>
    </div>`;
}

function initMap() {
  if (!window.L) {
    els.mapFallback.hidden = false;
    return false;
  }

  state.map = L.map('map', {
    zoomControl: true,
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 20
  }).setView([41.4107, -8.7402], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);

  state.markerLayer = L.layerGroup().addTo(state.map);
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
  state.filtered = state.points.filter(isVisibleByFilter);
  els.visibleCount.textContent = `${state.filtered.length} de ${state.points.length}`;
  if (!state.map || !state.markerLayer) return;

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
      marker = L.marker([p.latitude, p.longitude], { icon: createMarkerIcon(p), title: `${p.TipoLabel} ${p.IDEntidade || ''}`.trim() });
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
  state.map.fitBounds(bounds.pad(.08), { paddingTopLeft: [20, 110], paddingBottomRight: [20, 130], maxZoom: 15 });
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
  else els.sourceBadge.textContent = 'Base local inicial';
}

function setPoints(points, source, syncAt, { fit = false } = {}) {
  state.points = dedupePoints(points.map(normalizeFeature).filter(Boolean));
  setSourceBadge(source, syncAt);
  renderMarkers({ fit });
  updateNearest();
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

async function fetchProxy() {
  const response = await fetch(PROXY_QUERY, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error('Proxy sem JSON');
  const data = await response.json();
  if (!Array.isArray(data.features)) throw new Error('Resposta do proxy inválida');
  return data.features;
}

async function refreshFromSig({ quiet = false } = {}) {
  if (!navigator.onLine) {
    if (!quiet) showToast('Sem ligação à Internet. A usar os dados guardados.');
    return false;
  }

  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = '…';
  try {
    let features;
    try {
      features = await fetchProxy();
    } catch (_) {
      features = await fetchDirectSig();
    }
    const points = features.map(normalizeFeature).filter(Boolean);
    if (!points.length) throw new Error('O SIG não devolveu pontos válidos');
    const now = new Date().toISOString();
    setPoints(points, 'sig', now);
    await saveSnapshot({ features: points, fetchedAt: now });
    if (!quiet) showToast(`SIG atualizado: ${points.length} hidrantes.`);
    return true;
  } catch (err) {
    console.error(err);
    if (!quiet) showToast('Não foi possível atualizar o SIG. Mantive a última base disponível.', 3800);
    return false;
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = '↻';
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
  const response = await fetch(SEED_URL, { cache: 'default' });
  if (!response.ok) throw new Error('Seed indisponível');
  return response.json();
}

function findNearest() {
  if (!state.userPosition || !state.points.length) return null;
  let best = null;
  const origin = { lat: state.userPosition.latitude, lon: state.userPosition.longitude };
  for (const p of state.points) {
    const d = haversineMeters(origin, { lat: p.latitude, lon: p.longitude });
    if (!best || d < best.distance) best = { point: p, distance: d };
  }
  if (best) {
    best.bearing = bearingDegrees(origin, { lat: best.point.latitude, lon: best.point.longitude });
  }
  return best;
}

function updateNearest() {
  const previousId = state.nearest?.point ? getPointId(state.nearest.point) : null;
  state.nearest = findNearest();
  const nextId = state.nearest?.point ? getPointId(state.nearest.point) : null;

  if (!state.nearest) {
    els.nearestHeadline.textContent = state.userPosition ? 'Nenhum hidrante disponível' : 'Ative o GPS para calcular';
    els.nearestSubline.textContent = state.userPosition ? 'Verifique os filtros e os dados carregados.' : 'A sua posição é usada apenas no dispositivo.';
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
  const { point: p, distance, bearing } = state.nearest;
  const rows = [
    ['Distância', `${formatDistance(distance)} em linha reta`],
    ['Direção', `${compassDirection(bearing)} (${Math.round(bearing)}°)`],
    ...dataRowsForPoint(p)
  ];
  els.nearestData.innerHTML = rows.map(([k,v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
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
    const icon = L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [18,18], iconAnchor: [9,9] });
    state.userMarker = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(state.map).bindTooltip('A sua posição');
  } else {
    state.userMarker.setLatLng(latlng);
  }
  if (!state.accuracyCircle) {
    state.accuracyCircle = L.circle(latlng, { radius: Math.max(position.accuracy || 0, 8), className: 'user-accuracy', weight: 1 }).addTo(state.map);
  } else {
    state.accuracyCircle.setLatLng(latlng).setRadius(Math.max(position.accuracy || 0, 8));
  }
}

function startGps() {
  if (!('geolocation' in navigator)) {
    showToast('Este dispositivo/navegador não disponibiliza geolocalização.');
    return;
  }
  if (state.watchId !== null) {
    els.locateBtn.classList.add('active');
    if (state.userPosition && state.map) state.map.flyTo([state.userPosition.latitude, state.userPosition.longitude], 16);
    return;
  }

  els.locateBtn.textContent = '…';
  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      state.userPosition = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp
      };
      updateUserMarker(state.userPosition);
      updateNearest();
      els.locateBtn.textContent = '◎';
      els.locateBtn.classList.add('active');
      if (!startGps._centered && state.map) {
        startGps._centered = true;
        state.map.flyTo([state.userPosition.latitude, state.userPosition.longitude], 16, { duration: .6 });
      }
    },
    err => {
      console.warn(err);
      els.locateBtn.textContent = '◎';
      els.locateBtn.classList.remove('active');
      if (err.code === 1) showToast('Permissão de localização recusada. Pode ativá-la nas definições do navegador.', 4200);
      else showToast('Não foi possível obter a localização GPS.', 3400);
      if (state.watchId !== null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
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
    showToast('Aplicação e dados dos hidrantes preparados para uso offline.');
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
  els.searchInput.addEventListener('input', applyFilters);
  els.clearSearchBtn.addEventListener('click', () => { els.searchInput.value = ''; applyFilters(); els.searchInput.focus(); });
  els.typeFilter.addEventListener('change', applyFilters);
  els.statusFilter.addEventListener('change', applyFilters);
  els.refreshBtn.addEventListener('click', () => refreshFromSig());
  els.locateBtn.addEventListener('click', startGps);
  els.fitBtn.addEventListener('click', () => fitPoints());
  els.offlineBtn.addEventListener('click', () => els.infoDialog.showModal());
  els.prepareOfflineBtn.addEventListener('click', prepareOffline);
  els.nearestToggle.addEventListener('click', () => toggleNearest());
  els.focusNearestBtn.addEventListener('click', () => focusNearest());
  els.navigateNearestBtn.addEventListener('click', () => {
    if (!state.nearest) return;
    window.open(directionsUrl(state.nearest.point), '_blank', 'noopener');
  });
  els.copyNearestBtn.addEventListener('click', () => { if (state.nearest) copyCoordinates(state.nearest.point); });
  window.addEventListener('online', () => { updateOnlineUi(); refreshFromSig({ quiet: true }); });
  window.addEventListener('offline', updateOnlineUi);
}

async function bootstrapData() {
  let loaded = false;
  const cached = await loadSnapshot();
  if (cached?.features?.length) {
    setPoints(cached.features, 'cache', cached.fetchedAt, { fit: true });
    loaded = true;
  }

  if (!loaded) {
    try {
      const seed = await loadSeed();
      if (seed?.features?.length) {
        setPoints(seed.features, 'seed', seed.generatedAt, { fit: true });
        loaded = true;
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (!loaded) {
    els.sourceBadge.textContent = 'Sem dados';
    showToast('Não foi possível carregar a base inicial de hidrantes.', 4500);
  }

  if (navigator.onLine) {
    const isStale = !cached?.fetchedAt || (Date.now() - new Date(cached.fetchedAt).getTime()) > STALE_AFTER_MS;
    if (isStale) refreshFromSig({ quiet: true });
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
  initMap();
  registerServiceWorker();
  await bootstrapData();

  state.refreshTimer = setInterval(() => {
    if (navigator.onLine) refreshFromSig({ quiet: true });
  }, REFRESH_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', init);
