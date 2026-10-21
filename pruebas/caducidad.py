"""Todas las predicciones caducan a la vez (como cada noche en producción) y, mientras
se recalculan, la web tiene que seguir enseñando los números de antes. Solo puede
salir sin números un partido que nunca tuvo predicción.
Se corre contra el Worker local ya lleno (lo deja así e2e.sh) y la API falsa.
Uso: python pruebas/caducidad.py PUERTO_WORKER DIR_D1"""
import glob, json, sqlite3, sys, urllib.request

W = f"http://127.0.0.1:{sys.argv[1]}"
D1 = sys.argv[2]
get = lambda ruta: json.load(urllib.request.urlopen(W + ruta))
cron = lambda: urllib.request.urlopen(W + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*").read()
partidos = lambda e: [p for d in e["dias"] for p in d["partidos"]]
numeros = lambda p: (p.get("prob_local"), p.get("prob_empate"), p.get("prob_visita"), p.get("xg_local"), p.get("xg_visita"))

e = get("/api/estado")
assert e["estado"] == "listo" and e["pendientes"] == 0, (e["estado"], e["pendientes"])
antes = {p["id"]: numeros(p) for p in partidos(e)}

# la D1 local de wrangler dev (en el mismo sitio están también las trazas de observability)
base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
assert len(base) == 1, base
db = sqlite3.connect(base[0])
# todas caducan a la vez, y lo jugado de cada liga también (hay que volver a bajarlo)
db.execute("UPDATE predicciones SET calculado = '2000-01-01T00:00:00.000-05:00'")
db.execute("""UPDATE cache SET valor = json_set(valor, '$.actualizado', '2000-01-01T00:00:00.000-05:00')
              WHERE seccion = 'ligas'""")
# un partido sin predicción: ese sí sale sin números hasta calcularlo
uno = db.execute("SELECT id FROM predicciones ORDER BY utc DESC LIMIT 1").fetchone()[0]
db.execute("DELETE FROM predicciones WHERE id = ?", (uno,))
# sin esperar los 25 minutos de MIN_MINUTOS_ACTUALIZACION: la pasada arranca en el siguiente minuto
db.execute("UPDATE documentos SET valor = json_set(valor, '$.estado', 'actualizando') WHERE clave = 'resumen'")
db.commit()
db.close()

sin_max = 0
for i in range(80):
    cron()
    e = get("/api/estado")
    sin = [p for p in partidos(e) if p.get("pendiente")]
    assert len(sin) == e["pendientes"], (len(sin), e["pendientes"])
    assert all(p["id"] == uno for p in sin), [p["id"] for p in sin]
    assert "recalculando" not in e
    sin_max = max(sin_max, len(sin))
    print(i, e["estado"], "total", e["total"], "sin números", e["pendientes"], "| cron:", get("/salud")["estado"], flush=True)
    if e["estado"] == "listo":
        break
else:
    sys.exit("el recálculo no terminó")

db = sqlite3.connect(base[0])
viejas = db.execute("SELECT count(*) FROM predicciones WHERE calculado LIKE '2000-%'").fetchone()[0]
db.close()
despues = {p["id"]: numeros(p) for p in partidos(e)}
distintos = [k for k in antes if antes[k] != despues.get(k)]
print("recalculadas en", i + 1, "pasadas; sin números como mucho:", sin_max,
      "| predicciones viejas que quedan:", viejas, "| números distintos de antes:", len(distintos))
assert e["pendientes"] == 0 and viejas == 0 and not distintos
print("caducidad: OK")
