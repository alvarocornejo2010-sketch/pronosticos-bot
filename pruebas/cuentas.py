"""Las cuentas (worker/cuentas.js): crear con usuario y contraseña, entrar desde otro
aparato, las estrellas en la cuenta, cambiar la contraseña (cierra las demás
sesiones), el correo (crear con él, entrar con él, cambiarlo o quitarlo con la
contraseña), Turnstile al crear (sin la ficha o con una ya usada, no), el bloqueo tras
10 intentos sin acertar (también si llegan todos a la vez, y contando los de cambiar la
contraseña), ponerle usuario a una cuenta de la primera
versión (la del código), cerrar sesión (en uno y en todos), descargar los datos y
borrar la cuenta; lo que llega de otra web no entra, una ruta que no existe no hace
nada, cada cuenta guarda 20 sesiones como mucho, y los topes del día (cuentas nuevas,
intentos de entrar y filas escritas) cortan, menos al borrar; los intentos no gastan
lo de las estrellas. La "clave" que manda la web es el PBKDF2 de la contraseña
(app.js, claveDe); aquí basta con 64 caracteres hexadecimales.
Se corre contra el Worker local de e2e.sh, arrancado con MAX_CUENTAS_DIA=4,
MAX_INTENTOS_DIA=120, MAX_ESCRITURAS_CUENTAS_DIA=600 y el Turnstile de mentira de
api_falsa.py (vale "ficha-buena...", una vez cada una).
Uso: python pruebas/cuentas.py PUERTO_WORKER DIR_D1"""
import glob, hashlib, json, re, secrets, sqlite3, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from itertools import count

W = f"http://127.0.0.1:{sys.argv[1]}"
D1 = sys.argv[2]
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
PROPIA = {"Origin": "null", "Sec-Fetch-Site": "same-origin"}   # lo que manda la web (no-referrer)
clave = lambda texto: hashlib.sha256(texto.encode()).hexdigest()   # como si fuera el PBKDF2 del navegador
FICHAS = count()   # Turnstile: una ficha nueva para cada cuenta que se crea


def pedir(ruta, cuerpo=None, sesion=None, cabeceras=PROPIA, tipo="application/json", metodo=None):
    cab = {"User-Agent": UA, **cabeceras}
    if sesion:
        cab["Cookie"] = f"sesion={sesion}"
    datos = None
    if ruta == "/api/cuenta/crear" and isinstance(cuerpo, dict) and "turnstile" not in cuerpo:
        cuerpo = {**cuerpo, "turnstile": f"ficha-buena-{next(FICHAS)}"}
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


# sin cookie: no hay cuenta, y no se toca la cookie; la web recibe la clave pública de Turnstile
st, c, g, _ = pedir("/api/cuenta")
assert st == 200 and c == {"disponible": True, "cuenta": None, "turnstile": "clave_de_sitio_falsa"} and g is None, (st, c, g)

# Turnstile: sin la ficha, con una que Cloudflare no da por buena o con una enorme, no
# se crea la cuenta (y no cuenta para el tope de cuentas nuevas)
for ficha in (None, 5, "ficha-mala", "ficha-buena" + "x" * 3000):
    st, c, _, _ = pedir("/api/cuenta/crear", {"usuario": "robot.1", "clave": clave("r"), "equipos": [], "turnstile": ficha})
    assert st == 400 and "robot" in c["error"], (ficha, st, c)
print("Turnstile: sin la ficha o con una mala, no hay cuenta")

# crear: usuario (sin distinguir mayúsculas), la cookie y los equipos del navegador, limpios
st, c, g, _ = pedir("/api/cuenta/crear", {"usuario": " Alvaro.C ", "clave": clave("buena-1"),
                                          "equipos": ["Arsenal FC", " Arsenal FC ", "", 5, "x" * 81, "Real Madrid CF"]})
assert st == 200, (st, c)
for parte in ("Path=/", "Max-Age=15552000", "HttpOnly", "Secure", "SameSite=Lax"):
    assert parte in g, g
