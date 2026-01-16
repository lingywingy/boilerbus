#!/usr/bin/env python3
"""
CORS Proxy Server for Purdue Transit PWA
Uses ThreadingHTTPServer for better concurrency

Debug options (set via environment variables or command line):
  --mock              Enable mock API responses (no real API calls)
  --time HH:MM        Override Indiana time (e.g., --time 14:30 for 2:30 PM)

Examples:
  python server.py --mock --time 10:00    # Mock data, pretend it's 10 AM
  python server.py --time 22:00           # Real API, pretend it's 10 PM (off-hours)
  python server.py --mock                 # Mock data, real time
"""

import http.server
import socketserver
import os
import sys
import urllib.request
import urllib.error
import json
import ssl
import argparse
from urllib.parse import urlparse, parse_qs

PORT = 8085
LIFTANGO_BASE_URL = "https://hailer-odb-prod.liftango.com"

# Debug settings (set via command line)
DEBUG_MOCK_ENABLED = False
DEBUG_TIME_OVERRIDE = None  # Format: "HH:MM" or None for real time

# Create SSL context
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

# ═══════════════════════════════════════════════════════════════════════════
# Mock Data for Development
# ═══════════════════════════════════════════════════════════════════════════

MOCK_ROUTES_AND_STOPS = {
    "status": 200,
    "data": {
        "routes": [
            {
                "id": "mock-route-1",
                "label": "Gold Loop (rip)",
                "colour": "#CEB888",
                "stops": [
                    {"id": "stop-1", "label": "Engineering Mall", "latitude": 40.4284, "longitude": -86.9135},
                    {"id": "stop-2", "label": "Purdue Memorial Union", "latitude": 40.4249, "longitude": -86.9108},
                    {"id": "stop-3", "label": "Rawls Hall", "latitude": 40.4235, "longitude": -86.9265},
                    {"id": "stop-4", "label": "Krach Leadership Center", "latitude": 40.4223, "longitude": -86.9213},
                ],
                "routeShape": {
                    "orderedCoordinates": [
                        {"latitude": 40.4284, "longitude": -86.9135},
                        {"latitude": 40.4270, "longitude": -86.9120},
                        {"latitude": 40.4249, "longitude": -86.9108},
                        {"latitude": 40.4240, "longitude": -86.9180},
                        {"latitude": 40.4235, "longitude": -86.9265},
                        {"latitude": 40.4223, "longitude": -86.9213},
                        {"latitude": 40.4284, "longitude": -86.9135},
                    ]
                }
            },
            {
                "id": "mock-route-2",
                "label": "Black Loop",
                "colour": "#1A1A1A",
                "stops": [
                    {"id": "stop-5", "label": "Ross-Ade Stadium", "latitude": 40.4396, "longitude": -86.9187},
                    {"id": "stop-6", "label": "Corec", "latitude": 40.4289, "longitude": -86.9224},
                    {"id": "stop-2", "label": "Purdue Memorial Union", "latitude": 40.4249, "longitude": -86.9108},
                ],
                "routeShape": {
                    "orderedCoordinates": [
                        {"latitude": 40.4396, "longitude": -86.9187},
                        {"latitude": 40.4340, "longitude": -86.9200},
                        {"latitude": 40.4289, "longitude": -86.9224},
                        {"latitude": 40.4249, "longitude": -86.9108},
                        {"latitude": 40.4396, "longitude": -86.9187},
                    ]
                }
            },
            {
                "id": "mock-route-3",
                "label": "Silver Loop",
                "colour": "#94A3B8",
                "stops": [
                    {"id": "stop-7", "label": "Third Street Suites", "latitude": 40.4210, "longitude": -86.9050},
                    {"id": "stop-8", "label": "Chauncey Hill Mall", "latitude": 40.4235, "longitude": -86.9065},
                    {"id": "stop-1", "label": "Engineering Mall", "latitude": 40.4284, "longitude": -86.9135},
                ],
                "routeShape": {
                    "orderedCoordinates": [
                        {"latitude": 40.4210, "longitude": -86.9050},
                        {"latitude": 40.4235, "longitude": -86.9065},
                        {"latitude": 40.4260, "longitude": -86.9100},
                        {"latitude": 40.4284, "longitude": -86.9135},
                        {"latitude": 40.4210, "longitude": -86.9050},
                    ]
                }
            },
        ],
        "stops": [
            {"id": "stop-1", "addressId": "mock-uuid-1", "label": "Engineering Mall", "latitude": 40.4284, "longitude": -86.9135},
            {"id": "stop-2", "addressId": "mock-uuid-2", "label": "Purdue Memorial Union", "latitude": 40.4249, "longitude": -86.9108},
            {"id": "stop-3", "addressId": "mock-uuid-3", "label": "Rawls Hall", "latitude": 40.4235, "longitude": -86.9265},
            {"id": "stop-4", "addressId": "mock-uuid-4", "label": "Krach Leadership Center", "latitude": 40.4223, "longitude": -86.9213},
            {"id": "stop-5", "addressId": "mock-uuid-5", "label": "Ross-Ade Stadium", "latitude": 40.4396, "longitude": -86.9187},
            {"id": "stop-6", "addressId": "mock-uuid-6", "label": "Corec", "latitude": 40.4289, "longitude": -86.9224},
            {"id": "stop-7", "addressId": "mock-uuid-7", "label": "Third Street Suites", "latitude": 40.4210, "longitude": -86.9050},
            {"id": "stop-8", "addressId": "mock-uuid-8", "label": "Chauncey Hill Mall", "latitude": 40.4235, "longitude": -86.9065},
        ]
    }
}

