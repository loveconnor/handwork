import { version } from 'maplibre-gl/package.json';
import type { MapServices } from 'honestui/genui';

// Match the services and attribution used by HonestAI's map playground.
export const desktopMapServices: MapServices = {
  geocode: async (query, signal) => {
    signal.throwIfAborted();
    if (!window.handwork) throw new Error('Maps require the desktop app.');
    const place = await window.handwork.geocodePlace(query);
    signal.throwIfAborted();
    return place;
  },
  workerUrl: `./vendor/maplibre-gl/${version}/maplibre-gl-worker.mjs`,
  styles: { light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark' },
  imagery: {
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noreferrer">USGS The National Map</a>: Orthoimagery',
    label: 'Satellite',
  },
  placeAttribution: <span>Places found with Nominatim. Place data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a>.</span>,
};
