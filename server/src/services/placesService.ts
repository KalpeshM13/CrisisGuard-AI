import axios from 'axios';

export interface Place {
  id: string;
  title: string;
  type: string;
  lat: number;
  lng: number;
  address: string;
  phoneNumber?: string;
  operatingHours?: string;
  distance?: number;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat: number;
    lon: number;
  };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

const TYPE_TO_AMENITY_MAP: Record<string, string[]> = {
  hospital: ['hospital', 'clinic', 'doctors'],
  pharmacy: ['pharmacy'],
  police: ['police'],
  fire_station: ['fire_station'],
  atm: ['atm', 'bank'],
  gas_station: ['fuel'],
  ambulance: ['ambulance_station'],
  shelter: ['shelter'],
};

// Prioritize fast, working mirrors first
const OVERPASS_MIRRORS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

// In-memory cache with 10-minute TTL
interface CacheEntry {
  timestamp: number;
  data: Place[];
}
const placesCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCacheKey(lat: number, lng: number, radius: number, types: string[]): string {
  // Round to ~1km grid (0.01 degree) to reuse cache for slight GPS jitter
  const roundedLat = lat.toFixed(2);
  const roundedLng = lng.toFixed(2);
  const sortedTypes = [...types].sort().join(',');
  return `${roundedLat}:${roundedLng}:${radius}:${sortedTypes}`;
}

export const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const buildOverpassQuery = (lat: number, lng: number, radius: number, types: string[]): string => {
  const amenities: string[] = [];
  
  for (const type of types) {
    const typeAmenities = TYPE_TO_AMENITY_MAP[type];
    if (typeAmenities) {
      amenities.push(...typeAmenities);
    }
  }

  if (amenities.length === 0) {
    return '';
  }

  const regex = amenities.join('|');

  // Fast regex query with center tags and reasonable limit
  const query = `[out:json][timeout:8];
(
  node["amenity"~"^(${regex})$"](around:${radius},${lat},${lng});
  way["amenity"~"^(${regex})$"](around:${radius},${lat},${lng});
);
out center tags 120;`;

  return query;
};

const extractPlaceName = (tags: Record<string, string> | undefined): string => {
  if (!tags) return 'Emergency Service';
  return tags.name || tags['name:en'] || tags.operator || tags.brand || 'Emergency Service';
};

const extractVicinity = (tags: Record<string, string> | undefined): string => {
  if (!tags) return '';
  
  const parts: string[] = [];
  if (tags['addr:housenumber']) parts.push(tags['addr:housenumber']);
  if (tags['addr:street']) parts.push(tags['addr:street']);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  else if (tags['addr:town']) parts.push(tags['addr:town']);
  else if (tags['addr:village']) parts.push(tags['addr:village']);
  
  if (parts.length > 0) return parts.join(', ');
  return tags.city || tags.town || tags.state || '';
};

const mapOsmTypeToFrontend = (amenity: string): string => {
  if (['hospital', 'clinic', 'doctors'].includes(amenity)) return 'hospital';
  if (amenity === 'pharmacy') return 'pharmacy';
  if (amenity === 'police') return 'police';
  if (amenity === 'fire_station') return 'fire';
  if (['atm', 'bank'].includes(amenity)) return 'atm';
  if (amenity === 'fuel') return 'gas_station';
  if (amenity === 'ambulance_station') return 'ambulance';
  if (amenity === 'shelter') return 'shelter';
  return 'other';
};

// Fast Nominatim fallback if Overpass mirrors fail or time out
const fetchFromNominatimFallback = async (
  lat: number,
  lng: number,
  radius: number,
  types: string[]
): Promise<Place[]> => {
  console.log('⚡ Querying Nominatim fallback for nearby services...');
  const d = radius / 111320;
  const viewbox = `${(lng - d).toFixed(4)},${(lat + d).toFixed(4)},${(lng + d).toFixed(4)},${(lat - d).toFixed(4)}`;

  const amenityList: string[] = [];
  for (const t of types) {
    const list = TYPE_TO_AMENITY_MAP[t] || [t];
    amenityList.push(...list);
  }

  const queries = amenityList.slice(0, 6);
  const promises = queries.map(async (amenity) => {
    try {
      const res = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: {
          amenity: amenity,
          format: 'json',
          viewbox: viewbox,
          bounded: 1,
          limit: 15,
          addressdetails: 1,
        },
        headers: { 'User-Agent': 'CrisisGuardApp/1.0 (disaster-preparedness)' },
        timeout: 4000,
      });

      return (res.data || []).map((item: { place_id: number; lat: string; lon: string; name?: string; display_name?: string; type?: string }) => {
        const itemLat = parseFloat(item.lat);
        const itemLon = parseFloat(item.lon);
        const dist = calculateDistance(lat, lng, itemLat, itemLon);
        return {
          id: `nom-${item.place_id}`,
          title: item.name || item.display_name?.split(',')[0] || 'Emergency Service',
          type: mapOsmTypeToFrontend(item.type || amenity),
          lat: itemLat,
          lng: itemLon,
          address: item.display_name || '',
          distance: dist,
        };
      });
    } catch {
      return [];
    }
  });

  const arrays = await Promise.all(promises);
  return arrays.flat();
};

