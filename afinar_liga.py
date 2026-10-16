"""
Mide y afina el modelo de liga de app.py con resultados reales: las fuerzas
ajustadas por rival (ajustar_fuerzas: FACTOR_DIARIO, PSEUDO_GOLES_ATAQUE,
PSEUDO_GOLES_DEFENSA, ATAQUE_RECIEN_LLEGADO), la corrección de empates
(RHO_EMPATES) y el acercamiento de los mercados de goles (ENCOGER_GOLES).

Datos: openfootball/football.json en GitHub, gratis y sin token. Ocho ligas
(LaLiga, Premier, Bundesliga, Serie A, Ligue 1, Eredivisie, Primeira Liga y
Championship) desde 2010/11 las que más (Países Bajos y Portugal, desde
2018/19), unos 45.000 partidos; el Brasileirão solo tiene 2019, 2020, 2025 y
2026. Cada temporada se recorre como en producción (validacion.py): la anterior
hace de ancla e historial y cada partido se predice solo con lo jugado en días
anteriores.

Dos grupos de temporadas, para no elegir y juzgar con los mismos partidos:
  ajuste   2010/11 a 2020/21: aquí se eligen los parámetros.
  prueba   2021/22 en adelante: solo se mira el resultado.

Uso:
    python afinar_liga.py             # el modelo de app.py frente al anterior,
                                      # por liga y por temporada (~3 min)
    python afinar_liga.py afinar      # busca los parámetros en el grupo de
                                      # ajuste y los juzga en el de prueba

La evaluación usa las funciones de app.py (ajustar_fuerzas, calcular_poisson,
mercados_de_goles) y el recorrido de validacion.py, no una copia. La búsqueda
usa una gemela en numpy del mismo ajuste (_fuerzas_np), mil veces más rápida;
al final comprueba que da lo mismo que app.py.

Ojo con los nombres: openfootball cambió su forma de escribirlos en 2020/21
(las cinco grandes y la Championship: "Arsenal" pasó a "Arsenal FC") y en
2023/24 (Francia, Países Bajos y Portugal: "PSV Eindhoven" pasó a "PSV"). Sin
casarlos (mapa_nombres), media liga contaría como recién ascendida esas
temporadas. Y los 0-0 vienen como [0, 0] en vez de {"ft": [0, 0]}.

Descarga ~120 ficheros la primera vez (12 MB) y los guarda en openfootball_cache/.
"""
import json
import math
import os
import re
import sys
import unicodedata
from collections import defaultdict
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


def cargar(codigo, season):
    """Los partidos de una temporada con los nombres casados entre temporadas."""
    p = _crudos(codigo, season)
    if p is None:
        return None
    mp = mapa_nombres(codigo)
    return [dict(m, local=mp.get(m["local"], m["local"]), visita=mp.get(m["visita"], m["visita"])) for m in p]


def casos():
    """(liga, temporada evaluada) con la anterior disponible."""
    out = []
    for c in FICHERO:
        ss = set(temporadas(c))
        out += [(c, s) for s in sorted(ss) if s - 1 in ss and len(cargar(c, s - 1)) >= 100]
    return out


def _ancla(previa):
    n = len(previa)
    return {"avg_local": sum(m["gl"] for m in previa) / n, "avg_visita": sum(m["gv"] for m in previa) / n}


# ------------------------------------------------------------------
# Recorridos: cada partido con lo de antes, como validacion.py
# ------------------------------------------------------------------
def recorrer_app(caso):
    """El modelo de app.py: [xg_local, xg_visita, media local, media visita,
    goles local, goles visita] por partido, con el recorrido de validacion.py."""
    c, s = caso
    previa, ultima = cargar(c, s - 1), cargar(c, s)
    hist = validacion._Historial(previa, _ancla(previa), app.K_LIGA)
    filas = []
    for m in ultima:
        fz, media = hist.antes_de(m)
        xl, xv = app.calcular_xg_partido(app.fuerza_equipo(fz, m["local"]),
                                         app.fuerza_equipo(fz, m["visita"]), media)
        filas.append([xl, xv, media["avg_local"], media["avg_visita"], m["gl"], m["gv"]])
        hist.registrar(m)
    return c, s, np.array(filas, dtype=float)


