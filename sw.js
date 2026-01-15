/**
 * BoilerBus - Service Worker
 * Handles caching and offline support
 */

const CACHE_NAME = 'purdue-transit-v3';
const STATIC_CACHE = 'purdue-transit-static-v3';
const DYNAMIC_CACHE = 'purdue-transit-dynamic-v3';

// Static assets to cache immediately
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/config.js',
    '/app.js',
    '/manifest.json',
    'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// API endpoints that should NEVER be cached and always go to network
const API_PATTERNS = [
    /\/api\//,  // Our proxy API endpoint
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
            .then((cache) => {
                console.log('Caching static assets');
                return cache.addAll(STATIC_ASSETS.filter(url => !url.startsWith('http')));
            })
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

    // Map tiles - cache first (tiles don't change often)
    if (TILE_PATTERNS.some(pattern => pattern.test(url.href))) {
        event.respondWith(cacheFirst(request, DYNAMIC_CACHE));
        return;
    }

    // Static assets - stale while revalidate (allows updates to propagate)
    if (url.origin === location.origin) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    // External resources - stale while revalidate
    event.respondWith(staleWhileRevalidate(request));
});

/**
 * Network-only strategy (for API requests - no caching)
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
 * Cache-first strategy
 */
async function cacheFirst(request, cacheName) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        return new Response('Offline', { status: 503 });
    }
}

/**
 * Network-first strategy with timeout
 */
async function networkFirst(request, timeoutSeconds = 5) {
    const cache = await caches.open(DYNAMIC_CACHE);
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
        
        const response = await fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        
        return new Response(JSON.stringify({ error: 'Offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Stale-while-revalidate strategy
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

// Handle background sync for offline actions
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-favorites') {
        event.waitUntil(syncFavorites());
    }
});

async function syncFavorites() {
    // Future: sync favorite stops when back online
    console.log('Syncing favorites...');
}

// Push notifications (for future bus alerts)
self.addEventListener('push', (event) => {
    if (!event.data) return;

    const data = event.data.json();
    const options = {
        body: data.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-72.png',
        vibrate: [100, 50, 100],
        data: {
            url: data.url || '/',
        },
        actions: [
            { action: 'open', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' },
        ],
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'BoilerBus', options)
    );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'dismiss') return;

    event.waitUntil(
        clients.matchAll({ type: 'window' })
            .then((clientList) => {
                for (const client of clientList) {
                    if (client.url === event.notification.data.url && 'focus' in client) {
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow(event.notification.data.url);
                }
            })
    );
});
