"""
Backtest del modelo de pronósticos.

Reproduce el modelo de app.py sobre jornadas YA JUGADAS, usando en cada partido
solo la información que existía antes de ese partido (walk-forward, sin fugas de
información del futuro), y mide si las probabilidades están bien calibradas.

Uso:
    export FOOTBALL_DATA_TOKEN=tu_token
    python backtest.py                 # temporadas por defecto
    python backtest.py 2023 2024 2025  # temporadas concretas

Las temporadas se descargan una sola vez y quedan en backtest_cache/.
Ojo con el plan free de football-data.org: 10 requests/minuto y acceso limitado
a temporadas pasadas. Cada temporada es 1 request.
"""
import os
import sys
import json
import math
import time
from collections import defaultdict, deque
from datetime import datetime

import requests

# Importamos el modelo REAL desde app.py para no testear una copia que se
# desincroniza. app.py exige estas variables al arrancar.
os.environ.setdefault("UPDATE_SECRET", "backtest_dummy_secret")
if not os.environ.get("FOOTBALL_DATA_TOKEN"):
    sys.exit("Falta FOOTBALL_DATA_TOKEN. export FOOTBALL_DATA_TOKEN=tu_token")

import app  # noqa: E402

LIGA = os.environ.get("LIGA_BACKTEST", "PD")
TEMPORADAS = [int(a) for a in sys.argv[1:]] or [2023, 2024]
BURN_IN = 40          # partidos iniciales de cada temporada que no se puntúan
                      # (con la liga recién empezada no hay nada que predecir)
CACHE_DIR = "backtest_cache"
BASE_URL = "https://api.football-data.org/v4"


# ==========================================
# DESCARGA
# ==========================================
def descargar_temporada(season):
    os.makedirs(CACHE_DIR, exist_ok=True)
    ruta = os.path.join(CACHE_DIR, f"{LIGA}_{season}.json")
    if os.path.exists(ruta):
        with open(ruta) as f:
            return json.load(f)

    print(f"Descargando {LIGA} {season}...")
    resp = requests.get(
        f"{BASE_URL}/competitions/{LIGA}/matches",
        headers={"X-Auth-Token": os.environ["FOOTBALL_DATA_TOKEN"]},
        params={"season": season, "status": "FINISHED"},
        timeout=30,
    )
    if resp.status_code != 200:
        print(f"  HTTP {resp.status_code}: {resp.text[:200]}")
        return []
    partidos = resp.json().get("matches", [])
    with open(ruta, "w") as f:
        json.dump(partidos, f)
    time.sleep(6.5)  # respeta el límite del plan free
    return partidos


def cargar_partidos():
    todos = []
    for s in TEMPORADAS:
        todos.extend(descargar_temporada(s))
    limpios = []
    for m in todos:
        ft = m.get("score", {}).get("fullTime", {})
        if ft.get("home") is None or ft.get("away") is None:
            continue
        limpios.append({
            "fecha": m["utcDate"],
            "local_id": m["homeTeam"]["id"],
            "visita_id": m["awayTeam"]["id"],
            "local": m["homeTeam"]["name"],
            "visita": m["awayTeam"]["name"],
            "gl": ft["home"],
            "gv": ft["away"],
        })
    limpios.sort(key=lambda m: m["fecha"])
    return limpios


