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

    // [DISABLED] Maximum ETA to display (minutes) - arrivals beyond this are considered "not running"
    // MAX_DISPLAY_ETA_MINUTES: window.APP_CONFIG?.MAX_DISPLAY_ETA_MINUTES || 60,

    // Operating hours (Indiana time - America/Indiana/Indianapolis)
    OPERATING_HOURS_START: window.APP_CONFIG?.OPERATING_HOURS_START || 7,  // 7 AM
    OPERATING_HOURS_END: window.APP_CONFIG?.OPERATING_HOURS_END || 19,     // 7 PM (19:00)
    TIMEZONE: window.APP_CONFIG?.TIMEZONE || 'America/Indiana/Indianapolis',

    // Maximum ETA to display - arrivals beyond this are hidden
    MAX_DISPLAY_ETA_MINUTES: window.APP_CONFIG?.MAX_DISPLAY_ETA_MINUTES || 100,
};

// Validate and sanitize CONFIG values to prevent issues from invalid configuration
(function validateConfig() {
    // API timeout: must be between 5s and 2min
    if (typeof CONFIG.API_TIMEOUT_MS !== 'number' || CONFIG.API_TIMEOUT_MS < 5000 || CONFIG.API_TIMEOUT_MS > 120000) {
        console.warn('[CONFIG] Invalid API_TIMEOUT_MS, using default 30000ms');
        CONFIG.API_TIMEOUT_MS = 30000;
    }

    // Bus speed: must be positive and reasonable (1-60 mph)
    if (typeof CONFIG.BUS_AVG_SPEED_MPH !== 'number' || CONFIG.BUS_AVG_SPEED_MPH <= 0 || CONFIG.BUS_AVG_SPEED_MPH > 60) {
        console.warn('[CONFIG] Invalid BUS_AVG_SPEED_MPH, using default 10mph');
        CONFIG.BUS_AVG_SPEED_MPH = 10;
    }

    // Refresh interval: must be between 5s and 5min
    if (typeof CONFIG.REFRESH_INTERVAL_MS !== 'number' || CONFIG.REFRESH_INTERVAL_MS < 5000 || CONFIG.REFRESH_INTERVAL_MS > 300000) {
        console.warn('[CONFIG] Invalid REFRESH_INTERVAL_MS, using default 30000ms');
        CONFIG.REFRESH_INTERVAL_MS = 30000;
    }

    // Nearby radius: must be positive and reasonable (0.01-10 miles)
    if (typeof CONFIG.NEARBY_RADIUS_MILES !== 'number' || CONFIG.NEARBY_RADIUS_MILES <= 0 || CONFIG.NEARBY_RADIUS_MILES > 10) {
        console.warn('[CONFIG] Invalid NEARBY_RADIUS_MILES, using default 0.5 miles');
        CONFIG.NEARBY_RADIUS_MILES = 0.5;
    }
})();

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
    routeStopSequences: new Map(), // Maps routeId -> ordered array of stops with coords
    routeShapes: new Map(), // Maps routeId -> ordered array of path coordinates from API
    
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

/**
 * Escape HTML to prevent XSS attacks
 * Use this for any user-provided or API-sourced data inserted into innerHTML
 */
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

/**
 * Set refresh interval, clearing any existing one first
 * Prevents multiple concurrent refresh timers
 */
function setRefreshInterval(intervalMs) {
    if (state.refreshInterval) {
        clearInterval(state.refreshInterval);
    }
    state.refreshInterval = setInterval(refreshData, intervalMs);
}

/**
 * Get current time in Indiana timezone
 * Supports DEBUG_TIME_OVERRIDE from server.py for testing
 * @returns {Object} { hours, minutes, date }
 */
function getIndianaTime() {
    // Check for debug time override (set by server.py --time flag)
    if (window.DEBUG_TIME_OVERRIDE) {
        const [hours, minutes] = window.DEBUG_TIME_OVERRIDE.split(':').map(Number);
        return { hours, minutes, date: new Date() };
    }

    const now = new Date();
    // Get the time string in Indiana timezone
    const options = {
        timeZone: CONFIG.TIMEZONE,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    };
    const timeStr = now.toLocaleString('en-US', options);
    const [hours, minutes] = timeStr.split(':').map(Number);
    return { hours, minutes, date: now };
}

/**
 * Check if buses are currently operating (7 AM - 7 PM Indiana time)
 * @returns {Object} { isOperating, currentHour, minutesUntilStart, nextStartTime }
 */
