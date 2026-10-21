"""football-data a veces responde 200 con el calendario incompleto: el 21 oct 2026
dio 5 de los 11 partidos de LaLiga de la semana. Un partido que falta en una
descarga se conserva (con sus números); si falta en dos seguidas, se quita; y si
vuelve, vuelve. Se corre contra el Worker local ya lleno (lo deja así e2e.sh).
Uso: python pruebas/calendario.py PUERTO_WORKER PUERTO_API UPDATE_SECRET"""
import json, sys, urllib.request

W, API, SECRETO = f"http://127.0.0.1:{sys.argv[1]}", f"http://127.0.0.1:{sys.argv[2]}", sys.argv[3]
get = lambda url: json.load(urllib.request.urlopen(url))
partidos = lambda e: [p for d in e["dias"] for p in d["partidos"]]
de_laliga = lambda e: {p["id"]: p for p in partidos(e) if p["liga_codigo"] == "PD"}


def descarga_forzada():
    # /actualizar?forzar=1 deja un pedido; la pasada siguiente vuelve a bajar todos los calendarios
    get(W + f"/actualizar?token={SECRETO}&forzar=1")
    urllib.request.urlopen(W + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*").read()
    e = get(W + "/api/estado")
    assert e["estado"] == "listo", e["estado"]
    return e


e0 = get(W + "/api/estado")
antes = de_laliga(e0)
assert len(antes) >= 4, len(antes)

urllib.request.urlopen(API + "/__omitir?liga=PD&n=3&veces=2").read()
e1 = descarga_forzada()
assert de_laliga(e1).keys() == antes.keys(), "un calendario incompleto quitó partidos a la primera"
assert all(not p.get("pendiente") for p in de_laliga(e1).values())
print("1.ª descarga incompleta: se conservan los", len(antes), "partidos de LaLiga, con números")

e2 = descarga_forzada()
faltan = antes.keys() - de_laliga(e2).keys()
assert len(faltan) == 3, faltan
assert e2["total"] == e0["total"] - 3, (e2["total"], e0["total"])
print("2.ª descarga incompleta: se quitan los 3 que faltan dos veces:", sorted(faltan))

e3 = descarga_forzada()
assert de_laliga(e3).keys() == antes.keys(), "los que vuelven al calendario no vuelven a la web"
assert all(not p.get("pendiente") for p in de_laliga(e3).values())
assert e3["total"] == e0["total"]
print("calendario completo otra vez: vuelven, con la predicción que tenían")
print("calendario: OK")