MOCK_RUNNING_BUSES = {
    "status": 200,
    "data": [
        {
            "shiftSolutionId": "mock-bus-1",
            "route": {"id": "mock-route-1", "label": "Gold Loop", "colour": "#CEB888"},
            "vehicle": {"displayName": "Bus 101", "name": "Bus 101"},
            "location": {"latitude": 40.4260, "longitude": -86.9115, "timestamp": "2024-01-15T12:00:00Z"},
            "availableCapacities": [{"capacityName": "standard", "amount": 15}, {"capacityName": "wheelchair", "amount": 2}]
        },
        {
            "shiftSolutionId": "mock-bus-2",
            "route": {"id": "mock-route-1", "label": "Gold Loop", "colour": "#CEB888"},
            "vehicle": {"displayName": "Bus 102", "name": "Bus 102"},
            "location": {"latitude": 40.4230, "longitude": -86.9240, "timestamp": "2024-01-15T12:00:00Z"},
            "availableCapacities": [{"capacityName": "standard", "amount": 8}, {"capacityName": "wheelchair", "amount": 1}]
        },
        {
            "shiftSolutionId": "mock-bus-3",
            "route": {"id": "mock-route-2", "label": "Black Loop", "colour": "#1A1A1A"},
            "vehicle": {"displayName": "Bus 201", "name": "Bus 201"},
            "location": {"latitude": 40.4320, "longitude": -86.9195, "timestamp": "2024-01-15T12:00:00Z"},
            "availableCapacities": [{"capacityName": "standard", "amount": 22}, {"capacityName": "wheelchair", "amount": 2}]
        },
        {
            "shiftSolutionId": "mock-bus-4",
            "route": {"id": "mock-route-3", "label": "Silver Loop", "colour": "#94A3B8"},
            "vehicle": {"displayName": "Bus 301", "name": "Bus 301"},
            "location": {"latitude": 40.4245, "longitude": -86.9080, "timestamp": "2024-01-15T12:00:00Z"},
            "availableCapacities": [{"capacityName": "standard", "amount": 5}, {"capacityName": "wheelchair", "amount": 0}]
        },
    ]
}

