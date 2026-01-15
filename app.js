/**
 * BoilerBus
 * Real-time bus tracking for Purdue University campus (unofficial)
 */

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

// Merge with external config (from config.js) or use defaults
const CONFIG = {
    // API settings
    NETWORK_ID: window.APP_CONFIG?.NETWORK_ID || 'd22317c9-83ab-49e3-ba56-a424cdced862',
    WEB_ORIGIN: window.APP_CONFIG?.WEB_ORIGIN || 'https://purdue.liftango.com',

    // CORS proxy URL - empty for local dev (uses /api), or full worker URL for production
    CORS_PROXY_URL: window.APP_CONFIG?.CORS_PROXY_URL || '',

    // Computed: Base URL for API requests
    // - Local dev: '/api' (handled by server.py)
    // - Production: 'https://your-worker.workers.dev/api'
    get BASE_URL() {
        if (this.CORS_PROXY_URL) {
            // Production: use Cloudflare Worker
            return this.CORS_PROXY_URL.replace(/\/$/, '') + '/api';
        }
        // Local dev: use local proxy server
        return '/api';
    },

    // Purdue campus center (for fallback)
    DEFAULT_LAT: window.APP_CONFIG?.DEFAULT_LAT || 40.4237,
    DEFAULT_LON: window.APP_CONFIG?.DEFAULT_LON || -86.9212,

    // Settings
    NEARBY_RADIUS_MILES: window.APP_CONFIG?.NEARBY_RADIUS_MILES || 0.5,
    REFRESH_INTERVAL_MS: window.APP_CONFIG?.REFRESH_INTERVAL_MS || 30000,
    MAX_NEARBY_STOPS: window.APP_CONFIG?.MAX_NEARBY_STOPS || 10,
    API_TIMEOUT_MS: window.APP_CONFIG?.API_TIMEOUT_MS || 30000,

    // Map settings
    MAP_ZOOM_DEFAULT: window.APP_CONFIG?.MAP_ZOOM_DEFAULT || 16,
    MAP_ZOOM_FOCUSED: window.APP_CONFIG?.MAP_ZOOM_FOCUSED || 17,

    // Realistic ETA parameters for campus bus travel
    BUS_AVG_SPEED_MPH: window.APP_CONFIG?.BUS_AVG_SPEED_MPH || 10,
    STOP_TIME_SECONDS: window.APP_CONFIG?.STOP_TIME_SECONDS || 50,
    TRAFFIC_BUFFER_PERCENT: window.APP_CONFIG?.TRAFFIC_BUFFER_PERCENT || 0.15,
};

// ═══════════════════════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════════════════════

const state = {
    // Location
    userLat: null,
    userLon: null,
    userAddress: null,
    
    // Data
    routes: [],
    stops: [],
    runningBuses: [],
    nearbyStops: [],
    routeStopSequences: new Map(), // Maps routeId -> ordered array of stopIds
    
    // UI State
    currentView: 'nearby',
    selectedStop: null,
    selectedStopArrivals: [],
    isLoading: false,
    
    // Map
    map: null,
    userMarker: null,
    stopMarkers: [],
    busMarkers: [],
    routePolylines: [],     // Polylines showing route paths
    selectedRouteFilter: null, // Route ID to filter map by (null = show all)
    routeFilterOpen: false,   // Whether the route filter menu is open
    
    // Intervals
    refreshInterval: null,
};

// Generate session/trace IDs for API
const SESSION_ID = `ops-${crypto.randomUUID()}`;
const TRACE_ID = `ops-${crypto.randomUUID()}`;

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate distance between two points using Haversine formula
 * @returns Distance in miles
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth's radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(deg) {
    return deg * (Math.PI / 180);
}

/**
 * Format distance for display
 */
function formatDistance(miles) {
    if (miles < 0.1) {
        const feet = Math.round(miles * 5280);
        return `${feet} ft`;
    }
    return `${miles.toFixed(2)} mi`;
}

/**
 * Format ETA for display
 * @returns {Object} { text, className }
 */
function formatETA(minutes) {
    if (minutes === null || minutes === undefined) {
        return { text: '--', className: 'later' };
    }
    
    const mins = Math.round(minutes);
    
    if (mins <= 0) {
        return { text: 'Now', className: 'arriving' };
    } else if (mins <= 5) {
        return { text: `${mins} min`, className: 'arriving' };
    } else if (mins <= 15) {
        return { text: `${mins} min`, className: 'soon' };
    } else if (mins < 60) {
        return { text: `${mins} min`, className: 'later' };
    } else {
        const hours = Math.floor(mins / 60);
        const remainMins = mins % 60;
        return { text: `${hours}h ${remainMins}m`, className: 'later' };
    }
}

/**
 * Format time ago
 */
function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    
    try {
        const ts = new Date(timestamp);
        const now = new Date();
        const diff = (now - ts) / 1000;
        
        if (diff < 60) return `${Math.round(diff)}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        return `${Math.floor(diff / 3600)}h ago`;
    } catch {
        return '';
    }
}

/**
 * Convert hex color to CSS-friendly format
 */
function normalizeColor(color) {
    if (!color) return '#CEB888'; // Purdue gold default
    if (color.startsWith('#')) return color;
    return `#${color}`;
}

/**
 * Get first non-null value
 */