function checkOperatingHours() {
    const { hours, minutes } = getIndianaTime();
    const isOperating = hours >= CONFIG.OPERATING_HOURS_START && hours < CONFIG.OPERATING_HOURS_END;

    let minutesUntilStart = 0;
    let nextStartTime = '';

    if (!isOperating) {
        // Calculate time until 7 AM
        if (hours >= CONFIG.OPERATING_HOURS_END) {
            // After 7 PM - next service is tomorrow at 7 AM
            const hoursUntil = (24 - hours) + CONFIG.OPERATING_HOURS_START;
            minutesUntilStart = (hoursUntil * 60) - minutes;
        } else {
            // Before 7 AM - service starts today at 7 AM
            const hoursUntil = CONFIG.OPERATING_HOURS_START - hours;
            minutesUntilStart = (hoursUntil * 60) - minutes;
        }

        // Format next start time
        const hoursLeft = Math.floor(minutesUntilStart / 60);
        const minsLeft = minutesUntilStart % 60;
        if (hoursLeft > 0) {
            nextStartTime = `${hoursLeft}h ${minsLeft}m`;
        } else {
            nextStartTime = `${minsLeft} min`;
        }
    }

    return {
        isOperating,
        currentHour: hours,
        minutesUntilStart,
        nextStartTime,
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
    const routeShapes = new Map(); // For map display and position tracking
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

        // Extract route shape from API (orderedCoordinates)
        const routeShape = route.routeShape;
        if (routeShape && Array.isArray(routeShape.orderedCoordinates)) {
            const shapeCoords = routeShape.orderedCoordinates
                .filter(c => c.latitude && c.longitude)
                .map(c => ({ latitude: c.latitude, longitude: c.longitude }));
            if (shapeCoords.length > 0) {
                routeShapes.set(routeId || routeLabel, {
                    coordinates: shapeCoords,
                    colour: routeColour,
                    label: routeLabel,
                });
            }
        }

        routes.push({
            id: routeId || routeLabel,
            label: routeLabel,
            colour: routeColour,
            stops,
        });
    }

    // Store route sequences and shapes in state
    state.routeStopSequences = routeStopSequences;
    state.routeShapes = routeShapes;
    
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
 * Calculate perpendicular distance from a point to a line segment
 * Returns the distance and how far along the segment (0-1) the closest point is
 */
function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
        // Segment is a point
        return { distance: Math.sqrt((px - x1) ** 2 + (py - y1) ** 2), t: 0 };
    }

    // Project point onto line, clamped to segment
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    const distance = Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);

    return { distance, t };
}

/**
 * Find the position of a point along a route shape path.
 * Returns the segment index and the cumulative distance from the start.
 */
function findPositionOnRoute(lat, lon, shapeCoords) {
    let bestSegment = 0;
    let bestDistance = Infinity;
    let bestT = 0;

    for (let i = 0; i < shapeCoords.length - 1; i++) {
        const a = shapeCoords[i];
        const b = shapeCoords[i + 1];

        const result = pointToSegmentDistance(
            lon, lat,
            a.longitude, a.latitude,
            b.longitude, b.latitude
        );

        if (result.distance < bestDistance) {
            bestDistance = result.distance;
            bestSegment = i;
            bestT = result.t;
        }
    }

    // Return a "progress" value: segment index + fraction along that segment
    return bestSegment + bestT;
}

/**
 * Get the next stop for a bus based on its current position along the route shape.
 * Uses the ordered route shape coordinates to determine exact position and direction.
 * @returns {Object|null} { id, label } of the next stop, or null if unknown
 */