MOCK_STOP_DETAILS = {
    "status": 200,
    "data": {
        "stop": [
            {
                "shiftSolutionId": "mock-bus-1",
                "route": {"id": "mock-route-1", "label": "Gold Loop", "colour": "#CEB888"},
                "stopEta": 3,
                "availableCapacities": [{"capacityName": "standard", "amount": 15}]
            },
            {
                "shiftSolutionId": "mock-bus-2",
                "route": {"id": "mock-route-1", "label": "Gold Loop", "colour": "#CEB888"},
                "stopEta": 12,
                "availableCapacities": [{"capacityName": "standard", "amount": 8}]
            },
        ]
    }
}


class CORSProxyHandler(http.server.SimpleHTTPRequestHandler):
    """Custom handler with CORS proxy support"""
    
    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests"""
        # Log every request
        print(f"  >>> GET {self.path}")
        sys.stdout.flush()

        if self.path.startswith('/api/'):
            self.proxy_api_request()
        elif self.path == '/config.js' or self.path.startswith('/config.js?'):
            self.serve_local_config()
        else:
            # Add CORS headers to static files too
            try:
                super().do_GET()
            except Exception as e:
                print(f"  [ERROR] Static file error: {e}")

    def serve_local_config(self):
        """Serve config.js with debug overrides for local development"""
        try:
            with open('config.js', 'r', encoding='utf-8') as f:
                config_content = f.read()

            # Replace the CORS_PROXY_URL value with empty string for local dev
            import re
            modified_config = re.sub(
                r"CORS_PROXY_URL:\s*['\"][^'\"]*['\"]",
                "CORS_PROXY_URL: ''",
                config_content
            )

            # Inject debug time override if set
            debug_injection = ""
            if DEBUG_TIME_OVERRIDE:
                debug_injection = f"""
// ═══ DEBUG TIME OVERRIDE (from server.py --time flag) ═══
window.DEBUG_TIME_OVERRIDE = '{DEBUG_TIME_OVERRIDE}';
"""
                print(f"  [CONFIG] Injecting time override: {DEBUG_TIME_OVERRIDE}")

            if DEBUG_MOCK_ENABLED:
                debug_injection += """
// ═══ DEBUG MOCK MODE ENABLED (from server.py --mock flag) ═══
window.DEBUG_MOCK_ENABLED = true;
"""
                print(f"  [CONFIG] Mock mode enabled")

            # Prepend debug injection
            if debug_injection:
                modified_config = debug_injection + "\n" + modified_config

            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.end_headers()
            self.wfile.write(modified_config.encode('utf-8'))
            print(f"  [CONFIG] Served local config (CORS_PROXY_URL cleared)")

        except Exception as e:
            print(f"  [ERROR] Config error: {e}")
            self.send_response(500)
            self.end_headers()
    
    def end_headers(self):
        """Add CORS headers to all responses"""
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    
    def proxy_api_request(self):
        """Proxy requests to Liftango API (or return mock data in debug mode)"""
        api_path = self.path[4:]  # Remove '/api' prefix
        target_url = LIFTANGO_BASE_URL + api_path

        # Check for mock mode
        if DEBUG_MOCK_ENABLED:
            self.serve_mock_response(api_path)
            return

        print(f"  [PROXY] -> {target_url}")
        sys.stdout.flush()
        
        headers = {
            'x-lifty-product-id': 'fixed_route',
            'x-lifty-session-id': 'ops-pwa-proxy',
            'x-lifty-trace-id': 'ops-pwa-proxy',
            'Origin': 'https://purdue.liftango.com',
            'Referer': 'https://purdue.liftango.com/',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        }
        
        try:
            req = urllib.request.Request(target_url, headers=headers)
            with urllib.request.urlopen(req, timeout=30, context=ssl_context) as resp:
                data = resp.read()
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
                print(f"  [PROXY] OK - {len(data)} bytes")
                
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode('utf-8', errors='ignore')[:500]
            except:
                pass
            print(f"  [PROXY] HTTP {e.code}: {e.reason}")
            
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': True, 'status': e.code, 'message': str(e.reason)}).encode())
            
        except urllib.error.URLError as e:
            print(f"  [PROXY] URL Error: {e.reason}")
            
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': True, 'status': 502, 'message': str(e.reason)}).encode())
            
        except Exception as e:
            print(f"  [PROXY] Exception: {e}")
            
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': True, 'status': 500, 'message': str(e)}).encode())
        
        sys.stdout.flush()

    def serve_mock_response(self, api_path):
        """Return mock data for API requests"""
        # Parse query string to determine request type
        parsed = urlparse(api_path)
        query = parse_qs(parsed.query)
        req_type = query.get('type', [''])[0]

        print(f"  [MOCK] Serving mock data for: {req_type}")

        mock_data = None
        if req_type == 'getserviceroutesandstops':
            mock_data = MOCK_ROUTES_AND_STOPS
        elif req_type == 'getrunningshiftsolutions':
            mock_data = MOCK_RUNNING_BUSES
        elif req_type == 'getrunningstopdetails':
            mock_data = MOCK_STOP_DETAILS
        else:
            # Unknown request type - return empty success
            mock_data = {"status": 200, "data": []}
            print(f"  [MOCK] Unknown request type: {req_type}")

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(mock_data).encode())
        print(f"  [MOCK] OK - {len(json.dumps(mock_data))} bytes")
        sys.stdout.flush()

    def log_message(self, format, *args):
        """Suppress default logging (we do our own)"""
        pass


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded HTTP server for concurrent requests"""
    daemon_threads = True
    allow_reuse_address = True


