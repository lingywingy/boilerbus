/**
 * BoilerBus - Configuration
 *
 * SETUP INSTRUCTIONS:
 * 1. Deploy the Cloudflare Worker from cloudflare-worker.js
 * 2. Replace CORS_PROXY_URL below with your worker URL
 * 3. Deploy this app to GitHub Pages or any static host
 */

// eslint-disable-next-line no-unused-vars
var APP_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // REQUIRED: Set your CORS proxy URL
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // Deploy cloudflare-worker.js to Cloudflare Workers, then set the URL here.
    // Example: 'https://proxy.yourname.workers.dev'
    //
    // For local development, use: '' (empty string) and run server.py
    //
    CORS_PROXY_URL: 'https://cors.ling-nyc.com',

    // ═══════════════════════════════════════════════════════════════════════════
    // API Configuration (usually no changes needed)
    // ═══════════════════════════════════════════════════════════════════════════

    // Liftango API network ID for Purdue
    NETWORK_ID: 'd22317c9-83ab-49e3-ba56-a424cdced862',

    // Origin header for API requests (used by the proxy)
    WEB_ORIGIN: 'https://purdue.liftango.com',

    // ═══════════════════════════════════════════════════════════════════════════
    // Location Settings
    // ═══════════════════════════════════════════════════════════════════════════

    // Default location (Purdue campus center) when geolocation unavailable
    DEFAULT_LAT: 40.4237,
    DEFAULT_LON: -86.9212,

    // Radius for "nearby" stops (in miles)
    NEARBY_RADIUS_MILES: 0.5,

    // Maximum number of nearby stops to display
    MAX_NEARBY_STOPS: 10,

    // ═══════════════════════════════════════════════════════════════════════════
    // Refresh & Performance
    // ═══════════════════════════════════════════════════════════════════════════

    // How often to refresh bus data (milliseconds)
    REFRESH_INTERVAL_MS: 30000,

    // API request timeout (milliseconds)
    API_TIMEOUT_MS: 30000,

    // ═══════════════════════════════════════════════════════════════════════════
    // Map Settings
    // ═══════════════════════════════════════════════════════════════════════════

    MAP_ZOOM_DEFAULT: 16,
    MAP_ZOOM_FOCUSED: 17,

    // ═══════════════════════════════════════════════════════════════════════════
    // ETA Calculation Parameters
    // ═══════════════════════════════════════════════════════════════════════════
    // These affect estimated arrival times. Adjust based on local conditions.

    // Average bus speed in mph (slower due to campus traffic, pedestrians, turns)
    BUS_AVG_SPEED_MPH: 12,

    // Time spent at each stop in seconds (slow down, stop, doors, boarding, depart)
    STOP_TIME_SECONDS: 50,

    // Buffer for traffic lights, unexpected delays (0.15 = 15%)
    TRAFFIC_BUFFER_PERCENT: 0.15,
};