def recorrer_anterior(caso):
    """El modelo de la app hasta oct 2026, para compararlo: los últimos 20
    partidos de cada equipo, en casa y fuera por separado, encogidos hacia la
    media de la liga con 6 partidos de pseudo-cuenta y sin mirar al rival. Es
    una copia a propósito: app.py ya no lo tiene."""
    c, s = caso
    previa, ultima = cargar(c, s - 1), cargar(c, s)
    ancla, k_liga, pseudo, ventana = _ancla(previa), app.K_LIGA, 6, 20
    eq = defaultdict(list)
    for m in previa:
        eq[m["local"]].append((True, m["gl"], m["gv"])); eq[m["visita"]].append((False, m["gv"], m["gl"]))
    gl = gv = n = 0
    filas = []
    enc = lambda t, k, p: (t + pseudo * p) / (k + pseudo)   # noqa: E731
    for m in ultima:
        ml = (gl + k_liga * ancla["avg_local"]) / (n + k_liga)
        mv = (gv + k_liga * ancla["avg_visita"]) / (n + k_liga)
        def lado(t, casa):
            g = [0, 0, 0]
            for en_casa, f, cc in eq[t][-ventana:]:
                if en_casa == casa:
                    g[0] += f; g[1] += cc; g[2] += 1
            return g
        L, V = lado(m["local"], True), lado(m["visita"], False)
        xl = enc(L[0], L[2], ml) / ml * enc(V[1], V[2], ml) / ml * ml
        xv = enc(V[0], V[2], mv) / mv * enc(L[1], L[2], mv) / mv * mv
        filas.append([round(xl, 2), round(xv, 2), ml, mv, m["gl"], m["gv"]])
        eq[m["local"]].append((True, m["gl"], m["gv"])); eq[m["visita"]].append((False, m["gv"], m["gl"]))
        gl += m["gl"]; gv += m["gv"]; n += 1
    return c, s, np.array(filas, dtype=float)


def _fuerzas_np(caso, factor, k_at, k_de, a0):
    """Gemela en numpy de ajustar_fuerzas + el recorrido de validacion.py, para
    buscar parámetros deprisa. Mismo algoritmo; no el mismo orden de sumas, así
    que difiere en el último decimal (lo mide main al final)."""
    c, s = caso
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
    p_at = np.where(previos, 1.0, a0)
    at, de = p_at.copy(), np.ones(T)
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
        gc = np.bincount(h, w * ga, T) + np.bincount(a, w * gh, T) + k_de
        for _ in range(app.MAX_ITER_FUERZAS):
            at_n = gf / (np.bincount(h, w * ml * de[a], T) + np.bincount(a, w * mv * de[h], T) + k_at)
            de_n = gc / (np.bincount(h, w * mv * at_n[a], T) + np.bincount(a, w * ml * at_n[h], T) + k_de)
            cambio = max(np.abs(at_n - at).max(), np.abs(de_n - de).max())
            at, de = at_n, de_n
            if cambio < app.TOLERANCIA_FUERZAS:
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


def rejillas(lh, la, rho):
    """Rejillas de marcadores normalizadas, con la corrección de Dixon-Coles."""
    r = poisson.pmf(G[None, :], lh[:, None])[:, :, None] * poisson.pmf(G[None, :], la[:, None])[:, None, :]
    r[:, 0, 0] *= 1 - lh * la * rho
    r[:, 0, 1] *= 1 + lh * rho
    r[:, 1, 0] *= 1 + la * rho
    r[:, 1, 1] *= 1 - rho
    return r / r.sum(axis=(1, 2), keepdims=True)


