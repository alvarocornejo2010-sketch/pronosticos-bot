"""La página de cada equipo (worker/equipos.js), contra el Worker local ya lleno y con
las tablas bajadas (lo deja así tablas.py): /api/equipo/86 trae su fila de la tabla,
su ataque y su defensa (los del modelo, con su puesto en la liga), sus últimos partidos
de liga (los de la caché) y lo que dijo la web de sus partidos con resultado, con ETag;
un equipo que no existe da 404; /equipo/86 lleva su tarjeta, su descripción y su
dirección canónica; el sitemap trae todos los equipos de las tablas; cada partido de
/api/estado lleva el id de sus equipos; y Flask responde no_disponible. Y la CPU.
Uso: python pruebas/equipos.py PUERTO_WORKER PUERTO_INSPECTOR DIR_D1 MAX_MS"""
import glob, html, json, re, sqlite3, sys, urllib.error, urllib.request

from medir_cpu import Medidor

W, D1, MAX_MS = f"http://127.0.0.1:{sys.argv[1]}", sys.argv[3], float(sys.argv[4])
medidor = Medidor(sys.argv[2])


def pedir(ruta, etag=None):
    req = urllib.request.Request(W + ruta, headers={"If-None-Match": etag} if etag else {})
    try:
        r = urllib.request.urlopen(req)
        return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


og = lambda pagina, prop: html.unescape(re.search(rf'<meta property="og:{prop}" content="([^"]*)">', pagina).group(1))

