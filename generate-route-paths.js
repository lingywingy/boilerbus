#!/usr/bin/env node
/**
 * Route Path Generator for BoilerBus
 *
 * This script fetches route data from the Liftango API and generates
 * road-following polylines using OSRM (Open Source Routing Machine).
 *
 * The output is a static JavaScript file that can be loaded by the app
 * to draw route lines on the map without any runtime API calls.
 *
 * Usage:
 *   node generate-route-paths.js
 *
 * Output:
 *   route-paths.js - Static file with pre-computed polylines
 */

const https = require('https');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    // Liftango API (via CORS proxy)
    API_HOST: 'cors.ling-nyc.com',
    API_PATH_PREFIX: '/api', // Proxy forwards /api/* to Liftango
    NETWORK_ID: 'd22317c9-83ab-49e3-ba56-a424cdced862',
    WEB_ORIGIN: 'https://purdue.liftango.com',

    // OSRM public server (free, no API key needed)
    OSRM_HOST: 'router.project-osrm.org',

    // Rate limiting - be nice to public OSRM server
    DELAY_BETWEEN_REQUESTS_MS: 200,

    // Output file
    OUTPUT_FILE: 'route-paths.js',
};

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Helpers
// ═══════════════════════════════════════════════════════════════════════════

function httpsGet(options) {
    return new Promise((resolve, reject) => {
        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Failed to parse JSON: ${e.message}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
// Liftango API
// ═══════════════════════════════════════════════════════════════════════════

async function fetchRoutesAndStops() {
    console.log('Fetching routes and stops from Liftango API...');

    const params = new URLSearchParams({
        type: 'getserviceroutesandstops',
        version: '1',
        aclConfig: '',
        aclContext: 'fixed_route',
        networkId: CONFIG.NETWORK_ID,
    });

    const options = {
        hostname: CONFIG.API_HOST,
        path: `${CONFIG.API_PATH_PREFIX}/context/fixed-route/q?${params}`,
        headers: {
            'x-lifty-product-id': 'fixed_route',
            'x-lifty-session-id': `gen-${Date.now()}`,
            'x-lifty-trace-id': `trace-${Date.now()}`,
            'Origin': CONFIG.WEB_ORIGIN,
            'Accept': 'application/json',
        },
    };

    const payload = await httpsGet(options);
    return parseRoutesAndStops(payload);
}

function first(...values) {
    for (const v of values) {
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
}

function parseRoutesAndStops(payload) {
    const data = payload.data || payload.payload || payload;

    // Find routes list
    let routesList = null;
    if (typeof data === 'object' && data !== null) {
        for (const key of ['routes', 'entries', 'services']) {
            if (Array.isArray(data[key])) {
                routesList = data[key];
                break;
            }
        }
    }
    if (!routesList) routesList = [];

    // Build stops lookup
    const stopsById = new Map();
    const stopsList = data?.stops;
    if (Array.isArray(stopsList)) {
        for (const stop of stopsList) {
            if (typeof stop !== 'object') continue;
            if (stop.id) stopsById.set(stop.id, stop);
            if (stop.addressId) stopsById.set(stop.addressId, stop);
            if (stop.stopId) stopsById.set(stop.stopId, stop);
        }
    }

    const routes = [];
    const seen = new Set();

    for (const route of routesList) {
        if (typeof route !== 'object') continue;

        const routeId = first(route.id, route.routeId, route.refid);
        const routeLabel = first(route.label, route.name, route.routeLabel) || 'Unknown Route';
        const routeColour = route.colour || route.color || '#888888';

        const key = `${routeId || routeLabel}|${routeLabel}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const stopSequence = [];
        const routeStops = route.stops || route.stopList || route.stopIds;

        if (Array.isArray(routeStops)) {
            for (const s of routeStops) {
                let stopObj = null;
                if (typeof s === 'object') {
                    const lookupId = s.id || s.addressId || s.stopId;
                    stopObj = stopsById.get(lookupId) || s;
                } else if (stopsById.has(s)) {
                    stopObj = stopsById.get(s);
                }

                if (!stopObj) continue;

                const lat = stopObj.latitude;
                const lng = stopObj.longitude;
                const label = first(stopObj.label, stopObj.name) || 'Unknown';

                if (lat && lng) {
                    stopSequence.push({ lat, lng, label });
                }
            }
        }

        if (stopSequence.length >= 2) {
            routes.push({
                id: routeId || routeLabel,
                label: routeLabel,
                colour: routeColour,
                stops: stopSequence,
            });
        }
    }

    console.log(`Found ${routes.length} routes with stop sequences`);
    return routes;
}

// ═══════════════════════════════════════════════════════════════════════════
// OSRM Routing
// ═══════════════════════════════════════════════════════════════════════════

async function getRouteGeometry(fromLat, fromLng, toLat, toLng) {
    // OSRM expects lng,lat order (opposite of Leaflet)
    const coords = `${fromLng},${fromLat};${toLng},${toLat}`;

    const options = {
        hostname: CONFIG.OSRM_HOST,
        path: `/route/v1/driving/${coords}?overview=full&geometries=geojson`,
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'BoilerBus-RouteGenerator/1.0',
        },
    };

    try {
        const data = await httpsGet(options);

        if (data.code === 'Ok' && data.routes && data.routes[0]) {
            const geometry = data.routes[0].geometry;
            if (geometry && geometry.coordinates) {
                // GeoJSON is [lng, lat], convert to [lat, lng] for Leaflet
                return geometry.coordinates.map(([lng, lat]) => [lat, lng]);
            }
        }
        return null;
    } catch (err) {
        console.error(`  OSRM error: ${err.message}`);
        return null;
    }
}

async function generateRoutePath(route) {
    console.log(`\nProcessing: ${route.label} (${route.stops.length} stops)`);

    const fullPath = [];
    const stops = route.stops;

    // Connect each consecutive pair of stops
    for (let i = 0; i < stops.length; i++) {
        const from = stops[i];
        const to = stops[(i + 1) % stops.length]; // Loop back to first stop

        process.stdout.write(`  ${i + 1}/${stops.length}: ${from.label} → ${to.label}... `);

        const segment = await getRouteGeometry(from.lat, from.lng, to.lat, to.lng);

        if (segment && segment.length > 0) {
            // Avoid duplicating points at segment boundaries
            if (fullPath.length > 0) {
                // Skip first point if it's close to the last point
                const lastPoint = fullPath[fullPath.length - 1];
                const firstSegPoint = segment[0];
                const dist = Math.hypot(lastPoint[0] - firstSegPoint[0], lastPoint[1] - firstSegPoint[1]);
                if (dist < 0.0001) {
                    segment.shift(); // Remove duplicate
                }
            }
            fullPath.push(...segment);
            console.log(`OK (${segment.length} points)`);
        } else {
            // Fallback to straight line if OSRM fails
            console.log('FALLBACK (straight line)');
            if (fullPath.length === 0 ||
                fullPath[fullPath.length - 1][0] !== from.lat ||
                fullPath[fullPath.length - 1][1] !== from.lng) {
                fullPath.push([from.lat, from.lng]);
            }
            fullPath.push([to.lat, to.lng]);
        }

        // Rate limiting
        await delay(CONFIG.DELAY_BETWEEN_REQUESTS_MS);
    }

    console.log(`  Total path: ${fullPath.length} points`);
    return fullPath;
}

// ═══════════════════════════════════════════════════════════════════════════
// Output Generation
// ═══════════════════════════════════════════════════════════════════════════

function generateOutputFile(routePaths) {
    const output = `/**
 * BoilerBus - Pre-generated Route Paths
 *
 * Generated: ${new Date().toISOString()}
 *
 * These polylines follow actual roads (via OSRM) rather than straight lines
 * between stops. This file is loaded statically - no runtime API calls needed.
 *
 * To regenerate: node generate-route-paths.js
 */

// eslint-disable-next-line no-unused-vars
var ROUTE_PATHS = ${JSON.stringify(routePaths, null, 2)};
`;

    fs.writeFileSync(CONFIG.OUTPUT_FILE, output);
    console.log(`\nWrote ${CONFIG.OUTPUT_FILE}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('BoilerBus Route Path Generator');
    console.log('═══════════════════════════════════════════════════════════════\n');

    try {
        // Fetch route data
        const routes = await fetchRoutesAndStops();

        if (routes.length === 0) {
            console.error('No routes found!');
            process.exit(1);
        }

        // Generate paths for each route
        const routePaths = {};

        for (const route of routes) {
            const path = await generateRoutePath(route);
            routePaths[route.id] = {
                label: route.label,
                colour: route.colour,
                path: path,
            };
        }

        // Write output file
        generateOutputFile(routePaths);

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('Done! Next steps:');
        console.log('1. Add <script src="route-paths.js"></script> to index.html');
        console.log('2. Use ROUTE_PATHS in app.js to draw polylines on the map');
        console.log('═══════════════════════════════════════════════════════════════');

    } catch (err) {
        console.error('\nFatal error:', err.message);
        process.exit(1);
    }
}

main();
