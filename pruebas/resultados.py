"""El historial de aciertos (worker/resultados.js), contra el Worker local ya lleno: con unos
partidos de /api/estado "terminados" (en su D1, uno de ellos publicado después de empezar,
que no cuenta), /api/resultados trae la última semana con resultados y ?semana= cualquiera
de las que tienen, cada una con sus partidos (los números que publicó la web y el marcador),
lo sumado (en cuántos acertó el favorito y cuántos esperaban sus probabilidades, en total,
por tramo de confianza con el entero de la web y por liga) y sus vecinas, con ETag y 304;
una semana sin resultados o mal escrita da 404; /resultados y /resultados/2026-10-26 llevan
su tarjeta, su dirección canónica y su texto ya escrito; el sitemap trae todas las semanas;
el índice resultados_por_fecha se crea solo si falta; y la CPU.
Uso: python pruebas/resultados.py PUERTO_WORKER PUERTO_INSPECTOR DIR_D1 MAX_MS"""
import glob, html, json, re, sqlite3, sys, urllib.error, urllib.request
from datetime import date, datetime, timedelta, timezone

from medir_cpu import Medidor

W, D1, MAX_MS = f"http://127.0.0.1:{sys.argv[1]}", sys.argv[3], float(sys.argv[4])
medidor = Medidor(sys.argv[2])
LIMA = timezone(timedelta(hours=-5))


def pedir(ruta, etag=None):
    req = urllib.request.Request(W + ruta, headers={"If-None-Match": etag} if etag else {})
    try:
        r = urllib.request.urlopen(req)
        return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


og = lambda pagina, prop: html.unescape(re.search(rf'<meta property="og:{prop}" content="([^"]*)">', pagina).group(1))