const fetchFromOverpass = async (
  lat: number,
  lng: number,
  radius: number,
  types: string[]
): Promise<Place[]> => {
  const query = buildOverpassQuery(lat, lng, radius, types);
  
  if (!query) {
    console.log('No valid amenity types to search for');
    return [];
  }

  for (const mirror of OVERPASS_MIRRORS) {
    try {
      console.log(`Querying Overpass mirror: ${mirror}`);

      const response = await axios.post<OverpassResponse>(
        mirror,
        `data=${encodeURIComponent(query)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'CrisisGuard/1.0 (disaster-preparedness-app)',
          },
          timeout: 4000, // Fail fast after 4s rather than hanging
        }
      );

      const places: Place[] = [];
      const seenIds = new Set<string>();

      for (const element of response.data.elements || []) {
        const latVal = element.lat ?? element.center?.lat;
        const lonVal = element.lon ?? element.center?.lon;

        if (!latVal || !lonVal) continue;

        const tags = element.tags || {};
        const amenity = tags.amenity || 'other';

        const placeType = mapOsmTypeToFrontend(amenity);
        const uniqueId = `${latVal.toFixed(5)},${lonVal.toFixed(5)}`;

        if (seenIds.has(uniqueId)) continue;
        seenIds.add(uniqueId);

        const distance = calculateDistance(lat, lng, latVal, lonVal);
        const address = extractVicinity(tags);

        places.push({
          id: `place-${element.id}`,
          title: extractPlaceName(tags),
          type: placeType,
          lat: latVal,
          lng: lonVal,
          address: address,
          phoneNumber: tags.phone || tags['contact:phone'],
          operatingHours: tags.opening_hours,
          distance,
        });
      }

      if (places.length > 0) {
        console.log(`✅ Overpass (${mirror}) returned ${places.length} places`);
        return places;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.log(`Mirror ${mirror} failed (${error.code || error.response?.status || error.message}), trying next...`);
      } else {
        console.log(`Mirror ${mirror} error, trying next...`);
      }
    }
  }

  // If all Overpass mirrors fail or return empty, use Nominatim fallback
  console.warn('⚠️ All Overpass mirrors failed or timed out. Falling back to Nominatim...');
  try {
    const fallbackPlaces = await fetchFromNominatimFallback(lat, lng, radius, types);
    console.log(`✅ Nominatim fallback returned ${fallbackPlaces.length} places`);
    return fallbackPlaces;
  } catch (fbError) {
    console.error('Nominatim fallback also failed:', fbError);
    return [];
  }
};

export async function findNearbyPlaces(
  latitude: number,
  longitude: number,
  types: string[],
  radius: number = 5000
): Promise<Place[]> {
  console.log(`findNearbyPlaces called: lat=${latitude}, lng=${longitude}, types=${types.join(', ')}, radius=${radius}`);

  // Check cache first
  const cacheKey = getCacheKey(latitude, longitude, radius, types);
  const cached = placesCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`⚡ Returning ${cached.data.length} cached places for ${cacheKey}`);
    return cached.data;
  }

  try {
    const places = await fetchFromOverpass(latitude, longitude, radius, types);

    const filteredPlaces = places
      .filter(p => p.distance !== undefined && p.distance * 1000 <= radius)
      .sort((a, b) => (a.distance || 0) - (b.distance || 0))
      .slice(0, 60);

    console.log(`Total places found: ${filteredPlaces.length}`);

    if (filteredPlaces.length > 0) {
      placesCache.set(cacheKey, {
        timestamp: Date.now(),
        data: filteredPlaces,
      });
    }

    return filteredPlaces;
  } catch (error) {
    console.error('Error fetching places:', error);
    return [];
  }
}