a = token(g)
cuenta = c["cuenta"]
assert cuenta["usuario"] == "alvaro.c" and cuenta["equipos"] == ["Arsenal FC", "Real Madrid CF"], cuenta
assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}", cuenta["id"]), cuenta["id"]
st, c, g, _ = pedir("/api/cuenta", sesion=a)
assert c["cuenta"] == cuenta and g is None, (c, g)   # recién vista: sin renovar
print(f"crear: usuario alvaro.c, ID {cuenta['id']}, cookie HttpOnly/Secure/SameSite=Lax de 180 días y los equipos del navegador")

# el usuario no se repite (tampoco cambiando mayúsculas) y tiene que valer
assert pedir("/api/cuenta/crear", {"usuario": "ALVARO.C", "clave": clave("x"), "equipos": []})[0] == 409
for malo in ("ab", "ñandú", "-empieza", "con espacio", "x" * 25, None):
    st, c, _, _ = pedir("/api/cuenta/crear", {"usuario": malo, "clave": clave("x"), "equipos": []})
    assert st == 400 and "usuario" in c["error"].lower(), (malo, st, c)
assert pedir("/api/cuenta/crear", {"usuario": "otro.mas", "clave": "corta", "equipos": []})[0] == 400
print("usuario: único sin distinguir mayúsculas, de 3 a 24 letras, números, punto, guion o guion bajo")

# las estrellas van a la cuenta
assert pedir("/api/cuenta/equipo", {"equipo": "FC Barcelona", "seguir": True}, a)[0] == 200
assert pedir("/api/cuenta/equipo", {"equipo": "Arsenal FC", "seguir": False}, a)[0] == 200
assert pedir("/api/cuenta/equipo", {"equipo": "FC Barcelona", "seguir": True}, a)[0] == 200   # repetir no pasa nada
assert pedir("/api/cuenta/equipo", {"equipo": "", "seguir": True}, a)[0] == 400
assert pedir("/api/cuenta/equipo", {"equipo": "Inter"}, a)[0] == 400
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"]["equipos"] == ["Real Madrid CF", "FC Barcelona"]

# otro aparato: usuario y contraseña, y sus equipos se suman
st, c, g, _ = pedir("/api/cuenta/entrar", {"usuario": "Alvaro.C", "clave": clave("buena-1"),
                                           "equipos": ["FC Internazionale Milano", "FC Barcelona"]})
assert st == 200 and c["cuenta"]["equipos"] == ["Real Madrid CF", "FC Barcelona", "FC Internazionale Milano"], (st, c)
b = token(g)
assert b != a and c["cuenta"]["id"] == cuenta["id"]
for usuario, k in (("alvaro.c", clave("mala")), ("nadie.aqui", clave("buena-1")), ("??", clave("x"))):
    st, c, g, _ = pedir("/api/cuenta/entrar", {"usuario": usuario, "clave": k, "equipos": []})
    assert st == 401 and g is None and c["error"] == "Usuario o contraseña incorrectos.", (usuario, st, c, g)
assert pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave("buena-1"), "equipos": []})[0] == 200
print("entrar desde otro aparato: con usuario y contraseña; con la contraseña mal o un usuario que no existe, el mismo error")

# solo desde la propia web, con JSON y con el método que toca
assert pedir("/api/cuenta/crear", {"usuario": "x.y.z", "clave": clave("x")}, cabeceras={"Sec-Fetch-Site": "cross-site"})[0] == 403
assert pedir("/api/cuenta/crear", {"usuario": "x.y.z", "clave": clave("x")}, cabeceras={"Origin": "https://otra-web.example"})[0] == 403
assert pedir("/api/cuenta/borrar", {}, a, cabeceras={"Origin": "https://otra-web.example"})[0] == 403
assert pedir("/api/cuenta/crear", b"usuario=1", tipo="application/x-www-form-urlencoded")[0] == 400
assert pedir("/api/cuenta/crear", b"[]")[0] == 400
assert pedir("/api/cuenta/crear")[0] == 405
assert pedir("/api/cuenta", {}, a)[0] == 405
assert pedir("/api/cuenta/equipo", {"equipo": "Inter", "seguir": True})[0] == 401   # sin sesión
assert pedir("/api/cuenta/datos")[0] == 401
assert pedir("/api/cuenta/codigo", {}, a)[0] in (404, 405)   # la ruta del código ya no existe
assert pedir("/api/cuenta/nada", {}, a)[0] in (404, 405)
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"]["equipos"] == ["Real Madrid CF", "FC Barcelona", "FC Internazionale Milano"]
print("otra web, un formulario, sin sesión o una ruta que no existe: no entra")

