"""
Mide y afina el modelo de liga de app.py con resultados reales: las fuerzas
(ajustar_fuerzas, modelo 6: un filtro de Kalman con KALMAN_DERIVA, KALMAN_INICIO,
KALMAN_TEMPORADA y KALMAN_NUEVO, los tiros a puerta con PESO_TIROS y
EXPONENTE_FUERZAS, y los priors de los recién llegados), la corrección de empates
(RHO_EMPATES) y los mercados de goles: el acercamiento del total (ENCOGER_TOTAL) y
el 0 de cada equipo (MENOS_CEROS).

Datos, gratis y sin token:
  - resultados: openfootball/football.json en GitHub. Ocho ligas (LaLiga, Premier,
    Bundesliga, Serie A, Ligue 1, Eredivisie, Primeira Liga y Championship) desde
    2010/11 las que más (Países Bajos y Portugal, desde 2018/19), unos 38.000
    partidos; el Brasileirão solo tiene 2019, 2020, 2025 y 2026.
  - tiros a puerta y cuotas de bet365: football-data.co.uk (lo que lee la web en
    producción), por un espejo en GitHub con todas sus temporadas en un archivo
    (xgabora/Club-Football-Match-Data-2000-2025, data/Matches.csv, 45 MB). Se casan
    con openfootball por el cruce y el marcador (_casar): el 99 % de los partidos.
    El Brasileirão no los trae.
Cada temporada se recorre como en producción (validacion.py): la anterior hace de
ancla e historial y cada partido se predice solo con lo jugado en días anteriores.

Dos grupos de temporadas, para no elegir y juzgar con los mismos partidos:
  ajuste   2010/11 a 2020/21: aquí se eligen los parámetros.
  prueba   2021/22 en adelante: solo se mira el resultado.

Uso:
    python afinar_liga.py             # el modelo de app.py frente al modelo 5 (el ajuste
                                      # de goles pesados por antigüedad) y frente a
                                      # bet365, por liga y por temporada (~2 min)
    python afinar_liga.py afinar      # busca los parámetros en el grupo de ajuste y
                                      # los juzga en el de prueba
    python afinar_liga.py descensos   # de dónde parten los recién llegados: los
                                      # que bajan de la Premier a la Championship
                                      # y los que suben a cada liga
    python afinar_liga.py tabla       # la proyección de la tabla (la de app.js)
                                      # a mitad de temporadas pasadas, contra
                                      # cómo acabaron (~1 min)

La evaluación usa las funciones de app.py (ajustar_fuerzas, calcular_poisson,
mercados_de_goles) y el recorrido de validacion.py, no una copia. La búsqueda usa
una gemela incremental del mismo filtro (_kalman), que recorre cada temporada una
vez en vez de rehacer el filtro cada día; al final comprueba que da lo mismo que
app.py. El modelo 5 vive aquí (_fuerzas_np y MODELO5), solo para comparar.

Ojo con los nombres: openfootball cambió su forma de escribirlos en 2020/21
(las cinco grandes y la Championship: "Arsenal" pasó a "Arsenal FC") y en
2023/24 (Francia, Países Bajos y Portugal: "PSV Eindhoven" pasó a "PSV"). Sin
casarlos (mapa_nombres), media liga contaría como recién ascendida esas
temporadas. Los 0-0 vienen como [0, 0] en vez de {"ft": [0, 0]}. Y openfootball
fecha en julio de 2019 los partidos de la vuelta de 2019/20 (julio de 2020).

Descarga ~120 ficheros la primera vez (12 MB) y los guarda en openfootball_cache/,
y el de football-data en footballdata_cache/.
"""
import csv
import json
import math
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import date, timedelta
from multiprocessing import Pool

import numpy as np
import requests
from scipy.stats import poisson

# app.py exige estas variables al importarse; aquí no se pide nada a football-data.
os.environ.setdefault("FOOTBALL_DATA_TOKEN", "sin_uso_en_este_script")
os.environ.setdefault("UPDATE_SECRET", "afinar_liga_dummy_secret")

import app          # noqa: E402
import validacion   # noqa: E402

URL = "https://raw.githubusercontent.com/openfootball/football.json/master/{t}/{f}.json"
CACHE = "openfootball_cache"
FICHERO = {"PD": "es.1", "PL": "en.1", "BL1": "de.1", "SA": "it.1", "FL1": "fr.1",
           "DED": "nl.1", "PPL": "pt.1", "ELC": "en.2", "BSA": "br.1"}
PRIMERA, ULTIMA = 2010, 2026          # temporadas que se intentan bajar
FIN_AJUSTE = 2020                     # ajuste: temporadas evaluadas hasta 2020/21


# ------------------------------------------------------------------
# Datos
# ------------------------------------------------------------------
def _ruta(codigo, season):
    t = str(season) if codigo == "BSA" else f"{season}-{str(season + 1)[2:]}"
    return t, os.path.join(CACHE, f"{t}_{FICHERO[codigo]}.json")


def _bajar(codigo, season):
    """El fichero de una temporada, o None si openfootball no la tiene."""
    t, ruta = _ruta(codigo, season)
    if not os.path.exists(ruta):
        os.makedirs(CACHE, exist_ok=True)
        resp = requests.get(URL.format(t=t, f=FICHERO[codigo]), timeout=30)
        if resp.status_code == 404:
            with open(ruta, "w") as f:
                f.write("null")        # se recuerda que no existe
            return None
        resp.raise_for_status()
        with open(ruta, "w", encoding="utf-8") as f:
            f.write(resp.text)
    with open(ruta, encoding="utf-8") as f:
        return json.load(f)


def _crudos(codigo, season):
    """Los partidos con resultado de una temporada, por fecha, con el nombre que
    trae openfootball. Sin los playoffs de ascenso de la Championship."""
    j = _bajar(codigo, season)
    if not j:
        return None
    out = []
    for m in j["matches"]:
        if codigo == "ELC" and "Matchday" not in str(m.get("round", "")):
            continue
        sc = m.get("score")
        ft = sc if isinstance(sc, list) else (sc or {}).get("ft")   # los 0-0 vienen como [0, 0]
        if not ft or len(ft) != 2:
            continue
        out.append({"fecha": m["date"] + "T" + (m.get("time") or "00:00")[:5],
                    "local": m["team1"], "visita": m["team2"], "gl": int(ft[0]), "gv": int(ft[1])})
    out.sort(key=lambda x: x["fecha"])
    return out


VACIAS = {"fc", "cf", "afc", "sc", "ac", "as", "cd", "ud", "rc", "rcd", "sd", "ca", "club", "de",
          "ss", "us", "bc", "bv", "sbv", "tsg", "sv", "calcio", "futbol", "balompie", "sl", "gd", "cs",
          "fk", "1909", "1901", "1899", "1907", "1913", "1910", "65", "04", "05", "07", "1", "the",
          "e", "do", "da", "spvgg", "vfl", "ogc", "sco", "aj", "ssc", "acf", "uc", "hsc", "estac",
          "csd", "cfc", "sk", "and"}
