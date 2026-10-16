"""
Mide cómo predecir la Champions con la fuerza de cada equipo en SU liga
nacional, y estima el nivel de cada liga (FACTOR_LIGA en app.py).

El modelo de liga mide a un equipo con sus partidos en la misma competición.
En la Champions eso no sirve: 4 partidos en casa y 4 fuera, contra rivales de
niveles muy distintos. Aquí cada equipo se mide en su liga nacional (sus
últimos partidos, relativos a la media de esa liga) y se ajusta por el nivel
de la liga: dominar la Eredivisie no es dominar la Premier. Ese nivel solo se
ve donde se cruzan ligas, en la propia Champions, y de ahí se estima.

Datos: resultados de openfootball/football.json en GitHub (sin token):
Champions 2024/25 y las ligas nacionales 2022/23 a 2024/25. Los equipos de
ligas que no están en el plan (Bélgica, Austria, Escocia...) cuentan como un
equipo medio de "otra liga". Usa _encoger, calcular_poisson y las constantes
de app.py, no una copia.

Compara, con validación cruzada de 5 bloques (cada partido se predice con un
ajuste que no lo ha visto):
  - base: equipo medio (solo la media de goles de la Champions)
  - solo liga nacional: la fuerza de cada equipo en su liga, sin nivel de liga
  - solo nivel de liga: todos los equipos de una liga iguales
  - liga nacional + nivel de liga
  - liga nacional atenuada + nivel de liga: la fuerza nacional elevada a un
    exponente < 1 (se ajusta), porque los grandes arrasan en su liga y su
    fuerza nacional tomada tal cual exagera. Es el modelo que usa la app.

Uso:
    python afinar_champions.py

Descarga ~20 ficheros la primera vez y los guarda en openfootball_cache/.
"""
import json
import math
import os
import random
import sys
from collections import defaultdict, deque
from datetime import date, timedelta

import numpy as np
import requests
from scipy.optimize import minimize
from scipy.stats import poisson

# app.py exige estas variables al importarse; aquí no se pide nada a football-data.
os.environ.setdefault("FOOTBALL_DATA_TOKEN", "sin_uso_en_este_script")
os.environ.setdefault("UPDATE_SECRET", "afinar_champions_dummy_secret")

import app  # noqa: E402

URL = "https://raw.githubusercontent.com/openfootball/football.json/master/{t}/{l}.json"
CACHE = "openfootball_cache"
TEMPORADA_CL = "2024-25"
TEMPORADAS_LIGA = ["2022-23", "2023-24", "2024-25"]
FICHERO_LIGA = {"PL": "en.1", "PD": "es.1", "SA": "it.1", "BL1": "de.1", "FL1": "fr.1", "DED": "nl.1", "PPL": "pt.1"}
# país del sufijo "(ENG)" de openfootball -> liga del plan. Mónaco juega la Ligue 1.
LIGA_DE_PAIS = {"ENG": "PL", "ESP": "PD", "ITA": "SA", "GER": "BL1", "FRA": "FL1", "MCO": "FL1", "NED": "DED", "POR": "PPL"}
OTRA = "otra"
BLOQUES = 5
SIGMA_NIVEL = 0.30      # prior del log-factor de cada liga: a 1 sigma, ±35% de goles


def cargar(t, l):
    os.makedirs(CACHE, exist_ok=True)
    ruta = os.path.join(CACHE, f"{t}_{l}.json")
    if not os.path.exists(ruta):
        resp = requests.get(URL.format(t=t, l=l), timeout=30)
        resp.raise_for_status()
        with open(ruta, "w") as f:
            f.write(resp.text)
    with open(ruta) as f:
        return json.load(f)["matches"]


def marcador(m):
    sc = m.get("score")
    ft = sc if isinstance(sc, list) else (sc or {}).get("ft")
    return ft if ft and len(ft) == 2 else None


def temporada_de(d):
    """Año de inicio de la temporada europea de una fecha (agosto a mayo)."""
    return d.year if d.month >= 7 else d.year - 1


