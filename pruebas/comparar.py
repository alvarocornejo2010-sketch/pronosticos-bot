"""Compara lo que sirve el Worker con lo que sirvió Flask (salida de correr_flask.py).
Sale con error si hay alguna diferencia.
Uso: python pruebas/comparar.py flask.json URL_WORKER"""
import json, sys, urllib.request

flask = json.load(open(sys.argv[1]))
base = sys.argv[2].rstrip("/")
w = {k: json.load(urllib.request.urlopen(base + r))
     for k, r in (("estado", "/api/estado"), ("ligas", "/api/ligas"), ("validacion", "/api/validacion"))}
IGNORAR = {"calculado", "ultima_actualizacion", "requests_gastadas", "debug_busqueda", "plataforma", "hora", "iniciado"}
dif = []


def cmp(a, b, ruta):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in set(a) | set(b):
            if k in IGNORAR:
                continue
            if k not in a or k not in b:
                dif.append((ruta + "." + k, a.get(k, "<falta>"), b.get(k, "<falta>")))
                continue
            cmp(a[k], b[k], ruta + "." + k)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            dif.append((ruta + "[len]", len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            cmp(x, y, f"{ruta}[{i}]")
    elif a != b and not (isinstance(a, (int, float)) and isinstance(b, (int, float)) and float(a) == float(b)):
        dif.append((ruta, a, b))


for k in ("estado", "ligas", "validacion"):
    antes = len(dif)
    cmp(flask[k], w[k], k)
    print(f"{k}: {len(dif) - antes} diferencias")
for d in dif[:25]:
    print("  ", str(d)[:300])
n = sum(len(d["partidos"]) for d in w["estado"]["dias"])
cl = sum(1 for d in w["estado"]["dias"] for p in d["partidos"] if p["liga_codigo"] == "CL")
print(f"partidos en el Worker: {n} (Champions {cl}); días: {[d['fecha'] + ' ' + d['etiqueta'] for d in w['estado']['dias']]}")
sys.exit(1 if dif else 0)
