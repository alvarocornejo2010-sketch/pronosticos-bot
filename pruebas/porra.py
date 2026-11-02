"""La porra contra el modelo (worker/porra.js), contra el Worker local ya lleno: con una
cuenta (puesta a mano en su D1: el tope de cuentas nuevas lo gasta cuentas.py), elegir 1, X
o 2 en dos partidos, cambiar uno y quitar otro; lo raro no entra (un signo que no existe, un
partido que no está, uno que ya empezó, otro sin pronóstico, sin sesión o desde otra web);
con un resultado, lo sumado (en cuántos acertó quien juega y en cuántos la web, con su
favorito) y el partido entre los ya jugados; la descarga de datos lo trae y borrar la
cuenta lo borra.
Uso: python pruebas/porra.py PUERTO_WORKER DIR_D1"""
import base64, glob, hashlib, json, os, sqlite3, sys, time, urllib.error, urllib.request

W, D1 = f"http://127.0.0.1:{sys.argv[1]}", sys.argv[2]
PROPIA = {"Origin": "null", "Sec-Fetch-Site": "same-origin"}   # lo que manda la web


def pedir(ruta, cuerpo=None, sesion=None, cabeceras=PROPIA):
    cab = {"Content-Type": "application/json", **cabeceras}
    if sesion:
        cab["Cookie"] = f"sesion={sesion}"
    datos = None if cuerpo is None else json.dumps(cuerpo).encode()
    req = urllib.request.Request(W + ruta, data=datos, headers=cab, method="POST" if datos is not None else "GET")
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
assert len(base) == 1, base
db = sqlite3.connect(base[0])
assert pedir("/api/cuenta")[0] == 200   # que existan las tablas de las cuentas (y la de la porra)
ahora = int(time.time() * 1000)
token = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
cuenta = os.urandom(16).hex()   # como las de verdad (idPublico lee el hexadecimal)
# cuentas.py deja gastado el tope de escrituras de las cuentas del día (lo prueba): otro día
db.execute("DELETE FROM visitas WHERE tipo = 'escrituras_cuentas'")
db.execute("INSERT INTO cuentas (id, creada, vista) VALUES (?, ?, ?)", (cuenta, ahora, ahora))
db.execute("INSERT INTO sesiones (hash, cuenta, creada, vista) VALUES (?, ?, ?, ?)",
           (hashlib.sha256(token.encode()).hexdigest(), cuenta, ahora, ahora))
db.commit()

estado = json.loads(urllib.request.urlopen(W + "/api/estado").read())
ya = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
con = [p for d in estado["dias"] for p in d["partidos"] if not p.get("pendiente") and p["utcDate"] > ya]
p1, p2, p3 = con[:3]
st, d = pedir("/api/cuenta/porra", sesion=token)
assert st == 200 and d == {"estado": "listo", "elegidos": {}, "resumen": {"jugados": 0, "aciertos": 0, "web": 0}, "ultimos": []}, d

# elegir, cambiar y quitar
for p, s in ((p1, "1"), (p2, "X"), (p1, "2")):
    st, d = pedir("/api/cuenta/porra", {"id": p["id"], "signo": s}, token)
    assert st == 200 and d == {"ok": True, "id": p["id"], "signo": s}, (st, d)
assert pedir("/api/cuenta/porra", sesion=token)[1]["elegidos"] == {str(p1["id"]): "2", str(p2["id"]): "X"}
assert pedir("/api/cuenta/porra", {"id": p2["id"], "signo": None}, token)[0] == 200
assert pedir("/api/cuenta/porra", sesion=token)[1]["elegidos"] == {str(p1["id"]): "2"}
assert db.execute("SELECT count(*) FROM porra WHERE cuenta = ?", (cuenta,)).fetchone()[0] == 1
print(f"elegir, cambiar y quitar: {p1['local']} – {p1['visita']}, 2")

