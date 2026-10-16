"""
Mide cómo predecir la Champions: la fuerza de cada equipo en SU liga nacional,
el nivel de cada liga y su historial en la propia Champions, y ajusta las
constantes de app.py (FACTOR_LIGA, FACTOR_OTRA_LIGA, EXPONENTE_FUERZA_CHAMPIONS,
ESCALA_CHAMPIONS y K_HISTORIAL_CHAMPIONS).

El modelo de liga mide a un equipo con sus partidos en la misma competición.
En la Champions eso solo no sirve: 4 partidos en casa y 4 fuera por temporada,
contra rivales de niveles muy distintos. Aquí cada equipo se mide en su liga
nacional (sus fuerzas de liga, las mismas que usa la app: ajustar_fuerzas con
su temporada anterior y lo jugado de la actual), se ajusta
por el nivel de la liga (dominar la Eredivisie no es dominar la Premier; ese
nivel solo se ve donde se cruzan ligas, en la propia Champions) y se corrige
con su historial en la Champions: lo que marcó y encajó en sus partidos de esta
temporada y la anterior frente a lo esperado de un equipo de su nivel de liga
contra esos rivales (historial_champions en app.py).

Datos: openfootball, sin token. La Champions 2022/23 a 2025/26 (628 partidos)
del repositorio champions-league, en formato de texto, y las ligas nacionales
2021/22 a 2025/26 de football.json, con los nombres casados entre temporadas
(afinar_liga.cargar). Los equipos de ligas que no están en el plan (Bélgica,
Austria, Escocia...) cuentan como un equipo medio de "otra liga". Usa
ajustar_fuerzas, fuerza_equipo, historial_champions, multiplicadores_historial,
calcular_xg_champions, calcular_poisson y las constantes de app.py, no una copia.

Compara, con validación cruzada de 5 bloques y dejando fuera una temporada
entera cada vez (cada partido se predice con un ajuste que no lo ha visto):
  - base: equipo medio (solo la media de goles de la Champions)
  - solo nivel de liga: todos los equipos de una liga iguales
  - liga nacional atenuada + nivel: la fuerza nacional elevada a un exponente
    < 1, porque los grandes arrasan en su liga y tomada tal cual exagera.
  - + historial en la Champions: el de la app.

Lo esperado del historial usa los niveles y la escala que tiene app.py: si el
ajuste los cambia mucho, se ponen en app.py y se corre otra vez (con los de
ahora, una segunda vuelta mueve los niveles 0.02 como mucho).

Uso:
    python afinar_champions.py

Descarga ~30 ficheros la primera vez y los guarda en openfootball_cache/.
"""
import math
import os
import random
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date

import numpy as np
import requests
from scipy.optimize import minimize

# app.py exige estas variables al importarse; aquí no se pide nada a football-data.
os.environ.setdefault("FOOTBALL_DATA_TOKEN", "sin_uso_en_este_script")
os.environ.setdefault("UPDATE_SECRET", "afinar_champions_dummy_secret")

import app  # noqa: E402
import afinar_liga  # noqa: E402

URL_CL = "https://raw.githubusercontent.com/openfootball/champions-league/master/{t}/cl.txt"
CACHE = "openfootball_cache"
TEMPORADAS_CL = ["2022-23", "2023-24", "2024-25", "2025-26"]
TEMPORADAS_LIGA = [2021, 2022, 2023, 2024, 2025]
FICHERO_LIGA = {"PL": "en.1", "PD": "es.1", "SA": "it.1", "BL1": "de.1", "FL1": "fr.1", "DED": "nl.1", "PPL": "pt.1"}
# país del sufijo "(ENG)" de openfootball -> liga del plan. Mónaco juega la Ligue 1.
LIGA_DE_PAIS = {"ENG": "PL", "ESP": "PD", "ITA": "SA", "GER": "BL1", "FRA": "FL1", "MCO": "FL1", "NED": "DED", "POR": "PPL"}
OTRA = "otra"
NIVELES = list(FICHERO_LIGA) + [OTRA]
BLOQUES = 5
SIGMA_NIVEL = 0.30      # prior del log-factor de cada liga: a 1 sigma, ±35% de goles


# ------------------------------------------------------------------
# Datos
# ------------------------------------------------------------------
def _descargar(url, ruta):
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.exists(ruta):
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        with open(ruta, "w", encoding="utf-8") as f:
            f.write(resp.text)
    with open(ruta, encoding="utf-8") as f:
        return f.read()