estado = json.loads(pedir("/api/estado")[2])
partidos = [{**p, "fecha": d["fecha"]} for d in estado["dias"] for p in d["partidos"]]
assert all(isinstance(p["local_id"], int) and isinstance(p["visita_id"], int) for p in partidos), "fichas sin el id de sus equipos"
tabla = json.loads(pedir("/api/tabla/PD")[2])
ids = {e["id"] for e in tabla["equipos"]}
base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
assert len(base) == 1, base
db = sqlite3.connect(base[0])
assert {"predicciones_por_local", "predicciones_por_visita"} <= {
    f[0] for f in db.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
fuerzas = json.loads(db.execute("SELECT valor FROM cache WHERE seccion = 'fuerzas' AND clave = 'PD'").fetchone()[0])
lista = json.loads(db.execute("SELECT valor FROM cache WHERE seccion = 'partidos_liga' AND clave = 'PD:actual'").fetchone()[0])
# un equipo de LaLiga que juega esta semana con pronóstico, y uno de sus partidos de visita; con 5
# partidos jugados o más, para ver que la forma son los 5 últimos (en la API falsa, el Girona tiene
# 4 y el Sevilla 3, y cuál juega primero depende del día)
jugados = lambda e: sum(e in (x[1], x[2]) for x in lista["partidos"])
p = next(p for p in partidos if p["liga_codigo"] == "PD" and not p.get("pendiente") and p["visita_id"] in ids
         and jugados(p["visita_id"]) >= 5)
eid, nombre = p["visita_id"], p["visita"]
print(f"fichas: los {len(partidos)} partidos llevan el id de sus equipos")

# su partido "terminó" 2-1 y la web lo había publicado antes: lo que dijo, contra lo que pasó
db.execute("INSERT OR REPLACE INTO resultados (id, liga, utc, gl, gv, contado, liquidado) VALUES (?, 'PD', ?, 2, 1, 1, 0)",
           (p["id"], p["utcDate"]))
db.commit()

ruta = f"/api/equipo/{eid}"
st, cab, cuerpo = pedir(ruta)
assert st == 200 and cab["Content-Type"].startswith("application/json") and cab["ETag"], (st, cuerpo[:200])
d = json.loads(cuerpo)
yo = next(e for e in tabla["equipos"] if e["id"] == eid)
assert (d["estado"], d["id"], d["nombre"], d["liga"], d["liga_nombre"]) == ("listo", eid, nombre, "PD", tabla["nombre"]), d
assert (d["corto"], d["escudo"]) == (yo["corto"], yo["escudo"]), d
assert d["tabla"] == {k: yo[k] for k in ("pos", "pj", "g", "e", "p", "gf", "gc", "pts")} | {
    "equipos": len(tabla["equipos"]), "actualizada": tabla["tabla_actualizada"]}, d["tabla"]

# ataque y defensa: los del modelo, y su puesto entre los de la tabla
a, df, n = fuerzas["equipos"][str(eid)]
f = d["fuerza"]
assert (f["ataque"], f["defensa"], f["partidos"], f["equipos"]) == (round(a, 3), round(df, 3), n, len(ids)), f
todas = [fuerzas["equipos"][str(i)] for i in ids]
assert f["puesto_ataque"] == 1 + sum(x[0] > a for x in todas), f
assert f["puesto_defensa"] == 1 + sum(x[1] < df for x in todas), f
print(f"{nombre}: {d['tabla']['pos']}.º con {d['tabla']['pts']} puntos; marca {f['ataque']} ({f['puesto_ataque']}.º),"
      f" encaja {f['defensa']} ({f['puesto_defensa']}.º), con {n} partidos")

# su forma: los 5 últimos de liga de la caché, del más viejo al más nuevo, desde su lado
nombres = {e["id"]: e["nombre"] for e in tabla["equipos"]}
suyos = [x for x in lista["partidos"] if eid in (x[1], x[2])][-5:]
esperada = [{"local": x[1] == eid, "rival": nombres[x[2] if x[1] == eid else x[1]],
             "gf": x[3] if x[1] == eid else x[4], "gc": x[4] if x[1] == eid else x[3]} for x in suyos]
assert len(suyos) == 5 and [{k: v for k, v in x.items() if k in ("local", "rival", "gf", "gc")} for x in d["forma"]] == esperada, d["forma"]

# lo que dijo la web: su partido con resultado, con los números que publicó
assert len(d["ultimos"]) == 1, d["ultimos"]
u = d["ultimos"][0]
assert (u["id"], u["gl"], u["gv"], u["visita"], u["utcDate"]) == (p["id"], 2, 1, nombre, p["utcDate"]), u
assert (u["prob_local"], u["prob_empate"], u["prob_visita"]) == (p["prob_local"], p["prob_empate"], p["prob_visita"]), u
assert (u["fecha"], u["hora"]) == (p["fecha"], p["hora"]), u
print("forma: sus 5 últimos de liga; lo que dijo la web: su partido con resultado, con los números publicados")

st, cab2, cuerpo = pedir(ruta, cab["ETag"])
assert st == 304 and cuerpo == "", st
st, cab2, cuerpo = pedir(ruta, "W/" + cab["ETag"])
assert st == 304, st
st, _, cuerpo = pedir("/api/equipo/999999999")
assert st == 404 and json.loads(cuerpo)["estado"] == "no_encontrado", (st, cuerpo)
assert pedir("/api/equipo/12abc")[0] == 404
ms = [medidor.pedir(W + ruta)[1] for _ in range(5)]
print(f"ruta: ETag y 304 (también W/); uno que no existe, 404; CPU {min(ms)}-{max(ms)} ms")
assert max(ms) <= MAX_MS, ms

# /equipo/86: la web con su tarjeta, para compartir y para Google
st, cab, pag = pedir(f"/equipo/{eid}")
corto = d["corto"] or nombre
assert st == 200 and cab["Content-Type"].startswith("text/html") and cab.get("X-Robots-Tag") is None, st
assert "script-src 'self'" in cab["Content-Security-Policy"] and '<script src="/app.js"></script>' in pag
assert og(pag, "title") == f"{corto}: próximos partidos y pronóstico", og(pag, "title")
desc = og(pag, "description")
assert desc.startswith(f"{tabla['nombre']}: {d['tabla']['pos']}.º con {d['tabla']['pts']} puntos. Próximo partido: "), desc
assert f'<link rel="canonical" href="{W}/equipo/{eid}">' in pag and og(pag, "url") == f"{W}/equipo/{eid}"
st, cab, pag = pedir("/equipo/999999999")
assert st == 200 and cab["X-Robots-Tag"] == "noindex" and "<title>Pronósticos</title>" in pag
print(f"/equipo/{eid}: la web con la tarjeta de {corto} ({desc[:60]}…) y su dirección canónica; uno que no existe, fuera de Google")

# el sitemap: los equipos de todas las tablas que ya hay
listas = [json.loads(pedir("/api/tabla/" + c)[2]) for c in ("PD", "PL", "FL1", "BL1", "SA", "DED", "PPL", "ELC", "BSA")]
todos = {e["id"] for t in listas if t["estado"] == "listo" for e in t["equipos"]}
mapa = pedir("/sitemap.xml")[2]
en_mapa = {int(x) for x in re.findall(r"<loc>[^<]*/equipo/(\d+)</loc>", mapa)}
assert en_mapa == todos and len(todos) >= 150, (len(en_mapa), len(todos))
print(f"sitemap: los {len(todos)} equipos de las tablas")

db.execute("DELETE FROM resultados WHERE id = ?", (p["id"],))
db.commit()
print("equipos: OK")
