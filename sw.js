/**
 * BoilerBus - Service Worker
 * Handles caching for map tiles and static assets
 */

const STATIC_CACHE = 'purdue-transit-static-v3';
const DYNAMIC_CACHE = 'purdue-transit-dynamic-v3';

// Static assets to cache immediately
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/config.js',
    '/app.js',
    '/welcome.js',
    '/manifest.json',
];

// API endpoints that should NEVER be cached (real-time data)
const API_PATTERNS = [
    /\/api\//,
    /hailer-odb-prod\.liftango\.com/,
    /nominatim\.openstreetmap\.org/,
];

// Map tile patterns for caching
const TILE_PATTERNS = [
    /basemaps\.cartocdn\.com/,
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => {
                return Promise.all(
                    keys
                        .filter((key) => key !== STATIC_CACHE && key !== DYNAMIC_CACHE)
                        .map((key) => caches.delete(key))
                );
            })
            .then(() => self.clients.claim())
    );
});

// Fetch event - handle requests
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') return;

    // API requests - network ONLY, never cache (real-time data)
    if (API_PATTERNS.some(pattern => pattern.test(url.href)) || url.pathname.startsWith('/api/')) {
        event.respondWith(networkOnly(request));
        return;
    }

    // Map tiles - cache first (tiles don't change)
    if (TILE_PATTERNS.some(pattern => pattern.test(url.href))) {
        event.respondWith(cacheFirst(request));
        return;
    }

    // Static assets and external resources - stale while revalidate
    event.respondWith(staleWhileRevalidate(request));
});

/**
 * Network-only strategy (for API requests)
 */
async function networkOnly(request) {
    try {
        return await fetch(request);
    } catch {
        return new Response(JSON.stringify({ error: 'Network unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Cache-first strategy (for map tiles)
 */
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(DYNAMIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        return new Response('Offline', { status: 503 });
    }
}

/**
 * Stale-while-revalidate strategy (for static assets)
 */
async function staleWhileRevalidate(request) {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cached = await cache.match(request);

    const fetchPromise = fetch(request)
        .then((response) => {
            if (response.ok) {
                cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => cached);

    return cached || fetchPromise;
}