function first(...values) {
    for (const v of values) {
        if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
}

/**
 * Debounce function
 */
function debounce(fn, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// API Functions
// ═══════════════════════════════════════════════════════════════════════════

function getApiHeaders() {
    return {
        'x-lifty-product-id': 'fixed_route',
        'x-lifty-session-id': SESSION_ID,
        'x-lifty-trace-id': TRACE_ID,
        'Origin': CONFIG.WEB_ORIGIN,
        'Accept': 'application/json',
    };
}

async function fetchApi(endpoint, params = {}) {
    // Build URL - use full URL if proxy configured, otherwise relative path
    const baseUrl = CONFIG.BASE_URL;
    const apiPath = `${baseUrl}/context/fixed-route/q`;

    // Create URL object - handle both absolute and relative URLs
    let url;
    if (baseUrl.startsWith('http')) {
        url = new URL(apiPath);
    } else {
        url = new URL(apiPath, window.location.origin);
    }

    url.searchParams.set('type', endpoint);
    url.searchParams.set('version', '1');
    url.searchParams.set('aclConfig', '');
    url.searchParams.set('aclContext', 'fixed_route');
    url.searchParams.set('networkId', CONFIG.NETWORK_ID);

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    console.log('[API] Fetching:', url.toString());

    // Add timeout to prevent hanging forever
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);
    
    try {
        const response = await fetch(url.toString(), {
            headers: getApiHeaders(),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[API] Error:', response.status, errorText);
            throw new Error(`API Error: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[API] Success:', endpoint);
        return data;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            console.error('[API] Request timed out:', endpoint);
            throw new Error('Request timed out');
        }
        throw err;
    }
}

/**
 * Fetch all routes and stops
 */
async function fetchRoutesAndStops() {
    const payload = await fetchApi('getserviceroutesandstops');
    return parseRoutesAndStops(payload);
}

/**
 * Parse routes and stops from API response
 * Also builds route stop sequences for ETA calculation
 */
function parseRoutesAndStops(payload) {
    const data = payload.data || payload.payload || payload;
    
    let routesList = null;
    if (typeof data === 'object' && data !== null) {
        for (const key of ['routes', 'entries', 'services']) {
            if (Array.isArray(data[key])) {
                routesList = data[key];
                break;
            }
        }
    }
    
    if (!routesList) {
        routesList = findListWithKey(data, 'stops') || [];
    }
    
    // Build stops lookup - index by multiple IDs for flexible lookup
    const stopsById = new Map();
    const stopsList = data?.stops;
    if (Array.isArray(stopsList)) {
        for (const stop of stopsList) {
            if (typeof stop !== 'object') continue;
            // Index by all possible IDs so we can look up by any reference
            if (stop.id) stopsById.set(stop.id, stop);
            if (stop.addressId) stopsById.set(stop.addressId, stop);
            if (stop.stopId) stopsById.set(stop.stopId, stop);
        }
    }
    
    const routes = [];
    const allStops = new Map();
    const routeStopSequences = new Map(); // For ETA calculation
    const seen = new Set();
    
    for (const route of routesList) {
        if (typeof route !== 'object') continue;
        
        const routeId = first(route.id, route.routeId, route.refid);
        const routeLabel = first(route.label, route.name, route.routeLabel) || 'Unknown Route';
        const routeColour = route.colour || route.color;
        
        const key = `${routeId || routeLabel}|${routeLabel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        
        const stops = [];
        const stopSequence = []; // Ordered list of stops with coordinates for this route
        const routeStops = route.stops || route.stopList || route.stopIds;
        
        if (Array.isArray(routeStops)) {
            for (const s of routeStops) {
                let stopObj = null;
                if (typeof s === 'object') {
                    // Inline stop object - try to enrich with full data from lookup
                    const lookupId = s.id || s.addressId || s.stopId;
                    stopObj = stopsById.get(lookupId) || s;
                } else if (typeof s === 'string' && stopsById.has(s)) {
                    stopObj = stopsById.get(s);
                } else if (typeof s === 'number' && stopsById.has(s)) {
                    stopObj = stopsById.get(s);
                }

                if (!stopObj) continue;

                // The API's `id` field contains the UUID needed for getrunningstopdetails
                // `addressId` is actually a numeric ID (confusingly named)
                const rawId = stopObj.id;
                const isIdUuid = typeof rawId === 'string' && rawId.includes('-') && rawId.length > 30;
                const stopUuid = isIdUuid ? rawId : null;

                const stopId = first(stopObj.id, stopObj.addressId, stopObj.stopId);
                const stopLabel = first(stopObj.label, stopObj.name) || 'Unknown Stop';

                const stopData = {
                    id: stopId || stopLabel,
                    addressId: stopUuid,  // Store the UUID for API calls (from `id` field when it's a UUID)
                    label: stopLabel,
                    latitude: stopObj.latitude,
                    longitude: stopObj.longitude,
                    routes: [],
                };
                
                stops.push(stopData);
                
                // Build stop sequence for route-aware ETA
                if (stopData.latitude && stopData.longitude) {
                    stopSequence.push({
                        id: stopData.id,
                        latitude: stopData.latitude,
                        longitude: stopData.longitude,
                    });
                }
                
                // Add to all stops map
                if (!allStops.has(stopData.id)) {
                    allStops.set(stopData.id, { ...stopData });
                }
                // Track which routes serve this stop
                const existingStop = allStops.get(stopData.id);
                if (!existingStop.routes.find(r => r.id === (routeId || routeLabel))) {
                    existingStop.routes.push({
                        id: routeId || routeLabel,
                        label: routeLabel,
                        colour: routeColour,
                    });
                }
            }
        }
        
        // Store stop sequence for this route
        routeStopSequences.set(routeId || routeLabel, stopSequence);
        
        routes.push({
            id: routeId || routeLabel,
            label: routeLabel,
            colour: routeColour,
            stops,
        });
    }
    
    // Store route sequences in state for ETA calculation
    state.routeStopSequences = routeStopSequences;
    
    return {
        routes,
        stops: Array.from(allStops.values()),
    };
}

/**
 * Find a list containing objects with a specific key
 */
function findListWithKey(obj, key) {
    if (typeof obj !== 'object' || obj === null) return null;
    
    if (Array.isArray(obj)) {
        if (obj.length > 0 && typeof obj[0] === 'object' && key in obj[0]) {
            return obj;
        }
        for (const item of obj) {
            const result = findListWithKey(item, key);
            if (result) return result;
        }
    } else {
        for (const val of Object.values(obj)) {
            const result = findListWithKey(val, key);
            if (result) return result;
        }
    }
    return null;
}

/**
 * Fetch running shift solutions (active buses)
 * Parses vehicle info, capacity, and location data
 */
async function fetchRunningBuses() {
    const payload = await fetchApi('getrunningshiftsolutions');
    const solutions = findListWithKey(payload, 'shiftSolutionId');
    
    if (!solutions) return [];
    
    // Parse and enrich bus data with capacity info
    return solutions.map(bus => {
        // Extract capacity information
        // API returns availableCapacities array like:
        // [{"amount":11,"capacityName":"standard"},{"amount":0,"capacityName":"wheelchair"}]
        let capacity = null;
        
        const capacities = bus.availableCapacities;
        if (Array.isArray(capacities) && capacities.length > 0) {
            let standardSeats = null;
            let wheelchairSeats = null;
            
            for (const cap of capacities) {
                if (typeof cap !== 'object') continue;
                const name = cap.capacityName || cap.name || '';
                const amount = cap.amount;
                
                if (amount !== null && amount !== undefined) {
                    if (name === 'standard' || name === '') {
                        standardSeats = amount;
                    } else if (name === 'wheelchair') {
                        wheelchairSeats = amount;
                    }
                }
            }
            
            if (standardSeats !== null) {
                capacity = {
                    available: standardSeats,
                    wheelchair: wheelchairSeats,
                    total: null,
                    percentage: null,
                };
            }
        }
        
        // Fallback: try availableCapacity (singular) - used in Pusher events
        if (!capacity && bus.availableCapacity) {
            const available = bus.availableCapacity;
            if (typeof available === 'object' && available.amount !== undefined) {
                capacity = {
                    available: available.amount,
                    wheelchair: null,
                    total: null,
                    percentage: null,
                };
            } else if (typeof available === 'number') {
                capacity = {
                    available: available,
                    wheelchair: null,
                    total: null,
                    percentage: null,
                };
            }
        }
        
        return {
            ...bus,
            capacity,
        };
    });
}

/**
 * Fetch stop details (arrivals)
 * Returns array from data.stop in the API response
 * @param {string} stopId - The addressId (UUID) of the stop
 */
async function fetchStopDetails(stopId) {
    if (!stopId) return [];

    // API requires the UUID format for stopId
    // Skip if stopId doesn't look like a UUID
    const stopIdStr = String(stopId);
    const isUuid = stopIdStr.includes('-') && stopIdStr.length > 30;
    if (!isUuid) {
        return [];
    }

    try {
        const payload = await fetchApi('getrunningstopdetails', { stopId: stopIdStr });
        // API returns { status: 200, data: { stop: [...] } }
        if (payload?.data?.stop && Array.isArray(payload.data.stop)) {
            return payload.data.stop;
        }
        // Fallback: try to find array with shiftSolutionId
        const stops = findListWithKey(payload, 'shiftSolutionId');
        return stops || [];
    } catch (err) {
        // API returns 500 when no buses or invalid stop - treat as empty
        if (err.message.includes('500')) return [];
        throw err;
    }
}

/**
 * Reverse geocode coordinates to address
 */
async function reverseGeocode(lat, lon) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'PurdueTransitPWA/1.0' }
        });
        
        if (!response.ok) throw new Error('Geocoding failed');
        
        const data = await response.json();
        
        // Build a friendly address
        const addr = data.address || {};
        const parts = [];
        
        if (addr.building || addr.amenity || addr.shop) {
            parts.push(addr.building || addr.amenity || addr.shop);
        }
        if (addr.house_number && addr.road) {
            parts.push(`${addr.house_number} ${addr.road}`);
        } else if (addr.road) {
            parts.push(addr.road);
        }
        
        if (parts.length === 0) {
            return data.display_name?.split(',').slice(0, 2).join(',') || 'Unknown Location';
        }
        
        return parts.join(', ');
    } catch {
        return 'Purdue University';
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Geolocation
// ═══════════════════════════════════════════════════════════════════════════

async function getCurrentLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('Geolocation not supported'));
            return;
        }
        
        navigator.geolocation.getCurrentPosition(
            (position) => {
                resolve({
                    lat: position.coords.latitude,
                    lon: position.coords.longitude,
                });
            },
            (error) => {
                reject(error);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 60000,
            }
        );
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Data Processing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate nearby stops with distances
 */
