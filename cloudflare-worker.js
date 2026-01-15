/**
 * BoilerBus CORS Proxy - Cloudflare Worker
 *
 * This worker proxies requests to the Liftango API, adding CORS headers
 * so the PWA can access the API from any domain.
 *
 * DEPLOYMENT INSTRUCTIONS:
 *
 * 1. Go to https://dash.cloudflare.com/
 * 2. Navigate to Workers & Pages > Create application > Create Worker
 * 3. Name your worker (e.g., "purdue-transit-proxy")
 * 4. Replace the default code with this file's contents
 * 5. Click "Deploy"
 *
 * OPTIONAL: Enable Rate Limiting (Recommended)
 *
 * To add Cloudflare's distributed rate limiting:
 * 1. In your worker's dashboard, go to Settings > Bindings
 * 2. Click "Add" under "Rate Limiting"
 * 3. Set the variable name to: RATE_LIMITER
 * 4. Configure the limit:
 *    - Limit: 150 requests
 *    - Period: 60 seconds (only 10 or 60 are allowed)
 * 5. Click "Deploy" to apply changes
 *
 * Without this binding, the worker uses in-memory rate limiting
 * which resets on restarts and doesn't sync across edge locations.
 *
 * Your worker URL will be: https://your-worker-name.your-subdomain.workers.dev
 */

// Liftango API base URL
const LIFTANGO_API = 'https://hailer-odb-prod.liftango.com';

// Allowed origins (add your domains here, or use '*' for public access)
const ALLOWED_ORIGINS = [
    'http://localhost:8000',
    'http://localhost:8080',
    'http://localhost:3000',
    'http://127.0.0.1:8000',
    // Add your GitHub Pages URL here:
    // 'https://yourusername.github.io',
];

// Set to true to allow any origin (less secure but easier for public forks)
const ALLOW_ANY_ORIGIN = true;

// Rate limit settings (requests per IP per minute)
// Only used if RATE_LIMITER binding is not configured
const SIMPLE_RATE_LIMIT = 150;
const RATE_LIMIT_WINDOW_MS = 60000;

// In-memory rate limiting (fallback when binding not available)
// Note: This resets on worker restart and doesn't work across edge locations
const ipRequestCounts = new Map();

export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return handleCORS(request);
        }

        // Only allow GET requests
        if (request.method !== 'GET') {
            return new Response('Method not allowed', { status: 405 });
        }

        const url = new URL(request.url);

        // Health check endpoint
        if (url.pathname === '/health') {
            return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Only proxy /api/* paths
        if (!url.pathname.startsWith('/api/')) {
            return new Response('Not found. Use /api/* to proxy to Liftango API.', { status: 404 });
        }

        // Get client IP for rate limiting
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

        // Check rate limit
        const rateLimitResult = await checkRateLimit(clientIP, env);
        if (!rateLimitResult.allowed) {
            return new Response(JSON.stringify({
                error: 'Rate limit exceeded',
                retryAfter: rateLimitResult.retryAfter,
            }), {
                status: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Retry-After': String(rateLimitResult.retryAfter),
                    ...getCORSHeaders(request),
                },
            });
        }

        // Proxy the request
        try {
            const response = await proxyRequest(request, url);
            return response;
        } catch (error) {
            console.error('Proxy error:', error);
            return new Response(JSON.stringify({
                error: 'Proxy error',
                message: error.message,
            }), {
                status: 502,
                headers: {
                    'Content-Type': 'application/json',
                    ...getCORSHeaders(request),
                },
            });
        }
    },
};

/**
 * Check rate limit for a client IP
 */
async function checkRateLimit(clientIP, env) {
    // Try to use Cloudflare Rate Limiting binding if available
    if (env && env.RATE_LIMITER) {
        try {
            const { success } = await env.RATE_LIMITER.limit({ key: clientIP });
            if (!success) {
                return { allowed: false, retryAfter: 60 };
            }
            return { allowed: true };
        } catch (e) {
            console.error('Rate limiter error:', e);
            // Fall through to simple rate limiting
        }
    }

    // Simple in-memory rate limiting (fallback)
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;

    // Clean up old entries
    for (const [ip, data] of ipRequestCounts.entries()) {
        if (data.windowStart < windowStart) {
            ipRequestCounts.delete(ip);
        }
    }

    // Get or create entry for this IP
    let ipData = ipRequestCounts.get(clientIP);
    if (!ipData || ipData.windowStart < windowStart) {
        ipData = { count: 0, windowStart: now };
        ipRequestCounts.set(clientIP, ipData);
    }

    // Check limit
    if (ipData.count >= SIMPLE_RATE_LIMIT) {
        const retryAfter = Math.ceil((ipData.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
        return { allowed: false, retryAfter };
    }

    // Increment count
    ipData.count++;
    return { allowed: true };
}

/**
 * Proxy request to Liftango API
 */
async function proxyRequest(request, url) {
    // Build target URL
    const apiPath = url.pathname.substring(4); // Remove '/api' prefix
    const targetUrl = LIFTANGO_API + apiPath + url.search;

    // Build headers for the upstream request
    const headers = new Headers({
        'Accept': 'application/json',
        'Origin': 'https://purdue.liftango.com',
        'Referer': 'https://purdue.liftango.com/',
        'User-Agent': 'PurdueTransitPWA/1.0',
        'x-lifty-product-id': 'fixed_route',
        'x-lifty-session-id': 'pwa-proxy',
        'x-lifty-trace-id': crypto.randomUUID(),
    });

    // Make the request
    const response = await fetch(targetUrl, {
        method: 'GET',
        headers,
    });

    // Build response with CORS headers
    const responseHeaders = new Headers(response.headers);

    // Add CORS headers
    const corsHeaders = getCORSHeaders(request);
    for (const [key, value] of Object.entries(corsHeaders)) {
        responseHeaders.set(key, value);
    }

    // Don't cache API responses
    responseHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
    });
}

/**
 * Handle CORS preflight requests
 */
function handleCORS(request) {
    return new Response(null, {
        status: 204,
        headers: getCORSHeaders(request),
    });
}

/**
 * Get CORS headers based on request origin
 */
function getCORSHeaders(request) {
    const origin = request.headers.get('Origin') || '*';

    // Check if origin is allowed
    let allowedOrigin = '*';
    if (!ALLOW_ANY_ORIGIN) {
        if (ALLOWED_ORIGINS.includes(origin)) {
            allowedOrigin = origin;
        } else {
            allowedOrigin = ALLOWED_ORIGINS[0] || 'null';
        }
    }

    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, x-lifty-product-id, x-lifty-session-id, x-lifty-trace-id',
        'Access-Control-Max-Age': '86400',
    };
}
