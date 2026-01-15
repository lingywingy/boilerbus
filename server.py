#!/usr/bin/env python3
"""
CORS Proxy Server for Purdue Transit PWA
Uses ThreadingHTTPServer for better concurrency
"""

import http.server
import socketserver
import os
import sys
import urllib.request
import urllib.error
import json
import ssl
from urllib.parse import urlparse

PORT = 8085
LIFTANGO_BASE_URL = "https://hailer-odb-prod.liftango.com"

# Create SSL context
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE


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
        else:
            # Add CORS headers to static files too
            try:
                super().do_GET()
            except Exception as e:
                print(f"  [ERROR] Static file error: {e}")
    
    def end_headers(self):
        """Add CORS headers to all responses"""
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    
    def proxy_api_request(self):
        """Proxy requests to Liftango API"""
        api_path = self.path[4:]  # Remove '/api' prefix
        target_url = LIFTANGO_BASE_URL + api_path
        
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
    
    def log_message(self, format, *args):
        """Suppress default logging (we do our own)"""
        pass


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded HTTP server for concurrent requests"""
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    print(f"\n[SERVER] Purdue Transit PWA - CORS Proxy")
    print("-" * 50)
    print(f"   URL:   http://localhost:{PORT}")
    print(f"   Proxy: /api/* -> {LIFTANGO_BASE_URL}")
    print("-" * 50)
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
