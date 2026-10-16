// Use HonestAI's existing gateway, including its Nominatim queue and cache.
// The renderer can submit place names, never arbitrary network destinations.
const cache = new Map();
const pending = new Map();
export async function geocodePlace(query) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200 || /[\x00-\x1f]/.test(query)) throw new Error('Enter a place name between 2 and 200 characters.');
  const normalized = query.trim().replace(/\s+/g, ' ');
  const key = normalized.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < 86400000) return cached.place;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= 16) throw new Error('Place lookups are busy. Try again shortly.');
  const lookup = (async () => {
    const response = await fetch('https://ai.honestui.com/api/playground/geocode', {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: normalized }), signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('HonestAI place lookup is unavailable. Try again shortly.'); }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 65536) throw new Error('The place service returned too much data.');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = body?.place;
    const place = result === null ? null : { lat: result?.lat, lon: result?.lon, label: result?.label };
    if (place !== null && (!place || typeof place.lat !== 'number' || !Number.isFinite(place.lat) || Math.abs(place.lat) > 90 || typeof place.lon !== 'number' || !Number.isFinite(place.lon) || Math.abs(place.lon) > 180 || typeof place.label !== 'string' || place.label.length > 4000)) throw new Error('The place service returned an invalid location.');
    if (cache.size >= 1000) cache.delete(cache.keys().next().value);
    cache.set(key, { time: Date.now(), place });
    return place;
  })();
  pending.set(key, lookup);
  try { return await lookup; } finally { pending.delete(key); }
}
