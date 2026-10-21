"""
Backtest walk-forward del modelo, ejecutado DENTRO de la app.

Por qué aquí y no en un script aparte: el token ya vive en Render, así que no hay
que copiarlo a ninguna terminal, y sobre todo se valida el modelo que está
realmente desplegado — `calcular_xg_partido` y `calcular_poisson` se importan de
`app`, no se reimplementan. Una copia del modelo en otro archivo se desincroniza
en cuanto tocas uno de los dos y entonces validas algo que no es lo que publicas.

Método: para cada liga se bajan dos temporadas. La anterior sirve de ancla y de
historial inicial; la última se recorre día a día prediciendo cada partido SOLO
con lo ocurrido en días anteriores: las fuerzas de ajustar_fuerzas con la
temporada anterior y lo ya jugado de esta, y la media de la temporada en curso
anclada en la anterior. Es la misma situación que en producción.

Además del 1X2 mide dos mercados de goles, más de 2.5 y ambos marcan, con la
misma función que publica la web (`mercados_de_goles`) y contra la misma base
"equipo medio". No cuesta ni una petición más: salen de los mismos resultados.

Se dispara con /validar?token=... y el resultado queda en /api/validacion.
Cuesta 2 peticiones por liga, una sola vez: las temporadas terminadas no cambian.
"""
import json
import math
import os
import sys
from collections import defaultdict


def _rutas():
    import app
    base = app.DATA_DIR
    return (os.path.join(base, "validacion.json"),
            os.path.join(base, "validacion_cache"))


# ==========================================
# DESCARGA (cacheada en disco)
# ==========================================
def _cargar_temporada(codigo_liga, season):
    import app
    _, cache_dir = _rutas()
    os.makedirs(cache_dir, exist_ok=True)
    # _liga: desde oct 2026 sin playoffs (app.solo_liga); las de antes se bajan otra vez
    ruta = os.path.join(cache_dir, f"{codigo_liga}_{season}_liga.json")

    if os.path.exists(ruta):
        try:
            with open(ruta) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass   # archivo corrupto: se vuelve a pedir

    resp = app.get_con_pausa(f"{app.BASE_URL}/competitions/{codigo_liga}/matches",
                             {"season": season, "status": "FINISHED"})
    if resp.status_code != 200:
        print(f"Validación {codigo_liga} {season}: HTTP {resp.status_code}", file=sys.stderr)
        return []

    limpios = []
    for m in app.solo_liga(resp.json().get("matches", [])):
        ft = m.get("score", {}).get("fullTime", {})
        if ft.get("home") is None or ft.get("away") is None:
            continue
        limpios.append({"fecha": m["utcDate"],
                        "local": m["homeTeam"]["id"], "visita": m["awayTeam"]["id"],
                        "gl": ft["home"], "gv": ft["away"]})
    limpios.sort(key=lambda x: x["fecha"])
    with open(ruta, "w") as f:
        json.dump(limpios, f)
    return limpios


# ==========================================
# ESTADO INCREMENTAL
# ==========================================
def _compacto(m):
    import app
    return [app.dia_de(m["fecha"]), m["local"], m["visita"], m["gl"], m["gv"]]


