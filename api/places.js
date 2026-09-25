// /api/places.js — Vercel serverless function
// Proxies Overpass API (OpenStreetMap places) with multi-mirror parallel racing.
// Free, no API key. Supports category-specific queries so tapping "Ortho" or
// "Eye Care" in the UI actually re-queries OSM for that specialty near the
// user, rather than just filtering whatever generic list already loaded.

export const config = { runtime: 'edge' };

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

// Category -> Overpass query fragment. Ortho/Eye/Dental aren't standalone
// OSM amenities the way hospital/pharmacy/clinic are — they're clinics or
// hospitals tagged with healthcare:speciality, or amenity=dentist for dental.
// So each category builds a different, targeted query.
function buildQuery(lat, lng, radius, category) {
  const around = `(around:${radius},${lat},${lng})`;
  let clauses;
  switch (category) {
    case 'hospital':
      clauses = [`node["amenity"="hospital"]${around}`, `way["amenity"="hospital"]${around}`];
      break;
    case 'pharmacy':
      clauses = [`node["amenity"="pharmacy"]${around}`, `way["amenity"="pharmacy"]${around}`];
      break;
    case 'dental':
      clauses = [`node["amenity"="dentist"]${around}`, `way["amenity"="dentist"]${around}`];
      break;
    case 'clinic':
      clauses = [`node["amenity"="clinic"]${around}`, `way["amenity"="clinic"]${around}`];
      break;
    case 'ortho':
      clauses = [
        `node["healthcare:speciality"~"orthopaedic|orthopedic",i]${around}`,
        `way["healthcare:speciality"~"orthopaedic|orthopedic",i]${around}`,
        `node["amenity"~"hospital|clinic"]["healthcare:speciality"~"ortho",i]${around}`,
      ];
      break;
    case 'eye':
      clauses = [
        `node["healthcare:speciality"~"ophthalmology|optometry|eye",i]${around}`,
        `way["healthcare:speciality"~"ophthalmology|optometry|eye",i]${around}`,
        `node["healthcare"="optometrist"]${around}`,
        `node["shop"="optician"]${around}`,
      ];
      break;
    case 'all':
    default:
      clauses = [
        `node["amenity"="hospital"]${around}`, `way["amenity"="hospital"]${around}`,
        `node["amenity"="pharmacy"]${around}`, `way["amenity"="pharmacy"]${around}`,
        `node["amenity"="dentist"]${around}`, `way["amenity"="dentist"]${around}`,
        `node["amenity"="clinic"]${around}`, `way["amenity"="clinic"]${around}`,
      ];
  }
  return `[out:json][timeout:20];(${clauses.join(';')};);out center 80;`;
}

async function tryMirror(url, query, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.elements) throw new Error('No elements in response');
    return data;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const lat = parseFloat(searchParams.get('lat'));
  const lng = parseFloat(searchParams.get('lng'));
  const radius = parseInt(searchParams.get('radius') || '6000', 10);
  const category = searchParams.get('category') || 'all';

  if (isNaN(lat) || isNaN(lng)) {
    return new Response(JSON.stringify({ error: 'lat and lng query params required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const query = buildQuery(lat, lng, radius, category);

  const attempts = MIRRORS.map(mirror =>
    tryMirror(mirror, query, 8000).then(
      data => ({ ok: true, mirror, data }),
      err  => ({ ok: false, mirror, error: err.message })
    )
  );

  const results = await Promise.all(attempts);
  const success = results.find(r => r.ok);

  if (success) {
    return new Response(JSON.stringify({ elements: success.data.elements, source: success.mirror, category }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' }
    });
  }

  const errors = results.map(r => `${r.mirror}: ${r.error}`);
  return new Response(JSON.stringify({
    error: 'All map data sources are currently busy. Please try again in a moment.',
    details: errors
  }), { status: 503, headers: { 'Content-Type': 'application/json' } });
}