function calculateNearbyStops() {
    if (!state.userLat || !state.userLon || !state.stops.length) {
        state.nearbyStops = [];
        return;
    }
    
    const stopsWithDistance = state.stops
        .filter(stop => stop.latitude && stop.longitude)
        .map(stop => ({
            ...stop,
            distance: haversineDistance(
                state.userLat, state.userLon,
                stop.latitude, stop.longitude
            ),
        }))
        .filter(stop => stop.distance <= CONFIG.NEARBY_RADIUS_MILES)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, CONFIG.MAX_NEARBY_STOPS);
    
    state.nearbyStops = stopsWithDistance;
}

/**
 * Calculate route-aware ETA from bus position to target stop
 * Accounts for intermediate stops, dwell time, and traffic buffer
 * Matches the Python TUI calculation for consistency
 */
function calculateRouteAwareETA(bus, targetStop, routeId) {
    const loc = bus.location || {};
    const busLat = loc.latitude;
    const busLon = loc.longitude;
    
    if (!busLat || !busLon || !targetStop.latitude || !targetStop.longitude) {
        return null;
    }
    
    // Get the stop sequence for this route
    const stopSequence = state.routeStopSequences.get(routeId);
    
    if (!stopSequence || stopSequence.length < 2) {
        // Fallback: simple distance-based estimate with route factor
        const directDistance = haversineDistance(
            busLat, busLon,
            targetStop.latitude, targetStop.longitude
        );
        // Add 30% for route indirection + traffic buffer
        let etaMinutes = (directDistance * 1.3 / CONFIG.BUS_AVG_SPEED_MPH) * 60;
        etaMinutes *= (1 + CONFIG.TRAFFIC_BUFFER_PERCENT);
        return Math.max(1, Math.round(etaMinutes));
    }
    
    // Find which stop the bus is closest to (current position in route)
    let busStopIndex = 0;
    let closestDistance = Infinity;
    
    for (let i = 0; i < stopSequence.length; i++) {
        const stop = stopSequence[i];
        const dist = haversineDistance(busLat, busLon, stop.latitude, stop.longitude);
        if (dist < closestDistance) {
            closestDistance = dist;
            busStopIndex = i;
        }
    }
    
    // Find target stop index
    let targetStopIndex = stopSequence.findIndex(s => s.id === targetStop.id);
    
    if (targetStopIndex === -1) {
        // Target stop not in sequence - use simple calculation
        const directDistance = haversineDistance(
            busLat, busLon,
            targetStop.latitude, targetStop.longitude
        );
        let etaMinutes = (directDistance * 1.3 / CONFIG.BUS_AVG_SPEED_MPH) * 60;
        etaMinutes *= (1 + CONFIG.TRAFFIC_BUFFER_PERCENT);
        return Math.max(1, Math.round(etaMinutes));
    }
    
    const n = stopSequence.length;
    
    // If bus is already at or very close to target stop (within ~250 feet)
    if (busStopIndex === targetStopIndex && closestDistance < 0.05) {
        return 1; // Arriving in about a minute
    }
    
    // Calculate how far ahead the target is along the route (handles loop)
    const stopsAhead = (targetStopIndex - busStopIndex + n) % n;
    
    // If target is 0 stops ahead but bus isn't there yet
    if (stopsAhead === 0) {
        let etaMinutes = (closestDistance / CONFIG.BUS_AVG_SPEED_MPH) * 60;
        etaMinutes *= (1 + CONFIG.TRAFFIC_BUFFER_PERCENT);
        return Math.max(1, Math.round(etaMinutes));
    }
    
    // Calculate distance along the route
    let routeDistance = 0;
    let current = busStopIndex;
    
    for (let step = 0; step < stopsAhead; step++) {
        const nextIdx = (current + 1) % n;
        const fromStop = stopSequence[current];
        const toStop = stopSequence[nextIdx];
        
        routeDistance += haversineDistance(
            fromStop.latitude, fromStop.longitude,
            toStop.latitude, toStop.longitude
        );
        current = nextIdx;
    }
    
    // Add distance from bus to its nearest stop
    const totalDistance = closestDistance + routeDistance;
    
    // Calculate driving time
    const drivingTimeMinutes = (totalDistance / CONFIG.BUS_AVG_SPEED_MPH) * 60;
    
    // Add time for intermediate stops (not counting target stop)
    const intermediateStops = Math.max(0, stopsAhead - 1);
    const stopTimeMinutes = (intermediateStops * CONFIG.STOP_TIME_SECONDS) / 60;
    
    // Calculate total time with traffic buffer
    let totalTimeMinutes = drivingTimeMinutes + stopTimeMinutes;
    totalTimeMinutes *= (1 + CONFIG.TRAFFIC_BUFFER_PERCENT);
    
    // Round up to be conservative
    return Math.max(1, Math.round(totalTimeMinutes + 0.5));
}

/**
 * Get the next stop for a bus based on its current position
 * @returns {Object|null} { id, label } of the next stop, or null if unknown
 */