class Liga:
    """Lo que la app sabría de una liga en cada momento: los últimos partidos de
    cada equipo dentro de VENTANA_DIAS y la media de la temporada en curso,
    anclada en la anterior con K_LIGA, igual que obtener_promedio_liga."""

    def __init__(self):
        self.equipos = defaultdict(lambda: deque(maxlen=app.MAX_PARTIDOS_EQUIPO * 3))
        self.totales = defaultdict(lambda: [0, 0, 0])   # temporada -> goles local, visita, partidos

    def registrar(self, m):
        self.equipos[m["local"]].append((m["fecha"], True, m["gl"], m["gv"]))
        self.equipos[m["visita"]].append((m["fecha"], False, m["gv"], m["gl"]))
        t = self.totales[temporada_de(m["fecha"])]
        t[0] += m["gl"]; t[1] += m["gv"]; t[2] += 1

    def media(self, d):
        actual, previa = self.totales[temporada_de(d)], self.totales[temporada_de(d) - 1]
        if previa[2] >= 100:
            ancla = (previa[0] / previa[2], previa[1] / previa[2])
        else:
            ancla = (app.PRIOR_AVG_LOCAL, app.PRIOR_AVG_VISITA)
        k = app.K_LIGA
        return {"avg_local": (actual[0] + k * ancla[0]) / (actual[2] + k),
                "avg_visita": (actual[1] + k * ancla[1]) / (actual[2] + k)}

    def stats(self, equipo, d):
        desde = d - timedelta(days=app.VENTANA_DIAS)
        ult = [x for x in self.equipos[equipo] if x[0] >= desde][-app.MAX_PARTIDOS_EQUIPO:]
        s = {"gf_local": 0, "gc_local": 0, "n_local": 0, "gf_visita": 0, "gc_visita": 0, "n_visita": 0}
        for _, en_casa, gf, gc in ult:
            lado = "local" if en_casa else "visita"
            s["gf_" + lado] += gf; s["gc_" + lado] += gc; s["n_" + lado] += 1
        return s


def fuerza(liga, s, media, en_casa):
    """Ataque y defensa relativos a la media de su liga: lo mismo que
    fuerzas_champions en app.py."""
    avg_l, avg_v = media["avg_local"], media["avg_visita"]
    if en_casa:
        return (app._encoger(s["gf_local"], s["n_local"], avg_l) / avg_l,
                app._encoger(s["gc_local"], s["n_local"], avg_v) / avg_v)
    return (app._encoger(s["gf_visita"], s["n_visita"], avg_v) / avg_v,
            app._encoger(s["gc_visita"], s["n_visita"], avg_l) / avg_l)


def preparar():
    ligas = {c: Liga() for c in FICHERO_LIGA}
    eventos = []
    for c, l in FICHERO_LIGA.items():
        for t in TEMPORADAS_LIGA:
            for m in cargar(t, l):
                ft = marcador(m)
                if not ft or "atchday" not in str(m.get("round")):
                    continue        # sin resultado o playoff: no es liga
                eventos.append((date.fromisoformat(m["date"]), 1, c,
                                {"fecha": date.fromisoformat(m["date"]), "local": m["team1"], "visita": m["team2"],
                                 "gl": ft[0], "gv": ft[1]}))
    for m in cargar(TEMPORADA_CL, "uefa.cl"):
        ft = marcador(m)
        if not ft:
            continue            # la final viene sin marcador
        eventos.append((date.fromisoformat(m["date"]), 0, "CL", m))
    # mismo día: primero se predice la Champions y luego se registra la liga
    eventos.sort(key=lambda e: (e[0], e[1]))

    filas, sin_casar = [], set()
    for d, tipo, c, m in eventos:
        if tipo == 1:
            ligas[c].registrar(m)
            continue
        fila = {"fecha": d, "gl": marcador(m)[0], "gv": marcador(m)[1]}
        for lado, campo, en_casa in (("l", "team1", True), ("v", "team2", False)):
            nombre, pais = m[campo].rsplit(" (", 1)
            liga = LIGA_DE_PAIS.get(pais.rstrip(")"))
            if liga and nombre not in ligas[liga].equipos:
                sin_casar.add(m[campo]); liga = None
            if liga:
                a, df = fuerza(liga, ligas[liga].stats(nombre, d), ligas[liga].media(d), en_casa)
            else:
                a, df = 1.0, 1.0
            fila["liga_" + lado], fila["at_" + lado], fila["def_" + lado] = liga or OTRA, a, df
        filas.append(fila)
    if sin_casar:
        print("AVISO: equipos sin casar con su liga (cuentan como otra liga):", sorted(sin_casar))
    return filas


NIVELES = list(FICHERO_LIGA) + [OTRA]


def lambdas(p, f, modo):
    """p = [log g_local, log g_visita, exponente, nivel por liga...]. El exponente
    solo cuenta en el modo atenuado; en los demás vale 1."""
    s = dict(zip(NIVELES, p[3:])) if modo in ("completo", "nivel", "atenuado") else defaultdict(float)
    usa_fuerza = modo in ("completo", "nacional", "atenuado")
    b = p[2] if modo == "atenuado" else 1.0
    al, dl = (f["at_l"] ** b, f["def_l"] ** b) if usa_fuerza else (1.0, 1.0)
    av, dv = (f["at_v"] ** b, f["def_v"] ** b) if usa_fuerza else (1.0, 1.0)
    dif = s[f["liga_l"]] - s[f["liga_v"]]
    return (math.exp(p[0]) * al * dv * math.exp(dif),
            math.exp(p[1]) * av * dl * math.exp(-dif))