class _Historial:
    """Sabe responder 'qué se sabía justo antes de este partido': las fuerzas
    de todos los equipos (ajustar_fuerzas, como obtener_fuerzas_liga en
    producción) y la media de la temporada en curso anclada en la anterior
    (como obtener_promedio_liga). Se recalculan al cambiar de día, así que los
    partidos de un mismo día no se ven entre sí; el ajuste de cada día arranca
    del anterior, que solo lo hace converger antes."""

    def __init__(self, previa, ancla, k, codigo_liga=None, de_arriba=()):
        self.previa = [_compacto(m) for m in previa]
        self.actual = []
        self.ancla, self.k = ancla, k
        self.codigo_liga, self.de_arriba = codigo_liga, list(de_arriba)
        self.gl = self.gv = self.n = 0
        self.dia = None
        self.fuerzas = None
        self.media = None

    def antes_de(self, m):
        """(fuerzas, media) con todo lo jugado antes del día de m."""
        import app
        dia = app.dia_de(m["fecha"])
        if dia != self.dia:
            k = self.k
            self.media = {"avg_local": (self.gl + k * self.ancla["avg_local"]) / (self.n + k),
                          "avg_visita": (self.gv + k * self.ancla["avg_visita"]) / (self.n + k)}
            self.fuerzas = app.ajustar_fuerzas(self.previa, self.actual, self.media,
                                               inicio=self.fuerzas["equipos"] if self.fuerzas else None,
                                               codigo_liga=self.codigo_liga, de_arriba=self.de_arriba)
            self.dia = dia
        return self.fuerzas, self.media

    def registrar(self, m):
        self.actual.append(_compacto(m))
        self.gl += m["gl"]; self.gv += m["gv"]; self.n += 1


# ==========================================
# MÉTRICAS
# ==========================================
def _resultado(m):
    if m["gl"] > m["gv"]: return 0
    if m["gl"] == m["gv"]: return 1
    return 2


def _brier(p, y):
    return sum((p[i] - (1 if i == y else 0)) ** 2 for i in range(3))


def _logloss(p, y):
    return -math.log(max(p[y], 1e-15))


class _Acumulador:
    def __init__(self):
        self.b = []; self.l = []; self.aciertos = 0; self.n = 0
        self.bins = defaultdict(lambda: [0.0, 0, 0])

    def add(self, p, y):
        self.b.append(_brier(p, y)); self.l.append(_logloss(p, y))
        self.aciertos += (max(range(3), key=lambda i: p[i]) == y)
        self.n += 1
        for i, v in enumerate(p):
            b = self.bins[min(int(v * 10), 9)]
            b[0] += v; b[1] += (1 if i == y else 0); b[2] += 1

    def resumen(self):
        if not self.n:
            return None
        return {"brier": round(sum(self.b) / self.n, 4),
                "logloss": round(sum(self.l) / self.n, 4),
                "acierto": round(100 * self.aciertos / self.n, 1),
                "n": self.n}

    def calibracion(self, minimo=25):
        return _calibracion(self.bins, minimo)


class _Binario:
    """Lo mismo que _Acumulador para un mercado de sí o no (más de 2.5, ambos
    marcan). Guarda además la media predicha y la frecuencia real: si el modelo
    se equivoca de forma sistemática en un mercado, ahí se ve antes que en el Brier."""

    def __init__(self):
        self.b = []; self.l = []; self.aciertos = 0; self.n = 0
        self.suma_p = 0.0; self.si = 0
        self.bins = defaultdict(lambda: [0.0, 0, 0])

    def add(self, p, y):
        self.b.append((p - y) ** 2)
        self.l.append(-math.log(max(p if y else 1 - p, 1e-15)))
        self.aciertos += ((p >= 0.5) == bool(y))
        self.n += 1; self.suma_p += p; self.si += y
        b = self.bins[min(int(p * 10), 9)]
        b[0] += p; b[1] += y; b[2] += 1

    def resumen(self):
        if not self.n:
            return None
        return {"brier": round(sum(self.b) / self.n, 4),
                "logloss": round(sum(self.l) / self.n, 4),
                "acierto": round(100 * self.aciertos / self.n, 1),
                "predicho": round(100 * self.suma_p / self.n, 1),
                "real": round(100 * self.si / self.n, 1),
                "n": self.n}

    def calibracion(self, minimo=25):
        return _calibracion(self.bins, minimo)


def _calibracion(bins, minimo):
    filas = []
    for b in sorted(bins):
        suma, ac, n = bins[b]
        if n < minimo:
            continue
        pred, real = 100 * suma / n, 100 * ac / n
        se = 100 * math.sqrt(max(pred / 100 * (1 - pred / 100), 1e-9) / n)
        filas.append({"rango": f"{b*10}-{b*10+10}%", "casos": n,
                      "predicho": round(pred, 1), "real": round(real, 1),
                      "desvio": round(real - pred, 1),
                      "se": round(se, 1),
                      "significativo": bool(abs(real - pred) > 2 * se)})
    return filas