function getNextStopForBus(bus) {
    const loc = bus.location || {};
    const busLat = loc.latitude;
    const busLon = loc.longitude;
    const route = bus.route || {};
    const routeId = route.id || route.label;

    if (!busLat || !busLon || !routeId) return null;

    // Get the stop sequence for this route
    const stopSequence = state.routeStopSequences.get(routeId);
    if (!stopSequence || stopSequence.length < 2) return null;

    // Find which stop the bus is closest to
    let closestIndex = 0;
    let closestDistance = Infinity;

    for (let i = 0; i < stopSequence.length; i++) {
        const stop = stopSequence[i];
        const dist = haversineDistance(busLat, busLon, stop.latitude, stop.longitude);
        if (dist < closestDistance) {
            closestDistance = dist;
            closestIndex = i;
        }
    }

    // The next stop is the one after the closest (wrapping around for loop routes)
    const nextIndex = (closestIndex + 1) % stopSequence.length;
    const nextStopData = stopSequence[nextIndex];

    // Find the full stop info from state.stops
    const fullStop = state.stops.find(s => s.id === nextStopData.id);

    return {
        id: nextStopData.id,
        label: fullStop?.label || 'Next stop',
    };
}

/**
 * Get next arrivals for a stop
 * Uses route-aware ETA calculation considering stops along the way
 */
function getNextArrivalsForStop(stopId) {
    // Find buses that serve this stop based on their route
    const arrivals = [];
    const stop = state.stops.find(s => s.id === stopId);
    if (!stop) return arrivals;
    
    for (const bus of state.runningBuses) {
        const busRoute = bus.route;
        if (!busRoute) continue;
        
        // Check if this bus's route serves this stop
        const matchingRoute = stop.routes.find(r => 
            r.id === busRoute.id || r.label === busRoute.label
        );
        
        if (matchingRoute) {
            const routeId = busRoute.id || busRoute.label;

            // Calculate route-aware ETA
            const etaMinutes = calculateRouteAwareETA(bus, stop, routeId);

            // Get the bus's next stop
            const nextStop = getNextStopForBus(bus);

            arrivals.push({
                shiftSolutionId: bus.shiftSolutionId,
                route: {
                    id: busRoute.id,
                    label: busRoute.label,
                    colour: busRoute.colour || matchingRoute.colour,
                },
                vehicle: bus.vehicle,
                location: bus.location,
                capacity: bus.capacity,  // Include capacity info
                nextStop,  // Include next stop info
                etaMinutes,
            });
        }
    }
    
    // Sort by ETA
    arrivals.sort((a, b) => {
        if (a.etaMinutes === null) return 1;
        if (b.etaMinutes === null) return -1;
        return a.etaMinutes - b.etaMinutes;
    });
    
    return arrivals;
}

/**
 * Parse capacity from availableCapacities array (API format)
 */
function parseCapacityFromApi(availableCapacities) {
    if (!Array.isArray(availableCapacities) || availableCapacities.length === 0) {
        return null;
    }

    let standardSeats = null;
    let wheelchairSeats = null;

    for (const cap of availableCapacities) {
        if (typeof cap !== 'object') continue;
        const name = cap.capacityName || '';
        const amount = cap.amount;

        if (amount !== null && amount !== undefined) {
            if (name === 'standard' || name === '') {
                standardSeats = amount;
            } else if (name === 'wheelchair') {
                wheelchairSeats = amount;
            }
        }
    }

    if (standardSeats !== null) {
        return {
            available: standardSeats,
            wheelchair: wheelchairSeats,
            total: null,
            percentage: null,
        };
    }

    return null;
}

/**
 * Get arrivals from stop details API
 * Uses API-provided stopEta which accounts for traffic and route
 * Falls back to calculated arrivals if API returns empty
 */
async function fetchArrivalsForStop(stopId) {
    try {
        const stop = state.stops.find(s => s.id === stopId);
        // Use addressId (UUID) for API call, fall back to stopId
        const apiStopId = stop?.addressId || stopId;
        const details = await fetchStopDetails(apiStopId);

        // If API returned results, use them
        if (details && details.length > 0) {
            return details.map(entry => {
                const route = entry.route || {};

                // Find full bus info from running buses (has location data)
                const bus = state.runningBuses.find(b =>
                    b.shiftSolutionId === entry.shiftSolutionId
                ) || {};

                // Use API-provided stopEta (official ETA from server)
                const officialEta = entry.stopEta;

                // Calculate our own ETA for comparison/fallback
                const routeId = route.id || route.label;
                const calculatedEta = calculateRouteAwareETA(
                    { location: bus.location || entry.location },
                    stop,
                    routeId
                );

                // Use official ETA if available, otherwise use calculated
                const etaMinutes = (officialEta !== null && officialEta !== undefined)
                    ? officialEta
                    : calculatedEta;

                // Use busTowards from API as the next stop direction, fall back to calculated
                let nextStop = null;
                if (route.busTowards) {
                    nextStop = { label: route.busTowards };
                } else {
                    nextStop = getNextStopForBus(bus.shiftSolutionId ? bus : { ...entry, route, location: bus.location });
                }

                // Parse capacity from API response (entry.availableCapacities) or from running bus
                const capacity = parseCapacityFromApi(entry.availableCapacities) || bus.capacity || null;

                return {
                    shiftSolutionId: entry.shiftSolutionId,
                    route: {
                        id: route.id,
                        label: route.label || 'Unknown Route',
                        colour: route.colour,
                    },
                    vehicle: bus.vehicle || entry.vehicle,
                    location: bus.location || entry.location,
                    capacity,
                    nextStop,
                    etaMinutes,
                    officialEta,      // Keep official ETA for display
                    calculatedEta,    // Keep calculated ETA for comparison
                };
            });
        }

        // API returned empty - fall back to calculated arrivals
        console.log('[API] Stop details empty, using calculated arrivals');
        return getNextArrivalsForStop(stopId);
    } catch (err) {
        // Fallback to calculated arrivals on error
        console.log('[API] Stop details failed, using calculated arrivals:', err.message);
        return getNextArrivalsForStop(stopId);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// UI Rendering
// ═══════════════════════════════════════════════════════════════════════════

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

function setLoadingStatus(message) {
    const el = $('#loading-status');
    if (el) el.textContent = message;
}

function showLoading() {
    $('#loading-screen').classList.remove('hidden', 'fade-out');
    $('#main-app').classList.add('hidden');
}

function hideLoading() {
    $('#loading-screen').classList.add('fade-out');
    $('#main-app').classList.remove('hidden');
    
    setTimeout(() => {
        $('#loading-screen').classList.add('hidden');
    }, 400);
}

function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-message">${message}</span>`;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 200);
    }, 3000);
}

function updateLocationBar() {
    const el = $('#current-address');
    if (el) el.textContent = state.userAddress || 'Locating...';
}

