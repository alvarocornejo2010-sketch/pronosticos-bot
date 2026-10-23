"""El enlace para compartir un partido (worker/compartir.js): /partido/123 es la web
con la tarjeta Open Graph de ese partido (los mismos números que la tabla, con las
cabeceras de public/_headers); un partido que no existe da la tarjeta de siempre.
Se corre contra el Worker local ya lleno (lo deja así e2e.sh).
Uso: python pruebas/compartir.py PUERTO_WORKER"""
import html, json, re, sys, urllib.error, urllib.request

W = f"http://127.0.0.1:{sys.argv[1]}"


def pedir(ruta, metodo="GET"):
    try:
        r = urllib.request.urlopen(urllib.request.Request(W + ruta, method=metodo))
        return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, ""


def enteros(bruto):   # enterosQueSuman de app.js
    e = [int(v // 1) for v in bruto]
    faltan = 100 - sum(e)
    for i in sorted(range(3), key=lambda i: -(bruto[i] - e[i])):
        if faltan <= 0:
            break
        e[i] += 1
        faltan -= 1
    return e


og = lambda pagina, prop: html.unescape(re.search(rf'<meta property="og:{prop}" content="([^"]*)">', pagina).group(1))

estado = json.load(urllib.request.urlopen(W + "/api/estado"))
p = next(p for d in estado["dias"] for p in d["partidos"] if not p.get("pendiente"))
local, visita = p.get("local_corto") or p["local"], p.get("visita_corto") or p["visita"]
st, cab, pag = pedir(f"/partido/{p['id']}")
assert st == 200 and cab["Content-Type"].startswith("text/html"), (st, cab["Content-Type"])
assert cab.get("X-Robots-Tag") is None, cab.get("X-Robots-Tag")
assert "script-src 'self'" in cab["Content-Security-Policy"], cab["Content-Security-Policy"]
assert pag.count("<!-- og -->") == 1 and '<script src="/app.js"></script>' in pag
assert og(pag, "title") == f"{local} – {visita}", og(pag, "title")
l, x, v = enteros([p["prob_local"], p["prob_empate"], p["prob_visita"]])
assert f"{local} {l} % · empate {x} % · {visita} {v} %." in og(pag, "description"), og(pag, "description")
assert og(pag, "url") == f"{W}/partido/{p['id']}" and og(pag, "image") == f"{W}/og.png"
assert f"<title>{html.escape(local)} – {html.escape(visita)} · Pronósticos</title>" in pag
# para Google: la misma descripción que la tarjeta y su dirección canónica
desc = html.unescape(re.search(r'<meta name="description" content="([^"]*)">', pag).group(1))
assert desc == og(pag, "description") and pag.count('<meta name="description"') == 1, desc
assert f'<link rel="canonical" href="{W}/partido/{p["id"]}">' in pag
print(f"/partido/{p['id']}: la web con la tarjeta de {local} – {visita} ({l}/{x}/{v}), su descripción y su"
      " dirección canónica, con su CSP")

st, cab, pag = pedir("/partido/999999999")
assert st == 200 and og(pag, "title") == "Pronósticos de fútbol: 1 X 2 y goles" and "<title>Pronósticos</title>" in pag
assert cab["X-Robots-Tag"] == "noindex"   # la portada con otra dirección: fuera de Google
st, _, cuerpo = pedir(f"/partido/{p['id']}", "HEAD")
assert st == 200 and cuerpo == ""
assert pedir(f"/partido/{p['id']}", "POST")[0] == 405
assert pedir("/partido/12abc")[0] == 404
st, cab, _ = pedir("/og.png")
assert st == 200 and cab["Content-Type"] == "image/png"
print("un partido que no existe: la tarjeta de siempre, fuera de Google; HEAD, POST y rutas raras, bien; og.png se sirve")
print("compartir: OK")
