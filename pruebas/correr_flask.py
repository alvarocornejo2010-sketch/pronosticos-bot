"""Corre la app de Python (app.py + validacion.py) contra la API falsa y guarda
lo que servirían /api/estado, /api/ligas y /api/validacion.
Uso: python pruebas/correr_flask.py PUERTO_API SALIDA"""
import json, os, shutil, sys, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUERTO, SALIDA = sys.argv[1], sys.argv[2]
datos = tempfile.mkdtemp(prefix="flask_")
os.environ.update(FOOTBALL_DATA_TOKEN="prueba", UPDATE_SECRET="prueba-local-123456", DATA_DIR=datos)
os.environ.pop("RENDER_EXTERNAL_URL", None)   # sin planificador: las pasadas se lanzan a mano
sys.path.insert(0, REPO)
import app, validacion
app.BASE_URL = f"http://127.0.0.1:{PUERTO}/v4"
app.PAUSA_ENTRE_REQUESTS = 0
app.PRESUPUESTO_REQUESTS = 10000
app.correr_actualizacion()
validacion.correr_validacion()
cli = app.app.test_client()
out = {k: cli.get(r).get_json() for k, r in (("estado", "/api/estado"), ("ligas", "/api/ligas"), ("validacion", "/api/validacion"))}
out["cabeceras_web"] = dict(cli.get("/").headers)
out["web_bytes"] = len(cli.get("/").data)
json.dump(out, open(SALIDA, "w"), ensure_ascii=False)
e = out["estado"]
print("flask:", e["estado"], "total", e["total"], "pendientes", e["pendientes"], "peticiones", e.get("requests_gastadas"),
      "| validacion:", out["validacion"]["estado"])
shutil.rmtree(datos)
