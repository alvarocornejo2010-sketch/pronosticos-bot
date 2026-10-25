"""Las visitas (worker/visitas.js): lo que manda la web se suma bien; lo que no
encaja en las listas fijas, lo de otra web, lo de un bot y lo que no es JSON no
cuenta; el panel exige el token; y al llegar al tope del día se deja de escribir.
Se corre contra el Worker local de e2e.sh, arrancado con MAX_VISITAS_DIA=60.
Uso: python pruebas/visitas.py PUERTO_WORKER UPDATE_SECRET"""
import json, sys, urllib.error, urllib.request

W, SECRETO = f"http://127.0.0.1:{sys.argv[1]}", sys.argv[2]
NAVEGADOR = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
get = lambda url: json.load(urllib.request.urlopen(url))


def mandar(cuerpo, ua=NAVEGADOR, origen=None, sitio=None):
    datos = cuerpo if isinstance(cuerpo, bytes) else json.dumps(cuerpo).encode()
    cab = {"User-Agent": ua, "Content-Type": "text/plain;charset=UTF-8"}
    if origen:
        cab["Origin"] = origen
    if sitio:
        cab["Sec-Fetch-Site"] = sitio
    r = urllib.request.urlopen(urllib.request.Request(W + "/api/contar", data=datos, headers=cab, method="POST"))
    assert r.status == 204, r.status


def estado_http(url, metodo="GET"):
    try:
        return urllib.request.urlopen(urllib.request.Request(url, method=metodo)).status
    except urllib.error.HTTPError as e:
        return e.code


resumen = lambda: get(W + f"/api/visitas?token={SECRETO}")

r = resumen()
assert r["semana"]["visitas"] == 0 and r["dias"][-1]["dia"] == r["hoy"] and len(r["dias"]) == 30, r["semana"]

mandar([{"t": "entrada", "v": "nuevo", "d": "escritorio", "o": "www.google.com", "via": "partido", "f": 1}])
mandar([{"t": "entrada", "v": "repite", "d": "escritorio", "o": ""}])
mandar([{"t": "entrada", "v": "vuelve", "hace": 3, "d": "movil", "o": "", "app": 1}])
r = resumen()
s, d = r["semana"], r["desglose"]
assert (s["visitas"], s["visitantes"], s["nuevos"], s["vuelven"]) == (3, 2, 1, 1), s
assert d["origen"] == {"google": 1, "directo": 1}, d["origen"]
assert d["dispositivo"] == {"escritorio": 1, "movil": 1}, d["dispositivo"]
assert d["vuelta"] == {"2-7": 1}, d["vuelta"]
assert sum(d["hora"].values()) == 3, d["hora"]
assert (s["llegadas"], s["con_favoritos"], s["en_app"]) == (1, 1, 1), s
print("entradas: 3 visitas de 2 visitantes (1 nuevo de Google, 1 que vuelve), por hora y pantalla;"
      " 1 llegó por un enlace compartido y sigue a algún equipo; 1 desde la app instalada")

estado = get(W + "/api/estado")
fecha, uno = next((dia["fecha"], p) for dia in estado["dias"] for p in dia["partidos"])
mandar([{"t": "partido", "id": uno["id"]}, {"t": "partido", "id": uno["id"]}, {"t": "partido", "id": 999999999},
        {"t": "partido", "id": "1; DROP TABLE visitas"}, {"t": "liga", "c": "PD"}, {"t": "liga", "c": "<b>XX</b>"},
        {"t": "busqueda"}, {"t": "pestana", "p": "panorama"}, {"t": "pestana", "p": "otra"}, {"t": "inventado"},
        "texto", None, {"t": "entrada", "v": "nuevo", "o": "evil.example"}, {"t": "entrada", "v": "nuevo"},
        {"t": "compartir", "id": uno["id"]}, {"t": "compartir", "id": 999999999}, {"t": "favorito"},
        {"t": "instalada"}, {"t": "error", "k": "TypeError", "l": 812}, {"t": "error", "k": "Promesa", "l": 0},
        {"t": "error", "k": "<script>", "l": 1}, {"t": "error", "k": "TypeError", "l": "812"},
        {"t": "error", "k": "TypeError", "l": 812}, {"t": "error", "k": "RangeError", "l": 5}])
