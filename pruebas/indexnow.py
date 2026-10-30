"""El aviso a los buscadores (worker/indexnow.js), contra el Worker local ya lleno y con las
tablas bajadas: en un minuto libre del cron manda a IndexNow (el de mentira de api_falsa.py)
la portada, las ligas, los partidos de la ventana con predicción y los equipos de las tablas,
con la clave del archivo que sirve la web; no lo repite antes de 3 horas; luego manda solo lo
que cambió (un partido que terminó, sus equipos, su liga y la portada), nada si no cambió
nada, y si IndexNow falla, lo vuelve a mandar la vez siguiente.
Uso: python pruebas/indexnow.py PUERTO_WORKER PUERTO_API DIR_D1"""
import glob, json, os, re, sqlite3, sys, time, urllib.request

W, API, D1 = f"http://127.0.0.1:{sys.argv[1]}", f"http://127.0.0.1:{sys.argv[2]}", sys.argv[3]
WEB = "https://pronosticos-bot.alvarocornejo2010.workers.dev"   # URL_WEB: la de producción
HORA = 3600000
cron = lambda: urllib.request.urlopen(W + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*").read()
pedir = lambda url: json.load(urllib.request.urlopen(url))
recibidas = lambda: pedir(API + "/__indexnow")

# la clave: la del archivo de public/ que sirve la web, la misma que va en config.js
publico = os.path.join(os.path.dirname(__file__), "..", "public")
claves = [f[:-4] for f in os.listdir(publico) if re.fullmatch(r"[0-9a-f]{32}\.txt", f)]
assert len(claves) == 1, claves
clave = claves[0]
config = open(os.path.join(publico, "..", "worker", "config.js"), encoding="utf-8").read()
assert f'INDEXNOW_CLAVE = "{clave}"' in config
r = urllib.request.urlopen(f"{W}/{clave}.txt")
assert r.headers["Content-Type"].startswith("text/plain") and r.read().decode().strip() == clave
print(f"clave: /{clave}.txt la sirve la web, con la clave de config.js")

base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
assert len(base) == 1, base
db = sqlite3.connect(base[0])
doc = lambda: db.execute("SELECT valor, actualizado FROM documentos WHERE clave = 'indexnow'").fetchone()


def esperar(cambio, minutos=40):
    """Lanza el cron hasta que cambia el documento indexnow."""
    antes = doc()
    for _ in range(minutos):
        cron()
        if doc() and doc() != antes:
            return json.loads(doc()[0])
    sys.exit(f"IndexNow no se mandó en {minutos} minutos del cron ({cambio})")


def atrasar():   # como si la última vez hubiera sido hace 4 horas
    db.execute("UPDATE documentos SET actualizado = actualizado - 4 * ? WHERE clave = 'indexnow'", (HORA,))
    db.commit()


# como si no se hubiera hecho nunca: toca en el siguiente minuto libre, y va todo
db.execute("DELETE FROM documentos WHERE clave = 'indexnow'")
db.commit()
n = len(recibidas())
d = esperar("la primera vez")
envios = recibidas()
assert len(envios) == n + 1 and d["estado"] == 200 and d["al_dia"] is True, (len(envios), d)
e = envios[-1]
assert (e["host"], e["key"], e["keyLocation"]) == ("pronosticos-bot.alvarocornejo2010.workers.dev", clave,
                                                    f"{WEB}/{clave}.txt"), e
assert e["tipo"].startswith("application/json")
assert all(u.startswith(WEB + "/") for u in e["urlList"]) and len(set(e["urlList"])) == len(e["urlList"])
rutas = {u[len(WEB):] for u in e["urlList"]}
estado = pedir(W + "/api/estado")
ahora = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
partidos = [p for dia in estado["dias"] for p in dia["partidos"]]
con_numeros = {f"/partido/{p['id']}" for p in partidos if not p.get("pendiente") and p["utcDate"] > ahora}
ligas = {f"/liga/{c}" for c in ("CL", "PD", "PL", "FL1", "BL1", "SA", "DED", "PPL", "ELC", "BSA")}
mapa = urllib.request.urlopen(W + "/sitemap.xml").read().decode()
equipos = {f"/equipo/{i}" for i in re.findall(r"<loc>[^<]*/equipo/(\d+)</loc>", mapa)}
assert "/" in rutas and ligas <= rutas and con_numeros <= rutas and equipos <= rutas, (
    len(rutas), ligas - rutas, len(con_numeros - rutas), len(equipos - rutas))
assert d["urls"] == len(rutas) and set(d["enviados"]) >= {p["id"] for p in partidos if not p.get("pendiente")
                                                          and p["utcDate"] > ahora}
print(f"la primera vez: {len(rutas)} direcciones (la portada, las 10 ligas, {len(con_numeros)} partidos por jugar con"
      f" pronóstico y {len(equipos)} equipos de las tablas), con su clave")

hecho = doc()
for _ in range(5):
    cron()
assert doc() == hecho and len(recibidas()) == n + 1, "IndexNow se repitió antes de 3 horas"
print("no se repite antes de 3 horas")

# 3 horas después sin cambios: no se manda nada
atrasar()
d = esperar("sin cambios")
assert d["urls"] == 0 and "estado" not in d and len(recibidas()) == n + 1, d
print("sin cambios, no se manda nada")

# un partido termina: él, sus equipos, su liga y la portada, nada más
p, q = [x for x in partidos if not x.get("pendiente") and x["utcDate"] > ahora][:2]
liquidado = int(time.time() * 1000)
db.execute("INSERT OR REPLACE INTO resultados (id, liga, utc, gl, gv, contado, liquidado) VALUES (?, ?, ?, 1, 0, 1, ?)",
           (p["id"], p["liga_codigo"], p["utcDate"], liquidado))
db.commit()
atrasar()
d = esperar("un partido terminado")
e = recibidas()[-1]
rutas = {u[len(WEB):] for u in e["urlList"]}
assert rutas == {"/", f"/liga/{p['liga_codigo']}", f"/partido/{p['id']}", f"/equipo/{p['local_id']}",
                 f"/equipo/{p['visita_id']}"}, rutas
assert d["desde"] == liquidado and d["estado"] == 200, d
print(f"un partido que termina: la portada, su liga, su página y la de sus dos equipos ({len(rutas)} direcciones)")

# si IndexNow falla, se apunta sin mover nada, y la vez siguiente va otra vez
urllib.request.urlopen(API + "/__indexnow?estado=500").read()
db.execute("INSERT OR REPLACE INTO resultados (id, liga, utc, gl, gv, contado, liquidado) VALUES (?, ?, ?, 0, 2, 1, ?)",
           (q["id"], q["liga_codigo"], q["utcDate"], liquidado + 1))
db.commit()
atrasar()
d = esperar("IndexNow falla")
assert d["estado"] == 500 and d["desde"] == liquidado and "error" in d, d
urllib.request.urlopen(API + "/__indexnow?estado=200").read()
atrasar()
d = esperar("después del fallo")
assert f"{WEB}/partido/{q['id']}" in recibidas()[-1]["urlList"] and d["desde"] == liquidado + 1 and d["estado"] == 200, d
print("si IndexNow falla, la vez siguiente lo vuelve a mandar")

db.execute("DELETE FROM resultados WHERE id IN (?, ?)", (p["id"], q["id"]))
db.commit()
print("indexnow: OK")
