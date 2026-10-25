"""Lo que hace la web instalable y lo que leen los buscadores: el manifiesto, el
service worker y los iconos se sirven con su tipo; la CSP de la página los deja
cargar; robots.txt apunta al sitemap; y el sitemap lista la portada y los partidos
por jugar (worker/buscadores.js), con las direcciones del origen de la petición.
Se corre contra el Worker local ya lleno (lo deja así e2e.sh).
Uso: python pruebas/descubrir.py PUERTO_WORKER"""
import json, sys, time, urllib.request
import xml.etree.ElementTree as ET

W = f"http://127.0.0.1:{sys.argv[1]}"


def pedir(ruta):
    r = urllib.request.urlopen(W + ruta)
    return r.headers, r.read()


cab, _ = pedir("/")
csp = cab["Content-Security-Policy"]
assert "manifest-src 'self'" in csp and "worker-src 'self'" in csp, csp
cab, cuerpo = pedir("/manifest.webmanifest")
m = json.loads(cuerpo)
assert cab["Content-Type"].startswith("application/manifest+json"), cab["Content-Type"]
assert m["display"] == "standalone" and m["start_url"] == "/" and m["short_name"] == "Pronósticos"
tamanos = {(i["sizes"], i["purpose"]) for i in m["icons"]}
assert {("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")} <= tamanos, tamanos
for i in m["icons"] + [{"src": "/apple-touch-icon.png"}]:
    c, png = pedir(i["src"])
    assert c["Content-Type"] == "image/png" and png[:8] == b"\x89PNG\r\n\x1a\n", i["src"]
cab, sw = pedir("/sw.js")
assert "javascript" in cab["Content-Type"] and b'addEventListener("fetch"' in sw
assert "connect-src 'self'" in cab["Content-Security-Policy"]   # deja al service worker pedir la página
print("instalable: manifiesto (standalone, iconos 192, 512 y maskable), service worker e iconos; CSP con manifest-src")

cab, txt = pedir("/robots.txt")
txt = txt.decode()
assert cab["Content-Type"].startswith("text/plain") and f"Sitemap: {W}/sitemap.xml" in txt
assert "Disallow: /api/contar" in txt and "Disallow: /api/visitas" in txt and "Disallow: /visitas" in txt
assert "Disallow: /api/avisos" in txt
assert "Disallow: /api/\n" not in txt   # Google pinta la página con /api/estado
cab, xml = pedir("/sitemap.xml")
assert cab["Content-Type"].startswith("application/xml")
ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
locs = [u.find("s:loc", ns).text for u in ET.fromstring(xml).findall("s:url", ns)]
estado = json.load(urllib.request.urlopen(W + "/api/estado"))
ahora = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
por_jugar = {f"{W}/partido/{p['id']}" for d in estado["dias"] for p in d["partidos"] if p["utcDate"] > ahora}
assert locs[0] == W + "/" and len(locs) == len(set(locs)), locs[:3]
# los equipos de las tablas también van (los mira equipos.py)
partidos = {l for l in locs[1:] if "/equipo/" not in l}
assert partidos == por_jugar, (len(partidos), len(por_jugar), partidos ^ por_jugar)
print(f"buscadores: robots.txt apunta al sitemap; el sitemap trae la portada, los {len(por_jugar)} partidos por jugar"
      f" y {len(locs) - 1 - len(partidos)} equipos")
print("descubrir: OK")