# descargar los datos: todo lo de la cuenta, sin la contraseña ni los tokens
st, d, _, cab = pedir("/api/cuenta/datos", sesion=a)
assert st == 200 and 'attachment; filename="pronosticos-mi-cuenta.json"' == cab["Content-Disposition"]
assert d["cuenta"]["usuario"] == "alvaro.c" and d["cuenta"]["id"] == cuenta["id"], d["cuenta"]
assert [e["equipo"] for e in d["equipos"]] == ["Real Madrid CF", "FC Barcelona", "FC Internazionale Milano"], d
assert len(d["sesiones"]) == 3 and sum(s["este_aparato"] for s in d["sesiones"]) == 1, d["sesiones"]
assert clave("buena-1") not in json.dumps(d) and a not in json.dumps(d)
print("descargar mis datos: usuario, ID, 3 sesiones y equipos; ni la contraseña ni los tokens")

# cambiar la contraseña: con la actual; las demás sesiones se cierran, esta sigue
assert pedir("/api/cuenta/contrasena", {"actual": clave("mala"), "nueva": clave("buena-2")}, a)[0] == 403
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"] is not None   # una contraseña mal no cierra la sesión
assert pedir("/api/cuenta/contrasena", {"actual": clave("buena-1"), "nueva": "corta"}, a)[0] == 400
assert pedir("/api/cuenta/contrasena", {"actual": clave("buena-1"), "nueva": clave("buena-2")}, a)[0] == 200
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"] is not None and pedir("/api/cuenta", sesion=b)[1]["cuenta"] is None
assert pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave("buena-1"), "equipos": []})[0] == 401
st, c, g, _ = pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave("buena-2"), "equipos": []})
assert st == 200
tercera = token(g)
print("cambiar la contraseña: hace falta la actual; la vieja deja de valer y los otros aparatos salen")

# 10 intentos seguidos sin acertar bloquean el usuario 15 minutos (también con la
# buena); los de cambiar la contraseña cuentan (una sesión robada no sirve para probar)
for i in range(5):
    assert pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave(f"mal-{i}"), "equipos": []})[0] == 401
for i in range(4):
    assert pedir("/api/cuenta/contrasena", {"actual": clave(f"mal-c{i}"), "nueva": clave("otra-1")}, tercera)[0] == 403
st, c, _, _ = pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave("mal-9"), "equipos": []})
assert st == 429 and "15 min" in c["error"], (st, c)
st, c, _, _ = pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave("buena-2"), "equipos": []})
assert st == 429, (st, c)
assert pedir("/api/cuenta/contrasena", {"actual": clave("buena-2"), "nueva": clave("otra-1")}, tercera)[0] == 429
assert pedir("/api/cuenta", sesion=tercera)[1]["cuenta"] is not None   # quien ya estaba dentro, sigue
base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
assert len(base) == 1, base
db = sqlite3.connect(base[0])
db.execute("UPDATE usuarios SET bloqueado = 1 WHERE usuario = 'alvaro.c'")   # pasan los 15 minutos
db.commit()
assert pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave("buena-2"), "equipos": []})[0] == 200
assert db.execute("SELECT fallos, bloqueado FROM usuarios WHERE usuario = 'alvaro.c'").fetchone() == (0, 0)
print("bloqueo: a los 10 intentos sin acertar (entrando o cambiando la contraseña), 15 minutos; quien ya estaba dentro sigue")

