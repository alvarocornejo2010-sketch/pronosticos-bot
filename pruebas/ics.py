"""El calendario de Mis equipos (worker/calendario.js), contra el Worker local ya lleno
(lo deja así e2e.sh, arrancado con MAX_CALENDARIOS_DIA=5): se crea con una lista de
equipos y da una clave; /calendario/<clave>.ics es un iCalendar bien formado (CRLF,
líneas de 75 octetos como mucho, texto escapado) con un evento por partido de esos
equipos, con su hora, su pronóstico (los enteros de la web) y, al terminar, su resultado;
cambiar los equipos con la misma clave cambia los eventos; una clave que ya no está se
vuelve a crear; lo raro no entra; el tope de calendarios nuevos corta; el panel lo cuenta;
robots.txt lo deja fuera; y Flask no lo tiene. Y la CPU de leerlo.
Uso: python pruebas/ics.py PUERTO_WORKER PUERTO_INSPECTOR DIR_D1 UPDATE_SECRET MAX_MS"""
import calendar, glob, json, re, sqlite3, sys, time, urllib.error, urllib.request

from medir_cpu import Medidor

W, D1, SECRETO, MAX_MS = f"http://127.0.0.1:{sys.argv[1]}", sys.argv[3], sys.argv[4], float(sys.argv[5])
medidor = Medidor(sys.argv[2])


def pedir(ruta, cuerpo=None, origen=None, metodo=None):
    cab = {"Content-Type": "application/json"} if cuerpo is not None else {}
    if origen:
        cab["Origin"] = origen
    datos = None if cuerpo is None else (cuerpo if isinstance(cuerpo, bytes) else json.dumps(cuerpo).encode())
    try:
        r = urllib.request.urlopen(urllib.request.Request(W + ruta, data=datos, headers=cab, method=metodo))
        return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def enteros(bruto):   # enterosQueSuman de app.js
    e = [int(v // 1) for v in bruto]
    faltan = 100 - sum(e)
    for i in sorted(range(3), key=lambda i: -(bruto[i] - e[i])):
        if faltan <= 0:
            break
        e[i] += 1
        faltan -= 1
    return e


def eventos(texto_bytes):
    """Los eventos del .ics, comprobando el formato de cada línea."""
    assert texto_bytes.endswith(b"\r\n"), "termina sin CRLF"
    fisicas = texto_bytes.split(b"\r\n")[:-1]
    assert all(len(l) <= 75 for l in fisicas), max(fisicas, key=len)
    assert all(b"\n" not in l and b"\r" not in l for l in fisicas)
    lineas = []
    for l in fisicas:
        if l.startswith(b" "):
            lineas[-1] += l[1:]
        else:
            lineas.append(l)
    lineas = [l.decode("utf-8") for l in lineas]   # el pliegue no parte ningún carácter
    assert lineas[0] == "BEGIN:VCALENDAR" and lineas[-1] == "END:VCALENDAR" and "VERSION:2.0" in lineas
    evs, ev = [], None
    for l in lineas:
        if l == "BEGIN:VEVENT":
            ev = {}
        elif l == "END:VEVENT":
            evs.append(ev)
            ev = None
        elif ev is not None:
            k, v = l.split(":", 1)
            ev[k] = v
    return evs


def desescapar(v):
    return re.sub(r"\\(.)", lambda m: "\n" if m.group(1) in "nN" else m.group(1), v)


fecha = lambda iso: time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))))

estado = json.loads(pedir("/api/estado")[2])
todos = [{**p, "fecha": d["fecha"]} for d in estado["dias"] for p in d["partidos"]]
juegos = lambda eq: [p for p in todos if eq in (p["local"], p["visita"])]
veces = {}
for p in todos:
    for e in (p["local"], p["visita"]):
        veces[e] = veces.get(e, 0) + 1
A = max(veces, key=lambda e: (veces[e], e))
B = next(e for e in sorted(veces, key=lambda e: -veces[e]) if e != A and not any(A in (p["local"], p["visita"]) for p in juegos(e)))

# 1. lo raro no entra
assert pedir("/api/calendario", {"equipos": [A]}, origen="https://otra.web")[0] == 403
assert pedir("/api/calendario", {"equipos": []})[0] == 400
assert pedir("/api/calendario", {"clave": "NO-VALE", "equipos": [A]})[0] == 400
assert pedir("/api/calendario", b"no es json")[0] == 400
assert pedir("/api/calendario")[0] == 405
assert pedir("/calendario/abc.ics")[0] == 404
assert pedir("/calendario/" + "a" * 26 + ".ics")[0] == 404   # bien escrita pero no existe

# 2. crear: una clave al azar y su dirección
st, _, cuerpo = pedir("/api/calendario", {"equipos": [A, B, "Un equipo que no existe"]})
assert st == 200, (st, cuerpo)
d = json.loads(cuerpo)
clave = d["clave"]
assert re.fullmatch(r"[a-z2-7]{26}", clave) and d["ruta"] == f"/calendario/{clave}.ics" and d["equipos"] == 3, d