ALIAS = {"inter": "internazionale", "lisboa": "benfica", "bor": "borussia", "cp": "portugal"}
NO_CASAR = {"Gazélec FC Ajaccio"}      # otro club que el AC Ajaccio


def _fichas(nombre):
    s = unicodedata.normalize("NFKD", nombre).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    t = {ALIAS.get(w, w) for w in s.split()} - VACIAS
    return t or set(s.split())


def _similitud(a, b):
    ta, tb = _fichas(a), _fichas(b)
    comun = len(ta & tb)
    return comun / min(len(ta), len(tb)) + 0.01 * comun / len(ta | tb) if ta and tb else 0


def temporadas(codigo):
    return [s for s in range(PRIMERA, ULTIMA + 1) if _crudos(codigo, s)]


_MAPAS = {}


def mapa_nombres(codigo):
    """{nombre de una temporada: el más reciente del mismo equipo}: de la
    temporada más nueva hacia atrás, un nombre que no estaba se casa con uno
    conocido que no juegue esa temporada si todas sus palabras (sin FC, CF...)
    están en él."""
    if codigo in _MAPAS:
        return _MAPAS[codigo]
    canon, conocidos = {}, set()
    for s in reversed(temporadas(codigo)):
        p = _crudos(codigo, s)
        eq = {m["local"] for m in p} | {m["visita"] for m in p}
        usados = {canon[n] for n in eq if n in canon}
        for n in sorted(eq & conocidos):
            canon.setdefault(n, n)
        libres = sorted(conocidos - usados)
        for n in sorted(eq - conocidos):
            mejor = max(libres, key=lambda c: _similitud(n, c), default=None)
            if mejor and n not in NO_CASAR and _similitud(n, mejor) >= 1.0:
                canon[n] = canon.get(mejor, mejor)
                libres.remove(mejor)
            else:
                canon[n] = n
        conocidos |= eq
    _MAPAS[codigo] = canon
    return canon


def _cargar_base(codigo, season):
    """Los partidos de una temporada con los nombres casados entre temporadas."""
    p = _crudos(codigo, season)
    if p is None:
        return None
    mp = mapa_nombres(codigo)
    return [dict(m, local=mp.get(m["local"], m["local"]), visita=mp.get(m["visita"], m["visita"])) for m in p]


