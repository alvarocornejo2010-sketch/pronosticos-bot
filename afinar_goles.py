"""
Mide cuánto hay que acercar los goles esperados a la media de liga para los
mercados de goles (ENCOGER_GOLES en app.py): más de 2.5 y ambos marcan.

  alfa = 0 -> todos los partidos con los goles de dos equipos medios (la base)
  alfa = 1 -> los goles esperados del modelo tal cual

Misma regla que afinar.py: se elige alfa mirando una temporada y se juzga con la
otra, con un test pareado de Brier contra la base. Se hace en los dos sentidos.

Los datos NO son de football-data.org (su plan free no da temporadas viejas):
son los resultados de openfootball/football.json en GitHub, gratis y sin token,
de LaLiga, Premier, Bundesliga, Serie A y Ligue 1. Los equipos van por nombre en
vez de por id, que para el modelo da igual. Usa el modelo de app.py
(calcular_xg_partido y mercados_de_goles) y el historial de validacion.py, no una
copia.

Uso:
    python afinar_goles.py

Descarga 15 ficheros la primera vez y los guarda en openfootball_cache/.
"""
import json
import math
import os
import sys

import requests

# app.py exige estas variables al importarse; aquí no se pide nada a football-data.
os.environ.setdefault("FOOTBALL_DATA_TOKEN", "sin_uso_en_este_script")
os.environ.setdefault("UPDATE_SECRET", "afinar_goles_dummy_secret")

import app          # noqa: E402
import validacion   # noqa: E402

URL = "https://raw.githubusercontent.com/openfootball/football.json/master/{t}/{l}.json"
LIGAS = {"PD": "es.1", "PL": "en.1", "BL1": "de.1", "SA": "it.1", "FL1": "fr.1"}
TEMPORADAS = (2023, 2024)          # se evalúan; 2022 solo sirve de ancla e historial
ALFAS = [round(a * 0.1, 1) for a in range(11)]
CACHE = "openfootball_cache"
MERCADOS = validacion.MERCADOS


def cargar(codigo, season):
    os.makedirs(CACHE, exist_ok=True)
    t = f"{season}-{str(season + 1)[2:]}"
    ruta = os.path.join(CACHE, f"{t}_{LIGAS[codigo]}.json")
    if not os.path.exists(ruta):
        resp = requests.get(URL.format(t=t, l=LIGAS[codigo]), timeout=30)
        resp.raise_for_status()
        with open(ruta, "w") as f:
            f.write(resp.text)
    with open(ruta) as f:
        partidos = json.load(f)["matches"]
    out = [{"fecha": m["date"] + "T" + (m.get("time") or "00:00"),
            "local": m["team1"], "visita": m["team2"],
            "gl": m["score"]["ft"][0], "gv": m["score"]["ft"][1]}
           for m in partidos if (m.get("score") or {}).get("ft")]
    return sorted(out, key=lambda x: x["fecha"])


def partidos_de(codigo, season):
    """(xg_local, xg_visita, media de liga, partido) de cada partido, predicho solo
    con lo anterior: el mismo recorrido que validacion.validar_liga."""
    previa, ultima = cargar(codigo, season - 1), cargar(codigo, season)
    ancla = {"avg_local": sum(m["gl"] for m in previa) / len(previa),
             "avg_visita": sum(m["gv"] for m in previa) / len(previa)}
    hist = validacion._Historial(app.MAX_PARTIDOS_EQUIPO)
    for m in previa:
        hist.registrar(m)
    out = []
    for m in ultima:
        media = hist.media_liga(ancla, app.K_LIGA)
        xl, xv = app.calcular_xg_partido(hist.stats(m["local"]), hist.stats(m["visita"]), media)
        out.append((xl, xv, media, m))
        hist.registrar(m)
    return out


def diferencias(filas, alfa):
    """Brier del modelo menos Brier de la base, partido a partido. Negativo = gana el modelo."""
    app.ENCOGER_GOLES = alfa
    d = {k: [] for k in MERCADOS}
    for xl, xv, media, m in filas:
        pm = app.mercados_de_goles(xl, xv, media)
        pb = app.mercados_de_goles(media["avg_local"], media["avg_visita"], media)
        for k, (clave, ocurre) in MERCADOS.items():
            y = 1 if ocurre(m) else 0
            d[k].append((pm[clave] / 100 - y) ** 2 - (pb[clave] / 100 - y) ** 2)
    return d


def media_y_error(xs):
    n = len(xs)
    m = sum(xs) / n
    return m, math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1) / n)


def main():
    original = app.ENCOGER_GOLES
    datos = {s: [x for c in LIGAS for x in partidos_de(c, s)] for s in TEMPORADAS}
    tabla = {s: {a: {k: media_y_error(v) for k, v in diferencias(datos[s], a).items()}
                 for a in ALFAS} for s in TEMPORADAS}

    print("Diferencia de Brier contra la base (negativo = mejor que la media de liga)\n")
    print("alfa  " + "  ".join(f"{s} {k:>6}" + " " * 9 for s in TEMPORADAS for k in MERCADOS))
    for a in ALFAS:
        celdas = [f"{tabla[s][a][k][0]:+.5f}±{tabla[s][a][k][1]:.5f}" for s in TEMPORADAS for k in MERCADOS]
        marca = "  <- app.py" if a == original else ""
        print(f"{a:<4}  " + "  ".join(celdas) + marca)

    for train, test in ((TEMPORADAS[0], TEMPORADAS[1]), (TEMPORADAS[1], TEMPORADAS[0])):
        mejor = min(ALFAS, key=lambda a: sum(tabla[train][a][k][0] for k in MERCADOS))
        res = "  ".join(f"{k} {m:+.5f} ± {se:.5f} ({m / se:+.1f} se)"
                        for k, (m, se) in tabla[test][mejor].items())
        print(f"\nElegido con {train}: alfa {mejor}. Juzgado con {test}: {res}")

    app.ENCOGER_GOLES = original


if __name__ == "__main__":
    sys.exit(main())