def lunes(utc):
    d = datetime.strptime(utc, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone(LIMA).date()
    return (d - timedelta(days=d.weekday())).isoformat()


def enteros(bruto):   # los de la web: resto mayor, suman 100
    en = [int(v // 1) for v in bruto]
    for i in sorted(range(3), key=lambda i: -(bruto[i] - en[i]))[:100 - sum(en)]:
        en[i] += 1
    return en


def sumar(lista):
    """Lo que suma resultados.js: [partidos, aciertos, esperados] en total, por tramo y por liga."""
    cero = lambda: [0, 0, 0.0]
    r = {"total": cero(), "tramos": {"claros": cero(), "medios": cero(), "renidos": cero()}, "ligas": {}}
    for p in lista:
        probs = [p["prob_local"], p["prob_empate"], p["prob_visita"]]
        i = max(range(3), key=lambda k: (probs[k], -k))   # el mayor; si empatan, el primero
        paso = 0 if p["gl"] > p["gv"] else 1 if p["gl"] == p["gv"] else 2
        n = enteros(probs)[i]
        tramo = "claros" if n >= 60 else "medios" if n >= 45 else "renidos"
        for c in (r["total"], r["tramos"][tramo], r["ligas"].setdefault(p["liga_codigo"], cero())):
            c[0] += 1
            c[1] += i == paso
            c[2] = round(c[2] + probs[i] / 100, 4)
    return r


base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
assert len(base) == 1, base
db = sqlite3.connect(base[0])
estado = json.loads(pedir("/api/estado")[2])
partidos = [p for d in estado["dias"] for p in d["partidos"] if not p.get("pendiente")]
# unos cuantos de varias ligas, con marcadores variados; el último, publicado después de empezar
elegidos = sorted(partidos, key=lambda p: (p["utcDate"], p["id"]))[::7][:14]
assert len(elegidos) >= 8, len(elegidos)
marcadores = [(2, 0), (1, 1), (0, 1), (3, 2), (0, 0), (1, 2), (2, 1)]
for k, p in enumerate(elegidos):
    p["gl"], p["gv"] = marcadores[k % len(marcadores)]
    p["contado"] = 0 if k == len(elegidos) - 1 else 1
originales = db.execute("SELECT id, liga, utc, gl, gv, contado, liquidado FROM resultados").fetchall()
db.execute("DELETE FROM resultados")
db.executemany("INSERT INTO resultados (id, liga, utc, gl, gv, contado, liquidado) VALUES (?, ?, ?, ?, ?, ?, ?)",
               [(p["id"], p["liga_codigo"], p["utcDate"], p["gl"], p["gv"], p["contado"], k + 1) for k, p in enumerate(elegidos)])
# en producción, la primera petición no encuentra el índice y lo crea
db.execute("DROP INDEX IF EXISTS resultados_por_fecha")
db.commit()
contados = [p for p in elegidos if p["contado"]]
semanas = sorted({lunes(p["utcDate"]) for p in contados})
print(f"resultados: {len(contados)} partidos terminados (y uno publicado tarde) en {len(semanas)} semana(s)")

st, cab, cuerpo = pedir("/api/resultados")
assert st == 200 and cab["Content-Type"].startswith("application/json") and cab["ETag"], (st, cuerpo[:300])
assert "resultados_por_fecha" in {f[0] for f in db.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
d = json.loads(cuerpo)
assert (d["estado"], d["semana"], d["primera"], d["ultima"]) == ("listo", semanas[-1], semanas[0], semanas[-1]), d
for i, s in enumerate(semanas):
    st, _, cuerpo = pedir(f"/api/resultados?semana={s}")
    d = json.loads(cuerpo)
    suyos = [p for p in contados if lunes(p["utcDate"]) == s]
    assert st == 200 and d["semana"] == s and d["hasta"] == (date.fromisoformat(s) + timedelta(days=6)).isoformat(), d
    vecina = lambda k: (date.fromisoformat(s) + timedelta(days=7 * k)).isoformat()
    assert d["anterior"] == (vecina(-1) if i else None) and d["siguiente"] == (vecina(1) if i < len(semanas) - 1 else None), d
    assert [x["id"] for x in d["partidos"]] == [p["id"] for p in suyos], ([x["id"] for x in d["partidos"]], [p["id"] for p in suyos])
    for x, p in zip(d["partidos"], suyos):
        assert (x["gl"], x["gv"], x["utcDate"], x["fecha"], x["hora"]) == (p["gl"], p["gv"], p["utcDate"], p["fecha"], p["hora"]), x
        assert (x["prob_local"], x["prob_empate"], x["prob_visita"]) == (p["prob_local"], p["prob_empate"], p["prob_visita"]), x
        assert (x["local"], x["visita"], x["local_id"], x["visita_id"]) == (p["local"], p["visita"], p["local_id"], p["visita_id"]), x
    esperado = sumar(suyos)
    assert d["resumen"]["total"] == esperado["total"] and d["resumen"]["ligas"] == esperado["ligas"], (d["resumen"], esperado)
    assert d["resumen"]["tramos"] == esperado["tramos"], (d["resumen"]["tramos"], esperado["tramos"])
    t = esperado["total"]
    print(f"semana {s}: {t[0]} partidos, acertó el favorito en {t[1]} (esperaban {t[2]:.2f}), {len(esperado['ligas'])} ligas")
# un día cualquiera de la semana lleva a su lunes
otro = (date.fromisoformat(semanas[0]) + timedelta(days=3)).isoformat()
assert json.loads(pedir(f"/api/resultados?semana={otro}")[2])["semana"] == semanas[0]

st, cab, cuerpo = pedir("/api/resultados")
assert pedir("/api/resultados", cab["ETag"])[0] == 304 and pedir("/api/resultados", "W/" + cab["ETag"])[0] == 304
for mal in ("1999-01-04", "2099-01-05", "abc"):
    st, _, cuerpo = pedir(f"/api/resultados?semana={mal}")
    assert st == 404 and json.loads(cuerpo)["estado"] == "no_encontrado", (mal, st, cuerpo)
ms = [medidor.pedir(W + "/api/resultados")[1] for _ in range(5)]
assert max(ms) <= MAX_MS, ms
print(f"ruta: ETag y 304 (también W/); una semana sin resultados o mal escrita, 404; CPU {min(ms)}-{max(ms)} ms")

# /resultados: la web con la tarjeta de la última semana y su texto; /resultados/<lunes>, la suya
e = html.escape
d = json.loads(pedir("/api/resultados")[2])
st, cab, pag = pedir("/resultados")
assert st == 200 and cab["Content-Type"].startswith("text/html") and cab.get("X-Robots-Tag") is None, st
assert "script-src 'self'" in cab["Content-Security-Policy"] and '<script src="/app.js"></script>' in pag
assert og(pag, "title") == "Resultados: lo que dijo la web y lo que pasó" and f'<link rel="canonical" href="{W}/resultados">' in pag
t = d["resumen"]["total"]
desc = og(pag, "description")
assert desc.startswith("Semana del ") and f"acertó el favorito en {t[1]} de {t[0]} " in desc, desc
texto = pag[pag.index('id="vista"'):pag.index("</main>")]
assert 'id="titulo-vista">Resultados de la semana del ' in pag
for x in d["partidos"]:
    assert f'<li><a href="/partido/{x["id"]}">' in texto and f"{e(x.get('local_corto') or x['local'])} {x['gl']}-{x['gv']}" in texto, x["id"]
assert "<h2>Por liga</h2>" in texto and texto.count('<li><a href="/partido/') == len(d["partidos"])
if len(semanas) > 1:
    assert f'<a href="/resultados/{semanas[-2]}">' in texto
    st, _, pag = pedir(f"/resultados/{semanas[0]}")
    assert st == 200 and f'<link rel="canonical" href="{W}/resultados/{semanas[0]}">' in pag
    assert og(pag, "title").startswith("Resultados de la semana del "), og(pag, "title")
    assert f'<a href="/resultados/{semanas[1]}">' in pag
st, cab, pag = pedir("/resultados/1999-01-04")
assert st == 200 and cab["X-Robots-Tag"] == "noindex" and "<title>Pronósticos de fútbol: 1 X 2 y goles</title>" in pag
assert pedir("/resultados/abc")[0] == 404
ms = [medidor.pedir(W + "/resultados")[1] for _ in range(3)]
assert max(ms) <= MAX_MS, ms
print(f"/resultados: la tarjeta ({desc[:70]}…), su dirección canónica y su texto con sus {len(d['partidos'])} partidos;"
      f" una semana sin resultados, fuera de Google; CPU {min(ms)}-{max(ms)} ms")

# el sitemap: /resultados y cada semana
mapa = pedir("/sitemap.xml")[2]
assert f"<loc>{W}/resultados</loc>" in mapa
assert set(re.findall(r"<loc>[^<]*/resultados/(\d{4}-\d{2}-\d{2})</loc>", mapa)) == {
    (date.fromisoformat(semanas[0]) + timedelta(days=7 * k)).isoformat()
    for k in range((date.fromisoformat(semanas[-1]) - date.fromisoformat(semanas[0])).days // 7 + 1)}
print("sitemap: /resultados y cada semana con resultados")

# lo que había, como estaba
db.execute("DELETE FROM resultados")
db.executemany("INSERT INTO resultados (id, liga, utc, gl, gv, contado, liquidado) VALUES (?, ?, ?, ?, ?, ?, ?)", originales)
db.commit()
print("resultados: OK")
