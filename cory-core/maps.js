'use strict';

const { httpError, text } = require('./identity');

const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const COMPUTE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

function apiKey() {
  const value = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!value) throw httpError('Drive-time lookup is not configured yet.', 503, 'MAPS_NOT_CONFIGURED');
  return value;
}

async function googleJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    const error = httpError('Google Maps could not calculate that location right now.', response.status >= 500 ? 503 : 400, 'MAPS_PROVIDER_ERROR');
    error.providerDetail = text(body, 1000);
    throw error;
  }
  return response.json();
}

async function autocompletePlaces(input, sessionToken) {
  const query = text(input, 160);
  if (query.length < 3) return [];
  const body = {
    input: query,
    includedRegionCodes: ['us'],
    languageCode: 'en-US',
    regionCode: 'US'
  };
  const token = text(sessionToken, 200);
  if (token) body.sessionToken = token;

  const data = await googleJson(PLACES_AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey(),
      'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text'
    },
    body: JSON.stringify(body)
  });

  return (data.suggestions || [])
    .map((item) => item.placePrediction)
    .filter(Boolean)
    .map((prediction) => ({
      placeId: prediction.placeId,
      label: prediction.text && prediction.text.text ? prediction.text.text : ''
    }))
    .filter((item) => item.placeId && item.label);
}

function waypoint(input) {
  const placeId = text(input && input.placeId, 300);
  if (placeId) return { placeId };

  const latitude = Number(input && input.latitude);
  const longitude = Number(input && input.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
    return { location: { latLng: { latitude, longitude } } };
  }

  const address = text(input && input.address, 500);
  if (address) return { address };
  throw httpError('Choose an address or allow location access to estimate drive time.');
}

function storeWaypoint() {
  const placeId = text(process.env.GOOGLE_STORE_PLACE_ID, 300);
  if (placeId) return { placeId };
  const address = text(process.env.BUSINESS_ADDRESS, 500);
  if (address) return { address };
  throw httpError('The store address is not configured.', 503, 'STORE_ADDRESS_NOT_CONFIGURED');
}

function durationSeconds(value) {
  const match = String(value || '').match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return match ? Number(match[1]) : 0;
}

async function computeDriveTime(input) {
  const request = {
    origin: waypoint(input || {}),
    destination: storeWaypoint(),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    languageCode: 'en-US',
    units: 'IMPERIAL',
    departureTime: new Date().toISOString()
  };

  const data = await googleJson(COMPUTE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey(),
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters'
    },
    body: JSON.stringify(request)
  });

  const route = data.routes && data.routes[0];
  if (!route) throw httpError('No driving route was found for that location.', 404, 'ROUTE_NOT_FOUND');
  const seconds = durationSeconds(route.duration);
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const distanceMiles = Math.round((Number(route.distanceMeters || 0) / 1609.344) * 10) / 10;
  const pickupAt = input && input.pickupAt ? new Date(input.pickupAt) : null;
  const suggestedDeparture = pickupAt && !Number.isNaN(pickupAt.getTime())
    ? new Date(pickupAt.getTime() - seconds * 1000).toISOString()
    : null;

  return {
    durationMinutes: minutes,
    distanceMiles,
    suggestedDeparture,
    trafficAware: true,
    estimateOnly: true
  };
}

module.exports = {
  autocompletePlaces,
  computeDriveTime,
  waypoint
};