def main():
    global DEBUG_MOCK_ENABLED, DEBUG_TIME_OVERRIDE

    # Parse command line arguments
    parser = argparse.ArgumentParser(
        description='CORS Proxy Server for Purdue Transit PWA',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python server.py                        Normal mode (real API)
  python server.py --mock                 Mock data mode (no API calls)
  python server.py --time 10:00           Override time to 10:00 AM
  python server.py --time 22:00           Override time to 10:00 PM (off-hours)
  python server.py --mock --time 14:30    Mock data + time override
        """
    )
    parser.add_argument('--mock', action='store_true',
                        help='Enable mock API responses (no real API calls)')
    parser.add_argument('--time', type=str, metavar='HH:MM',
                        help='Override Indiana time (e.g., 14:30 for 2:30 PM)')

    args = parser.parse_args()

    DEBUG_MOCK_ENABLED = args.mock
    DEBUG_TIME_OVERRIDE = args.time

    # Validate time format
    if DEBUG_TIME_OVERRIDE:
        try:
            h, m = DEBUG_TIME_OVERRIDE.split(':')
            int(h), int(m)
        except:
            print(f"[ERROR] Invalid time format: {DEBUG_TIME_OVERRIDE}")
            print("        Use HH:MM format (e.g., 14:30)")
            sys.exit(1)

    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    print(f"\n[SERVER] Purdue Transit PWA - CORS Proxy")
    print("=" * 50)
    print(f"   URL:   http://localhost:{PORT}")
    print(f"   Proxy: /api/* -> {LIFTANGO_BASE_URL}")

    # Show debug settings
    if DEBUG_MOCK_ENABLED or DEBUG_TIME_OVERRIDE:
        print("-" * 50)
        print("   DEBUG MODE:")
        if DEBUG_MOCK_ENABLED:
            print("     - Mock API: ENABLED (no real API calls)")
        if DEBUG_TIME_OVERRIDE:
            print(f"     - Time Override: {DEBUG_TIME_OVERRIDE} (Indiana)")

    print("=" * 50)
    print("   Waiting for requests...\n")
    sys.stdout.flush()

    server = ThreadedHTTPServer(("", PORT), CORSProxyHandler)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[SERVER] Stopped")
        server.shutdown()


if __name__ == "__main__":
    main()
