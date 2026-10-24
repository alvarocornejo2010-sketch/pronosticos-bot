"""Las cuentas básicas (worker/cuentas.js): crear con código, entrar desde otro
aparato, las estrellas en la cuenta, un código nuevo, cerrar sesión (en uno y en
todos), descargar los datos y borrar la cuenta; lo que llega de otra web no entra,
una ruta que no existe no hace nada, cada cuenta guarda 20 sesiones como mucho, y
los topes del día (cuentas nuevas y filas escritas) cortan, menos al borrar. Se
corre contra el Worker local de e2e.sh, arrancado con MAX_CUENTAS_DIA=4 y
MAX_ESCRITURAS_CUENTAS_DIA=400.
Uso: python pruebas/cuentas.py PUERTO_WORKER"""
import json, re, sys, urllib.error, urllib.request

W = f"http://127.0.0.1:{sys.argv[1]}"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
PROPIA = {"Origin": "null", "Sec-Fetch-Site": "same-origin"}   # lo que manda la web (no-referrer)


def pedir(ruta, cuerpo=None, sesion=None, cabeceras=PROPIA, tipo="application/json", metodo=None):
    cab = {"User-Agent": UA, **cabeceras}
    if sesion:
        cab["Cookie"] = f"sesion={sesion}"
    datos = None
    if cuerpo is not None:
        datos = cuerpo if isinstance(cuerpo, bytes) else json.dumps(cuerpo).encode()
        cab["Content-Type"] = tipo
    req = urllib.request.Request(W + ruta, data=datos, headers=cab, method=metodo or ("POST" if datos is not None else "GET"))
    try:
        r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        r = e
    texto = r.read().decode()
    galleta = r.headers.get("Set-Cookie")
    try:
        cuerpo = json.loads(texto)
    except ValueError:
        cuerpo = texto
    return r.status, cuerpo, galleta, r.headers


def token(galleta):
    m = re.match(r"sesion=([A-Za-z0-9_-]{43});", galleta or "")
    assert m, galleta
    return m.group(1)


# sin cookie: no hay cuenta, y no se toca la cookie
st, c, g, _ = pedir("/api/cuenta")
assert st == 200 and c == {"disponible": True, "cuenta": None} and g is None, (st, c, g)

# crear: el código (16 letras y números), la cookie y los equipos del navegador, limpios
st, c, g, _ = pedir("/api/cuenta/crear", {"equipos": ["Arsenal FC", " Arsenal FC ", "", 5, "x" * 81, "Real Madrid CF"]})
assert st == 200, (st, c)
codigo = c["codigo"]
assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}", codigo), codigo
for parte in ("Path=/", "Max-Age=15552000", "HttpOnly", "Secure", "SameSite=Lax"):
    assert parte in g, g
a = token(g)
assert c["cuenta"]["equipos"] == ["Arsenal FC", "Real Madrid CF"], c
st, c, g, _ = pedir("/api/cuenta", sesion=a)
assert c["cuenta"]["equipos"] == ["Arsenal FC", "Real Madrid CF"] and g is None, (c, g)   # recién vista: sin renovar
print(f"crear: código {codigo[:4]}-…, cookie HttpOnly/Secure/SameSite=Lax de 180 días y los equipos del navegador")

# las estrellas van a la cuenta
assert pedir("/api/cuenta/equipo", {"equipo": "FC Barcelona", "seguir": True}, a)[0] == 200
assert pedir("/api/cuenta/equipo", {"equipo": "Arsenal FC", "seguir": False}, a)[0] == 200
assert pedir("/api/cuenta/equipo", {"equipo": "FC Barcelona", "seguir": True}, a)[0] == 200   # repetir no pasa nada
assert pedir("/api/cuenta/equipo", {"equipo": "", "seguir": True}, a)[0] == 400
assert pedir("/api/cuenta/equipo", {"equipo": "Inter"}, a)[0] == 400
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"]["equipos"] == ["Real Madrid CF", "FC Barcelona"]