MESES = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
_FECHA = re.compile(r"^\s{2}(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\w{3}) (\d{1,2})(?: (\d{4}))?\s*$")
_PARTIDO = re.compile(r"^\s+(?:\d{1,2}:\d{2}\s+)?(.+?\(\w{3}\))\s+v\s+(.+?\(\w{3}\))\s+(.+?)\s*$")


def noventa(texto):
    """Marcador a los 90 minutos, que es lo que predice el modelo:
    '1-0 (0-0)' -> (1, 0); '4-2 pen. 1-0 a.e.t. (1-0, 1-0)' -> (1, 0);
    '3-2 a.e.t. (3-0, 1-0)' -> (3, 0)."""
    m = (re.search(r"a\.e\.t\.\s*\((\d+)-(\d+)", texto) if "a.e.t." in texto
         else re.match(r"(\d+)-(\d+)", texto))
    return (int(m.group(1)), int(m.group(2))) if m else None


def cargar_cl(t):
    """Los partidos de una Champions (formato Football.TXT): [{fecha, local, visita, gl, gv}]."""
    texto = _descargar(URL_CL.format(t=t), os.path.join(CACHE, f"{t}_cl.txt"))
    anio_ini, d, out = int(t[:4]), None, []
    for linea in texto.splitlines():
        f = _FECHA.match(linea)
        if f:
            mes = MESES[f.group(1)]
            anio = int(f.group(3)) if f.group(3) else (anio_ini if mes >= 7 else anio_ini + 1)
            d = date(anio, mes, int(f.group(2)))
            continue
        p = _PARTIDO.match(linea)
        if p and d:
            r = noventa(p.group(3))
            if r:
                out.append({"fecha": d, "local": p.group(1).strip(), "visita": p.group(2).strip(),
                            "gl": r[0], "gv": r[1]})
    return out


# La Champions 2022/23 de openfootball usa nombres cortos ("Real Madrid", "Inter");
# las siguientes y las ligas, los largos ("Real Madrid CF"). Se casan por palabras.
_RUIDO = {"fc", "cf", "ac", "as", "ssc", "sc", "afc", "club", "de", "sl", "fk", "sk", "rc", "ogc",
          "losc", "us", "ss", "vfb", "vfl", "tsg", "bv", "rb", "gnk"}
ALIAS = {"Inter": "FC Internazionale Milano", "Sporting CP": "Sporting Clube de Portugal"}


def _palabras(n):
    n = unicodedata.normalize("NFD", n.lower()).encode("ascii", "ignore").decode()
    return {t for t in re.split(r"[^a-z0-9]+", n) if t and t not in _RUIDO}


def casar(nombre, candidatos):
    """El nombre equivalente entre `candidatos`, o None si no hay uno solo."""
    if nombre in candidatos:
        return nombre
    if ALIAS.get(nombre) in candidatos:
        return ALIAS[nombre]
    a = _palabras(nombre)
    cand = [c for c in candidatos if a and a <= _palabras(c)]
    return cand[0] if len(cand) == 1 else None


def temporada_de(d):
    """Año de inicio de la temporada europea de una fecha (agosto a mayo)."""
    return d.year if d.month >= 7 else d.year - 1


class Liga:
    """Lo que la app sabría de una liga en cada momento: sus partidos de la
    temporada anterior y lo jugado de la actual, con los que se ajustan las
    fuerzas (ajustar_fuerzas, como obtener_fuerzas_liga), y la media de la
    temporada en curso anclada en la anterior con K_LIGA, igual que
    obtener_promedio_liga."""

    def __init__(self):
        self.partidos = defaultdict(list)                # temporada -> [[día, local, visita, gl, gv]]
        self.totales = defaultdict(lambda: [0, 0, 0])   # temporada -> goles local, visita, partidos
        self.memo = {}                                   # día -> fuerzas de ese día
        self.ultimas = {}                                # temporada -> últimas fuerzas (arranque)

    def registrar(self, m):
        s = temporada_de(m["fecha"])
        self.partidos[s].append([(m["fecha"] - date(1970, 1, 1)).days, m["local"], m["visita"], m["gl"], m["gv"]])
        t = self.totales[s]
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

    def fuerzas(self, d):
        """Las fuerzas con lo jugado antes del día d (los partidos de liga de ese
        día se registran después de predecir los de Champions)."""
        if d not in self.memo:
            s = temporada_de(d)
            previa = self.partidos[s - 1] if len(self.partidos[s - 1]) >= 100 else []
            antes = self.ultimas.get(s)
            fz = app.ajustar_fuerzas(previa, self.partidos[s], self.media(d),
                                     inicio=antes["equipos"] if antes else None)
            self.memo[d] = self.ultimas[s] = fz
        return self.memo[d]


