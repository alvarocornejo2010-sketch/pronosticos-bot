"""
Backtest walk-forward del modelo, ejecutado DENTRO de la app.

Por qué aquí y no en un script aparte: el token ya vive en Render, así que no hay
que copiarlo a ninguna terminal, y sobre todo se valida el modelo que está
realmente desplegado — `calcular_xg_partido` y `calcular_poisson` se importan de
`app`, no se reimplementan. Una copia del modelo en otro archivo se desincroniza
en cuanto tocas uno de los dos y entonces validas algo que no es lo que publicas.

Método: para cada liga se bajan dos temporadas. La anterior sirve de ancla y de
historial inicial; la última se recorre partido a partido prediciendo cada uno
SOLO con lo ocurrido antes. Es la misma situación que en producción.

Se dispara con /validar?token=... y el resultado queda en /api/validacion.
Cuesta 2 peticiones por liga, una sola vez: las temporadas terminadas no cambian.
"""
import json
import math
import os
import sys
from collections import defaultdict, deque


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
    ruta = os.path.join(cache_dir, f"{codigo_liga}_{season}.json")

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
    for m in resp.json().get("matches", []):
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
class _Historial:
    """Sabe responder 'qué se sabía justo antes de este partido'.

    Guarda por equipo los últimos MAX_PARTIDOS_EQUIPO partidos y de ahí saca las
    sumas por lado, igual que hace `obtener_stats_equipo` en producción: primero
    corta por los N más recientes y luego separa local de visitante.
    """

    def __init__(self, ventana):
        self.ventana = ventana
        self.equipos = defaultdict(lambda: deque(maxlen=ventana))
        self.gl = self.gv = self.n = 0

    def stats(self, team_id):
        s = {"gf_local": 0, "gc_local": 0, "n_local": 0,
             "gf_visita": 0, "gc_visita": 0, "n_visita": 0}
        for en_casa, gf, gc in self.equipos[team_id]:
            if en_casa:
                s["gf_local"] += gf; s["gc_local"] += gc; s["n_local"] += 1
            else:
                s["gf_visita"] += gf; s["gc_visita"] += gc; s["n_visita"] += 1
        return s

    def media_liga(self, ancla, k):
        return {"avg_local": (self.gl + k * ancla["avg_local"]) / (self.n + k),
                "avg_visita": (self.gv + k * ancla["avg_visita"]) / (self.n + k)}

    def registrar(self, m):
        self.equipos[m["local"]].append((True, m["gl"], m["gv"]))
        self.equipos[m["visita"]].append((False, m["gv"], m["gl"]))
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
        filas = []
        for b in sorted(self.bins):
            suma, ac, n = self.bins[b]
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

    hist = _Historial(app.MAX_PARTIDOS_EQUIPO)
    for m in previa:
        hist.registrar(m)   # historial de arranque, no se puntúa

    modelo = _Acumulador()
    base_liga = _Acumulador()
    base_frec = _Acumulador()
    conteo = [0, 0, 0]

    for m in ultima:
        y = _resultado(m)
        media = hist.media_liga(ancla, app.K_LIGA)

        # --- el modelo real, el mismo que publica la web ---
        xl, xv = app.calcular_xg_partido(hist.stats(m["local"]),
                                         hist.stats(m["visita"]), media)
        pr = app.calcular_poisson(xl, xv)
        modelo.add([pr["prob_local"] / 100, pr["prob_empate"] / 100, pr["prob_visita"] / 100], y)

        # --- base 1: dos equipos medios, ignora quién juega ---
        pb = app.calcular_poisson(round(media["avg_local"], 2), round(media["avg_visita"], 2))
        base_liga.add([pb["prob_local"] / 100, pb["prob_empate"] / 100, pb["prob_visita"] / 100], y)

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
        # la jornada 4 y no daría para nada.
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
            "hora": app.ahora().isoformat(),
            "resumen": {r["codigo"]: {
                "skill_score": r["skill_score"],
                "aporta_valor": r["aporta_valor"],
                "brier": r["modelo"]["brier"],
                "brier_base": r["base_equipo_medio"]["brier"],
            } for r in ok},
            "ligas": resultados,
        })
    except Exception as e:
        print(f"Validación: error {e}", file=sys.stderr)
        _escribir({"estado": "error", "error": str(e)})
    finally:
        validando_ahora = False