# lo raro no entra
assert pedir("/api/cuenta/porra", {"id": p3["id"], "signo": "3"}, token)[0] == 400
assert pedir("/api/cuenta/porra", {"id": "abc", "signo": "1"}, token)[0] == 400
assert pedir("/api/cuenta/porra", {"id": 999999999, "signo": "1"}, token)[0] == 404
assert pedir("/api/cuenta/porra", {"id": p3["id"], "signo": "1"})[0] == 401
assert pedir("/api/cuenta/porra", sesion=None)[0] == 401
assert pedir("/api/cuenta/porra", {"id": p3["id"], "signo": "1"}, token, {"Origin": "https://otra-web.example"})[0] == 403
utc = db.execute("SELECT utc FROM partidos WHERE id = ?", (p3["id"],)).fetchone()[0]
db.execute("UPDATE partidos SET utc = '2020-01-01T00:00:00Z' WHERE id = ?", (p3["id"],))
db.commit()
st, d = pedir("/api/cuenta/porra", {"id": p3["id"], "signo": "1"}, token)
assert st == 409 and "empezó" in d["error"], (st, d)
db.execute("UPDATE partidos SET utc = ? WHERE id = ?", (utc, p3["id"]))
fila = db.execute("SELECT * FROM predicciones WHERE id = ?", (p3["id"],)).fetchone()
db.execute("DELETE FROM predicciones WHERE id = ?", (p3["id"],))
db.commit()
st, d = pedir("/api/cuenta/porra", {"id": p3["id"], "signo": "1"}, token)
assert st == 409 and "calculado" in d["error"], (st, d)
db.execute(f"INSERT INTO predicciones VALUES ({', '.join('?' * len(fila))})", fila)   # como estaba
db.commit()
print("lo raro no entra: signo o partido que no existen (400, 404), sin sesión (401), desde otra web (403), ya empezado"
      " o sin pronóstico (409)")

# un resultado: p1 terminó 0-1 (eligió 2, acertó); la web acertó si su favorito era el 2
db.execute("INSERT OR REPLACE INTO resultados (id, liga, utc, gl, gv, contado, liquidado) VALUES (?, ?, ?, 0, 1, 1, ?)",
           (p1["id"], p1["liga_codigo"], p1["utcDate"], ahora))
db.commit()
st, d = pedir("/api/cuenta/porra", sesion=token)
probs = [p1["prob_local"], p1["prob_empate"], p1["prob_visita"]]
web = "1X2"[max(range(3), key=lambda k: (probs[k], -k))]
assert d["resumen"] == {"jugados": 1, "aciertos": 1, "web": int(web == "2")}, (d["resumen"], web)
u = d["ultimos"][0]
assert (u["id"], u["signo"], u["gl"], u["gv"], u["local"], u["prob_local"]) == (p1["id"], "2", 0, 1, p1["local"], p1["prob_local"]), u
# publicado después de empezar: no cuenta (ni para la web ni para quien juega)
db.execute("UPDATE resultados SET contado = 0 WHERE id = ?", (p1["id"],))
db.commit()
assert pedir("/api/cuenta/porra", sesion=token)[1]["resumen"]["jugados"] == 0
db.execute("UPDATE resultados SET contado = 1 WHERE id = ?", (p1["id"],))
db.commit()
print(f"con resultado: acertó 1 de 1, la web {int(web == '2')} (su favorito, el {web}); publicado tarde no cuenta")

# la descarga de datos lo trae; borrar la cuenta lo borra
req = urllib.request.Request(W + "/api/cuenta/datos", headers={"Cookie": f"sesion={token}"})
datos = json.loads(urllib.request.urlopen(req).read())
assert [(q["partido"], q["eligio"]) for q in datos["porra"]] == [(p1["id"], "2")], datos["porra"]
assert pedir("/api/cuenta/borrar", {}, token)[0] == 200
assert db.execute("SELECT count(*) FROM porra WHERE cuenta = ?", (cuenta,)).fetchone()[0] == 0
print("la descarga de datos lo trae y borrar la cuenta lo borra")

db.execute("DELETE FROM resultados WHERE id = ?", (p1["id"],))
db.commit()
print("porra: OK")