# una cuenta de la primera versión (la del código): se le pone usuario y contraseña
viejo_id, viejo_token = secrets.token_hex(16), secrets.token_urlsafe(32)[:43]
ms = int(time.time() * 1000)
db.execute("INSERT INTO cuentas (id, creada, vista) VALUES (?, ?, ?)", (viejo_id, ms, ms))
db.execute("INSERT INTO accesos (tipo, clave, cuenta, creado) VALUES ('codigo', ?, ?, ?)", ("ab" * 32, viejo_id, ms))
db.execute("INSERT INTO sesiones (hash, cuenta, creada, vista) VALUES (?, ?, ?, ?)",
           (hashlib.sha256(viejo_token.encode()).hexdigest(), viejo_id, ms, ms))
db.execute("INSERT INTO favoritos (cuenta, equipo, creado) VALUES (?, 'Aston Villa FC', ?)", (viejo_id, ms))
db.commit()
c = pedir("/api/cuenta", sesion=viejo_token)[1]["cuenta"]
assert c["usuario"] is None and c["equipos"] == ["Aston Villa FC"], c
assert pedir("/api/cuenta/usuario", {"usuario": "alvaro.c", "clave": clave("x")}, viejo_token)[0] == 409   # ya existe
st, c, _, _ = pedir("/api/cuenta/usuario", {"usuario": "de.antes", "clave": clave("vieja-1")}, viejo_token)
assert st == 200 and c["cuenta"]["usuario"] == "de.antes" and c["cuenta"]["equipos"] == ["Aston Villa FC"], (st, c)
assert db.execute("SELECT count(*) FROM accesos WHERE cuenta = ?", (viejo_id,)).fetchone()[0] == 0   # el código, fuera
assert pedir("/api/cuenta/usuario", {"usuario": "otro.nombre", "clave": clave("x")}, viejo_token)[0] == 409   # ya tiene
assert pedir("/api/cuenta/entrar", {"usuario": "de.antes", "clave": clave("vieja-1"), "equipos": []})[0] == 200
print("cuenta de la primera versión: se le pone usuario y contraseña, y el código deja de valer")

# 30 intentos a la vez: solo se comparan 10 (los 9 primeros, 401; el décimo pone el
# bloqueo, 429) y los demás ya ni miran la contraseña
with ThreadPoolExecutor(30) as hilos:
    res = list(hilos.map(lambda i: pedir("/api/cuenta/entrar", {"usuario": "de.antes", "clave": clave(f"a-la-vez-{i}"),
                                                                "equipos": []})[0], range(30)))
assert res.count(401) == 9 and res.count(429) == 21, sorted(res)
db.execute("UPDATE usuarios SET bloqueado = 1 WHERE usuario = 'de.antes'")
db.commit()
assert pedir("/api/cuenta/entrar", {"usuario": "de.antes", "clave": clave("vieja-1"), "equipos": []})[0] == 200
print("30 intentos a la vez: 9 sin acertar y el bloqueo; ninguno más llega a mirar la contraseña")

# el correo: opcional al crear, en minúsculas, único, y con él también se entra (la
# clave del correo es la misma contraseña con el correo de sal: aquí, otra cualquiera)
ku, kc = clave("usuario:cc-1"), clave("correo:cc-1")
for malo in ("sin-arroba", "a@b", "con espacio@x.com", "ñ@x.com"):
    st, c, _, _ = pedir("/api/cuenta/crear", {"usuario": "con.correo", "clave": ku, "correo": malo, "clave_correo": kc, "equipos": []})
    assert st == 400 and "correo" in c["error"], (malo, st, c)
assert pedir("/api/cuenta/crear", {"usuario": "con.correo", "clave": ku, "correo": "ana@x.com", "equipos": []})[0] == 400
st, c, g, _ = pedir("/api/cuenta/crear", {"usuario": "con.correo", "clave": ku, "correo": " Ana.Lopez@Example.COM ",
                                          "clave_correo": kc, "equipos": []})