def puntuar(f, rho, alfa):
    """Brier por partido del 1X2, de más de 2.5 y de ambos marcan, del modelo y
    de la base "equipo medio" (la media de la liga para los dos)."""
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
    lh = f[:, 2] * (f[:, 0] / f[:, 2]) ** alfa
    la = f[:, 3] * (f[:, 1] / f[:, 3]) ** alfa
    out["mas_25"], out["ambos"] = goles(rejillas(lh, la, rho))
    out["mas_25_base"], out["ambos_base"] = goles(rejillas(f[:, 2], f[:, 3], rho))
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
    viejo, _, _ = _juntar(pool.map(recorrer_anterior, lista))
    pn = puntuar(nuevo, app.RHO_EMPATES, app.ENCOGER_GOLES)
    pv = puntuar(viejo, 0.0, 0.3)          # el modelo anterior, con su Poisson sin corregir
    grupos = [("ajuste (hasta 2020/21)", temp <= FIN_AJUSTE), ("prueba (2021/22-2025/26)", (temp > FIN_AJUSTE) & (temp <= 2025)),
              ("2026/27 en curso", temp >= 2026)]
    print("\n1X2: skill frente a la base 'equipo medio' y diferencia de Brier con el modelo anterior")
    for nombre, m in grupos:
        if not m.any():
            continue
        d, se = pareado(pn["1x2"][m], pv["1x2"][m])
        dl, sel = pareado(pn["logloss"][m], pv["logloss"][m])
        print(f"  {nombre:26s} {m.sum():6d} partidos   anterior {skill(pv['1x2'][m], pv['1x2_base'][m]):+5.1f}%   "
              f"app.py {skill(pn['1x2'][m], pn['1x2_base'][m]):+5.1f}%   Brier {d:+.4f} ± {se:.4f} ({d / se:+.1f} se)"
              f"   LogLoss {dl:+.4f} ({dl / sel:+.1f} se)")
    prueba = temp > FIN_AJUSTE
    print("\nPor liga (prueba, 2021/22 en adelante): skill del 1X2, anterior -> app.py")
    for c in FICHERO:
        m = prueba & (liga == c)
        if m.any():
            d, se = pareado(pn["1x2"][m], pv["1x2"][m])
            print(f"  {c:4s} {m.sum():5d} partidos  {skill(pv['1x2'][m], pv['1x2_base'][m]):+5.1f}% -> "
                  f"{skill(pn['1x2'][m], pn['1x2_base'][m]):+5.1f}%   ({d / se:+.1f} se)")
    print("\nPor temporada: skill del 1X2, anterior -> app.py")
    for s in sorted(set(temp.tolist())):
        m = temp == s
        d, se = pareado(pn["1x2"][m], pv["1x2"][m])
        print(f"  {s}/{(s + 1) % 100:02d} {m.sum():5d} partidos  {skill(pv['1x2'][m], pv['1x2_base'][m]):+5.1f}% -> "
              f"{skill(pn['1x2'][m], pn['1x2_base'][m]):+5.1f}%   ({d / se:+.1f} se)")
    print("\nMercados de goles (prueba): skill frente a la base, anterior -> app.py")
    for k, txt in (("mas_25", "más de 2.5"), ("ambos", "ambos marcan")):
        print(f"  {txt:13s} {skill(pv[k][prueba], pv[k + '_base'][prueba]):+5.2f}% -> "
              f"{skill(pn[k][prueba], pn[k + '_base'][prueba]):+5.2f}%")
    print(f"\nEmpates (prueba): app.py predice {100 * pn['empate_pred'][prueba].mean():.1f}%, "
          f"hubo {100 * pn['empate_real'][prueba].mean():.1f}%")
    return nuevo, liga, temp