def preparar():
    ligas = {c: Liga() for c in FICHERO_LIGA}
    nombres_liga = defaultdict(set)
    eventos = []
    for c in FICHERO_LIGA:
        for t in TEMPORADAS_LIGA:
            for m in afinar_liga.cargar(c, t):
                d = date.fromisoformat(m["fecha"][:10])
                nombres_liga[c].update((m["local"], m["visita"]))
                eventos.append((d, 1, c, dict(m, fecha=d)))
    cl = {t: cargar_cl(t) for t in TEMPORADAS_CL}

    # un nombre por equipo en las cuatro temporadas: el de su liga si es de una
    # del plan; si no, el de las temporadas de nombres largos
    largos = {n for t in TEMPORADAS_CL[1:] for m in cl[t] for n in (m["local"], m["visita"])}
    canon, liga_de = {}, {}
    for t in TEMPORADAS_CL:
        for m in cl[t]:
            for completo in (m["local"], m["visita"]):
                if completo in canon:
                    continue
                nombre, pais = completo.rsplit(" (", 1)
                pais = pais.rstrip(")")
                liga = LIGA_DE_PAIS.get(pais)
                en_liga = casar(nombre, nombres_liga[liga]) if liga else None
                if en_liga:
                    canon[completo], liga_de[en_liga] = en_liga, liga
                else:
                    if liga:
                        print(f"AVISO: {completo} no casa con su liga: cuenta como otra liga.")
                    otros = {x.rsplit(" (", 1)[0] for x in largos if x.endswith(f"({pais})")}
                    canon[completo] = (casar(nombre, otros) or nombre) + f" ({pais})"
                    liga_de[canon[completo]] = None
    for t in TEMPORADAS_CL:
        for m in cl[t]:
            m["local"], m["visita"] = canon[m["local"]], canon[m["visita"]]
            eventos.append((m["fecha"], 0, "CL", m))
    # mismo día: primero se predice la Champions y luego se registra la liga
    eventos.sort(key=lambda e: (e[0], e[1]))

    hoy = app.ahora().isoformat()
    liga_equipo = {n: {"liga": l, "actualizado": hoy} for n, l in liga_de.items()}
    totales = defaultdict(lambda: [0, 0, 0])
    historial = defaultdict(lambda: defaultdict(list))   # temporada -> equipo -> [[rival, casa, gf, gc]]
    filas, dia, pendientes = [], None, []

    def registrar_dia():
        # los resultados de un día entran en el historial cuando ya se predijo el día entero
        for m in pendientes:
            s = temporada_de(m["fecha"])
            historial[s][m["local"]].append([m["visita"], 1, m["gl"], m["gv"]])
            historial[s][m["visita"]].append([m["local"], 0, m["gv"], m["gl"]])
            t = totales[s]
            t[0] += m["gl"]; t[1] += m["gv"]; t[2] += 1
        pendientes.clear()

    for d, tipo, c, m in eventos:
        if d != dia:
            registrar_dia(); dia = d
        if tipo == 1:
            ligas[c].registrar(m)
            continue
        s = temporada_de(d)
        # la media de la Champions como la ve la app: la temporada en curso anclada en la anterior
        act, prev = totales[s], totales[s - 1]
        hay_previa = prev[2] >= 100
        ancla = (prev[0] / prev[2], prev[1] / prev[2]) if hay_previa else (app.PRIOR_AVG_LOCAL, app.PRIOR_AVG_VISITA)
        k = app.K_LIGA
        mu = ((act[0] + k * ancla[0]) / (act[2] + k), (act[1] + k * ancla[1]) / (act[2] + k))
        # la caché que tendría la app ese día: el historial lo calcula app.historial_champions
        cache = {"liga_equipo": liga_equipo, "fixtures": {},
                 "ligas": {"CL": {"avg_local": mu[0], "avg_visita": mu[1], "historial": historial[s]}},
                 "priors": {"CL": {"avg_local": ancla[0], "avg_visita": ancla[1], "historial": historial[s - 1]}}
                 if hay_previa else {}}
        fila = {"fecha": d, "temporada": s, "gl": m["gl"], "gv": m["gv"], "mu_l": mu[0], "mu_v": mu[1]}
        for lado, campo in (("l", "local"), ("v", "visita")):
            equipo = m[campo]
            liga = liga_de[equipo]
            if liga:
                f = app.fuerza_equipo(ligas[liga].fuerzas(d), equipo)
                a, df = f["ataque"], f["defensa"]
            else:
                a, df = 1.0, 1.0
            factor = app.FACTOR_LIGA.get(liga, app.FACTOR_OTRA_LIGA)
            fila["liga_" + lado], fila["at_" + lado], fila["def_" + lado] = liga or OTRA, a, df
            fila["h_" + lado] = app.historial_champions(equipo, factor, cache)
        filas.append(fila)
        pendientes.append(m)
    return filas


