import axios from 'axios';

export interface WeatherData {
  temperature: string;
  condition: string;
  aqi: string;
  humidity: string;
  windSpeed: string;
  locationName: string;
  preciseArea?: string;
  fullAddress?: string;
}

const getPreciseLocationName = async (
  lat: number,
  lng: number,
  fallbackName: string,
  apiKey?: string
): Promise<{ locationName: string; preciseArea?: string; fullAddress?: string }> => {
  // 1. Try OpenStreetMap Nominatim for street & neighborhood precision
  try {
    const res = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      {
        headers: { 'User-Agent': 'CrisisGuard-AI/1.0 (info@crisisguard.app)' },
        timeout: 3000,
      }
    );
    if (res.data && res.data.address) {
      const a = res.data.address;
      const specific = [
        a.residential || a.building || a.road || a.amenity,
        a.neighbourhood || a.suburb || a.city_district || a.village || a.town
      ].filter(Boolean);
      const area = Array.from(new Set(specific)).join(', ');
      const city = a.city || a.town || a.municipality || a.county || '';
      const state = a.state || '';

      const displayName = [area || city, city && city !== area ? city : '', state]
        .filter(Boolean)
        .join(', ');

      if (displayName) {
        return {
          locationName: displayName,
          preciseArea: area || city,
          fullAddress: res.data.display_name,
        };
      }
    }
  } catch {
    // Continue to fallback
  }

  // 2. Try OpenWeather Geocoding API
  if (apiKey) {
    try {
      const geoRes = await axios.get(
        `http://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lng}&limit=1&appid=${apiKey}`,
        { timeout: 3000 }
      );
      if (geoRes.data && geoRes.data[0]) {
        const place = geoRes.data[0];
        const name = place.state ? `${place.name}, ${place.state}` : place.name;
        return {
          locationName: name,
          preciseArea: place.name,
          fullAddress: `${place.name}, ${place.state || ''}, ${place.country || ''}`,
        };
      }
    } catch {
      // Continue to fallback
    }
  }

  return {
    locationName: fallbackName,
    preciseArea: fallbackName,
    fullAddress: fallbackName,
  };
};

export const getWeatherAndAQI = async (lat: number, lng: number): Promise<WeatherData> => {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  
  if (!apiKey) {
    return getFallbackWeather();
  }

  try {
    // Get current weather
    const weatherResponse = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${apiKey}&units=metric`
    );

    // Get air pollution data
    const aqiResponse = await axios.get(
      `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lng}&appid=${apiKey}`
    );

    const weather = weatherResponse.data;
    const airQuality = aqiResponse.data.list[0];

    const aqiValue = airQuality.main.aqi;
    const aqiText = getAQIText(aqiValue);

    // Get precise reverse-geocoded location name
    const locationInfo = await getPreciseLocationName(lat, lng, weather.name, apiKey);

    return {
      temperature: `${Math.round(weather.main.temp)}°C`,
      condition: weather.weather[0].description,
      aqi: `${aqiValue} (${aqiText})`,
      humidity: `${weather.main.humidity}%`,
      windSpeed: `${Math.round(weather.wind.speed * 3.6)} km/h`,
      locationName: locationInfo.locationName,
      preciseArea: locationInfo.preciseArea,
      fullAddress: locationInfo.fullAddress,
    };
  } catch (error) {
    console.error('Weather API error:', error);
    return getFallbackWeather();
  }
};

const getAQIText = (aqi: number): string => {
  const aqiLevels = ['Good', 'Fair', 'Moderate', 'Poor', 'Very Poor', 'Extremely Poor'];
  return aqiLevels[aqi - 1] || 'Unknown';
};

const getFallbackWeather = (): WeatherData => ({
  temperature: '--',
  condition: 'Unavailable',
  aqi: '--',
  humidity: '--',
  windSpeed: '--',
  locationName: 'Service Unavailable',
});