# ==========================================
# ESTADO INCREMENTAL (solo pasado)
# ==========================================
class EstadoLiga:
    """Va acumulando resultados y sabe responder 'qué se sabía antes de este partido'."""

    def __init__(self, ventana=app.MAX_PARTIDOS_EQUIPO):
        self.ventana = ventana
        self.casa = defaultdict(lambda: deque())    # team_id -> [(gf, gc), ...] recientes en casa
        self.fuera = defaultdict(lambda: deque())
        self.gl_total = 0
        self.gv_total = 0
        self.n_total = 0

    def promedio_liga(self):
        k, pl, pv = app.K_LIGA, app.PRIOR_AVG_LOCAL, app.PRIOR_AVG_VISITA
        return {
            "avg_local": (self.gl_total + k * pl) / (self.n_total + k),
            "avg_visita": (self.gv_total + k * pv) / (self.n_total + k),
        }

    def stats(self, team_id):
        # La ventana de app.py es de N partidos TOTALES; aquí se aproxima con
        # los N/2 más recientes de cada lado, que es el mismo espíritu.
        mitad = max(1, self.ventana // 2)
        c = list(self.casa[team_id])[-mitad:]
        f = list(self.fuera[team_id])[-mitad:]
        return {
            "gf_local": sum(x[0] for x in c), "gc_local": sum(x[1] for x in c), "n_local": len(c),
            "gf_visita": sum(x[0] for x in f), "gc_visita": sum(x[1] for x in f), "n_visita": len(f),
        }

    def registrar(self, m):
        self.casa[m["local_id"]].append((m["gl"], m["gv"]))
        self.fuera[m["visita_id"]].append((m["gv"], m["gl"]))
        self.gl_total += m["gl"]
        self.gv_total += m["gv"]
        self.n_total += 1


# ==========================================
# FÓRMULA ANTIGUA (la que tenía el bug), para comparar
# ==========================================
def xg_formula_vieja(sl, sv, p):
    def media(total, n, defecto=1.3):
        return total / n if n else defecto
    for_local = media(sl["gf_local"], sl["n_local"])
    against_local = media(sl["gc_local"], sl["n_local"])
    for_visita = media(sv["gf_visita"], sv["n_visita"])
    against_visita = media(sv["gc_visita"], sv["n_visita"])
    xl = (for_local / p["avg_local"]) * (against_visita / p["avg_visita"]) * p["avg_local"]
    xv = (for_visita / p["avg_visita"]) * (against_local / p["avg_local"]) * p["avg_visita"]
    return round(xl, 2), round(xv, 2)


# ==========================================
# MÉTRICAS
# ==========================================
def resultado(m):
    if m["gl"] > m["gv"]: return 0
    if m["gl"] == m["gv"]: return 1
    return 2


def brier(probs, y):
    """Brier multiclase: 0 = perfecto, 2 = máximamente equivocado. Azar 3 vías ~0.66."""
    return sum((p - (1 if i == y else 0)) ** 2 for i, p in enumerate(probs))


def logloss(probs, y):
    return -math.log(max(probs[y], 1e-15))


class Acumulador:
    def __init__(self, nombre):
        self.nombre = nombre
        self.brier = []
        self.logloss = []
        self.aciertos = 0
        self.n = 0
        # bin (decil de probabilidad) -> [suma_predicha, aciertos_reales, casos]
        self.bins = defaultdict(lambda: [0.0, 0, 0])

    def add(self, probs, y):
        self.brier.append(brier(probs, y))
        self.logloss.append(logloss(probs, y))
        self.aciertos += (max(range(3), key=lambda i: probs[i]) == y)
        self.n += 1
        for i, p in enumerate(probs):
            b = self.bins[min(int(p * 10), 9)]
            b[0] += p
            b[1] += (1 if i == y else 0)
            b[2] += 1

    def resumen(self):
        if not self.n:
            return f"{self.nombre}: sin datos"
        return (f"{self.nombre:28s} Brier {sum(self.brier)/self.n:.4f}   "
                f"LogLoss {sum(self.logloss)/self.n:.4f}   "
                f"Acierto {100*self.aciertos/self.n:5.1f}%")

    def tabla_calibracion(self, minimo=10):
        filas = []
        for b in sorted(self.bins):
            suma, aciertos, n = self.bins[b]
            if n < minimo:
                continue
            filas.append((f"{b*10}-{b*10+10}%", n, 100 * suma / n, 100 * aciertos / n))
        return filas


def main():
    partidos = cargar_partidos()
    if not partidos:
        sys.exit("No se descargó ningún partido. Revisa el token y si tu plan cubre esas temporadas.")

    print(f"\n{len(partidos)} partidos cargados ({LIGA}, temporadas {TEMPORADAS})")
    print(f"Burn-in: se ignoran los primeros {BURN_IN} partidos.\n")

    estado = EstadoLiga()
    nuevo = Acumulador("Modelo corregido")
    viejo = Acumulador("Fórmula antigua (con bug)")
    base_liga = Acumulador("Base: equipo medio")
    base_frec = Acumulador("Base: frecuencia histórica")

    conteo_result = [0, 0, 0]
    evaluados = 0

    for i, m in enumerate(partidos):
        if i >= BURN_IN:
            y = resultado(m)
            p_liga = estado.promedio_liga()
            sl = estado.stats(m["local_id"])
            sv = estado.stats(m["visita_id"])

            # --- modelo corregido ---
            xl, xv = app.calcular_xg_partido(sl, sv, p_liga)
            pr = app.calcular_poisson(xl, xv)
            probs_n = [pr["prob_local"]/100, pr["prob_empate"]/100, pr["prob_visita"]/100]

            # --- fórmula antigua ---
            xl2, xv2 = xg_formula_vieja(sl, sv, p_liga)
            pr2 = app.calcular_poisson(xl2, xv2)
            probs_v = [pr2["prob_local"]/100, pr2["prob_empate"]/100, pr2["prob_visita"]/100]

            # --- baseline: dos equipos medios ---
            prb = app.calcular_poisson(p_liga["avg_local"], p_liga["avg_visita"])
            probs_b = [prb["prob_local"]/100, prb["prob_empate"]/100, prb["prob_visita"]/100]

            # --- baseline: frecuencia observada hasta ahora ---
            tot = sum(conteo_result) or 1
            probs_f = [c / tot for c in conteo_result] if sum(conteo_result) > 20 else [0.45, 0.25, 0.30]

            for acc, probs in ((nuevo, probs_n), (viejo, probs_v),
                               (base_liga, probs_b), (base_frec, probs_f)):
                acc.add(probs, y)

            conteo_result[y] += 1
            evaluados += 1

        estado.registrar(m)

    print("=" * 78)
    print(f"RESULTADOS  ({evaluados} partidos evaluados)")
    print("=" * 78)
    for acc in (nuevo, viejo, base_liga, base_frec):
        print("  " + acc.resumen())
    print("\n  Brier más BAJO = mejor. Si el modelo no le gana a las dos bases,")
    print("  no está aportando nada sobre 'la media de la liga'.\n")

    tot = sum(conteo_result)
    print(f"  Reparto real: 1={100*conteo_result[0]/tot:.1f}%  "
          f"X={100*conteo_result[1]/tot:.1f}%  2={100*conteo_result[2]/tot:.1f}%\n")

    print("=" * 78)
    print("CALIBRACIÓN del modelo corregido")
    print("(de todas las veces que dijo '30%', ¿pasó el 30% de las veces?)")
    print("=" * 78)
    print(f"  {'Rango':<12}{'Casos':>8}{'Predicho':>12}{'Real':>10}{'Desvío':>10}")
    for rango, n, pred, real in nuevo.tabla_calibracion():
        print(f"  {rango:<12}{n:>8}{pred:>11.1f}%{real:>9.1f}%{real-pred:>+9.1f}")
    print("\n  Desvíos consistentemente positivos = el modelo es tímido.")
    print("  Consistentemente negativos = el modelo se pasa de confiado.\n")


if __name__ == "__main__":
    main()