# otro aparato: el código como lo escriba la persona (minúsculas, espacios), y sus equipos se suman
escrito = codigo.lower().replace("-", " ")
st, c, g, _ = pedir("/api/cuenta/entrar", {"codigo": escrito, "equipos": ["FC Internazionale Milano", "FC Barcelona"]})
assert st == 200 and c["cuenta"]["equipos"] == ["Real Madrid CF", "FC Barcelona", "FC Internazionale Milano"], (st, c)
b = token(g)
assert b != a
st, c, g, _ = pedir("/api/cuenta/entrar", {"codigo": "0000-0000-0000-0000", "equipos": []})
assert st == 401 and g is None and "ninguna cuenta" in c["error"], (st, c, g)
assert pedir("/api/cuenta/entrar", {"codigo": "abc", "equipos": []})[0] == 400
print("entrar desde otro aparato: con el código escrito a mano; uno que no existe, no")

# solo desde la propia web, con JSON y con el método que toca
assert pedir("/api/cuenta/crear", {"equipos": []}, cabeceras={"Sec-Fetch-Site": "cross-site"})[0] == 403
assert pedir("/api/cuenta/crear", {"equipos": []}, cabeceras={"Origin": "https://otra-web.example"})[0] == 403
assert pedir("/api/cuenta/borrar", {}, a, cabeceras={"Origin": "https://otra-web.example"})[0] == 403
assert pedir("/api/cuenta/crear", b"equipos=1", tipo="application/x-www-form-urlencoded")[0] == 400
assert pedir("/api/cuenta/crear", b"[]")[0] == 400
assert pedir("/api/cuenta/crear")[0] == 405
assert pedir("/api/cuenta", {}, a)[0] == 405
assert pedir("/api/cuenta/equipo", {"equipo": "Inter", "seguir": True})[0] == 401   # sin sesión
assert pedir("/api/cuenta/datos")[0] == 401
assert pedir("/api/cuenta/nada", {}, a)[0] in (404, 405)   # una ruta que no existe no cae en otra
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"]["equipos"] == ["Real Madrid CF", "FC Barcelona", "FC Internazionale Milano"]
print("otra web, un formulario o sin sesión: no entra")

# un código nuevo: el de antes deja de valer
st, c, _, _ = pedir("/api/cuenta/codigo", {}, a)
nuevo = c["codigo"]
assert st == 200 and nuevo != codigo
assert pedir("/api/cuenta/entrar", {"codigo": codigo, "equipos": []})[0] == 401
st, c, g, _ = pedir("/api/cuenta/entrar", {"codigo": nuevo, "equipos": []})
assert st == 200
tercera = token(g)
print("código nuevo: el de antes ya no entra, el nuevo sí")

# descargar los datos: todo lo de la cuenta, sin el código ni los tokens
st, d, _, cab = pedir("/api/cuenta/datos", sesion=a)
assert st == 200 and 'attachment; filename="pronosticos-mi-cuenta.json"' == cab["Content-Disposition"]
assert [e["equipo"] for e in d["equipos"]] == ["Real Madrid CF", "FC Barcelona", "FC Internazionale Milano"], d
assert len(d["sesiones"]) == 3 and sum(s["este_aparato"] for s in d["sesiones"]) == 1, d["sesiones"]
assert [x["tipo"] for x in d["accesos"]] == ["codigo"]
assert codigo not in json.dumps(d) and nuevo not in json.dumps(d) and a not in json.dumps(d)
print("descargar mis datos: cuenta, accesos, 3 sesiones y equipos; ni el código ni los tokens")