st, cab, cuerpo = pedir(d["ruta"])
assert st == 200 and cab["Content-Type"] == "text/calendar; charset=utf-8" and cab["X-Robots-Tag"] == "noindex", cab
evs = eventos(cuerpo)
esperados = {p["id"]: p for p in juegos(A) + juegos(B)}
assert sorted(int(e["UID"].split("-")[1].split("@")[0]) for e in evs) == sorted(esperados), (len(evs), len(esperados))
for e in evs:
    p = esperados[int(e["UID"].split("-")[1].split("@")[0])]
    nl, nv = p.get("local_corto") or p["local"], p.get("visita_corto") or p["visita"]
    assert e["DTSTART"] == fecha(p["utcDate"]), (e["DTSTART"], p["utcDate"])
    assert desescapar(e["SUMMARY"]) == f"{nl} – {nv}", e["SUMMARY"]
    texto = desescapar(e["DESCRIPTION"])
    if p.get("pendiente"):
        assert "Pronóstico en cálculo." in texto, texto
    else:
        l, x, v = enteros([p["prob_local"], p["prob_empate"], p["prob_visita"]])
        assert f"Pronóstico: {nl} {l} % · empate {x} % · {nv} {v} %." in texto, texto
    assert e["URL"] == f"{W}/partido/{p['id']}" and texto.endswith(e["URL"]), e
print(f"calendario: {len(evs)} partidos de {A} y {B}, con su hora y su pronóstico; líneas de 75 octetos como mucho, con CRLF")

# 3. el resultado: un partido de A "terminó" 2-1
base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
db = sqlite3.connect(base[0])
p1 = next(p for p in juegos(A) if not p.get("pendiente"))
db.execute("INSERT OR REPLACE INTO resultados (id, liga, utc, gl, gv, contado, liquidado) VALUES (?, ?, ?, 2, 1, 1, 0)",
           (p1["id"], p1["liga_codigo"], p1["utcDate"]))
db.commit()
e1 = next(e for e in eventos(pedir(d["ruta"])[2]) if e["UID"] == f"partido-{p1['id']}@pronosticos-bot")
nl, nv = p1.get("local_corto") or p1["local"], p1.get("visita_corto") or p1["visita"]
l, x, v = enteros([p1["prob_local"], p1["prob_empate"], p1["prob_visita"]])
assert desescapar(e1["SUMMARY"]) == f"{nl} 2-1 {nv}", e1["SUMMARY"]
assert desescapar(e1["DESCRIPTION"]).startswith(f"Final. La web daba {nl} {l} % · empate {x} % · {nv} {v} %. "), e1
db.execute("DELETE FROM resultados WHERE id = ?", (p1["id"],))
db.commit()
print(f"resultado: «{nl} 2-1 {nv}», con lo que dijo la web")

# 4. otros equipos, la misma clave: el calendario suscrito los sigue
C = next(e for e in veces if e not in (A, B))
st, _, cuerpo = pedir("/api/calendario", {"clave": clave, "equipos": [C]})
assert st == 200 and json.loads(cuerpo)["clave"] == clave
uids = {e["UID"] for e in eventos(pedir(d["ruta"])[2])}
assert uids == {f"partido-{p['id']}@pronosticos-bot" for p in juegos(C)}, uids
assert pedir("/api/calendario", {"clave": clave, "equipos": []})[0] == 200   # sin estrellas, vacío
assert eventos(pedir(d["ruta"])[2]) == []
print(f"cambiar los equipos (a {C}, y a ninguno): la misma dirección, con los partidos nuevos")

# 5. visto: una escritura al día como mucho
db.execute("UPDATE calendarios SET visto = 0 WHERE clave = ?", (clave,))
db.commit()
pedir(d["ruta"])
visto = db.execute("SELECT visto FROM calendarios WHERE clave = ?", (clave,)).fetchone()[0]
assert visto > time.time() * 1000 - 60000, visto
pedir(d["ruta"])
assert db.execute("SELECT visto FROM calendarios WHERE clave = ?", (clave,)).fetchone()[0] == visto
# una clave que se borró (por no usarse) vuelve con la misma dirección
db.execute("DELETE FROM calendarios WHERE clave = ?", (clave,))
db.commit()
assert pedir(d["ruta"])[0] == 404
assert pedir("/api/calendario", {"clave": clave, "equipos": [A]})[0] == 200 and pedir(d["ruta"])[0] == 200
ms = [medidor.pedir(W + d["ruta"])[1] for _ in range(5)]
print(f"visto: se apunta una vez al día; una clave borrada vuelve con la misma dirección; CPU {min(ms)}-{max(ms)} ms")
assert max(ms) <= MAX_MS, ms

# 6. el tope de nuevos del día (MAX_CALENDARIOS_DIA=5): cuentan los creados, también los
# que se volvieron a crear (y el de la prueba de la interfaz, si ya corrió)
visitas = lambda: json.load(urllib.request.urlopen(W + f"/api/visitas?token={SECRETO}"))
hoy = visitas()["hoy"]
nuevos_hoy = lambda: db.execute("SELECT coalesce(sum(n), 0) FROM visitas WHERE dia = ? AND tipo = 'calendarios' AND clave = ''",
                                (hoy,)).fetchone()[0]
while True:
    st = pedir("/api/calendario", {"equipos": [B]})[0]
    if st == 429:
        break
    assert st == 200 and nuevos_hoy() <= 5, (st, nuevos_hoy())
assert nuevos_hoy() == 5, nuevos_hoy()
assert pedir("/api/calendario", {"clave": clave, "equipos": [A, B]})[0] == 200   # cambiar uno que ya hay, sí
filas = db.execute("SELECT count(*) FROM calendarios").fetchone()[0]
assert visitas()["calendarios"] == {"total": filas, "nuevos": 5, "usados": filas}, (visitas()["calendarios"], filas)
print("tope: a los 5 calendarios nuevos del día, 429 (cambiar uno que ya hay sigue funcionando); el panel lo cuenta")

assert "Disallow: /calendario/" in pedir("/robots.txt")[2].decode()
db.close()
print("ics: OK")