def ajustar(filas, modo):
    def coste(p):
        c = 0.0
        for f in filas:
            ll, lv = lambdas(p, f, modo)
            c -= poisson.logpmf(f["gl"], ll) + poisson.logpmf(f["gv"], lv)
        if modo in ("completo", "nivel", "atenuado"):
            c += sum(x * x for x in p[3:]) / (2 * SIGMA_NIVEL ** 2)
        return c
    p0 = np.zeros(3 + len(NIVELES))
    p0[0] = math.log(np.mean([f["gl"] for f in filas]))
    p0[1] = math.log(np.mean([f["gv"] for f in filas]))
    p0[2] = 1.0
    limites = [(None, None), (None, None), (0.0, 1.5)] + [(None, None)] * len(NIVELES)
    return minimize(coste, p0, method="L-BFGS-B", bounds=limites).x


def brier(f, ll, lv):
    pr = app.calcular_poisson(round(ll, 2), round(lv, 2))
    p = [pr["prob_local"] / 100, pr["prob_empate"] / 100, pr["prob_visita"] / 100]
    y = 0 if f["gl"] > f["gv"] else 1 if f["gl"] == f["gv"] else 2
    return sum((p[i] - (1 if i == y else 0)) ** 2 for i in range(3))


def main():
    filas = preparar()
    print(f"Champions {TEMPORADA_CL}: {len(filas)} partidos con resultado. "
          f"Equipos de otra liga en {sum((f['liga_l'] == OTRA) + (f['liga_v'] == OTRA) for f in filas)} plazas.\n")

    orden = list(range(len(filas)))
    random.Random(7).shuffle(orden)
    bloque = {i: k % BLOQUES for k, i in enumerate(orden)}
    modos = ["base", "nacional", "nivel", "completo", "atenuado"]
    nombres = {"base": "equipo medio", "nacional": "solo liga nacional",
               "nivel": "solo nivel de liga", "completo": "liga nacional + nivel",
               "atenuado": "liga nacional atenuada + nivel"}
    exponentes = []
    por_partido = {m: [0.0] * len(filas) for m in modos}
    for k in range(BLOQUES):
        entreno = [f for i, f in enumerate(filas) if bloque[i] != k]
        for modo in modos:
            p = ajustar(entreno, modo) if modo != "base" else None
            if modo == "atenuado":
                exponentes.append(p[2])
            if modo == "base":
                gl = np.mean([f["gl"] for f in entreno]); gv = np.mean([f["gv"] for f in entreno])
            for i, f in enumerate(filas):
                if bloque[i] != k:
                    continue
                ll, lv = (gl, gv) if modo == "base" else lambdas(p, f, modo)
                por_partido[modo][i] = brier(f, ll, lv)

    base = por_partido["base"]
    b0 = sum(base) / len(base)
    print(f"{'modelo':28} {'Brier':>7} {'skill':>7}   diferencia con la base (pareada)")
    for modo in modos:
        xs = por_partido[modo]
        d = [a - b for a, b in zip(xs, base)]
        md = sum(d) / len(d)
        se = math.sqrt(sum((x - md) ** 2 for x in d) / (len(d) - 1) / len(d)) if modo != "base" else 0
        extra = f"{md:+.4f} ± {se:.4f} ({md / se:+.1f} se)" if se else ""
        print(f"{nombres[modo]:28} {sum(xs) / len(xs):7.4f} {100 * (1 - sum(xs) / len(xs) / b0):+6.1f}%   {extra}")
    for a, b in (("atenuado", "nivel"), ("atenuado", "nacional"), ("atenuado", "completo")):
        d = [x - y for x, y in zip(por_partido[a], por_partido[b])]
        md = sum(d) / len(d); se = math.sqrt(sum((x - md) ** 2 for x in d) / (len(d) - 1) / len(d))
        print(f"{nombres[a]} frente a {nombres[b]}: {md:+.4f} ± {se:.4f} ({md / se:+.1f} se)")
    print("exponente ajustado en cada bloque:", " ".join(f"{e:.2f}" for e in exponentes))

    # factores finales: ajuste con todos los partidos, centrados en el equipo medio de la Champions
    p = ajustar(filas, "atenuado")
    print(f"\nEXPONENTE_FUERZA_CHAMPIONS = {p[2]:.2f}")
    s = dict(zip(NIVELES, p[3:]))
    plazas = [f["liga_l"] for f in filas] + [f["liga_v"] for f in filas]
    centro = sum(s[x] for x in plazas) / len(plazas)
    print("\nFACTOR_LIGA (equipo medio de la Champions = 1.00):")
    for c in NIVELES:
        n = plazas.count(c)
        print(f"  {c:5} {math.exp(s[c] - centro):.2f}   ({n} plazas)")
    obs_l = np.mean([f["gl"] for f in filas]); obs_v = np.mean([f["gv"] for f in filas])
    print(f"\nMedia de goles de la Champions: {obs_l:.2f} local, {obs_v:.2f} visitante. "
          f"Escala ajustada frente a la observada: {math.exp(p[0]) / obs_l:.2f} local, {math.exp(p[1]) / obs_v:.2f} visitante.")


if __name__ == "__main__":
    sys.exit(main())