assert st == 200 and c["cuenta"]["correo"] == "ana.lopez@example.com" and c["cuenta"]["usuario"] == "con.correo", (st, c)
cc = token(g)
assert pedir("/api/cuenta", sesion=cc)[1]["cuenta"]["correo"] == "ana.lopez@example.com"
st, c, _, _ = pedir("/api/cuenta/correo", {"correo": "ana.lopez@example.com", "clave_correo": kc, "actual": clave("vieja-1")}, viejo_token)
assert st == 409 and "otra cuenta" in c["error"], (st, c)   # de.antes no puede quedarse el correo de otra
st, c, g, _ = pedir("/api/cuenta/entrar", {"correo": "ANA.LOPEZ@example.com", "clave": kc, "equipos": ["Aston Villa FC"]})
assert st == 200 and c["cuenta"]["usuario"] == "con.correo" and c["cuenta"]["equipos"] == ["Aston Villa FC"], (st, c)
assert pedir("/api/cuenta/entrar", {"correo": "ana.lopez@example.com", "clave": ku, "equipos": []})[0] == 401   # la del usuario no vale
assert pedir("/api/cuenta/entrar", {"correo": "nadie@example.com", "clave": kc, "equipos": []})[0] == 401
assert pedir("/api/cuenta/entrar", {"usuario": "con.correo", "clave": ku, "equipos": []})[0] == 200
assert pedir("/api/cuenta/equipo", {"equipo": "Aston Villa FC", "seguir": False}, cc)[0] == 200
# un fallo con el correo cuenta para el bloqueo de su cuenta, y acertar lo pone a 0
assert pedir("/api/cuenta/entrar", {"correo": "ana.lopez@example.com", "clave": clave("mal"), "equipos": []})[0] == 401
assert db.execute("SELECT fallos FROM usuarios WHERE usuario = 'con.correo'").fetchone()[0] == 1
assert pedir("/api/cuenta/entrar", {"correo": "ana.lopez@example.com", "clave": kc, "equipos": []})[0] == 200
assert db.execute("SELECT fallos FROM usuarios WHERE usuario = 'con.correo'").fetchone()[0] == 0
d = pedir("/api/cuenta/datos", sesion=cc)[1]
assert d["correo"]["correo"] == "ana.lopez@example.com" and d["correo"]["verificado"] is False and kc not in json.dumps(d), d["correo"]
assert db.execute("SELECT length(hash), verificado FROM correos WHERE correo = 'ana.lopez@example.com'").fetchone() == (64, 0)
print("correo: opcional, en minúsculas y de una sola cuenta; con él se entra (y sus fallos cuentan para el bloqueo)")

