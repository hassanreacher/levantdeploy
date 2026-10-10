import json, os, http.server, socketserver
PORT = int(os.environ.get("PORT", "8000"))
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"app": "python", "replica": os.environ.get("LEVANT_REPLICA"), "path": self.path}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, fmt, *a): print("python:", fmt % a, flush=True)
class S(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True
print(f"python test app on {PORT}", flush=True)
S(("0.0.0.0", PORT), H).serve_forever()