# ------------------------------------------------------------------
# Modelos
# ------------------------------------------------------------------
class Datos:
    """Las columnas de las filas, en arrays, para que el coste sea una operación."""

    def __init__(self, filas):
        col = lambda k: np.array([f[k] for f in filas], dtype=float)   # noqa: E731
        self.filas = filas
        self.gl, self.gv, self.mu_l, self.mu_v = col("gl"), col("gv"), col("mu_l"), col("mu_v")
        self.at_l, self.def_l, self.at_v, self.def_v = col("at_l"), col("def_l"), col("at_v"), col("def_v")
        self.il = np.array([NIVELES.index(f["liga_l"]) for f in filas])
        self.iv = np.array([NIVELES.index(f["liga_v"]) for f in filas])
        h = lambda lado, k: np.array([f["h_" + lado][k] for f in filas], dtype=float)   # noqa: E731
        self.h = {(lado, k): h(lado, k) for lado in "lv" for k in ("gf", "gc", "esperado_f", "esperado_c")}
        self.temporada = np.array([f["temporada"] for f in filas])

    def parte(self, mascara):
        return Datos([f for f, m in zip(self.filas, mascara) if m])


N = len(NIVELES)
# p = [log escala local, log escala visita, exponente, nivel por liga..., log K]


def lambdas(p, d, modo):
    if modo == "base":
        return d.mu_l * math.exp(p[0]), d.mu_v * math.exp(p[1])
    s = np.asarray(p[3:3 + N])
    b = p[2] if modo in ("atenuado", "historial") else 0.0
    dif = s[d.il] - s[d.iv]
    ll = d.mu_l * math.exp(p[0]) * d.at_l ** b * d.def_v ** b * np.exp(dif)
    lv = d.mu_v * math.exp(p[1]) * d.at_v ** b * d.def_l ** b * np.exp(-dif)
    if modo == "historial":
        k = math.exp(p[3 + N])
        r = lambda lado, g, e: (d.h[(lado, g)] + k) / (d.h[(lado, e)] + k)   # noqa: E731
        ll = ll * r("l", "gf", "esperado_f") * r("v", "gc", "esperado_c")
        lv = lv * r("v", "gf", "esperado_f") * r("l", "gc", "esperado_c")
    return ll, lv


def ajustar(d, modo):
    def coste(p):
        ll, lv = lambdas(p, d, modo)
        c = -np.sum(d.gl * np.log(ll) - ll + d.gv * np.log(lv) - lv)
        if modo != "base":
            c += np.sum(np.asarray(p[3:3 + N]) ** 2) / (2 * SIGMA_NIVEL ** 2)
        return c
    p0 = np.zeros(4 + N)
    p0[2], p0[3 + N] = 0.5, math.log(30.0)
    limites = [(None, None), (None, None), (0.0, 1.5)] + [(None, None)] * N + [(math.log(0.5), math.log(500))]
    fijos = {"base": range(2, 4 + N), "nivel": (2, 3 + N), "atenuado": (3 + N,), "historial": ()}[modo]
    for i in fijos:
        limites[i] = (p0[i], p0[i])
    return minimize(coste, p0, method="L-BFGS-B", bounds=limites).x


def brier(gl, gv, ll, lv):
    pr = app.calcular_poisson(round(float(ll), 2), round(float(lv), 2))
    p = [pr["prob_local"] / 100, pr["prob_empate"] / 100, pr["prob_visita"] / 100]
    y = 0 if gl > gv else 1 if gl == gv else 2
    return sum((p[i] - (1 if i == y else 0)) ** 2 for i in range(3))


MODOS = ["base", "nivel", "atenuado", "historial"]
NOMBRES = {"base": "equipo medio", "nivel": "solo nivel de liga",
           "atenuado": "liga nacional atenuada + nivel", "historial": "+ historial en la Champions"}


def pareado(a, b):
    dif = a - b
    md = dif.mean()
    se = dif.std(ddof=1) / math.sqrt(len(dif))
    return f"{md:+.4f} ± {se:.4f} ({md / se:+.1f} se)"