# cambiarlo o quitarlo pide la contraseña (y cuenta como intento); la contraseña nueva
# va también con la sal del correo, o entrar con él pediría la vieja
kc2 = clave("correo2:cc-1")
st, c, _, _ = pedir("/api/cuenta/correo", {"correo": "ana@nuevo.pe", "clave_correo": kc2, "actual": clave("mal")}, cc)
assert st == 403 and pedir("/api/cuenta", sesion=cc)[1]["cuenta"]["correo"] == "ana.lopez@example.com", (st, c)
st, c, _, _ = pedir("/api/cuenta/correo", {"correo": "ana@nuevo.pe", "clave_correo": kc2, "actual": ku}, cc)
assert st == 200 and c["cuenta"]["correo"] == "ana@nuevo.pe", (st, c)
assert pedir("/api/cuenta/entrar", {"correo": "ana.lopez@example.com", "clave": kc, "equipos": []})[0] == 401
assert pedir("/api/cuenta/entrar", {"correo": "ana@nuevo.pe", "clave": kc2, "equipos": []})[0] == 200
ku3, kc3 = clave("usuario:cc-3"), clave("correo2:cc-3")
assert pedir("/api/cuenta/contrasena", {"actual": ku, "nueva": ku3}, cc)[0] == 400   # falta la del correo
assert pedir("/api/cuenta/contrasena", {"actual": ku, "nueva": ku3, "nueva_correo": kc3}, cc)[0] == 200
assert pedir("/api/cuenta/entrar", {"correo": "ana@nuevo.pe", "clave": kc2, "equipos": []})[0] == 401
assert pedir("/api/cuenta/entrar", {"correo": "ana@nuevo.pe", "clave": kc3, "equipos": []})[0] == 200
assert pedir("/api/cuenta/entrar", {"usuario": "con.correo", "clave": ku3, "equipos": []})[0] == 200
st, c, _, _ = pedir("/api/cuenta/correo", {"correo": "", "actual": ku3}, cc)
assert st == 200 and c["cuenta"]["correo"] is None, (st, c)
assert pedir("/api/cuenta/entrar", {"correo": "ana@nuevo.pe", "clave": kc3, "equipos": []})[0] == 401
st, c, _, _ = pedir("/api/cuenta/correo", {"correo": "ana@nuevo.pe", "clave_correo": kc3, "actual": ku3}, cc)
assert st == 200 and c["cuenta"]["correo"] == "ana@nuevo.pe", (st, c)
assert pedir("/api/cuenta/correo", {"correo": "ana@nuevo.pe", "clave_correo": kc3, "actual": clave("vieja-1")}, viejo_token)[0] == 409
print("cambiar o quitar el correo: con la contraseña; la contraseña nueva vale con el usuario y con el correo")

# cerrar sesión: en este aparato, y luego en todos
st, c, g, _ = pedir("/api/cuenta/salir", {"todas": False}, tercera)
assert st == 200 and "Max-Age=0" in g
st, c, g, _ = pedir("/api/cuenta", sesion=tercera)
assert c["cuenta"] is None and "Max-Age=0" in g, (c, g)   # una cookie que ya no vale se borra
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"] is not None
assert pedir("/api/cuenta/salir", {"todas": True}, a)[0] == 200
assert pedir("/api/cuenta", sesion=a)[1]["cuenta"] is None
print("cerrar sesión: en este aparato (los demás siguen) y en todos")

# borrar la cuenta: ya no hay nada, ni se puede entrar, y el usuario queda libre
st, c, g, _ = pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave("buena-2"), "equipos": []})
d4 = token(g)
assert pedir("/api/cuenta/correo", {"correo": "alvaro@example.com", "clave_correo": clave("correo:buena-2"),
                                   "actual": clave("buena-2")}, d4)[0] == 200
st, c, g, _ = pedir("/api/cuenta/borrar", {}, d4)
assert st == 200 and "Max-Age=0" in g
assert pedir("/api/cuenta", sesion=d4)[1]["cuenta"] is None
assert pedir("/api/cuenta/entrar", {"usuario": "alvaro.c", "clave": clave("buena-2"), "equipos": []})[0] == 401
assert db.execute("SELECT count(*) FROM usuarios WHERE usuario = 'alvaro.c'").fetchone()[0] == 0
assert db.execute("SELECT count(*) FROM correos WHERE correo = 'alvaro@example.com'").fetchone()[0] == 0
assert pedir("/api/cuenta/correo", {"correo": "alvaro@example.com", "clave_correo": clave("c"), "actual": clave("vieja-1")},
             viejo_token)[0] == 200   # el correo queda libre: de.antes se lo puede poner
print("borrar la cuenta: fuera las sesiones, el usuario y el correo (que quedan libres) y los equipos")

# hasta 60 equipos por cuenta
st, c, g, _ = pedir("/api/cuenta/crear", {"usuario": "sesenta", "clave": clave("s"), "equipos": [f"Equipo {i}" for i in range(70)]})
assert st == 200 and len(c["cuenta"]["equipos"]) == 60, len(c["cuenta"]["equipos"])
e = token(g)
st, c, _, _ = pedir("/api/cuenta/equipo", {"equipo": "Uno más", "seguir": True}, e)
assert st == 409 and "60" in c["error"], (st, c)
assert pedir("/api/cuenta/equipo", {"equipo": "Equipo 3", "seguir": True}, e)[0] == 200   # uno que ya sigue, sí
print("tope de equipos: 60 por cuenta")