r = resumen()
s, d = r["semana"], r["desglose"]
assert d["error"] == {"TypeError:812": 2, "Promesa:0": 1}, d["error"]   # lista cerrada, y 3 por petición
assert s["partidos"] == 2 and s["busquedas"] == 1, s
assert d["liga"] == {"PD": 1} and d["pestana"] == {"panorama": 1}, d
assert d["origen"] == {"google": 1, "directo": 1, "otro": 1}, d["origen"]   # una sola entrada por petición
assert s["visitas"] == 4, s
assert (s["compartidos"], s["estrellas"], s["instaladas"]) == (1, 1, 1), s
assert len(r["partidos"]) == 1, r["partidos"]
top = r["partidos"][0]
assert (top["id"], top["n"], top["liga"], top["utc"], top["fecha"], top["local"], top["visita"]) == (
    uno["id"], 2, uno["liga_codigo"], uno["utcDate"], fecha, uno.get("local_corto") or uno["local"],
    uno.get("visita_corto") or uno["visita"]), top
print("eventos: cuentan el partido que existe (abierto o compartido), la liga, la pestaña y la estrella;"
      " los errores del navegador por tipo y línea; lo inventado no")

antes = resumen()["semana"]
mandar([{"t": "entrada", "v": "nuevo"}], origen="https://otra-web.example")
mandar([{"t": "entrada", "v": "nuevo"}], origen="null", sitio="cross-site")
mandar([{"t": "entrada", "v": "nuevo"}], ua="Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")
mandar([{"t": "entrada", "v": "nuevo"}], ua="Mozilla/5.0 HeadlessChrome/140.0")
mandar(b"esto no es json")
mandar(b'{"t": "entrada"}')
mandar(json.dumps([{"t": "busqueda", "relleno": "x" * 5000}]).encode())
assert resumen()["semana"] == antes, (resumen()["semana"], antes)
mandar([{"t": "entrada", "v": "nuevo"}], origen=W)
# lo que manda un navegador que sigue el estándar: con Referrer-Policy: no-referrer, Origin "null"
mandar([{"t": "entrada", "v": "nuevo"}], origen="null", sitio="same-origin")
mandar([{"t": "entrada", "v": "nuevo"}], ua="Mozilla/5.0 (Linux; Android 10; CUBOT X30) Chrome/140.0 Mobile")
assert resumen()["semana"]["visitas"] == antes["visitas"] + 3
print("no cuentan: otra web, Googlebot, un navegador sin ventana, lo que no es una lista ni lo de más de 4 KB")

assert estado_http(W + "/api/contar") == 405
assert estado_http(W + "/api/visitas") == 403 and estado_http(W + "/visitas?token=otro_token_largo") == 403
pan = urllib.request.urlopen(W + f"/visitas?token={SECRETO}")
html = pan.read().decode()
csp = pan.headers["Content-Security-Policy"]
assert pan.headers["Content-Type"].startswith("text/html") and pan.headers["X-Robots-Tag"] == "noindex"
assert "script-src" not in csp and "default-src 'none'" in csp, csp
assert "<script" not in html and "Partidos más abiertos" in html and ">2<" in html and "Compartir, favoritos y app" in html
assert "TypeError:812" in html and "Errores del navegador" in html
print("panel: con token, en HTML, sin JavaScript y fuera de Google")

# el tope del día: con MAX_VISITAS_DIA=60, unas pocas búsquedas lo alcanzan
for _ in range(60):
    if resumen()["tope_alcanzado"]:
        break
    mandar([{"t": "busqueda"}])
r = resumen()
assert r["tope_alcanzado"] == [r["hoy"]], r["tope_alcanzado"]
lleno = r["semana"]
mandar([{"t": "busqueda"}, {"t": "entrada", "v": "nuevo"}])
assert resumen()["semana"] == lleno
print(f"tope: a las {r['dias'][-1]['escrituras']} escrituras se deja de contar")
print("visitas: OK")