function getNextStopForBus(bus) {
    const loc = bus.location || {};
    const busLat = loc.latitude;
    const busLon = loc.longitude;
    const route = bus.route || {};
    const routeId = route.id || route.label;

    if (!busLat || !busLon || !routeId) return null;

    // Get the stop sequence and route shape for this route
    const stopSequence = state.routeStopSequences.get(routeId);
    const routeShape = state.routeShapes.get(routeId);

    if (!stopSequence || stopSequence.length < 2) return null;

    // If we have a detailed route shape, use it for precise positioning
    if (routeShape && routeShape.coordinates && routeShape.coordinates.length > 1) {
        const shapeCoords = routeShape.coordinates;

        // Find where the bus is on the route shape
        const busProgress = findPositionOnRoute(busLat, busLon, shapeCoords);

        // Find where each stop is on the route shape
        const stopPositions = stopSequence.map(stop => ({
            stop,
            progress: findPositionOnRoute(stop.latitude, stop.longitude, shapeCoords)
        }));

        // Find the first stop that comes after the bus's current position
        // For loop routes, we may need to wrap around
        let nextStop = null;
        let minProgressAhead = Infinity;

        for (const sp of stopPositions) {
            let progressAhead = sp.progress - busProgress;

            // Handle wraparound for loop routes (stop is "behind" but actually ahead)
            if (progressAhead < 0) {
                progressAhead += shapeCoords.length;
            }

            // Must be ahead (progress > 0) but also reasonably close
            // Use a small threshold to avoid selecting a stop we just passed
            if (progressAhead > 0.5 && progressAhead < minProgressAhead) {
                minProgressAhead = progressAhead;
                nextStop = sp.stop;
            }
        }

        // If no stop found ahead, take the first stop (loop wraparound)
        if (!nextStop) {
            nextStop = stopSequence[0];
        }

        const fullStop = state.stops.find(s => s.id === nextStop.id);
        return {
            id: nextStop.id,
            label: fullStop?.label || 'Next stop',
        };
    }

    // Fallback: use simple stop-to-stop segment matching
    let bestSegmentEnd = 1;
    let bestDistance = Infinity;

    for (let i = 0; i < stopSequence.length - 1; i++) {
        const stopA = stopSequence[i];
        const stopB = stopSequence[i + 1];

        const result = pointToSegmentDistance(
            busLon, busLat,
            stopA.longitude, stopA.latitude,
            stopB.longitude, stopB.latitude
        );

        if (result.distance < bestDistance) {
            bestDistance = result.distance;
            bestSegmentEnd = i + 1;
        }
    }

    // For loop routes, check segment from last stop back to first
    if (stopSequence.length > 2) {
        const lastStop = stopSequence[stopSequence.length - 1];
        const firstStop = stopSequence[0];

        const result = pointToSegmentDistance(
            busLon, busLat,
            lastStop.longitude, lastStop.latitude,
            firstStop.longitude, firstStop.latitude
        );

        if (result.distance < bestDistance) {
            bestSegmentEnd = 0;
        }
    }

    const nextStopData = stopSequence[bestSegmentEnd];
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

                // Calculate the actual next stop for this bus based on its position
                // Note: route.busTowards is the route direction/terminus, not the next stop
                const nextStop = getNextStopForBus(bus.shiftSolutionId ? bus : { ...entry, route, location: bus.location });

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
    toast.innerHTML = `<span class="toast-message">${escapeHtml(message)}</span>`;
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

/**
 * Show floating off-hours banner pill
 */
function showOffHoursBanner() {
    // Remove existing banner if any
    hideOffHoursBanner();

    const { nextStartTime } = checkOperatingHours();

    const banner = document.createElement('div');
    banner.id = 'off-hours-banner';
    banner.className = 'off-hours-banner';
    banner.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
        </svg>
        <span>Buses resume in <strong>${escapeHtml(nextStartTime)}</strong></span>
        <span class="off-hours-times">7 AM – 7 PM</span>
    `;

    // Insert after header
    const mainApp = $('#main-app');
    const header = mainApp.querySelector('.header');
    if (header && header.nextSibling) {
        header.parentNode.insertBefore(banner, header.nextSibling);
    } else {
        mainApp.prepend(banner);
    }
}

/**
 * Hide the off-hours banner
 */
function hideOffHoursBanner() {
    const existing = $('#off-hours-banner');
    if (existing) {
        existing.remove();
    }
}

async function renderNearbyStops() {
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

    // Check if we should fetch ETAs (only during operating hours)
    const { isOperating } = checkOperatingHours();

    if (isOperating) {
        // Fetch official ETAs for all nearby stops in parallel
        const arrivalsPromises = state.nearbyStops.map(stop =>
            fetchArrivalsForStop(stop.id).catch(() => getNextArrivalsForStop(stop.id))
        );
        const allArrivals = await Promise.all(arrivalsPromises);

        // Render cards with official ETAs
        state.nearbyStops.forEach((stop, index) => {
            const arrivals = allArrivals[index];
            const card = createStopCard(stop, arrivals);
            container.appendChild(card);
        });
    } else {
        // Off-hours: render cards without ETAs (empty arrivals)
        state.nearbyStops.forEach(stop => {
            const card = createStopCard(stop, []);
            container.appendChild(card);
        });
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

    // Filter out arrivals with ETA > 100 minutes
    const filteredArrivals = arrivals.filter(arr =>
        arr.etaMinutes !== null && arr.etaMinutes <= CONFIG.MAX_DISPLAY_ETA_MINUTES
    );

    let arrivalsHtml = '';
    if (filteredArrivals.length === 0) {
        arrivalsHtml = '<p class="no-arrivals">No buses currently en route</p>';
    } else {
        const displayArrivals = filteredArrivals.slice(0, 3);
        arrivalsHtml = displayArrivals.map(arr => {
            const eta = formatETA(arr.etaMinutes);
            const color = normalizeColor(arr.route.colour);
            const capacity = formatCapacity(arr.capacity);

            let capacityHtml = '';
            if (capacity) {
                capacityHtml = `<span class="arrival-capacity ${escapeHtml(capacity.className)}" title="${escapeHtml(capacity.text)}">${escapeHtml(capacity.icon)}</span>`;
            }

            // Next stop info
            let nextStopHtml = '';
            if (arr.nextStop && arr.nextStop.label) {
                nextStopHtml = `<span class="arrival-next-stop" title="Next stop">Next: ${escapeHtml(arr.nextStop.label)}</span>`;
            }

            return `
                <div class="arrival-row">
                    <div class="arrival-route-info">
                        <div class="route-badge" style="background: ${color}20">
                            <span class="dot" style="background: ${color}"></span>
                            <span class="name">${escapeHtml(arr.route.label)}</span>
                        </div>
                        ${nextStopHtml}
                    </div>
                    <div class="arrival-info">
                        ${capacityHtml}
                        <span class="arrival-eta ${escapeHtml(eta.className)}">${escapeHtml(eta.text)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    card.innerHTML = `
        <div class="stop-card-header">
            <h3 class="stop-name">${escapeHtml(stop.label)}</h3>
            <span class="stop-distance">${escapeHtml(distanceStr)}</span>
        </div>
        <div class="stop-arrivals">
            ${arrivalsHtml}
        </div>
    `;
    
    card.addEventListener('click', () => {
        showStopDetail(stop).catch(err => {
            console.error('[UI] Error showing stop detail:', err);
            showToast('Failed to load stop details', 'error');
        });
    });

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

    // Check operating hours before fetching
    const { isOperating } = checkOperatingHours();

    if (isOperating) {
        // Show loading state
        const container = $('#stop-detail');
        container.innerHTML = `
            <div class="detail-header">
                <h2 class="detail-stop-name">${escapeHtml(stop.label)}</h2>
                <div class="detail-meta">
                    <span class="detail-meta-item">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                        </svg>
                        ${escapeHtml(formatDistance(stop.distance || 0))} away
                    </span>
                </div>
            </div>
            <div class="detail-section">
                <h4 class="detail-section-title">Loading arrivals...</h4>
                <div class="skeleton skeleton-card"></div>
                <div class="skeleton skeleton-card"></div>
            </div>
        `;

        // Fetch arrivals during operating hours
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
    } else {
        // Off-hours: show stop info without live arrivals (no loading state)
        state.selectedStopArrivals = [];
        renderStopDetail(stop, []);
    }
}

function renderStopDetail(stop, arrivals) {
    const container = $('#stop-detail');

    // Filter out arrivals with ETA > 100 minutes
    const filteredArrivals = arrivals.filter(arr =>
        arr.etaMinutes !== null && arr.etaMinutes <= CONFIG.MAX_DISPLAY_ETA_MINUTES
    );

    // Routes serving this stop
    const routesBadges = (stop.routes || []).map(r => {
        const color = normalizeColor(r.colour);
        return `<span class="route-badge" style="background: ${color}20">
            <span class="dot" style="background: ${color}"></span>
            <span class="name">${escapeHtml(r.label)}</span>
        </span>`;
    }).join('');

    // Arrivals
    let arrivalsHtml = '';
    if (filteredArrivals.length === 0) {
        arrivalsHtml = `
            <div class="empty-state">
                <svg class="empty-state-icon" viewBox="0 0 1024 1024" fill="currentColor">
                    <g transform="translate(102.4, 102.4) scale(0.8)">
                        <path d="M126.03 744.104H72.219c-17.312 0-31.263-13.802-31.263-30.72v-488.11c0-16.912 13.955-30.72 31.263-30.72h879.565c17.311 0 31.252 13.801 31.252 30.72v488.11c0 16.926-13.937 30.72-31.252 30.72h-42.639c-11.311 0-20.48 9.169-20.48 20.48s9.169 20.48 20.48 20.48h42.639c39.843 0 72.212-32.038 72.212-71.68v-488.11c0-39.635-32.373-71.68-72.212-71.68H72.219c-39.833 0-72.223 32.049-72.223 71.68v488.11c0 39.639 32.387 71.68 72.223 71.68h53.811c11.311 0 20.48-9.169 20.48-20.48s-9.169-20.48-20.48-20.48z"/>
                        <path d="M693.76 744.104H334.848c-11.311 0-20.48 9.169-20.48 20.48s9.169 20.48 20.48 20.48H693.76c11.311 0 20.48-9.169 20.48-20.48s-9.169-20.48-20.48-20.48zM993.28 467.83h-97.812c-16.962 0-30.72-13.758-30.72-30.72V193.531c0-11.311-9.169-20.48-20.48-20.48s-20.48 9.169-20.48 20.48V437.11c0 39.583 32.097 71.68 71.68 71.68h97.812c11.311 0 20.48-9.169 20.48-20.48s-9.169-20.48-20.48-20.48z"/>
                        <path d="M884.53 764.584c0-45.238-36.679-81.92-81.92-81.92-45.234 0-81.92 36.686-81.92 81.92 0 45.241 36.682 81.92 81.92 81.92 45.245 0 81.92-36.675 81.92-81.92zm40.96 0c0 67.866-55.014 122.88-122.88 122.88-67.859 0-122.88-55.017-122.88-122.88 0-67.856 55.024-122.88 122.88-122.88 67.863 0 122.88 55.021 122.88 122.88zm-611.12 0c0-45.234-36.686-81.92-81.92-81.92-45.241 0-81.92 36.682-81.92 81.92 0 45.245 36.675 81.92 81.92 81.92 45.238 0 81.92-36.679 81.92-81.92zm40.96 0c0 67.863-55.021 122.88-122.88 122.88-67.866 0-122.88-55.014-122.88-122.88 0-67.859 55.017-122.88 122.88-122.88 67.856 0 122.88 55.024 122.88 122.88z"/>
                        <path d="M725.76 468.085V292.633h-102.4v175.452h102.4zm0 40.96h-102.4c-22.616 0-40.96-18.344-40.96-40.96V292.633c0-22.624 18.342-40.96 40.96-40.96h102.4c22.618 0 40.96 18.336 40.96 40.96v175.452c0 22.616-18.344 40.96-40.96 40.96zm-243.825-40.96V292.633h-102.4v175.452h102.4zm0 40.96h-102.4c-22.616 0-40.96-18.344-40.96-40.96V292.633c0-22.624 18.342-40.96 40.96-40.96h102.4c22.618 0 40.96 18.336 40.96 40.96v175.452c0 22.616-18.344 40.96-40.96 40.96zm-243.825-40.96V292.633h-102.4v175.452h102.4zm0 40.96h-102.4c-22.616 0-40.96-18.344-40.96-40.96V292.633c0-22.624 18.342-40.96 40.96-40.96h102.4c22.618 0 40.96 18.336 40.96 40.96v175.452c0 22.616-18.344 40.96-40.96 40.96z"/>
                    </g>
                </svg>
                <h3 class="empty-state-title">No buses en route</h3>
                <p class="empty-state-message">Check back soon or view the map for all active buses.</p>
            </div>
        `;
    } else {
        arrivalsHtml = filteredArrivals.map((arr, i) => {
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
                    <span class="arrival-detail-item ${escapeHtml(capacity.className)}">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                        </svg>
                        ${escapeHtml(capacity.text)}
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
                        Next: ${escapeHtml(arr.nextStop.label)}
                    </span>
                `;
            }

            // Check if bus has valid location for map view
            const hasLocation = loc.latitude && loc.longitude;
            const clickableClass = hasLocation ? 'clickable' : '';
            const busId = arr.shiftSolutionId || '';

            // [DISABLED] Show calculated estimate under official time if both exist
            // const showComparison = arr.officialEta !== null && arr.officialEta !== undefined && arr.calculatedEta;
            // const comparisonHtml = showComparison
            //     ? `<span class="arrival-time-estimate" onclick="event.stopPropagation(); showEstimateInfo();">
            //         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            //             <circle cx="12" cy="12" r="10"/>
            //             <path d="M12 16v-4M12 8h.01"/>
            //         </svg>
            //         Our Est: ${arr.calculatedEta}m
            //     </span>`
            //     : '';
            const comparisonHtml = ''; // Custom ETA comparison disabled

            return `
                <div class="arrival-card ${clickableClass}" style="animation-delay: ${i * 50}ms" data-bus-id="${escapeHtml(busId)}" data-bus-lat="${loc.latitude || ''}" data-bus-lon="${loc.longitude || ''}">
                    <div class="arrival-card-header">
                        <div class="arrival-route">
                            <span class="arrival-route-dot" style="background: ${color}"></span>
                            <span class="arrival-route-name">${escapeHtml(arr.route.label)}</span>
                        </div>
                        <div class="arrival-time-container">
                            <span class="arrival-time ${escapeHtml(eta.className)}">${escapeHtml(eta.text)}</span>
                            ${comparisonHtml}
                        </div>
                    </div>
                    <div class="arrival-details">
                        <span class="arrival-detail-item">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/>
                            </svg>
                            ${escapeHtml(vehicleName)}
                        </span>
                        ${capacityHtml}
                        ${nextStopHtml}
                        ${distanceInfo ? `
                            <span class="arrival-detail-item">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                                </svg>
                                ${escapeHtml(distanceInfo)}
                            </span>
                        ` : ''}
                        ${timeAgo ? `
                            <span class="arrival-detail-item">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="12" r="10"/>
                                    <path d="M12 6v6l4 2" stroke="var(--bg-primary)" stroke-width="2"/>
                                </svg>
                                Updated ${escapeHtml(timeAgo)}
                            </span>
                        ` : ''}
                        ${ /* [DISABLED] Live vs Estimated indicator - custom ETA feature disabled
                        (arr.officialEta !== null && arr.officialEta !== undefined) ? `
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
                        ` */ ''}
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
    
    // Directions URL
    const hasCoords = stop.latitude && stop.longitude;
    const directionsUrl = hasCoords
        ? `https://www.google.com/maps/dir/?api=1&destination=${stop.latitude},${stop.longitude}&travelmode=walking`
        : null;

    container.innerHTML = `
        <div class="detail-header">
            <h2 class="detail-stop-name">${escapeHtml(stop.label)}</h2>
            <div class="detail-meta">
                ${stop.distance ? `
                    <span class="detail-meta-item">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                        </svg>
                        ${escapeHtml(formatDistance(stop.distance))}
                    </span>
                ` : ''}
                ${directionsUrl ? `
                    <a href="${directionsUrl}" target="_blank" rel="noopener" class="directions-link" title="Get directions">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M21.71 11.29l-9-9c-.39-.39-1.02-.39-1.41 0l-9 9c-.39.39-.39 1.02 0 1.41l9 9c.39.39 1.02.39 1.41 0l9-9c.39-.38.39-1.01 0-1.41zM14 14.5V12h-4v3H8v-4c0-.55.45-1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/>
                        </svg>
                        Directions
                    </a>
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
            <button class="route-filter-item ${isActive ? 'active' : ''}" data-route-id="${escapeHtml(route.id)}">
                <span class="route-filter-dot" style="background: ${color}"></span>
                <span class="route-filter-name">${escapeHtml(route.label)}${escapeHtml(busIndicator)}</span>
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

    // Clear existing markers and polylines - remove event listeners first to prevent memory leaks
    state.stopMarkers.forEach(m => { m.off(); m.remove(); });
    state.busMarkers.forEach(m => { m.off(); m.remove(); });
    state.routePolylines.forEach(p => p.remove());
    state.stopMarkers = [];
    state.busMarkers = [];
    state.routePolylines = [];
    
    const filterRouteId = state.selectedRouteFilter;

    // Draw route polylines from API-provided route shapes
    for (const [routeId, shapeData] of state.routeShapes) {
        // Skip if filtering to a different route
        if (filterRouteId && routeId !== filterRouteId) continue;

        if (shapeData.coordinates && shapeData.coordinates.length > 1) {
            // Convert { latitude, longitude } to [lat, lng] for Leaflet
            const path = shapeData.coordinates.map(c => [c.latitude, c.longitude]);
            const color = normalizeColor(shapeData.colour);
            const polyline = L.polyline(path, {
                color: color,
                weight: 4,
                opacity: 0.7,
                lineCap: 'round',
                lineJoin: 'round',
            }).addTo(state.map);

            state.routePolylines.push(polyline);
        }
    }

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
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
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
            <div class="popup-stop-name">${escapeHtml(stop.label)}</div>
            <div class="popup-stop-routes">${escapeHtml(routeNames)}</div>
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
                        <path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/>
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
        const nextStop = getNextStopForBus(bus);

        let capacityLine = '';
        if (capacity) {
            capacityLine = `<div class="popup-stop-routes ${escapeHtml(capacity.className)}">${escapeHtml(capacity.icon)} ${escapeHtml(capacity.text)}</div>`;
        }

        let nextStopLine = '';
        if (nextStop && nextStop.label) {
            nextStopLine = `<div class="popup-stop-routes" style="color: var(--text-muted); font-size: 0.8rem;">Next: ${escapeHtml(nextStop.label)}</div>`;
        }

        marker.bindPopup(`
            <div class="popup-stop-name">${escapeHtml(route.label || 'Unknown Route')}</div>
            <div class="popup-stop-routes">${escapeHtml(vehicleName)}</div>
            ${nextStopLine}
            ${capacityLine}
        `);
        
        state.busMarkers.push(marker);
    }
}

function showMapStopInfo(stop) {
    const overlay = $('#map-overlay');
    const arrivals = getNextArrivalsForStop(stop.id);

    // Directions URL
    const hasCoords = stop.latitude && stop.longitude;
    const directionsUrl = hasCoords
        ? `https://www.google.com/maps/dir/?api=1&destination=${stop.latitude},${stop.longitude}&travelmode=walking`
        : null;

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
                capacityHtml = `<span class="arrival-capacity ${escapeHtml(capacity.className)}" title="${escapeHtml(capacity.text)}">${escapeHtml(capacity.icon)}</span>`;
            }

            let nextStopHtml = '';
            if (arr.nextStop && arr.nextStop.label) {
                nextStopHtml = `<span class="arrival-next-stop">Next: ${escapeHtml(arr.nextStop.label)}</span>`;
            }

            return `
                <div class="arrival-row">
                    <div class="arrival-route-info">
                        <div class="route-badge" style="background: ${color}20">
                            <span class="dot" style="background: ${color}"></span>
                            <span class="name">${escapeHtml(arr.route.label)}</span>
                        </div>
                        ${nextStopHtml}
                    </div>
                    <div class="arrival-info">
                        ${capacityHtml}
                        <span class="arrival-eta ${escapeHtml(eta.className)}">${escapeHtml(eta.text)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    overlay.innerHTML = `
        <div class="map-stop-info">
            <div class="map-stop-info-header">
                <span class="map-stop-info-name">${escapeHtml(stop.label)}</span>
                <div class="map-stop-info-actions">
                    ${directionsUrl ? `
                        <a href="${directionsUrl}" target="_blank" rel="noopener" class="directions-link" title="Get directions">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <path d="M21.71 11.29l-9-9c-.39-.39-1.02-.39-1.41 0l-9 9c-.39.39-.39 1.02 0 1.41l9 9c.39.39 1.02.39 1.41 0l9-9c.39-.38.39-1.01 0-1.41zM14 14.5V12h-4v3H8v-4c0-.55.45-1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/>
                            </svg>
                        </a>
                    ` : ''}
                    <button class="map-stop-info-close" onclick="hideMapStopInfo()">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
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
// Routes/Stops Caching (for off-hours browsing)
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_KEY = 'boilerbus_routes_cache';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Cache routes and stops to localStorage for off-hours use
 * Returns true on success, false on failure
 */
function cacheRoutesAndStops() {
    try {
        const cacheData = {
            timestamp: Date.now(),
            routes: state.routes,
            stops: state.stops,
            // Convert Maps to arrays for JSON serialization
            routeShapes: Array.from(state.routeShapes.entries()),
            routeStopSequences: Array.from(state.routeStopSequences.entries()),
        };
        localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
        console.log('[CACHE] Saved routes/stops to localStorage');
        return true;
    } catch (err) {
        console.warn('[CACHE] Failed to cache routes:', err);
        // Detect specific error types for better user feedback
        if (err.name === 'QuotaExceededError' || err.code === 22) {
            // Storage quota exceeded - try to clear old cache and retry once
            try {
                localStorage.removeItem(CACHE_KEY);
                const minimalData = {
                    timestamp: Date.now(),
                    routes: state.routes,
                    stops: state.stops,
                    routeShapes: [], // Skip shapes to reduce size
                    routeStopSequences: [],
                };
                localStorage.setItem(CACHE_KEY, JSON.stringify(minimalData));
                console.log('[CACHE] Saved minimal cache (without shapes)');
                return true;
            } catch {
                showToast('Storage full - offline mode limited', 'warning');
            }
        } else if (err.name === 'SecurityError') {
            // Private browsing mode or storage disabled
            console.log('[CACHE] Storage not available (private browsing?)');
        }
        return false;
    }
}

/**
 * Load cached routes and stops from localStorage
 * @returns {boolean} true if cache was loaded successfully
 */
function loadCachedRoutesAndStops() {
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (!cached) return false;

        const cacheData = JSON.parse(cached);

        // Check cache age
        const age = Date.now() - cacheData.timestamp;
        if (age > CACHE_MAX_AGE_MS) {
            console.log('[CACHE] Cache expired, will refresh');
            localStorage.removeItem(CACHE_KEY);
            return false;
        }

        // Restore state
        state.routes = cacheData.routes || [];
        state.stops = cacheData.stops || [];
        state.routeShapes = new Map(cacheData.routeShapes || []);
        state.routeStopSequences = new Map(cacheData.routeStopSequences || []);

        console.log(`[CACHE] Loaded ${state.routes.length} routes, ${state.stops.length} stops from cache`);
        return state.routes.length > 0;
    } catch (err) {
        console.warn('[CACHE] Failed to load cache:', err);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Refresh & Data Loading
// ═══════════════════════════════════════════════════════════════════════════

async function refreshData() {
    const refreshBtn = $('#btn-refresh');
    refreshBtn.classList.add('refreshing');

    // Check operating hours - skip API calls if outside 7 AM - 7 PM Indiana time
    const { isOperating } = checkOperatingHours();
    if (!isOperating) {
        console.log('[REFRESH] Outside operating hours, skipping API calls');
        // Update the banner with current time until service
        showOffHoursBanner();
        refreshBtn.classList.remove('refreshing');
        return;
    }

    // Hide off-hours banner if it was showing (service just resumed)
    hideOffHoursBanner();

    try {
        // If we don't have route data yet (was off-hours at init), load it now
        if (state.routes.length === 0) {
            console.log('[REFRESH] Service resumed, loading initial data...');
            await loadInitialData();
            calculateNearbyStops();

            // Switch to normal refresh interval
            setRefreshInterval(CONFIG.REFRESH_INTERVAL_MS);
        } else {
            // Normal refresh - just fetch running buses
            state.runningBuses = await fetchRunningBuses();
        }

        // Recalculate nearby stops
        calculateNearbyStops();

        // Re-render current view
        if (state.currentView === 'nearby') {
            await renderNearbyStops();
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
    // Log debug settings if active
    if (window.DEBUG_TIME_OVERRIDE) {
        console.log(`[DEBUG] Time override active: ${window.DEBUG_TIME_OVERRIDE}`);
    }
    if (window.DEBUG_MOCK_ENABLED) {
        console.log('[DEBUG] Mock API mode enabled');
    }

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

        // Check operating hours
        const { isOperating } = checkOperatingHours();

        if (isOperating) {
            // Load data normally during operating hours
            await loadInitialData();

            // Cache routes/stops for off-hours use
            cacheRoutesAndStops();

            // Calculate nearby stops
            calculateNearbyStops();

            // Hide loading, show app
            hideLoading();

            // Render initial view
            await renderNearbyStops();

            // Start auto-refresh only during operating hours
            setRefreshInterval(CONFIG.REFRESH_INTERVAL_MS);
        } else {
            // Outside operating hours
            console.log('[INIT] Outside operating hours (7 AM - 7 PM Indiana time)');

            // Try to load cached routes/stops so users can still browse
            const hasCached = loadCachedRoutesAndStops();

            if (!hasCached) {
                // No cache - need to fetch routes/stops once (but not running buses)
                console.log('[INIT] No cached data, fetching routes/stops for offline browsing...');
                setLoadingStatus('Loading route data...');
                try {
                    const { routes, stops } = await fetchRoutesAndStops();
                    state.routes = routes;
                    state.stops = stops;
                    cacheRoutesAndStops();
                    console.log(`[INIT] Cached ${routes.length} routes, ${stops.length} stops`);
                } catch (err) {
                    console.warn('[INIT] Could not fetch routes:', err);
                }
            } else {
                console.log('[INIT] Using cached routes/stops');
            }

            // No running buses during off-hours
            state.runningBuses = [];

            // Calculate nearby stops (will show stops but no ETAs)
            calculateNearbyStops();

            // Hide loading, show app
            hideLoading();

            // Show the off-hours banner and nearby stops
            showOffHoursBanner();
            await renderNearbyStops();

            // Start a slower refresh to check when service resumes (every 5 min)
            setRefreshInterval(5 * 60 * 1000);
        }

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
            await renderNearbyStops();

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

/* [DISABLED] Custom ETA feature - kept for future use
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
*/
