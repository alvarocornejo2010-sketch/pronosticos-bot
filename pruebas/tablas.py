"""La tabla de cada liga y lo que le falta (worker/tablas.js), contra el Worker local
ya lleno y con la validación terminada (lo deja así correr_cron.py): el cron las baja
en sus minutos libres, una liga por minuto, sin pasarse de CPU. Comprueba que
/api/tabla/PD trae la clasificación de la API y cada partido que falta con sus goles
esperados (los mismos que los partidos de la semana entre esos equipos), con ETag;
que una tabla que falla (la del Brasileirão, la primera vez) no se pide otra vez en
cada minuto; y que en Flask responde no_disponible.
Uso: python pruebas/tablas.py PUERTO_WORKER PUERTO_API MAX_MS"""
import glob, json, os, subprocess, sys, urllib.error, urllib.request

W, API = f"http://127.0.0.1:{sys.argv[1]}", f"http://127.0.0.1:{sys.argv[2]}"
MAX_MS = float(sys.argv[3])
LIGAS = ["PD", "PL", "FL1", "BL1", "SA", "DED", "PPL", "ELC", "BSA"]
pid = next(p for p in subprocess.check_output(["pgrep", "-f", "workerd serve"]).decode().split()
           if f"127.0.0.1:{sys.argv[1]}" in open(f"/proc/{p}/cmdline").read().replace("\0", " "))


def cpu_ms():
    t = 0
    for f in glob.glob(f"/proc/{pid}/task/*/schedstat"):
        try:
            t += int(open(f).read().split()[0])
        except OSError:
            pass
    return t / 1e6


def pedir(ruta, etag=None):
    req = urllib.request.Request(W + ruta, headers={"If-None-Match": etag} if etag else {})
    try:
        r = urllib.request.urlopen(req)
        return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def tabla(c):
    return json.loads(pedir("/api/tabla/" + c)[2])


st, _, cuerpo = pedir("/api/tabla/PD")
assert st == 200 and json.loads(cuerpo)["estado"] == "sin_datos", cuerpo   # aún no: van después de la validación
ticks = []
for i in range(40):
    a = cpu_ms()
    urllib.request.urlopen(W + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*").read()
    ticks.append(round(cpu_ms() - a, 1))
    if all(tabla(c)["estado"] == "listo" for c in LIGAS[:-1]):
        break
else:
    sys.exit("tras 40 minutos del cron faltan tablas: " + str({c: tabla(c)["estado"] for c in LIGAS}))
print(f"tablas: 8 ligas en {len(ticks)} minutos del cron; CPU máx {max(ticks)} ms, media {sum(ticks) / len(ticks):.1f}")
assert max(ticks) <= MAX_MS, ticks

for c, n_eq, bajan in (("PD", 20, 3), ("BL1", 18, 2), ("ELC", 24, 3)):
    t = tabla(c)
    eq = t["equipos"]
    assert len(eq) == n_eq and [e["pos"] for e in eq] == list(range(1, n_eq + 1)), (c, [e["pos"] for e in eq])
    assert all(e["pts"] == 3 * e["g"] + e["e"] and e["pj"] == e["g"] + e["e"] + e["p"] for e in eq), c
    assert all(e["escudo"] is None or e["escudo"].startswith("https://") for e in eq), c
    assert t["zonas"][0] == ["Campeón", 1, 1] and t["zonas"][-1] == ["Descenso", -bajan, -1], t["zonas"]
    # 300 partidos, el aplazado incluido; en la Championship, uno de playoffs que no es liga
    assert len(t["restantes"]) == (299 if c == "ELC" else 300), (c, len(t["restantes"]))
    assert all(0 <= i < n_eq and 0 <= j < n_eq and i != j and xl > 0 and xv > 0 for i, j, xl, xv in t["restantes"]), c
    assert t["version_modelo"] >= 3 and t["tabla_actualizada"] and t["restantes_actualizados"]
print("tabla: la clasificación de la API, las zonas de cada liga y lo que falta, con el aplazado y sin los playoffs")

# los goles esperados de lo que falta son los del modelo: los mismos que los de la
# semana entre esos dos equipos (allí con dos decimales)
estado = json.loads(pedir("/api/estado")[2])
t = tabla("PD")
ids = {e["nombre"]: k for k, e in enumerate(t["equipos"])}
xg = {(i, j): (xl, xv) for i, j, xl, xv in t["restantes"]}
iguales = 0
for d in estado["dias"]:
    for p in d["partidos"]:
        par = (ids.get(p["local"]), ids.get(p["visita"]))
        if p.get("liga_codigo") == "PD" and not p.get("pendiente") and par in xg:
            assert abs(xg[par][0] - p["xg_local"]) <= 0.006 and abs(xg[par][1] - p["xg_visita"]) <= 0.006, (par, xg[par], p)
            iguales += 1
assert iguales >= 3, iguales
print(f"goles esperados: los de la semana en {iguales} partidos de LaLiga que también están en lo que falta")

st, cab, _ = pedir("/api/tabla/PD")
st2, _, cuerpo = pedir("/api/tabla/PD", cab["ETag"])
assert st == 200 and st2 == 304 and cuerpo == b"", (st, st2)
assert pedir("/api/tabla/XX")[0] == 404 and pedir("/api/tabla/CL")[0] == 404 and pedir("/api/tabla/pd")[0] == 404
print("ruta: ETag y 304; una liga que no existe (o la Champions) da 404")

# la del Brasileirão falló la primera vez: no se vuelve a pedir en cada minuto
assert tabla("BSA")["estado"] == "sin_datos"
for _ in range(3):
    urllib.request.urlopen(W + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*").read()
pedidas = json.load(urllib.request.urlopen(API + "/__stats"))["por_tipo"].get("/v4/competitions/BSA/standings", 0)
assert pedidas == 1, pedidas
print("una tabla que falla espera una hora antes de volver a pedirse")

os.environ.setdefault("FOOTBALL_DATA_TOKEN", "sin_uso_en_esta_prueba")
os.environ.setdefault("UPDATE_SECRET", "tablas_dummy_secret")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402

assert app.app.test_client().get("/api/tabla/PD").get_json()["estado"] == "no_disponible"
print("Flask: /api/tabla responde no_disponible")
print("tablas: OK")
