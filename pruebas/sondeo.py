"""El sondeo de la web: /api/estado, /api/registro y /api/validacion llevan ETag y
contestan 304 sin cuerpo si no cambiaron (también con el W/ que pone Cloudflare al
comprimir), y 200 con todo si cambiaron. En el Worker local ya lleno (lo deja así
e2e.sh) y en Flask, con su cliente de pruebas.
Uso: python pruebas/sondeo.py PUERTO_WORKER"""
import os, sys, urllib.error, urllib.request

W = f"http://127.0.0.1:{sys.argv[1]}"


def pedir(ruta, etag=None):
    req = urllib.request.Request(W + ruta, headers={"If-None-Match": etag} if etag else {})
    try:
        r = urllib.request.urlopen(req)
        return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:   # urllib trata el 304 como error
        return e.code, e.headers, e.read()


for ruta in ("/api/estado", "/api/registro", "/api/validacion"):
    st, cab, cuerpo = pedir(ruta)
    etag = cab["ETag"]
    assert st == 200 and etag and etag.startswith('"') and len(cuerpo) > 50, (ruta, st, etag)
    for variante in (etag, "W/" + etag, '"otro", ' + etag):
        st, cab, cuerpo = pedir(ruta, variante)
        assert st == 304 and cuerpo == b"" and cab["ETag"] == etag, (ruta, variante, st)
        assert cab["Cache-Control"].startswith("no-store") and cab["X-Content-Type-Options"] == "nosniff"
    st, _, cuerpo = pedir(ruta, '"no-es-este"')
    assert st == 200 and len(cuerpo) > 50, (ruta, st)
print("Worker: /api/estado, /api/registro y /api/validacion con ETag; 304 vacío si no cambió (también W/)")

os.environ.setdefault("FOOTBALL_DATA_TOKEN", "sin_uso_en_esta_prueba")
os.environ.setdefault("UPDATE_SECRET", "sondeo_dummy_secret")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402

cli = app.app.test_client()
for ruta in ("/api/estado", "/api/validacion"):
    r = cli.get(ruta)
    etag = r.headers["ETag"]
    assert r.status_code == 200 and etag, (ruta, r.status_code)
    r = cli.get(ruta, headers={"If-None-Match": etag})
    assert r.status_code == 304 and r.data == b"", (ruta, r.status_code)
print("Flask: /api/estado y /api/validacion con ETag y 304")