function updateHeaderTitle(title) {
    $('#header-title').textContent = title;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nearby Stops View
// ─────────────────────────────────────────────────────────────────────────────

function renderNearbyStops() {
    const container = $('#stops-list');
    container.innerHTML = '';
    
    if (state.nearbyStops.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg class="empty-state-icon" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                </svg>
                <h3 class="empty-state-title">No nearby stops</h3>
                <p class="empty-state-message">
                    Try moving closer to campus or increase your search radius.
                </p>
            </div>
        `;
        return;
    }
    
    for (const stop of state.nearbyStops) {
        const arrivals = getNextArrivalsForStop(stop.id);
        const card = createStopCard(stop, arrivals);
        container.appendChild(card);
    }
}

/**
 * Format capacity for display
 * @returns {Object} { text, className, icon }
 */
function formatCapacity(capacity) {
    if (!capacity) {
        return null;
    }
    
    // If we have available seats count
    if (capacity.available !== null && capacity.available !== undefined) {
        const seats = capacity.available;
        let wheelchair = '';
        if (capacity.wheelchair !== null && capacity.wheelchair > 0) {
            wheelchair = ` ♿${capacity.wheelchair}`;
        }
        
        if (seats <= 5) {
            return { 
                text: `${seats} seats${wheelchair}`, 
                className: 'capacity-busy',
                icon: '●●●○',
                seats: seats
            };
        } else if (seats <= 15) {
            return { 
                text: `${seats} seats${wheelchair}`, 
                className: 'capacity-moderate',
                icon: '●●○○',
                seats: seats
            };
        } else {
            return { 
                text: `${seats} seats${wheelchair}`, 
                className: 'capacity-available',
                icon: '●○○○',
                seats: seats
            };
        }
    }
    
    return null;
}

function createStopCard(stop, arrivals) {
    const card = document.createElement('div');
    card.className = 'stop-card';
    card.dataset.stopId = stop.id;
    
    const distanceStr = formatDistance(stop.distance);
    
    let arrivalsHtml = '';
    if (arrivals.length === 0) {
        arrivalsHtml = '<p class="no-arrivals">No buses currently en route</p>';
    } else {
        const displayArrivals = arrivals.slice(0, 3);
        arrivalsHtml = displayArrivals.map(arr => {
            const eta = formatETA(arr.etaMinutes);
            const color = normalizeColor(arr.route.colour);
            const capacity = formatCapacity(arr.capacity);

            let capacityHtml = '';
            if (capacity) {
                capacityHtml = `<span class="arrival-capacity ${capacity.className}" title="${capacity.text}">${capacity.icon}</span>`;
            }

            // Next stop info
            let nextStopHtml = '';
            if (arr.nextStop && arr.nextStop.label) {
                nextStopHtml = `<span class="arrival-next-stop" title="Next stop">Next: ${arr.nextStop.label}</span>`;
            }

            return `
                <div class="arrival-row">
                    <div class="arrival-route-info">
                        <div class="route-badge" style="background: ${color}20">
                            <span class="dot" style="background: ${color}"></span>
                            <span class="name">${arr.route.label}</span>
                        </div>
                        ${nextStopHtml}
                    </div>
                    <div class="arrival-info">
                        ${capacityHtml}
                        <span class="arrival-eta ${eta.className}">${eta.text}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    card.innerHTML = `
        <div class="stop-card-header">
            <h3 class="stop-name">${stop.label}</h3>
            <span class="stop-distance">${distanceStr}</span>
        </div>
        <div class="stop-arrivals">
            ${arrivalsHtml}
        </div>
    `;
    
    card.addEventListener('click', () => showStopDetail(stop));
    
    return card;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop Detail View
// ─────────────────────────────────────────────────────────────────────────────

async function showStopDetail(stop) {
    state.selectedStop = stop;
    state.currentView = 'detail';
    
    // Update UI
    updateHeaderTitle(stop.label);
    $('#btn-back').classList.remove('hidden');
    
    // Switch view
    switchView('detail');
    
    // Show loading state
    const container = $('#stop-detail');
    container.innerHTML = `
        <div class="detail-header">
            <h2 class="detail-stop-name">${stop.label}</h2>
            <div class="detail-meta">
                <span class="detail-meta-item">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                    </svg>
                    ${formatDistance(stop.distance || 0)} away
                </span>
            </div>
        </div>
        <div class="detail-section">
            <h4 class="detail-section-title">Loading arrivals...</h4>
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
        </div>
    `;
    
    // Fetch arrivals
    try {
        const arrivals = await fetchArrivalsForStop(stop.id);
        state.selectedStopArrivals = arrivals;
        renderStopDetail(stop, arrivals);
    } catch (err) {
        // Use calculated arrivals as fallback
        const arrivals = getNextArrivalsForStop(stop.id);
        state.selectedStopArrivals = arrivals;
        renderStopDetail(stop, arrivals);
    }
}

function renderStopDetail(stop, arrivals) {
    const container = $('#stop-detail');
    
    // Routes serving this stop
    const routesBadges = (stop.routes || []).map(r => {
        const color = normalizeColor(r.colour);
        return `<span class="route-badge" style="background: ${color}20">
            <span class="dot" style="background: ${color}"></span>
            <span class="name">${r.label}</span>
        </span>`;
    }).join('');
    
    // Arrivals
    let arrivalsHtml = '';
    if (arrivals.length === 0) {
        arrivalsHtml = `
            <div class="empty-state">
                <svg class="empty-state-icon" viewBox="0 0 48 48" fill="currentColor">
                    <rect x="8" y="12" width="32" height="24" rx="4"/>
                    <rect x="12" y="16" width="8" height="6" rx="1" fill="var(--bg-primary)"/>
                    <rect x="28" y="16" width="8" height="6" rx="1" fill="var(--bg-primary)"/>
                    <circle cx="14" cy="38" r="3"/>
                    <circle cx="34" cy="38" r="3"/>
                </svg>
                <h3 class="empty-state-title">No buses en route</h3>
                <p class="empty-state-message">Check back soon or view the map for all active buses.</p>
            </div>
        `;
    } else {
        arrivalsHtml = arrivals.map((arr, i) => {
            const eta = formatETA(arr.etaMinutes);
            const color = normalizeColor(arr.route.colour);
            const vehicle = arr.vehicle || {};
            const vehicleName = first(vehicle.displayName, vehicle.name) || 'Bus';
            const loc = arr.location || {};
            const timeAgo = formatTimeAgo(loc.timestamp || loc.recordedAt);
            const capacity = formatCapacity(arr.capacity);
            
            let distanceInfo = '';
            if (loc.latitude && loc.longitude && stop.latitude && stop.longitude) {
                const dist = haversineDistance(
                    loc.latitude, loc.longitude,
                    stop.latitude, stop.longitude
                );
                distanceInfo = `${formatDistance(dist)} away`;
            }
            
            // Build capacity display for detail view
            let capacityHtml = '';
            if (capacity) {
                capacityHtml = `
                    <span class="arrival-detail-item ${capacity.className}">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                        </svg>
                        ${capacity.text}
                    </span>
                `;
            }

            // Next stop display for detail view
            let nextStopHtml = '';
            if (arr.nextStop && arr.nextStop.label) {
                nextStopHtml = `
                    <span class="arrival-detail-item">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                        </svg>
                        Next: ${arr.nextStop.label}
                    </span>
                `;
            }

            // Check if bus has valid location for map view
            const hasLocation = loc.latitude && loc.longitude;
            const clickableClass = hasLocation ? 'clickable' : '';
            const busId = arr.shiftSolutionId || '';

            // Show calculated estimate under official time if both exist
            const showComparison = arr.officialEta !== null && arr.officialEta !== undefined && arr.calculatedEta;
            const comparisonHtml = showComparison
                ? `<span class="arrival-time-estimate" onclick="event.stopPropagation(); showEstimateInfo();">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M12 16v-4M12 8h.01"/>
                    </svg>
                    Our Est: ${arr.calculatedEta}m
                </span>`
                : '';

            return `
                <div class="arrival-card ${clickableClass}" style="animation-delay: ${i * 50}ms" data-bus-id="${busId}" data-bus-lat="${loc.latitude || ''}" data-bus-lon="${loc.longitude || ''}">
                    <div class="arrival-card-header">
                        <div class="arrival-route">
                            <span class="arrival-route-dot" style="background: ${color}"></span>
                            <span class="arrival-route-name">${arr.route.label}</span>
                        </div>
                        <div class="arrival-time-container">
                            <span class="arrival-time ${eta.className}">${eta.text}</span>
                            ${comparisonHtml}
                        </div>
                    </div>
                    <div class="arrival-details">
                        <span class="arrival-detail-item">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <rect x="4" y="6" width="16" height="12" rx="2"/>
                                <circle cx="8" cy="20" r="2"/>
                                <circle cx="16" cy="20" r="2"/>
                            </svg>
                            ${vehicleName}
                        </span>
                        ${capacityHtml}
                        ${nextStopHtml}
                        ${distanceInfo ? `
                            <span class="arrival-detail-item">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                                </svg>
                                ${distanceInfo}
                            </span>
                        ` : ''}
                        ${timeAgo ? `
                            <span class="arrival-detail-item">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="12" r="10"/>
                                    <path d="M12 6v6l4 2" stroke="var(--bg-primary)" stroke-width="2"/>
                                </svg>
                                Updated ${timeAgo}
                            </span>
                        ` : ''}
                        ${(arr.officialEta !== null && arr.officialEta !== undefined) ? `
                            <span class="arrival-detail-item eta-source eta-live" title="Live ETA from transit system">
                                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                                    <circle cx="12" cy="12" r="6"/>
                                </svg>
                                Live
                            </span>
                        ` : `
                            <span class="arrival-detail-item eta-source eta-calculated" title="Estimated based on bus location, route distance, and typical stop times">
                                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                                </svg>
                                Estimated
                            </span>
                        `}
                    </div>
                    ${hasLocation ? `
                        <div class="arrival-card-action">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M9 18l6-6-6-6"/>
                            </svg>
                            View on map
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }
    
    // Directions button
    const hasCoords = stop.latitude && stop.longitude;
    const directionsUrl = hasCoords 
        ? `https://www.google.com/maps/dir/?api=1&destination=${stop.latitude},${stop.longitude}&travelmode=walking`
        : null;
    
    container.innerHTML = `
        <div class="detail-header">
            <h2 class="detail-stop-name">${stop.label}</h2>
            <div class="detail-meta">
                ${stop.distance ? `
                    <span class="detail-meta-item">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                        </svg>
                        ${formatDistance(stop.distance)} away
                    </span>
                ` : ''}
            </div>
        </div>
        
        ${routesBadges ? `
            <div class="detail-section">
                <h4 class="detail-section-title">Routes</h4>
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    ${routesBadges}
                </div>
            </div>
        ` : ''}
        
        <div class="detail-section">
            <h4 class="detail-section-title">Next Arrivals</h4>
            ${arrivalsHtml}
        </div>
        
        ${directionsUrl ? `
            <a href="${directionsUrl}" target="_blank" rel="noopener" class="btn-directions">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M21.71 11.29l-9-9c-.39-.39-1.02-.39-1.41 0l-9 9c-.39.39-.39 1.02 0 1.41l9 9c.39.39 1.02.39 1.41 0l9-9c.39-.38.39-1.01 0-1.41zM14 14.5V12h-4v3H8v-4c0-.55.45-1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/>
                </svg>
                Get Directions
            </a>
        ` : ''}
    `;

    // Add click handlers for clickable arrival cards
    container.querySelectorAll('.arrival-card.clickable').forEach(card => {
        card.addEventListener('click', () => {
            const busLat = parseFloat(card.dataset.busLat);
            const busLon = parseFloat(card.dataset.busLon);
            if (busLat && busLon) {
                showBusOnMap(busLat, busLon);
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Filter Dropdown (on Map)
// ─────────────────────────────────────────────────────────────────────────────

function renderRouteFilterDropdown() {
    const container = $('#route-filter-dropdown');
    if (!container) return;
    
    // "All Routes" option
    let html = `
        <button class="route-filter-item all-routes ${!state.selectedRouteFilter ? 'active' : ''}" data-route-id="">
            <span class="route-filter-dot" style="background: linear-gradient(135deg, #CFB991, #8E6F3E)"></span>
            <span class="route-filter-name">All Routes</span>
            <svg class="route-filter-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
        </button>
    `;
    
    // Individual routes
    html += state.routes.map(route => {
        const color = normalizeColor(route.colour);
        const isActive = state.selectedRouteFilter === route.id;
        
        // Count active buses on this route
        const activeBuses = state.runningBuses.filter(bus => {
            const busRoute = bus.route || {};
            return busRoute.id === route.id || busRoute.label === route.label;
        }).length;
        
        const busIndicator = activeBuses > 0 ? ` (${activeBuses} bus${activeBuses > 1 ? 'es' : ''})` : '';
        
        return `
            <button class="route-filter-item ${isActive ? 'active' : ''}" data-route-id="${route.id}">
                <span class="route-filter-dot" style="background: ${color}"></span>
                <span class="route-filter-name">${route.label}${busIndicator}</span>
                <svg class="route-filter-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            </button>
        `;
    }).join('');
    
    container.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Map View
// ─────────────────────────────────────────────────────────────────────────────

function initMap() {
    if (state.map) return;
    
    const lat = state.userLat || CONFIG.DEFAULT_LAT;
    const lon = state.userLon || CONFIG.DEFAULT_LON;
    
    state.map = L.map('map', {
        center: [lat, lon],
        zoom: CONFIG.MAP_ZOOM_DEFAULT,
        zoomControl: true,
    });
    
    // Use CartoDB Dark Matter tiles for dark theme
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20,
    }).addTo(state.map);
    
    // Add user marker
    if (state.userLat && state.userLon) {
        const userIcon = L.divIcon({
            className: 'user-marker-container',
            html: '<div class="user-marker"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
        });
        
        state.userMarker = L.marker([state.userLat, state.userLon], { icon: userIcon })
            .addTo(state.map);
    }
    
    // Initial render of stops and buses
    updateMapMarkers();
}

function updateMapMarkers() {
    if (!state.map) return;
    
    // Clear existing markers and polylines
    state.stopMarkers.forEach(m => m.remove());
    state.busMarkers.forEach(m => m.remove());
    state.routePolylines.forEach(p => p.remove());
    state.stopMarkers = [];
    state.busMarkers = [];
    state.routePolylines = [];
    
    const filterRouteId = state.selectedRouteFilter;
    
    // Note: Route polylines are not drawn because the API doesn't provide
    // actual road geometry. Connecting stops with straight lines looks wrong
    // since buses follow roads, not straight paths between stops.
    
    // Add stop markers
    for (const stop of state.stops) {
        if (!stop.latitude || !stop.longitude) continue;
        
        // Check if stop belongs to filtered route
        if (filterRouteId) {
            const stopRouteIds = (stop.routes || []).map(r => r.id);
            if (!stopRouteIds.includes(filterRouteId)) continue;
        }
        
        // Get color from first route (or filtered route)
        let stopColor = '#CFB991'; // Default gold
        if (filterRouteId) {
            const route = state.routes.find(r => r.id === filterRouteId);
            if (route) stopColor = normalizeColor(route.colour);
        } else if (stop.routes && stop.routes[0]) {
            stopColor = normalizeColor(stop.routes[0].colour);
        }
        
        const stopIcon = L.divIcon({
            className: 'stop-marker-container',
            html: `
                <div class="stop-marker" style="border-color: ${stopColor}">
                    <svg viewBox="0 0 24 24" fill="${stopColor}">
                        <rect x="6" y="2" width="12" height="18" rx="2"/>
                        <circle cx="12" cy="22" r="2"/>
                    </svg>
                </div>
            `,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
        });
        
        const marker = L.marker([stop.latitude, stop.longitude], { icon: stopIcon })
            .addTo(state.map);
        
        // Popup content
        const routeNames = (stop.routes || []).map(r => r.label).join(', ') || 'Unknown';
        marker.bindPopup(`
            <div class="popup-stop-name">${stop.label}</div>
            <div class="popup-stop-routes">${routeNames}</div>
        `);
        
        marker.on('click', () => {
            showMapStopInfo(stop);
        });
        
        state.stopMarkers.push(marker);
    }
    
    // Add bus markers
    for (const bus of state.runningBuses) {
        const loc = bus.location;
        if (!loc?.latitude || !loc?.longitude) continue;
        
        const route = bus.route || {};
        
        // Skip if filtering and this bus isn't on the selected route
        if (filterRouteId && route.id !== filterRouteId) continue;
        
        const color = normalizeColor(route.colour);
        
        const busIcon = L.divIcon({
            className: 'bus-marker-container',
            html: `
                <div class="bus-marker" style="background: ${color}">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <rect x="4" y="6" width="16" height="12" rx="2"/>
                        <circle cx="8" cy="20" r="2"/>
                        <circle cx="16" cy="20" r="2"/>
                    </svg>
                </div>
            `,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
        });
        
        const marker = L.marker([loc.latitude, loc.longitude], { icon: busIcon })
            .addTo(state.map);
        
        const vehicle = bus.vehicle || {};
        const vehicleName = first(vehicle.displayName, vehicle.name) || 'Bus';
        const capacity = formatCapacity(bus.capacity);
        
        let capacityLine = '';
        if (capacity) {
            capacityLine = `<div class="popup-stop-routes ${capacity.className}">${capacity.icon} ${capacity.text}</div>`;
        }
        
        marker.bindPopup(`
            <div class="popup-stop-name">${route.label || 'Unknown Route'}</div>
            <div class="popup-stop-routes">${vehicleName}</div>
            ${capacityLine}
        `);
        
        state.busMarkers.push(marker);
    }
}

function showMapStopInfo(stop) {
    const overlay = $('#map-overlay');
    const arrivals = getNextArrivalsForStop(stop.id);
    
    let arrivalsHtml = '';
    if (arrivals.length === 0) {
        arrivalsHtml = '<p class="no-arrivals">No buses en route</p>';
    } else {
        arrivalsHtml = arrivals.slice(0, 2).map(arr => {
            const eta = formatETA(arr.etaMinutes);
            const color = normalizeColor(arr.route.colour);
            const capacity = formatCapacity(arr.capacity);
            
            let capacityHtml = '';
            if (capacity) {
                capacityHtml = `<span class="arrival-capacity ${capacity.className}" title="${capacity.text}">${capacity.icon}</span>`;
            }
            
            return `
                <div class="arrival-row">
                    <div class="route-badge" style="background: ${color}20">
                        <span class="dot" style="background: ${color}"></span>
                        <span class="name">${arr.route.label}</span>
                    </div>
                    <div class="arrival-info">
                        ${capacityHtml}
                        <span class="arrival-eta ${eta.className}">${eta.text}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    overlay.innerHTML = `
        <div class="map-stop-info">
            <div class="map-stop-info-header">
                <span class="map-stop-info-name">${stop.label}</span>
                <button class="map-stop-info-close" onclick="hideMapStopInfo()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
            <div class="stop-arrivals">
                ${arrivalsHtml}
            </div>
        </div>
    `;
}

function hideMapStopInfo() {
    $('#map-overlay').innerHTML = '';
}

function centerMapOnUser() {
    if (!state.map || !state.userLat || !state.userLon) return;
    state.map.setView([state.userLat, state.userLon], CONFIG.MAP_ZOOM_DEFAULT);
}

/**
 * Show a specific bus location on the map
 * Switches to map view and centers on the bus
 */
function showBusOnMap(lat, lon) {
    // Switch to map view
    updateHeaderTitle('Map');
    $('#btn-back').classList.add('hidden');
    switchView('map');

    // Wait for map to initialize then center on bus
    setTimeout(() => {
        if (state.map) {
            state.map.setView([lat, lon], CONFIG.MAP_ZOOM_FOCUSED);

            // Find and highlight the bus marker (open its popup)
            for (const marker of state.busMarkers) {
                const markerLatLng = marker.getLatLng();
                const dist = haversineDistance(markerLatLng.lat, markerLatLng.lng, lat, lon);
                if (dist < 0.01) { // Within ~50 feet
                    marker.openPopup();
                    break;
                }
            }
        }
    }, 150);
}

// ─────────────────────────────────────────────────────────────────────────────
// View Navigation
// ─────────────────────────────────────────────────────────────────────────────

function switchView(viewName) {
    const views = ['nearby', 'detail', 'map'];
    
    for (const view of views) {
        const el = $(`#view-${view}`);
        if (view === viewName) {
            el.classList.add('active');
            el.classList.remove('slide-left');
        } else {
            el.classList.remove('active');
        }
    }
    
    // Update nav
    $$('.nav-item').forEach(item => {
        const itemView = item.dataset.view;
        if (itemView === viewName || (viewName === 'detail' && itemView === 'nearby')) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    // Initialize map if switching to map view
    if (viewName === 'map') {
        setTimeout(() => {
            initMap();
            renderRouteFilterDropdown();
            state.map?.invalidateSize();
        }, 100);
    }
    
    state.currentView = viewName;
}

function goBack() {
    if (state.currentView === 'detail') {
        state.selectedStop = null;
        state.selectedStopArrivals = [];
        updateHeaderTitle('Nearby Stops');
        $('#btn-back').classList.add('hidden');
        switchView('nearby');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Refresh & Data Loading
// ═══════════════════════════════════════════════════════════════════════════

async function refreshData() {
    const refreshBtn = $('#btn-refresh');
    refreshBtn.classList.add('refreshing');
    
    try {
        // Fetch running buses
        state.runningBuses = await fetchRunningBuses();
        
        // Recalculate nearby stops
        calculateNearbyStops();
        
        // Re-render current view
        if (state.currentView === 'nearby') {
            renderNearbyStops();
        } else if (state.currentView === 'detail' && state.selectedStop) {
            const arrivals = await fetchArrivalsForStop(state.selectedStop.id);
            state.selectedStopArrivals = arrivals;
            renderStopDetail(state.selectedStop, arrivals);
        } else if (state.currentView === 'map') {
            updateMapMarkers();
        }
        
    } catch (err) {
        console.error('Refresh error:', err);
        showToast('Failed to refresh data', 'error');
    } finally {
        refreshBtn.classList.remove('refreshing');
    }
}

async function loadInitialData() {
    setLoadingStatus('Fetching routes...');
    console.log('[INIT] Fetching routes and stops...');
    
    try {
        const { routes, stops } = await fetchRoutesAndStops();
        state.routes = routes;
        state.stops = stops;
        console.log(`[INIT] Got ${routes.length} routes, ${stops.length} stops`);
    } catch (err) {
        console.error('[INIT] Failed to fetch routes:', err);
        throw err;
    }
    
    setLoadingStatus('Fetching active buses...');
    console.log('[INIT] Fetching running buses...');
    
    try {
        state.runningBuses = await fetchRunningBuses();
        console.log(`[INIT] Got ${state.runningBuses.length} running buses`);
    } catch (err) {
        console.error('[INIT] Failed to fetch buses:', err);
        // Don't throw - we can still show stops without buses
        state.runningBuses = [];
        showToast('Could not load bus data', 'warning');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
    try {
        // Get user location
        setLoadingStatus('Getting your location...');
        
        try {
            const location = await getCurrentLocation();
            state.userLat = location.lat;
            state.userLon = location.lon;
            
            // Reverse geocode
            setLoadingStatus('Finding your address...');
            state.userAddress = await reverseGeocode(location.lat, location.lon);
        } catch (locErr) {
            console.warn('Location error:', locErr);
            // Use default Purdue location
            state.userLat = CONFIG.DEFAULT_LAT;
            state.userLon = CONFIG.DEFAULT_LON;
            state.userAddress = 'Purdue University';
            showToast('Using default campus location', 'info');
        }
        
        updateLocationBar();
        
        // Load data
        await loadInitialData();
        
        // Calculate nearby stops
        calculateNearbyStops();
        
        // Hide loading, show app
        hideLoading();
        
        // Render initial view
        renderNearbyStops();
        
        // Start auto-refresh
        state.refreshInterval = setInterval(refreshData, CONFIG.REFRESH_INTERVAL_MS);
        
    } catch (err) {
        console.error('Init error:', err);
        setLoadingStatus('Error loading data. Please refresh.');
        showToast('Failed to load transit data', 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // Navigation buttons
    $$('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            
            if (state.currentView === 'detail') {
                goBack();
            }
            
            if (view === 'nearby') {
                updateHeaderTitle('Nearby Stops');
                $('#btn-back').classList.add('hidden');
            } else if (view === 'map') {
                updateHeaderTitle('Map');
                $('#btn-back').classList.add('hidden');
            }
            
            switchView(view);
        });
    });
    
    // Header buttons
    $('#btn-back').addEventListener('click', goBack);
    $('#btn-refresh').addEventListener('click', refreshData);
    $('#btn-locate').addEventListener('click', async () => {
        try {
            const location = await getCurrentLocation();
            state.userLat = location.lat;
            state.userLon = location.lon;
            state.userAddress = await reverseGeocode(location.lat, location.lon);
            updateLocationBar();
            
            calculateNearbyStops();
            renderNearbyStops();
            
            if (state.map) {
                if (state.userMarker) {
                    state.userMarker.setLatLng([location.lat, location.lon]);
                }
                centerMapOnUser();
            }
            
            showToast('Location updated', 'success');
        } catch {
            showToast('Unable to get location', 'error');
        }
    });
    
    // Route filter toggle
    const filterToggle = $('#route-filter-toggle');
    const filterDropdown = $('#route-filter-dropdown');
    const filterContainer = $('#map-route-filter');
    
    filterToggle?.addEventListener('click', () => {
        state.routeFilterOpen = !state.routeFilterOpen;
        filterDropdown?.classList.toggle('hidden', !state.routeFilterOpen);
        filterContainer?.classList.toggle('open', state.routeFilterOpen);
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (state.routeFilterOpen && !filterContainer?.contains(e.target)) {
            state.routeFilterOpen = false;
            filterDropdown?.classList.add('hidden');
            filterContainer?.classList.remove('open');
        }
    });
    
    // Route filter selection
    filterDropdown?.addEventListener('click', (e) => {
        const item = e.target.closest('.route-filter-item');
        if (!item) return;
        
        const routeId = item.dataset.routeId;
        
        // Update selection
        state.selectedRouteFilter = routeId || null;
        
        // Update label
        const label = $('#route-filter-label');
        if (routeId) {
            const route = state.routes.find(r => r.id === routeId);
            label.textContent = route?.label || 'Unknown';
        } else {
            label.textContent = 'All Routes';
        }
        
        // Update active states
        filterDropdown.querySelectorAll('.route-filter-item').forEach(el => {
            el.classList.toggle('active', el.dataset.routeId === (routeId || ''));
        });
        
        // Close dropdown
        state.routeFilterOpen = false;
        filterDropdown.classList.add('hidden');
        filterContainer?.classList.remove('open');
        
        // Re-render map
        updateMapMarkers();
    });
    
    // Initialize app
    init();
});

// Register service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('[SW] Registered'))
        .catch(err => console.log('[SW] Registration failed:', err));
}

// Make functions globally available
window.hideMapStopInfo = hideMapStopInfo;

/**
 * Show info popup explaining how our ETA estimate is calculated
 */
function showEstimateInfo() {
    const modal = document.createElement('div');
    modal.className = 'estimate-info-modal';
    modal.innerHTML = `
        <div class="estimate-info-backdrop" onclick="this.parentElement.remove()"></div>
        <div class="estimate-info-content">
            <div class="estimate-info-header">
                <h3>How We Calculate ETAs</h3>
                <button class="estimate-info-close" onclick="this.closest('.estimate-info-modal').remove()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
            <div class="estimate-info-body">
                <p>When official ETAs are available, we also show our own estimate for comparison. Here's how we calculate it:</p>
                <ul>
                    <li><strong>Average Speed:</strong> ${CONFIG.BUS_AVG_SPEED_MPH} mph (accounting for stops, traffic, and campus conditions)</li>
                    <li><strong>Stop Time:</strong> ${CONFIG.STOP_TIME_SECONDS} seconds per intermediate stop</li>
                    <li><strong>Traffic Buffer:</strong> ${Math.round(CONFIG.TRAFFIC_BUFFER_PERCENT * 100)}% added for delays</li>
                </ul>
                <p class="estimate-info-note">Our estimate uses the bus's GPS location and calculates the route distance through each stop. The official "Live" ETA comes directly from the transit system.</p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}
window.showEstimateInfo = showEstimateInfo;