# el tope de cuentas nuevas del día (MAX_CUENTAS_DIA=4): se cuentan las creadas,
# también las que ya se borraron (la de la primera versión se metió a mano)
creadas, n = 3, 0
while True:
    st, c, _, _ = pedir("/api/cuenta/crear", {"usuario": f"nueva.{n}", "clave": clave("n"), "equipos": []})
    n += 1
    if st != 200:
        break
    creadas += 1
assert st == 429 and creadas == 4, (st, creadas, c)
print(f"tope de cuentas nuevas: a las {creadas} del día (contando la borrada), 429")

# cada cuenta guarda sus 20 sesiones más recientes
for _ in range(21):
    st, c, g, _ = pedir("/api/cuenta/entrar", {"usuario": "sesenta", "clave": clave("s"), "equipos": []})
    assert st == 200, (st, c)
ultima = token(g)
d = pedir("/api/cuenta/datos", sesion=ultima)[1]
assert len(d["sesiones"]) == 20 and pedir("/api/cuenta", sesion=e)[1]["cuenta"] is None, len(d["sesiones"])
print("sesiones: 20 por cuenta como mucho; la más vieja se cierra sola")

# el tope de intentos de entrar del día (MAX_INTENTOS_DIA=120): probar en bucle acaba en
# 429 para todos los que no tengan sesión, pero no gasta lo de las estrellas
escritas = lambda: db.execute("SELECT coalesce(sum(n), 0) FROM visitas WHERE tipo = 'escrituras_cuentas'").fetchone()[0]
antes, veces = escritas(), 0
while True:
    st, c, _, _ = pedir("/api/cuenta/entrar", {"usuario": "nadie.aqui", "clave": clave(f"p{veces}"), "equipos": []})
    if st != 401:
        break
    veces += 1
    assert veces < 200
assert st == 429 and "demasiados intentos de entrar" in c["error"], (st, c)
assert pedir("/api/cuenta/entrar", {"usuario": "sesenta", "clave": clave("s"), "equipos": []})[0] == 429
assert escritas() == antes and pedir("/api/cuenta/equipo", {"equipo": "Equipo 5", "seguir": False}, ultima)[0] == 200
print(f"tope de intentos: tras {veces} más, 429 al entrar; las estrellas de quien ya está dentro siguen")
# el tope de filas escritas por las cuentas en el día (MAX_ESCRITURAS_CUENTAS_DIA=600):
# poner y quitar una estrella en bucle acaba en 429, y borrar la cuenta sigue funcionando
veces = 0
while True:
    st, c, _, _ = pedir("/api/cuenta/equipo", {"equipo": "Equipo 5", "seguir": veces % 2 == 0}, ultima)
    if st != 200:
        break
    veces += 1
    assert veces < 300
assert st == 429 and "muchos cambios" in c["error"], (st, c)
assert pedir("/api/cuenta/borrar", {}, ultima)[0] == 200 and pedir("/api/cuenta", sesion=ultima)[1]["cuenta"] is None
print(f"tope de escrituras: tras {veces} estrellas, 429; borrar la cuenta, aun así, sí")
db.close()

# el panel de visitas las cuenta (creadas: también las borradas; la de la primera versión no pasó por crear)
v = json.load(urllib.request.urlopen(W + "/api/visitas?token=secreto_de_prueba_123"))
assert v["cuentas"] == {"total": 3, "creadas": 4, "activas": 3, "con_equipos": 1, "con_usuario": 3, "con_correo": 2,
                        "intentos": 120}, v["cuentas"]
print("panel de visitas: 4 creadas esta semana, 3 quedan, todas con usuario y 2 con correo; 120 intentos de entrar")
print("cuentas: OK")