def afinar(pool, lista):
    """Búsqueda por coordenadas en el grupo de ajuste, con la gemela en numpy."""
    ajuste = [x for x in lista if x[1] <= FIN_AJUSTE]
    rejilla = {"factor": [1.0, 0.999, 0.9985, 0.998, 0.9975, 0.997, 0.996],
               "k_at": [2, 4, 6, 8, 11, 15], "k_de": [4, 6, 8, 11, 15, 20],
               "a0": [0.7, 0.75, 0.8, 0.85, 0.9, 1.0]}
    mejor = {"factor": app.FACTOR_DIARIO, "k_at": app.PSEUDO_GOLES_ATAQUE,
             "k_de": app.PSEUDO_GOLES_DEFENSA, "a0": app.ATAQUE_RECIEN_LLEGADO}
    memo = {}

    def coste(p):
        clave = tuple(p[k] for k in rejilla)
        if clave not in memo:
            f, _, _ = _juntar(pool.map(_np, [(c, clave) for c in ajuste]))
            memo[clave] = puntuar(f, app.RHO_EMPATES, app.ENCOGER_GOLES)["1x2"].mean()
        return memo[clave]

    print(f"Búsqueda en {len(ajuste)} temporadas de ajuste (Brier del 1X2):")
    for ronda in range(3):
        cambio = False
        for k, vals in rejilla.items():
            res = [(coste(dict(mejor, **{k: v})), v) for v in vals]
            b, v = min(res)
            cambio |= v != mejor[k]
            mejor[k] = v
            print(f"  {k:7s} " + "  ".join(f"{vv}:{bb:.5f}" for bb, vv in res) + f"   -> {v}", flush=True)
        if not cambio:
            break
    print("mejor:", mejor)
    clave = tuple(mejor[k] for k in rejilla)
    f, _, temp = _juntar(pool.map(_np, [(c, clave) for c in lista]))
    print("\nCon esas fuerzas, corrección de empates y mercados de goles (Brier; ajuste | prueba):")
    aj, pr = temp <= FIN_AJUSTE, temp > FIN_AJUSTE
    for rho in (0.0, -0.03, -0.05, -0.08, -0.12):
        p = puntuar(f, rho, app.ENCOGER_GOLES)
        print(f"  RHO_EMPATES {rho:+.2f}: 1X2 {p['1x2'][aj].mean():.5f} | {p['1x2'][pr].mean():.5f}"
              f"   empates {100 * p['empate_pred'][aj].mean():.1f}% (hubo {100 * p['empate_real'][aj].mean():.1f}%)")
    for alfa in (0.3, 0.4, 0.5, 0.6, 0.7, 1.0):
        p = puntuar(f, app.RHO_EMPATES, alfa)
        print(f"  ENCOGER_GOLES {alfa}: más de 2.5 {skill(p['mas_25'][aj], p['mas_25_base'][aj]):+.2f}% | "
              f"{skill(p['mas_25'][pr], p['mas_25_base'][pr]):+.2f}%   ambos marcan "
              f"{skill(p['ambos'][aj], p['ambos_base'][aj]):+.2f}% | {skill(p['ambos'][pr], p['ambos_base'][pr]):+.2f}%")


def main():
    lista = casos()
    print(f"{len(lista)} temporadas evaluables: "
          + ", ".join(f"{c} {sum(1 for x in lista if x[0] == c)}" for c in FICHERO))
    with Pool(min(4, os.cpu_count() or 1)) as pool:
        if sys.argv[1:] == ["afinar"]:
            afinar(pool, lista)
            return
        nuevo, _, _ = evaluar(pool, lista)
        clave = (app.FACTOR_DIARIO, app.PSEUDO_GOLES_ATAQUE, app.PSEUDO_GOLES_DEFENSA, app.ATAQUE_RECIEN_LLEGADO)
        gemela, _, _ = _juntar(pool.map(_np, [(c, clave) for c in lista]))
    print(f"\nGemela en numpy frente a app.py: diferencia máxima de goles esperados "
          f"{np.abs(np.round(gemela[:, :2], 2) - nuevo[:, :2]).max():.2f} en {len(nuevo)} partidos.")


if __name__ == "__main__":
    main()