# Mercados de goles que se validan además del 1X2: clave de mercados_de_goles y
# qué cuenta como "sí" con el marcador real.
MERCADOS = {
    "mas_25": ("prob_mas_25", lambda m: m["gl"] + m["gv"] > 2.5),
    "ambos":  ("prob_ambos",  lambda m: m["gl"] > 0 and m["gv"] > 0),
}


def _resumen_mercado(modelo, base):
    m_res, b_res = modelo.resumen(), base.resumen()
    skill = round(100 * (1 - m_res["brier"] / b_res["brier"]), 1)
    return {"modelo": m_res, "base_equipo_medio": b_res, "skill_score": skill,
            "aporta_valor": bool(skill > 0 and m_res["logloss"] < b_res["logloss"]),
            "calibracion": modelo.calibracion()}


# ==========================================
# VALIDACIÓN DE UNA LIGA
# ==========================================
def validar_liga(codigo_liga, nombre, season):
    import app

    previa = _cargar_temporada(codigo_liga, season - 1)
    ultima = _cargar_temporada(codigo_liga, season)
    if len(ultima) < 100:
        return {"liga": nombre, "error": f"temporada {season} no disponible "
                                         f"({len(ultima)} partidos)"}

    # El ancla es la media de la temporada anterior, igual que en producción.
    if len(previa) >= 100:
        gl = sum(m["gl"] for m in previa); gv = sum(m["gv"] for m in previa)
        ancla = {"avg_local": gl / len(previa), "avg_visita": gv / len(previa),
                 "origen": f"temporada {season-1}"}
    else:
        ancla = {"avg_local": app.PRIOR_AVG_LOCAL, "avg_visita": app.PRIOR_AVG_VISITA,
                 "origen": "constante de respaldo"}

    # los que bajan de la liga de arriba parten de su propia fuerza (LIGA_DE_ARRIBA):
    # su temporada anterior ya la bajó la validación de esa liga, que va antes
    de_arriba = []
    if codigo_liga in app.LIGA_DE_ARRIBA:
        sup = _cargar_temporada(app.LIGA_DE_ARRIBA[codigo_liga], season - 1)
        de_arriba = [t for m in sup for t in (m["local"], m["visita"])]

    # la temporada anterior entra en las fuerzas, no se puntúa
    hist = _Historial(previa if len(previa) >= 100 else [], ancla, app.K_LIGA,
                      codigo_liga=codigo_liga, de_arriba=de_arriba)

    modelo = _Acumulador()
    base_liga = _Acumulador()
    base_frec = _Acumulador()
    conteo = [0, 0, 0]
    mercados = {k: (_Binario(), _Binario()) for k in MERCADOS}

    for m in ultima:
        y = _resultado(m)
        fuerzas, media = hist.antes_de(m)

        # --- el modelo real, el mismo que publica la web ---
        xl, xv = app.calcular_xg_partido(app.fuerza_equipo(fuerzas, m["local"]),
                                         app.fuerza_equipo(fuerzas, m["visita"]), media)
        pr = app.calcular_poisson(xl, xv)
        modelo.add([pr["prob_local"] / 100, pr["prob_empate"] / 100, pr["prob_visita"] / 100], y)

        # --- base 1: dos equipos medios, ignora quién juega ---
        pb = app.calcular_poisson(round(media["avg_local"], 2), round(media["avg_visita"], 2))
        base_liga.add([pb["prob_local"] / 100, pb["prob_empate"] / 100, pb["prob_visita"] / 100], y)

        # --- mercados de goles: los mismos números que publica la web ---
        gm = app.mercados_de_goles(xl, xv, media)
        gb = app.mercados_de_goles(media["avg_local"], media["avg_visita"], media)
        for k, (clave, ocurre) in MERCADOS.items():
            si = 1 if ocurre(m) else 0
            mercados[k][0].add(gm[clave] / 100, si)
            mercados[k][1].add(gb[clave] / 100, si)

        # --- base 2: la frecuencia observada hasta ahora ---
        t = sum(conteo)
        base_frec.add([c / t for c in conteo] if t > 30 else [0.45, 0.26, 0.29], y)

        conteo[y] += 1
        hist.registrar(m)

    t = sum(conteo) or 1
    m_res, b_res = modelo.resumen(), base_liga.resumen()
    # skill score: cuánto Brier le quita a la base. 0 = no aporta nada.
    skill = round(100 * (1 - m_res["brier"] / b_res["brier"]), 1)

    return {
        "liga": nombre,
        "codigo": codigo_liga,
        "temporada_evaluada": season,
        "ancla": ancla["origen"],
        "partidos": m_res["n"],
        "modelo": m_res,
        "base_equipo_medio": b_res,
        "base_frecuencia": base_frec.resumen(),
        "skill_score": skill,
        "aporta_valor": bool(skill > 0 and m_res["logloss"] < b_res["logloss"]),
        "reparto_real": {"1": round(100 * conteo[0] / t, 1),
                         "X": round(100 * conteo[1] / t, 1),
                         "2": round(100 * conteo[2] / t, 1)},
        "calibracion": modelo.calibracion(),
        "mercados": {k: _resumen_mercado(mod, base) for k, (mod, base) in mercados.items()},
    }