# ------------------------------------------------------------------
# Tiros a puerta y cuotas (football-data.co.uk, por el espejo de GitHub)
# ------------------------------------------------------------------
URL_FD = "https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data/Matches.csv"
CACHE_FD = "footballdata_cache"
_FILAS_FD = None


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def filas_fd():
    """{división: [partido]} de football-data.co.uk, con los nombres por clave_tiros
    (el espejo escribe a veces un equipo de dos formas en la misma temporada)."""
    global _FILAS_FD
    if _FILAS_FD is None:
        ruta = os.path.join(CACHE_FD, "Matches.csv")
        if not os.path.exists(ruta):
            os.makedirs(CACHE_FD, exist_ok=True)
            resp = requests.get(URL_FD, timeout=300)
            resp.raise_for_status()
            with open(ruta, "wb") as f:
                f.write(resp.content)
        quiero = set(app.DIVISION_TIROS.values())
        _FILAS_FD = defaultdict(list)
        with open(ruta, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r["Division"] not in quiero or _num(r["FTHome"]) is None:
                    continue
                _FILAS_FD[r["Division"]].append({
                    "fecha": r["MatchDate"], "local": app.clave_tiros(r["HomeTeam"]),
                    "visita": app.clave_tiros(r["AwayTeam"]),
                    "gl": int(float(r["FTHome"])), "gv": int(float(r["FTAway"])),
                    "pl": _num(r["HomeTarget"]), "pv": _num(r["AwayTarget"]),
                    "o": (_num(r["OddHome"]), _num(r["OddDraw"]), _num(r["OddAway"]))})
    return _FILAS_FD


def _dia_iso(s, d=0):
    return (date.fromisoformat(s[:10]) + timedelta(days=d)).isoformat()


_CASADOS = {}


def _casar(codigo):
    """{(temporada, índice en _cargar_base): fila de football-data}. Cada nombre de
    openfootball toma el de football-data que le dan los partidos con el mismo marcador
    el mismo día (o uno antes o después) que solo pueden ser uno, temporada a temporada
    (y si una no da, el de todas). Luego cada partido toma la fila del mismo cruce y
    marcador: primero a menos de 4 días; lo que queda, la más cercana aún sin usar a
    menos de 400 (las fechas de mentira de la vuelta de 2019/20)."""
    if codigo in _CASADOS:
        return _CASADOS[codigo]
    filas = filas_fd()[app.DIVISION_TIROS[codigo]]
    por_marcador = defaultdict(list)
    for r in filas:
        por_marcador[(r["fecha"], r["gl"], r["gv"])].append(r)
    votos, total = {}, defaultdict(Counter)
    for s in temporadas(codigo):
        v = votos[s] = defaultdict(Counter)
        for m in _cargar_base(codigo, s):
            cand = [r for d in (0, -1, 1) for r in por_marcador.get((_dia_iso(m["fecha"], d), m["gl"], m["gv"]), [])]
            if len(cand) == 1:
                for a, b in ((m["local"], cand[0]["local"]), (m["visita"], cand[0]["visita"])):
                    v[a][b] += 1
                    total[a][b] += 1
    todos = {n: c.most_common(1)[0][0] for n, c in total.items()}
    cruces = defaultdict(list)
    for r in filas:
        cruces[(r["local"], r["visita"], r["gl"], r["gv"])].append(r)
    out, usadas, quedan = {}, set(), []
    for s in temporadas(codigo):
        mp = dict(todos, **{n: c.most_common(1)[0][0] for n, c in votos[s].items()})
        for i, m in enumerate(_cargar_base(codigo, s)):
            f = date.fromisoformat(m["fecha"][:10])
            cand = sorted(((abs((date.fromisoformat(r["fecha"]) - f).days), id(r), r)
                           for r in cruces.get((mp.get(m["local"]), mp.get(m["visita"]), m["gl"], m["gv"]), [])),
                          key=lambda x: x[0])
            if cand and cand[0][0] <= 3 and id(cand[0][2]) not in usadas:
                out[(s, i)] = cand[0][2]
                usadas.add(id(cand[0][2]))
            else:
                quedan.append((s, i, cand))
    for s, i, cand in quedan:
        libres = [x for x in cand if x[1] not in usadas and x[0] < 400]
        if libres:
            out[(s, i)] = libres[0][2]
            usadas.add(libres[0][1])
    _CASADOS[codigo] = out
    return out


def cargar(codigo, season):
    """Los partidos de una temporada con los nombres casados entre temporadas y, si
    football-data.co.uk los tiene, sus tiros a puerta (pl, pv) y las cuotas de bet365
    (cuotas: 1, X, 2)."""
    p = _cargar_base(codigo, season)
    if p is None or codigo not in app.DIVISION_TIROS:
        return p
    cas = _casar(codigo)
    out = []
    for i, m in enumerate(p):
        r = cas.get((season, i))
        if r and r["pl"] is not None and r["pv"] is not None:
            m = dict(m, pl=int(r["pl"]), pv=int(r["pv"]))
        if r and all(r["o"]):
            m = dict(m, cuotas=r["o"])
        out.append(m)
    return out


def preparar():
    """Lo que cuesta leer y casar, antes de repartir el trabajo entre procesos."""
    for c in FICHERO:
        for s in temporadas(c):
            _cargar_base(c, s)
        if c in app.DIVISION_TIROS:
            _casar(c)


def casos():
    """(liga, temporada evaluada) con la anterior disponible."""
    out = []
    for c in FICHERO:
        ss = set(temporadas(c))
        out += [(c, s) for s in sorted(ss) if s - 1 in ss and len(cargar(c, s - 1)) >= 100]
    return out


def de_arriba(codigo, season):
    """Los que llegan a la liga desde la de arriba (app.LIGA_DE_ARRIBA: de la
    Premier a la Championship), con el nombre que llevan en esta liga: los
    recién llegados que casan con un equipo de la temporada anterior de la de
    arriba (cada liga casa sus nombres por su cuenta, ver mapa_nombres). La app
    pasa la lista entera de la de arriba; para el ajuste es lo mismo."""
    sup = app.LIGA_DE_ARRIBA.get(codigo)
    previa, ultima = cargar(codigo, season - 1), cargar(codigo, season)
    arriba = cargar(sup, season - 1) if sup else None
    if not arriba or not previa or not ultima:
        return []
    nombres = {m["local"] for m in arriba} | {m["visita"] for m in arriba}
    antes = {m["local"] for m in previa} | {m["visita"] for m in previa}
    nuevos = sorted(({m["local"] for m in ultima} | {m["visita"] for m in ultima}) - antes)
    return [n for n in nuevos if max(_similitud(n, x) for x in nombres) >= 1.0]


def _ancla(previa):
    n = len(previa)
    return {"avg_local": sum(m["gl"] for m in previa) / n, "avg_visita": sum(m["gv"] for m in previa) / n}


# ------------------------------------------------------------------
# Recorridos: cada partido con lo de antes, como validacion.py
# ------------------------------------------------------------------
def recorrer_app(caso):
    """El modelo de app.py: [xg_local, xg_visita, media local, media visita, goles
    local, goles visita, y las cuotas de bet365 de 1, X y 2 (nan si no las hay)] por
    partido, con el recorrido de validacion.py."""
    c, s = caso
    previa, ultima = cargar(c, s - 1), cargar(c, s)
    hist = validacion._Historial(previa, _ancla(previa), app.K_LIGA, codigo_liga=c, de_arriba=de_arriba(c, s))
    filas = []
    for m in ultima:
        fz, media = hist.antes_de(m)
        xl, xv = app.calcular_xg_partido(app.fuerza_equipo(fz, m["local"]),
                                         app.fuerza_equipo(fz, m["visita"]), media)
        filas.append([xl, xv, media["avg_local"], media["avg_visita"], m["gl"], m["gv"],
                      *m.get("cuotas", (math.nan,) * 3)])
        hist.registrar(m)
    return c, s, np.array(filas, dtype=float)


def _kalman(caso, q=None, p_ini=None, q_temp=None, p_nuevo=None, peso=None, exponente=None,
            a0=None, d0=None, baja=None):
    """Gemela incremental de ajustar_fuerzas con el recorrido de validacion.py: las
    mismas operaciones en el mismo orden (con exp_exacto y log_exacto), pero recorriendo
    cada temporada una sola vez en vez de rehacer el filtro cada día. Con los parámetros
    de app.py da lo mismo que recorrer_app (lo comprueba main); los que se den, mandan.
    Devuelve las filas de recorrer_app, con los goles esperados sin redondear."""
    c, s = caso
    q = app.KALMAN_DERIVA if q is None else q
    p_ini = app.KALMAN_INICIO if p_ini is None else p_ini
    q_temp = app.KALMAN_TEMPORADA if q_temp is None else q_temp
    p_nuevo = app.KALMAN_NUEVO if p_nuevo is None else p_nuevo
    W = app.PESO_TIROS if peso is None else peso
    e_f = app.EXPONENTE_FUERZAS if exponente is None else exponente
    previa, ultima = cargar(c, s - 1), cargar(c, s)
    prev = [validacion._compacto(m) for m in previa]
    act = [validacion._compacto(m) for m in ultima]
    kl = kv = 0.0
    gl = gv = tl = tv = 0
    for p in prev:
        if len(p) > 5:
            gl += p[3]; gv += p[4]; tl += p[5]; tv += p[6]
    if tl > 0 and tv > 0:
        kl, kv = gl / tl, gv / tv
    elif any(len(p) > 5 for p in act):
        return recorrer_app(caso)   # los goles por tiro saldrían de esta temporada: cambian cada día
    arriba = set(de_arriba(c, s))
    previos = {t for p in prev for t in (p[1], p[2])}
    con_previa = len(prev) > 0
    if len(prev) >= 100:
        al_, av_ = sum(p[3] for p in prev) / len(prev), sum(p[4] for p in prev) / len(prev)
    else:
        al_, av_ = app.PRIOR_AVG_LOCAL, app.PRIOR_AVG_VISITA
    a_asc = app.ATAQUE_RECIEN_LLEGADO if a0 is None else a0
    d_asc = app.DEFENSA_RECIEN_LLEGADO.get(c, 1.0) if d0 is None else d0
    a_baj, d_baj = (app.ATAQUE_DESCENDIDO, app.DEFENSA_DESCENDIDO) if baja is None else baja

    def prior(t):
        return (a_baj, d_baj) if t in arriba else (a_asc, d_asc)

    estado, orden = {}, []
    cuenta = {"tiros": 0, "n": 0}

    def paso(p, en_actual, ml, mv):
        d, loc, vis, g1, g2 = p[0], p[1], p[2], p[3], p[4]
        for t in (loc, vis):
            e = estado.get(t)
            if e is None:
                if en_actual and con_previa and t not in previos:
                    a, df = prior(t)
                    e = [app.log_exacto(a), app.log_exacto(df), p_nuevo, p_nuevo, d, 0]
                else:
                    e = [0.0, 0.0, p_ini, p_ini, d, 0]
                estado[t] = e
                orden.append(t)
            if d > e[4]:
                e[2] += q * (d - e[4])
                e[3] += q * (d - e[4])
                e[4] = d
            e[5] += 1
        el, ev = estado[loc], estado[vis]
        lam_l = ml * app.exp_exacto(el[0] + ev[1])
        lam_v = mv * app.exp_exacto(ev[0] + el[1])
        if len(p) > 5 and kl > 0:
            y_l = (1 - W) * g1 + W * kl * p[5]
            y_v = (1 - W) * g2 + W * kv * p[6]
            cuenta["tiros"] += 1
        else:
            y_l, y_v = g1, g2
        for at, de, lam, y in ((el, ev, lam_l, y_l), (ev, el, lam_v, y_v)):
            pa, pd = at[2], de[3]
            den = 1 + lam * (pa + pd)
            at[0] += pa * (y - lam) / den
            de[1] += pd * (y - lam) / den
            at[2] = pa - lam * pa * pa / den
            de[3] = pd - lam * pd * pd / den
        cuenta["n"] += 1

    for p in prev:
        paso(p, False, al_, av_)
    ancla = _ancla(previa)
    filas, i = [], 0
    gl_t = gv_t = n_t = 0
    while i < len(act):
        j = i
        while j < len(act) and act[j][0] == act[i][0]:
            j += 1
        # lo que diría app.py ese día: las fuerzas de lo jugado antes, elevadas a su exponente
        n = cuenta["n"]
        b = 1 + (e_f - 1) * (cuenta["tiros"] / n) if n else 1.0
        ml = (gl_t + app.K_LIGA * ancla["avg_local"]) / (n_t + app.K_LIGA)
        mv = (gv_t + app.K_LIGA * ancla["avg_visita"]) / (n_t + app.K_LIGA)

        def fuerza(t):
            e = estado.get(t)
            if e is not None:
                return app.exp_exacto(b * e[0]), app.exp_exacto(b * e[1])
            if not con_previa:
                return 1.0, 1.0
            a, df = prior(t)
            return app.exp_exacto(b * app.log_exacto(a)), app.exp_exacto(b * app.log_exacto(df))

        for k in range(i, j):
            (ah, dh), (aa, da) = fuerza(act[k][1]), fuerza(act[k][2])
            m = ultima[k]
            filas.append([ml * ah * da, mv * aa * dh, ml, mv, m["gl"], m["gv"], *m.get("cuotas", (math.nan,) * 3)])
        # y luego se juegan
        ml_f = (gl_t + app.K_LIGA * al_) / (n_t + app.K_LIGA)
        mv_f = (gv_t + app.K_LIGA * av_) / (n_t + app.K_LIGA)
        for k in range(i, j):
            if k == 0:
                for t in orden:
                    estado[t][2] += q_temp
                    estado[t][3] += q_temp
            paso(act[k], True, ml_f, mv_f)
        for k in range(i, j):
            gl_t += act[k][3]; gv_t += act[k][4]; n_t += 1
        i = j
    return c, s, np.array(filas, dtype=float)


def _k(arg):
    caso, sobre = arg
    return _kalman(caso, **sobre)


# El modelo 5 (hasta nov 2026), para comparar: el ataque y la defensa de cada equipo con
# los goles de las dos temporadas pesados por antigüedad (factor^días), encogidos hacia su
# prior con pseudo-goles y ajustados hasta que nada cambia. Ver "El modelo" en CLAUDE.md.
MODELO5 = {"factor": 0.998, "k_at": 6, "k_de": 8, "tolerancia": 1e-4, "max_iter": 300}
CLAVE_MODELO5 = (MODELO5["factor"], MODELO5["k_at"], MODELO5["k_de"], 0.8)


def _fuerzas_np(caso, factor, k_at, k_de, a0, d0=None, baja=None):
    """El modelo 5 en numpy (el ajuste de app.py hasta nov 2026) con el recorrido de
    validacion.py, para comparar con el de ahora. d0 (la defensa de la que parte un
    ascendido) y baja (ataque y defensa de un descendido de la liga de arriba) son,
    si no se dan, los de app.py para esa liga."""
    c, s = caso
    d0 = app.DEFENSA_RECIEN_LLEGADO.get(c, 1.0) if d0 is None else d0
    baja = (app.ATAQUE_DESCENDIDO, app.DEFENSA_DESCENDIDO) if baja is None else baja
    previa, ultima = cargar(c, s - 1), cargar(c, s)
    ancla = _ancla(previa)
    todos = previa + ultima
    nombres = sorted({m["local"] for m in todos} | {m["visita"] for m in todos})
    idx = {x: i for i, x in enumerate(nombres)}
    T = len(nombres)
    H = np.array([idx[m["local"]] for m in todos]); A = np.array([idx[m["visita"]] for m in todos])
    GH = np.array([m["gl"] for m in todos], float); GA = np.array([m["gv"] for m in todos], float)
    D = np.array([app.dia_de(m["fecha"]) for m in todos])
    n0 = len(previa)
    previos = np.zeros(T, bool); previos[H[:n0]] = True; previos[A[:n0]] = True
    p_at, p_de = np.where(previos, 1.0, a0), np.where(previos, 1.0, d0)
    for n in de_arriba(c, s):
        p_at[idx[n]], p_de[idx[n]] = baja
    at, de = p_at.copy(), p_de.copy()
    filas, i = [], n0
    while i < len(todos):
        j = i
        while j < len(todos) and D[j] == D[i]:
            j += 1
        h, a, gh, ga = H[:i], A[:i], GH[:i], GA[:i]
        w = factor ** (D[:i].max() - D[:i]).astype(float)
        ml = (GH[n0:i].sum() + app.K_LIGA * ancla["avg_local"]) / (i - n0 + app.K_LIGA)
        mv = (GA[n0:i].sum() + app.K_LIGA * ancla["avg_visita"]) / (i - n0 + app.K_LIGA)
        gf = np.bincount(h, w * gh, T) + np.bincount(a, w * ga, T) + k_at * p_at
        gc = np.bincount(h, w * ga, T) + np.bincount(a, w * gh, T) + k_de * p_de
        for _ in range(MODELO5["max_iter"]):
            at_n = gf / (np.bincount(h, w * ml * de[a], T) + np.bincount(a, w * mv * de[h], T) + k_at)
            de_n = gc / (np.bincount(h, w * mv * at_n[a], T) + np.bincount(a, w * ml * at_n[h], T) + k_de)
            cambio = max(np.abs(at_n - at).max(), np.abs(de_n - de).max())
            at, de = at_n, de_n
            if cambio < MODELO5["tolerancia"]:
                break
        for k in range(i, j):
            filas.append([ml * at[H[k]] * de[A[k]], mv * at[A[k]] * de[H[k]], ml, mv, GH[k], GA[k]])
        i = j
    return c, s, np.array(filas)


def _np(arg):
    caso, params = arg
    return _fuerzas_np(caso, *params)


# ------------------------------------------------------------------
# Puntuación
# ------------------------------------------------------------------
G = np.arange(app.LIMITE_GOLES + 1)
DIF, TOT = np.subtract.outer(G, G), np.add.outer(G, G)


def _ceros(p, z):
    """Con el 0 un z más bajo y lo que pierde repartido entre los demás (_menos_ceros)."""
    if not z:
        return p
    p0 = p[:, :1]
    return np.concatenate([p0 * (1 - z), p[:, 1:] * (1 - p0 * (1 - z)) / (1 - p0)], 1)


def rejillas(lh, la, rho, z=0.0):
    """Rejillas de marcadores normalizadas, con la corrección de Dixon-Coles (y, en los
    mercados de goles, con MENOS_CEROS)."""
    r = _ceros(poisson.pmf(G[None, :], lh[:, None]), z)[:, :, None] * _ceros(poisson.pmf(G[None, :], la[:, None]), z)[:, None, :]
    r[:, 0, 0] *= 1 - lh * la * rho
    r[:, 0, 1] *= 1 + lh * rho
    r[:, 1, 0] *= 1 + la * rho
    r[:, 1, 1] *= 1 - rho
    return r / r.sum(axis=(1, 2), keepdims=True)


def puntuar(f, rho, alfa, forma="total", z=None):
    """Brier por partido del 1X2, de más de 2.5 y de ambos marcan, del modelo y
    de la base "equipo medio" (la media de la liga para los dos). Los mercados de
    goles, con el total de goles esperados acercado a la media de la liga (lineal,
    alfa: ENCOGER_TOTAL de app.py) o, con forma="log", cada equipo por separado en
    escala logarítmica (los modelos de antes del 4). z: MENOS_CEROS (por defecto, el
    de app.py; los modelos de antes del 5, 0). "marcador": log loss del marcador
    exacto de la rejilla de goles, con la que se eligen ENCOGER_TOTAL y MENOS_CEROS."""
    z = app.MENOS_CEROS if z is None else z
    y = np.where(f[:, 4] > f[:, 5], 0, np.where(f[:, 4] == f[:, 5], 1, 2))
    mas = (f[:, 4] + f[:, 5] > 2.5).astype(float)
    amb = ((f[:, 4] > 0) & (f[:, 5] > 0)).astype(float)
    def b1x2(r):
        p = np.stack([r[:, DIF > 0].sum(1), r[:, DIF == 0].sum(1), r[:, DIF < 0].sum(1)], 1)
        o = np.zeros_like(p); o[np.arange(len(y)), y] = 1
        return ((p - o) ** 2).sum(1), -np.log(p[np.arange(len(y)), y])
    def goles(r):
        return (r[:, TOT > 2.5].sum(1) - mas) ** 2, (r[:, 1:, 1:].sum((1, 2)) - amb) ** 2
    out = {}
    out["1x2"], out["logloss"] = b1x2(rejillas(f[:, 0], f[:, 1], rho))
    out["1x2_base"], out["logloss_base"] = b1x2(rejillas(np.round(f[:, 2], 2), np.round(f[:, 3], 2), rho))
    if forma == "log":
        lh = f[:, 2] * (f[:, 0] / f[:, 2]) ** alfa
        la = f[:, 3] * (f[:, 1] / f[:, 3]) ** alfa
    else:
        total, media = f[:, 0] + f[:, 1], f[:, 2] + f[:, 3]
        escala = (media + alfa * (total - media)) / total
        lh, la = f[:, 0] * escala, f[:, 1] * escala
    rg = rejillas(lh, la, rho, z)
    out["mas_25"], out["ambos"] = goles(rg)
    out["marcador"] = -np.log(rg[np.arange(len(y)), np.minimum(f[:, 4], G[-1]).astype(int),
                                 np.minimum(f[:, 5], G[-1]).astype(int)])
    out["mas_25_base"], out["ambos_base"] = goles(rejillas(f[:, 2], f[:, 3], rho, z))
    out["empate_pred"] = rejillas(f[:, 0], f[:, 1], rho)[:, DIF == 0].sum(1)
    out["empate_real"] = (y == 1).astype(float)
    return out


def pareado(a, b):
    d = a - b
    return d.mean(), d.std(ddof=1) / math.sqrt(len(d))


def skill(x, base):
    return 100 * (1 - x.mean() / base.mean())


def _juntar(res):
    f = np.concatenate([r[2] for r in res])
    liga = np.concatenate([[r[0]] * len(r[2]) for r in res])
    temp = np.concatenate([[r[1]] * len(r[2]) for r in res])
    return f, liga, temp


# ------------------------------------------------------------------
# Informes
# ------------------------------------------------------------------
def evaluar(pool, lista):
    nuevo, liga, temp = _juntar(pool.map(recorrer_app, lista))
    viejo, _, _ = _juntar(pool.map(_np, [(c, CLAVE_MODELO5) for c in lista]))
    viejo[:, :2] = np.round(viejo[:, :2], 2)          # como calcular_xg_partido
    pn = puntuar(nuevo, app.RHO_EMPATES, app.ENCOGER_TOTAL)
    pv = puntuar(viejo, app.RHO_EMPATES, app.ENCOGER_TOTAL)
    grupos = [("ajuste (hasta 2020/21)", temp <= FIN_AJUSTE), ("prueba (2021/22-2025/26)", (temp > FIN_AJUSTE) & (temp <= 2025)),
              ("2026/27 en curso", temp >= 2026)]
    print("\n1X2: skill frente a la base 'equipo medio' y diferencia de Brier con el modelo 5")
    for nombre, m in grupos:
        if not m.any():
            continue
        d, se = pareado(pn["1x2"][m], pv["1x2"][m])
        dl, sel = pareado(pn["logloss"][m], pv["logloss"][m])
        print(f"  {nombre:26s} {m.sum():6d} partidos   modelo 5 {skill(pv['1x2'][m], pv['1x2_base'][m]):+5.2f}%   "
              f"app.py {skill(pn['1x2'][m], pn['1x2_base'][m]):+5.2f}%   Brier {d:+.4f} ± {se:.4f} ({d / se:+.1f} se)"
              f"   LogLoss {dl:+.4f} ({dl / sel:+.1f} se)")
    prueba = (temp > FIN_AJUSTE) & (temp <= 2025)
    print("\nPor liga (prueba): skill del 1X2, modelo 5 -> app.py")
    for c in FICHERO:
        m = prueba & (liga == c)
        if m.any():
            d, se = pareado(pn["1x2"][m], pv["1x2"][m])
            print(f"  {c:4s} {m.sum():5d} partidos  {skill(pv['1x2'][m], pv['1x2_base'][m]):+5.2f}% -> "
                  f"{skill(pn['1x2'][m], pn['1x2_base'][m]):+5.2f}%   ({d / se:+.1f} se)")
    print("\nPor temporada: skill del 1X2, modelo 5 -> app.py")
    for s in sorted(set(temp.tolist())):
        m = temp == s
        d, se = pareado(pn["1x2"][m], pv["1x2"][m])
        print(f"  {s}/{(s + 1) % 100:02d} {m.sum():5d} partidos  {skill(pv['1x2'][m], pv['1x2_base'][m]):+5.2f}% -> "
              f"{skill(pn['1x2'][m], pn['1x2_base'][m]):+5.2f}%   ({d / se:+.1f} se)")
    print("\nMercados de goles (prueba): skill frente a la base, modelo 5 -> app.py")
    for k, txt in (("mas_25", "más de 2.5"), ("ambos", "ambos marcan")):
        d, se = pareado(pn[k][prueba], pv[k][prueba])
        print(f"  {txt:13s} {skill(pv[k][prueba], pv[k + '_base'][prueba]):+5.2f}% -> "
              f"{skill(pn[k][prueba], pn[k + '_base'][prueba]):+5.2f}%   ({d / se:+.1f} se)")
    for nombre, m in grupos[:2]:
        d, se = pareado(pn["marcador"][m], pv["marcador"][m])
        print(f"  log loss del marcador frente al modelo 5, {nombre}: {d:+.5f} ({d / se:+.1f} se)")
    print(f"\nEmpates (prueba): app.py predice {100 * pn['empate_pred'][prueba].mean():.1f}%, "
          f"hubo {100 * pn['empate_real'][prueba].mean():.1f}%")
    # bet365 sin su margen (las cuotas inversas, normalizadas), en los mismos partidos
    o = nuevo[:, 6:9]
    con = ~np.isnan(o).any(1)
    y = np.where(nuevo[:, 4] > nuevo[:, 5], 0, np.where(nuevo[:, 4] == nuevo[:, 5], 1, 2))
    q = 1 / np.where(con[:, None], o, 1.0)
    q /= q.sum(1, keepdims=True)
    obs = np.zeros_like(q)
    obs[np.arange(len(y)), y] = 1
    casa = ((q - obs) ** 2).sum(1)
    print("\nFrente a bet365 sin su margen (los partidos con cuotas), skill del 1X2:")
    for nombre, m in grupos[:2]:
        m = m & con
        print(f"  {nombre:26s} {m.sum():6d} partidos   modelo 5 {skill(pv['1x2'][m], pv['1x2_base'][m]):+5.2f}%   "
              f"app.py {skill(pn['1x2'][m], pn['1x2_base'][m]):+5.2f}%   bet365 {skill(casa[m], pn['1x2_base'][m]):+5.2f}%")
    return nuevo, liga, temp


def afinar(pool, lista):
    """Búsqueda por coordenadas de los parámetros del filtro en el grupo de ajuste, con
    la gemela incremental (_kalman), y luego la corrección de empates y los mercados de
    goles con esas fuerzas."""
    ajuste = [x for x in lista if x[1] <= FIN_AJUSTE]
    rejilla = {"exponente": [1.0, 1.05, 1.1, 1.15, 1.2, 1.25], "q": [3e-5, 5e-5, 7e-5, 1e-4],
               "p_ini": [0.08, 0.12, 0.16, 0.24, 0.32], "q_temp": [0.0, 0.005, 0.01, 0.02],
               "peso": [0.3, 0.4, 0.5, 0.6], "p_nuevo": [0.03, 0.04, 0.06, 0.08, 0.12]}
    mejor = {"exponente": app.EXPONENTE_FUERZAS, "q": app.KALMAN_DERIVA, "p_ini": app.KALMAN_INICIO,
             "q_temp": app.KALMAN_TEMPORADA, "peso": app.PESO_TIROS, "p_nuevo": app.KALMAN_NUEVO}
    memo = {}

    def coste(p):
        clave = tuple(sorted(p.items()))
        if clave not in memo:
            f, _, _ = _juntar(pool.map(_k, [(c, p) for c in ajuste]))
            memo[clave] = puntuar(f, app.RHO_EMPATES, app.ENCOGER_TOTAL)["1x2"].mean()
        return memo[clave]

    print(f"Búsqueda en {len(ajuste)} temporadas de ajuste (Brier del 1X2):")
    for ronda in range(4):
        cambio = False
        for k, vals in rejilla.items():
            res = [(coste(dict(mejor, **{k: v})), v) for v in vals]
            b, v = min(res)
            cambio |= v != mejor[k]
            mejor[k] = v
            print(f"  {k:9s} " + "  ".join(f"{vv}:{bb:.5f}" for bb, vv in res) + f"   -> {v}", flush=True)
        if not cambio:
            break
    print("mejor:", mejor)
    f, _, temp = _juntar(pool.map(_k, [(c, mejor) for c in lista]))
    print("\nCon esas fuerzas, corrección de empates y mercados de goles (Brier; ajuste | prueba):")
    aj, pr = temp <= FIN_AJUSTE, temp > FIN_AJUSTE
    for rho in (0.0, -0.03, -0.05, -0.08, -0.12):
        p = puntuar(f, rho, app.ENCOGER_TOTAL)
        print(f"  RHO_EMPATES {rho:+.2f}: 1X2 {p['1x2'][aj].mean():.5f} | {p['1x2'][pr].mean():.5f}"
              f"   empates {100 * p['empate_pred'][aj].mean():.1f}% (hubo {100 * p['empate_real'][aj].mean():.1f}%)")
    for alfa in (0.4, 0.5, 0.6, 0.7, 0.8, 1.0):
        p = puntuar(f, app.RHO_EMPATES, alfa)
        print(f"  ENCOGER_TOTAL {alfa}: más de 2.5 {skill(p['mas_25'][aj], p['mas_25_base'][aj]):+.2f}% | "
              f"{skill(p['mas_25'][pr], p['mas_25_base'][pr]):+.2f}%   ambos marcan "
              f"{skill(p['ambos'][aj], p['ambos_base'][aj]):+.2f}% | {skill(p['ambos'][pr], p['ambos_base'][pr]):+.2f}%"
              f"   marcador {p['marcador'][aj].mean():.5f} | {p['marcador'][pr].mean():.5f}")
    p0 = puntuar(f, app.RHO_EMPATES, app.ENCOGER_TOTAL, z=0.0)
    for z in (0.0, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08):
        p = puntuar(f, app.RHO_EMPATES, app.ENCOGER_TOTAL, z=z)
        partes = []
        for nombre, m in (("ajuste", aj), ("prueba", pr)):
            d, se = pareado(p["marcador"][m], p0["marcador"][m])
            partes.append(f"{nombre} {d:+.5f}" + (f" ({d / se:+.1f} se)" if se else ""))
        print(f"  MENOS_CEROS {z:.2f}: log loss del marcador frente a 0, " + "   ".join(partes))


def _k_prior(arg):
    caso, d0, baja = arg
    return _kalman(caso, d0=d0, baja=baja)


def _fuerza_real(partidos):
    """(ataque, defensa) de cada equipo con una temporada entera y sin prior:
    lo que fue de verdad ese año."""
    nombres = sorted({m["local"] for m in partidos} | {m["visita"] for m in partidos})
    idx = {x: i for i, x in enumerate(nombres)}
    T = len(nombres)
    H = np.array([idx[m["local"]] for m in partidos]); A = np.array([idx[m["visita"]] for m in partidos])
    GH = np.array([m["gl"] for m in partidos], float); GA = np.array([m["gv"] for m in partidos], float)
    ml, mv = GH.mean(), GA.mean()
    at, de = np.ones(T), np.ones(T)
    for _ in range(5000):
        at_n = (np.bincount(H, GH, T) + np.bincount(A, GA, T)) / (np.bincount(H, ml * de[A], T) + np.bincount(A, mv * de[H], T))
        de_n = (np.bincount(H, GA, T) + np.bincount(A, GH, T)) / (np.bincount(H, mv * at_n[A], T) + np.bincount(A, ml * at_n[H], T))
        listo = max(np.abs(at_n - at).max(), np.abs(de_n - de).max()) < 1e-10
        at, de = at_n, de_n
        if listo:
            break
    return {n: (at[idx[n]], de[idx[n]]) for n in nombres}


def descensos(pool, lista):
    """De dónde parten los recién llegados (prior_recien_llegado en app.py):
    diferencia de Brier del 1X2 con cada prior frente a tratarlos como un
    ascendido cualquiera (ataque ATAQUE_RECIEN_LLEGADO, defensa 1)."""
    def brier(casos_liga, d0, baja):
        res = pool.map(_k_prior, [(x, d0, baja) for x in casos_liga])
        return {g: puntuar(np.concatenate([r[2] for r in res if filtro(r[1])]), app.RHO_EMPATES,
                           app.ENCOGER_TOTAL)["1x2"]
                for g, filtro in (("ajuste", lambda s: s <= FIN_AJUSTE),
                                  ("prueba", lambda s: FIN_AJUSTE < s <= 2025))}

    def linea(texto, b, b0, marca=False):
        partes = []
        for g in ("ajuste", "prueba"):
            d, se = pareado(b[g], b0[g])
            partes.append(f"{g} {d:+.4f} ({d / se:+.1f} se)" if se else f"{g} igual")
        print(f"  {texto:22s} " + "   ".join(partes) + ("   <- app.py" if marca else ""), flush=True)

    asc = (app.ATAQUE_RECIEN_LLEGADO, 1.0)
    elc = [x for x in lista if x[0] == "ELC"]
    print("Los que bajan de la Premier a la Championship (ataque, defensa de partida):")
    b0 = brier(elc, 1.0, asc)
    for at_b in (1.0, 1.1, 1.2, 1.3, 1.4):
        for de_b in (0.8, 0.85, 0.9, 1.0):
            linea(f"{at_b:.2f}, {de_b:.2f}", brier(elc, 1.0, (at_b, de_b)), b0,
                  (at_b, de_b) == (app.ATAQUE_DESCENDIDO, app.DEFENSA_DESCENDIDO))
    print("Fuerza de verdad (temporada entera, media geométrica) de los recién llegados:")
    for liga in ("ELC", "PL"):
        for g, filtro in (("ajuste", lambda s: s <= FIN_AJUSTE), ("prueba", lambda s: FIN_AJUSTE < s <= 2025)):
            bajan, suben = [], []
            for c, s in lista:
                if c == liga and filtro(s):
                    real = _fuerza_real(cargar(c, s))
                    antes = {m["local"] for m in cargar(c, s - 1)} | {m["visita"] for m in cargar(c, s - 1)}
                    arriba = set(de_arriba(c, s))
                    for n in set(real) - antes:
                        (bajan if n in arriba else suben).append(real[n])
            for txt, v in (("bajan", bajan), ("suben", suben)):
                if v:
                    g_at, g_de = np.exp(np.log(np.array(v)).mean(0))
                    print(f"  {liga:4s} {g:6s} {txt}: {len(v):3d} equipos, ataque {g_at:.2f}, defensa {g_de:.2f}")
    for liga, valores in (("PL", (1.1, 1.2, 1.3, 1.4)), (None, (1.1, 1.2))):
        sel = [x for x in lista if (x[0] == liga if liga else x[0] not in ("PL", "ELC"))]
        print(f"Defensa de partida de un ascendido, {'Premier' if liga else 'las demás ligas (sin Premier ni Championship)'}:")
        b0 = brier(sel, 1.0, None)
        for d0 in valores:
            linea(f"{d0:.2f}", brier(sel, d0, None), b0, liga and d0 == app.DEFENSA_RECIEN_LLEGADO.get(liga))


# ------------------------------------------------------------------
# La proyección de la tabla (simularPorTandas en app.js, tablas.js en el Worker)
# ------------------------------------------------------------------
CORTES = (0.25, 0.5, 0.75)            # lo jugado de la temporada al cortarla
BAJAN = {"PD": 3, "PL": 3, "SA": 3, "BL1": 2, "FL1": 2, "DED": 2, "PPL": 2, "BSA": 4, "ELC": 3}   # ZONAS
SIMULACIONES = 4000                   # las de app.js


def _tabla(n, partidos):
    pts, dg, gf = np.zeros(n), np.zeros(n), np.zeros(n)
    for i, j, a, b in partidos:
        dg[i] += a - b; dg[j] += b - a; gf[i] += a; gf[j] += b
        if a > b:
            pts[i] += 3
        elif a < b:
            pts[j] += 3
        else:
            pts[i] += 1; pts[j] += 1
    return pts, dg, gf


def _puestos(pts, dg, gf):
    """Puesto de cada equipo (0, el primero), por puntos, diferencia de goles y goles
    a favor, como app.js; con varias filas, cada una es una temporada simulada."""
    orden = np.argsort(-(pts * 1e8 + (dg + 1000) * 1e4 + gf), axis=-1, kind="stable")
    pos = np.empty_like(orden)
    np.put_along_axis(pos, orden, np.broadcast_to(np.arange(orden.shape[-1]), orden.shape), axis=-1)
    return pos


def cortes_temporada(caso):
    """Cada corte de una temporada completa: lo jugado hasta ahí, lo que falta con los
    goles esperados de ese día (las fuerzas y la media de liga de validacion.py, como
    tablas.js) y cómo acabó."""
    c, s = caso
    previa, ultima = cargar(c, s - 1), cargar(c, s)
    equipos = sorted({m["local"] for m in ultima} | {m["visita"] for m in ultima})
    n = len(equipos)
    if len(ultima) != n * (n - 1):    # temporada incompleta en openfootball
        return []
    idx = {e: i for i, e in enumerate(equipos)}
    par = lambda m: (idx[m["local"]], idx[m["visita"]])   # noqa: E731
    hist = validacion._Historial(previa, _ancla(previa), app.K_LIGA, codigo_liga=c, de_arriba=de_arriba(c, s))
    dias = [app.dia_de(m["fecha"]) for m in ultima]
    objetivo = [int(f * len(ultima)) for f in CORTES]
    out = []
    for pos, m in enumerate(ultima):
        # el corte, al empezar el primer día con la parte de la temporada ya jugada
        while len(out) < len(objetivo) and pos >= objetivo[len(out)] and dias[pos] != dias[pos - 1]:
            fz, media = hist.antes_de(m)
            out.append({"liga": c, "temp": s, "corte": CORTES[len(out)], "n": n,
                        "jugados": [(*par(x), x["gl"], x["gv"]) for x in ultima[:pos]],
                        "restantes": [(*par(x), *app.calcular_xg_partido(app.fuerza_equipo(fz, x["local"]),
                                                                           app.fuerza_equipo(fz, x["visita"]), media))
                                      for x in ultima[pos:]],
                        "final": [(*par(x), x["gl"], x["gv"]) for x in ultima]})
        if len(out) == len(objetivo):
            break
        hist.registrar(m)
    return out


def simular_corte(arg):
    """Lo que falta de un corte jugado SIMULACIONES veces, cada partido con dos Poisson
    de sus goles esperados (simularPorTandas). Con sigma > 0, en cada temporada simulada
    el ataque y la defensa de cada equipo se mueven al azar (lognormal de media 1): la
    fuerza de hoy no es segura. Devuelve, por zona de la web, la probabilidad de cada
    equipo y si acabó en ella, y los puntos (media y si los reales caen en el 10-90 %)."""
    r, sigma = arg
    n, rng = r["n"], np.random.default_rng(7)
    p0, d0, g0 = _tabla(n, r["jugados"])
    R = np.array(r["restantes"], dtype=float)
    i, j = R[:, 0].astype(int), R[:, 1].astype(int)
    xl, xv = np.broadcast_to(R[:, 2], (SIMULACIONES, len(R))), np.broadcast_to(R[:, 3], (SIMULACIONES, len(R)))
    if sigma:
        A = np.exp(sigma * rng.standard_normal((SIMULACIONES, n)) - sigma ** 2 / 2)
        D = np.exp(sigma * rng.standard_normal((SIMULACIONES, n)) - sigma ** 2 / 2)
        xl, xv = xl * A[:, i] * D[:, j], xv * A[:, j] * D[:, i]
    gl, gv = np.minimum(rng.poisson(xl), 10), np.minimum(rng.poisson(xv), 10)   # app.js corta en 10
    pts, dg, gf = (np.repeat(v[None], SIMULACIONES, 0) for v in (p0, d0, g0))
    for k in range(len(R)):
        a, b = gl[:, k], gv[:, k]
        pts[:, i[k]] += np.where(a > b, 3, np.where(a == b, 1, 0))
        pts[:, j[k]] += np.where(b > a, 3, np.where(a == b, 1, 0))
        dg[:, i[k]] += a - b; dg[:, j[k]] += b - a; gf[:, i[k]] += a; gf[:, j[k]] += b
    pos = _puestos(pts, dg, gf)
    fp, fd, fg = _tabla(n, r["final"])
    real = _puestos(fp, fd, fg)
    zonas = {"campeón": (0, 0), "arriba": (0, 1 if r["liga"] == "ELC" else 3), "descenso": (n - BAJAN[r["liga"]], n - 1)}
    q10, q90 = np.percentile(pts, 10, axis=0), np.percentile(pts, 90, axis=0)
    return {"liga": r["liga"], "temp": r["temp"], "corte": r["corte"],
            "zonas": [(z, ((pos >= a) & (pos <= b)).mean(0), ((real >= a) & (real <= b)).astype(float))
                      for z, (a, b) in zonas.items()],
            "pts": (pts.mean(0), fp, ((fp >= q10) & (fp <= q90)).astype(float))}


def tabla(pool, lista):
    """La proyección de la tabla de la web, medida: cada temporada completa cortada al
    25, 50 y 75 % jugado, simulada desde ahí y comparada con cómo acabó (por puntos,
    diferencia y goles a favor: sin sanciones ni enfrentamientos directos, que los
    resultados no traen). Calibración de las zonas que enseña la web (campeón, top 4 o
    ascenso directo, descenso directo) y de los puntos, y la búsqueda de sigma (duda en
    la fuerza de cada equipo) en el ajuste, juzgada en la prueba por temporadas."""
    cortes = [r for rr in pool.map(cortes_temporada, [x for x in lista if x[1] <= 2025]) for r in rr]
    temporadas = sorted({(r["liga"], r["temp"]) for r in cortes})
    print(f"{len(temporadas)} temporadas completas, {len(cortes)} cortes")

    def por_temporada(res):
        d = defaultdict(lambda: np.zeros(3))
        for r in res:
            for _, p, y in r["zonas"]:
                pc = np.clip(p, 1 / (2 * SIMULACIONES), 1 - 1 / (2 * SIMULACIONES))
                d[(r["liga"], r["temp"])] += [((p - y) ** 2).sum(), -(y * np.log(pc) + (1 - y) * np.log(1 - pc)).sum(), len(p)]
        return d

    base = pool.map(simular_corte, [(r, 0.0) for r in cortes])
    P = np.concatenate([p for r in base for _, p, _ in r["zonas"]])
    Y = np.concatenate([y for r in base for _, _, y in r["zonas"]])
    Z = np.concatenate([[z] * len(p) for r in base for z, p, _ in r["zonas"]])
    print("\nCalibración de las zonas (todas las temporadas): lo que daba la web -> lo que pasó")
    for a, b in ((0, .01), (.01, .1), (.1, .3), (.3, .5), (.5, .7), (.7, .9), (.9, .99), (.99, 1.0001)):
        m = (P >= a) & (P < b)
        print(f"  {100 * a:3.0f}-{min(100, 100 * b):3.0f} %: {100 * P[m].mean():5.1f} -> {100 * Y[m].mean():5.1f}   ({m.sum()})")
    for z in ("campeón", "arriba", "descenso"):
        print(f"  {z:9s} " + "   ".join(f"{100 * a:.0f}-{100 * b:.0f} %: {100 * P[m].mean():.1f} -> {100 * Y[m].mean():.1f} ({m.sum()})"
                                     for a, b in ((.1, .3), (.3, .7), (.7, .9)) for m in [(Z == z) & (P >= a) & (P < b)]))
    print("Puntos al final (Proy.): error medio, sesgo y cuántos caen en el 10-90 % de las simulaciones")
    for c in CORTES:
        rr = [r for r in base if r["corte"] == c]
        media, real, dentro = (np.concatenate([r["pts"][k] for r in rr]) for k in range(3))
        print(f"  con el {100 * c:.0f} % jugado: {np.abs(media - real).mean():.1f} puntos, sesgo {np.mean(real - media):+.2f},"
              f" dentro {100 * dentro.mean():.0f} %")

    b0 = por_temporada(base)
    print("\nDuda en la fuerza de cada equipo (sigma) frente a ninguna: Brier y log loss de las zonas por equipo,"
          " test pareado por temporadas")
    for sigma in (0.03, 0.05, 0.08, 0.11, 0.15):
        bs = por_temporada(pool.map(simular_corte, [(r, sigma) for r in cortes]))
        partes = []
        for nombre, f in (("ajuste", lambda k: k[1] <= FIN_AJUSTE), ("prueba", lambda k: k[1] > FIN_AJUSTE)):
            ks = [k for k in temporadas if f(k)]
            for i, txt in ((0, "Brier"), (1, "log loss")):
                d = np.array([(bs[k][i] - b0[k][i]) / b0[k][2] for k in ks])
                partes.append(f"{nombre} {txt} {d.mean():+.5f} ({d.mean() / (d.std(ddof=1) / math.sqrt(len(d))):+.1f} se)")
        print(f"  sigma {sigma:.2f}: " + "   ".join(partes), flush=True)


def main():
    preparar()
    lista = casos()
    print(f"{len(lista)} temporadas evaluables: "
          + ", ".join(f"{c} {sum(1 for x in lista if x[0] == c)}" for c in FICHERO))
    with Pool(min(4, os.cpu_count() or 1)) as pool:
        if sys.argv[1:] == ["afinar"]:
            afinar(pool, lista)
            return
        if sys.argv[1:] == ["descensos"]:
            descensos(pool, lista)
            return
        if sys.argv[1:] == ["tabla"]:
            tabla(pool, lista)
            return
        nuevo, _, _ = evaluar(pool, lista)
        gemela, _, _ = _juntar(pool.map(_k, [(c, {}) for c in lista]))
    print(f"\nGemela incremental frente a app.py: diferencia máxima de goles esperados "
          f"{np.abs(np.round(gemela[:, :2], 2) - nuevo[:, :2]).max():.2f} en {len(nuevo)} partidos.")


if __name__ == "__main__":
    main()