# cerrar sesión: en este aparato, y luego en todos
st, c, g, _ = pedir("/api/cuenta/salir", {"todas": False}, tercera)
assert st == 200 and "Max-Age=0" in g
st, c, g, _ = pedir("/api/cuenta", sesion=tercera)
assert c["cuenta"] is None and "Max-Age=0" in g, (c, g)   # una cookie que ya no vale se borra
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"] is not None
assert pedir("/api/cuenta/salir", {"todas": True}, a)[0] == 200
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"] is None and pedir("/api/cuenta", sesion=b)[1]["cuenta"] is None
print("cerrar sesión: en este aparato (los demás siguen) y en todos")

# borrar la cuenta: ya no hay nada, ni se puede entrar con el código
st, c, g, _ = pedir("/api/cuenta/entrar", {"codigo": nuevo, "equipos": []})
d4 = token(g)
st, c, g, _ = pedir("/api/cuenta/borrar", {}, d4)
assert st == 200 and "Max-Age=0" in g
assert pedir("/api/cuenta", sesion=d4)[1]["cuenta"] is None
assert pedir("/api/cuenta/entrar", {"codigo": nuevo, "equipos": []})[0] == 401
print("borrar la cuenta: fuera la sesión, el código y los equipos")

# hasta 60 equipos por cuenta
st, c, g, _ = pedir("/api/cuenta/crear", {"equipos": [f"Equipo {i}" for i in range(70)]})
assert st == 200 and len(c["cuenta"]["equipos"]) == 60, len(c["cuenta"]["equipos"])
e, codigo_e = token(g), c["codigo"]
st, c, _, _ = pedir("/api/cuenta/equipo", {"equipo": "Uno más", "seguir": True}, e)
assert st == 409 and "60" in c["error"], (st, c)
assert pedir("/api/cuenta/equipo", {"equipo": "Equipo 3", "seguir": True}, e)[0] == 200   # uno que ya sigue, sí
print("tope de equipos: 60 por cuenta")

# el tope de cuentas nuevas del día (MAX_CUENTAS_DIA=4): se cuentan las creadas,
# también las que ya se borraron
creadas = 2
while True:
    st, c, _, _ = pedir("/api/cuenta/crear", {"equipos": []})
    if st != 200:
        break
    creadas += 1
assert st == 429 and creadas == 4, (st, creadas, c)
print(f"tope de cuentas nuevas: a las {creadas} del día (contando la borrada), 429")

# cada cuenta guarda sus 20 sesiones más recientes
for _ in range(21):
    st, c, g, _ = pedir("/api/cuenta/entrar", {"codigo": codigo_e, "equipos": []})
    assert st == 200, (st, c)
ultima = token(g)
d = pedir("/api/cuenta/datos", sesion=ultima)[1]
assert len(d["sesiones"]) == 20 and pedir("/api/cuenta", sesion=e)[1]["cuenta"] is None, len(d["sesiones"])
print("sesiones: 20 por cuenta como mucho; la más vieja se cierra sola")

# el tope de filas escritas por las cuentas en el día (MAX_ESCRITURAS_CUENTAS_DIA=400):
# poner y quitar una estrella en bucle acaba en 429, y borrar la cuenta sigue funcionando
veces = 0
while True:
    st, c, _, _ = pedir("/api/cuenta/equipo", {"equipo": "Equipo 5", "seguir": veces % 2 == 1}, ultima)
    if st != 200:
        break
    veces += 1
    assert veces < 300
assert st == 429 and "muchos cambios" in c["error"], (st, c)
assert pedir("/api/cuenta/borrar", {}, ultima)[0] == 200 and pedir("/api/cuenta", sesion=ultima)[1]["cuenta"] is None
print(f"tope de escrituras: tras {veces} estrellas, 429; borrar la cuenta, aun así, sí")

# el panel de visitas las cuenta (creadas: también las borradas)
v = json.load(urllib.request.urlopen(W + "/api/visitas?token=secreto_de_prueba_123"))
assert v["cuentas"] == {"total": 2, "creadas": 4, "activas": 2, "con_equipos": 0}, v["cuentas"]
print("panel de visitas: 4 creadas esta semana, 2 quedan")
print("cuentas: OK")