def validar(d, bloques, titulo):
    por_partido = {m: np.zeros(len(d.gl)) for m in MODOS}
    params = defaultdict(list)
    for k in sorted(set(bloques.tolist())):
        entreno, prueba = d.parte(bloques != k), bloques == k
        dp = d.parte(prueba)
        for modo in MODOS:
            p = ajustar(entreno, modo)
            params[modo].append(p)
            ll, lv = lambdas(p, dp, modo)
            por_partido[modo][prueba] = [brier(*x) for x in zip(dp.gl, dp.gv, ll, lv)]
    base = por_partido["base"]
    print(f"\n== {titulo} ==")
    print(f"{'modelo':32} {'Brier':>7} {'skill':>7}   diferencia con la base (pareada)")
    for modo in MODOS:
        xs = por_partido[modo]
        extra = pareado(xs, base) if modo != "base" else ""
        print(f"{NOMBRES[modo]:32} {xs.mean():7.4f} {100 * (1 - xs.mean() / base.mean()):+6.1f}%   {extra}")
    print(f"historial frente a liga nacional atenuada: {pareado(por_partido['historial'], por_partido['atenuado'])}")
    print("exponente en cada ajuste:", " ".join(f"{p[2]:.2f}" for p in params["historial"]),
          "| K:", " ".join(f"{math.exp(p[3 + N]):.0f}" for p in params["historial"]))
    for t in sorted(set(d.temporada.tolist())):
        m = d.temporada == t
        print(f"  {t}/{(t + 1) % 100:02d} ({m.sum()} partidos): " + "  ".join(
            f"{x} {100 * (1 - por_partido[x][m].mean() / base[m].mean()):+.1f}%" for x in ("atenuado", "historial")))


def main():
    filas = preparar()
    d = Datos(filas)
    otras = sum((f["liga_l"] == OTRA) + (f["liga_v"] == OTRA) for f in filas)
    print(f"Champions {TEMPORADAS_CL[0]} a {TEMPORADAS_CL[-1]}: {len(filas)} partidos con resultado. "
          f"Equipos de otra liga en {otras} plazas.")

    orden = list(range(len(filas)))
    random.Random(7).shuffle(orden)
    bloques = np.zeros(len(filas), dtype=int)
    for k, i in enumerate(orden):
        bloques[i] = k % BLOQUES
    validar(d, bloques, f"validación cruzada de {BLOQUES} bloques")
    validar(d, d.temporada, "una temporada fuera cada vez")

    # constantes finales: ajuste con todos los partidos, niveles centrados en el equipo medio de la Champions
    p = ajustar(d, "historial")
    s = dict(zip(NIVELES, p[3:3 + N]))
    plazas = [f["liga_l"] for f in filas] + [f["liga_v"] for f in filas]
    centro = sum(s[x] for x in plazas) / len(plazas)
    print(f"\nEXPONENTE_FUERZA_CHAMPIONS = {p[2]:.2f}")
    print(f"K_HISTORIAL_CHAMPIONS = {math.exp(p[3 + N]):.0f}")
    print(f"ESCALA_CHAMPIONS = ({math.exp(p[0]):.2f}, {math.exp(p[1]):.2f})")
    print("FACTOR_LIGA (equipo medio de la Champions = 1.00):")
    for c in NIVELES:
        print(f"  {c:5} {math.exp(s[c] - centro):.2f}   ({plazas.count(c)} plazas)")

    # la fórmula de la app, con sus constantes de ahora, sobre los mismos partidos
    b = app.EXPONENTE_FUERZA_CHAMPIONS
    total = 0.0
    for f in filas:
        lado = {}
        for x in "lv":
            at, de = app.multiplicadores_historial(f["h_" + x])
            lado[x] = {"ataque": f["at_" + x] ** b, "defensa": f["def_" + x] ** b, "ataque_cl": at, "defensa_cl": de,
                       "factor": app.FACTOR_LIGA.get(f["liga_" + x], app.FACTOR_OTRA_LIGA)}
        xl, xv = app.calcular_xg_champions(lado["l"], lado["v"], {"avg_local": f["mu_l"], "avg_visita": f["mu_v"]})
        total += brier(f["gl"], f["gv"], xl, xv)
    ll, lv = lambdas(p, d, "historial")
    ajuste = np.mean([brier(*x) for x in zip(d.gl, d.gv, ll, lv)])
    print(f"\nLa fórmula de app.py con sus constantes: Brier {total / len(filas):.4f} "
          f"(el ajuste con todos los partidos: {ajuste:.4f}, dentro de la muestra).")


if __name__ == "__main__":
    sys.exit(main())