# ==========================================
# ORQUESTACIÓN
# ==========================================
validando_ahora = False


def leer_resultado():
    archivo, _ = _rutas()
    if os.path.exists(archivo):
        try:
            with open(archivo) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"estado": "sin_ejecutar",
            "nota": "Lanza /validar?token=... para calcularlo."}


def _escribir(d):
    archivo, _ = _rutas()
    with open(archivo, "w") as f:
        json.dump(d, f, indent=2)


def correr_validacion(season=None):
    global validando_ahora
    import app
    if validando_ahora:
        return
    validando_ahora = True
    try:
        # La temporada evaluada por defecto es la última terminada: la actual va por
        # la jornada 4 y no daría para nada. Va con el calendario europeo para todas;
        # al Brasileirão (año natural) también le toca una temporada terminada, solo
        # que entre enero y junio es la penúltima en vez de la última.
        if season is None:
            season = app.temporada_actual() - 1

        _escribir({"estado": "calculando", "iniciado": app.ahora().isoformat(),
                   "temporada": season, "ligas": {}})

        resultados = {}
        for nombre, codigo in app.LIGAS.items():
            try:
                resultados[codigo] = validar_liga(codigo, nombre, season)
            except Exception as e:
                resultados[codigo] = {"liga": nombre, "error": str(e)}
            _escribir({"estado": "calculando", "temporada": season,
                       "ligas": resultados, "hora": app.ahora().isoformat()})

        ok = [r for r in resultados.values() if not r.get("error")]
        _escribir({
            "estado": "listo",
            "temporada": season,
            "version_modelo": app.VERSION_MODELO,
            "hora": app.ahora().isoformat(),
            "resumen": {r["codigo"]: {
                "skill_score": r["skill_score"],
                "aporta_valor": r["aporta_valor"],
                "brier": r["modelo"]["brier"],
                "brier_base": r["base_equipo_medio"]["brier"],
                "mercados": {k: {"skill_score": v["skill_score"],
                                 "aporta_valor": v["aporta_valor"]}
                             for k, v in r["mercados"].items()},
            } for r in ok},
            "ligas": resultados,
        })
    except Exception as e:
        print(f"Validación: error {e}", file=sys.stderr)
        # se cuentan los intentos: si algo falla siempre, no queremos que el
        # planificador lo reintente indefinidamente gastando cuota
        previos = leer_resultado().get("intentos", 0)
        _escribir({"estado": "error", "error": str(e), "intentos": previos + 1,
                   "version_modelo": app.VERSION_MODELO})
    finally:
        validando_ahora = False
