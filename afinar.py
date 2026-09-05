"""
Afina los parámetros del modelo con datos reales, sin engañarse.

Prueba combinaciones de:
  - PSEUDO_PARTIDOS : fuerza del encogimiento hacia la media de liga
  - rho             : corrección de Dixon-Coles para empates (0 = desactivada)

La regla de oro: los parámetros se ELIGEN mirando una temporada (train) y se
JUZGAN con otra que no se ha tocado (test). Si eliges y juzgas con los mismos
partidos, siempre sale bien y siempre mientes: eso es sobreajuste.

Uso:
    $env:FOOTBALL_DATA_TOKEN="tu_token"
    python afinar.py 2023 2024          # ajusta con 2023, valida con 2024

Reutiliza las temporadas ya descargadas en backtest_cache/.
"""
import os
import sys
import math
from collections import defaultdict, deque

import numpy as np
from scipy.stats import poisson

os.environ.setdefault("UPDATE_SECRET", "afinar_dummy_secret")
if not os.environ.get("FOOTBALL_DATA_TOKEN"):
    sys.exit("Falta FOOTBALL_DATA_TOKEN.")

from backtest import descargar_temporada, resultado, brier, logloss  # noqa: E402

BURN_IN = 40
LIMITE_GOLES = 10

# Rejillas a explorar. Ampliar si hace falta, pero cuidado: cuantas más
# combinaciones pruebes sobre el mismo train, más fácil es que la ganadora lo
# sea por suerte. Por eso existe el test.
PSEUDOS = [1, 2, 3, 4, 6, 8, 12]
RHOS = [0.0, -0.05, -0.10, -0.15, -0.20]

PRIOR_AVG_LOCAL = 1.50
PRIOR_AVG_VISITA = 1.15
K_LIGA = 50
MAX_PARTIDOS_EQUIPO = 20


# ==========================================
# MODELO PARAMETRIZABLE
# ==========================================
def tau_dixon_coles(x, y, lam, mu, rho):
    """Corrige la dependencia entre los goles en marcadores bajos.

    El Poisson independiente reparte mal 0-0, 1-0, 0-1 y 1-1, y el error va casi
    todo en contra de los empates. Con rho < 0 sube 0-0 y 1-1 y baja 1-0 y 0-1.
    """
    if x == 0 and y == 0:
        return 1 - lam * mu * rho
    if x == 0 and y == 1:
        return 1 + lam * rho
    if x == 1 and y == 0:
        return 1 + mu * rho
    if x == 1 and y == 1:
        return 1 - rho
    return 1.0


_GOLES = np.arange(LIMITE_GOLES + 1)


def probabilidades(lam, mu, rho=0.0):
    """Rejilla de marcadores vectorizada. M[x][y] = P(local marca x, visita marca y).

    Se hace con numpy porque este script evalúa decenas de miles de partidos:
    con bucles de Python tardaría minutos en vez de segundos.
    """
    M = np.outer(poisson.pmf(_GOLES, lam), poisson.pmf(_GOLES, mu))
    if rho:
        # solo los cuatro marcadores bajos que corrige Dixon-Coles
        M[0, 0] *= 1 - lam * mu * rho
        M[0, 1] *= 1 + lam * rho
        M[1, 0] *= 1 + mu * rho
        M[1, 1] *= 1 - rho
    pl = np.tril(M, -1).sum()   # x > y : triángulo inferior sin diagonal
    pe = np.trace(M)            # x == y
    pv = np.triu(M, 1).sum()    # x < y
    t = pl + pe + pv
    return [pl / t, pe / t, pv / t]


def _encoger(total, n, prior, k):
    return (total + k * prior) / (n + k)


def xg_partido(sl, sv, p, pseudo):
    al, av = p["avg_local"], p["avg_visita"]
    for_local      = _encoger(sl["gf_local"],  sl["n_local"],  al, pseudo)
    against_local  = _encoger(sl["gc_local"],  sl["n_local"],  av, pseudo)
    for_visita     = _encoger(sv["gf_visita"], sv["n_visita"], av, pseudo)
    against_visita = _encoger(sv["gc_visita"], sv["n_visita"], al, pseudo)
    xl = (for_local / al) * (against_visita / al) * al
    xv = (for_visita / av) * (against_local / av) * av
    return xl, xv


class EstadoLiga:
    """Acumula resultados y responde 'qué se sabía justo antes de este partido'."""

    def __init__(self, ventana=MAX_PARTIDOS_EQUIPO):
        self.mitad = max(1, ventana // 2)
        self.casa = defaultdict(deque)
        self.fuera = defaultdict(deque)
        self.gl = self.gv = self.n = 0

    def promedio_liga(self):
        return {
            "avg_local": (self.gl + K_LIGA * PRIOR_AVG_LOCAL) / (self.n + K_LIGA),
            "avg_visita": (self.gv + K_LIGA * PRIOR_AVG_VISITA) / (self.n + K_LIGA),
        }

    def stats(self, tid):
        c = list(self.casa[tid])[-self.mitad:]
        f = list(self.fuera[tid])[-self.mitad:]
        return {"gf_local": sum(x[0] for x in c), "gc_local": sum(x[1] for x in c), "n_local": len(c),
                "gf_visita": sum(x[0] for x in f), "gc_visita": sum(x[1] for x in f), "n_visita": len(f)}

    def registrar(self, m):
        self.casa[m["local_id"]].append((m["gl"], m["gv"]))
        self.fuera[m["visita_id"]].append((m["gv"], m["gl"]))
        self.gl += m["gl"]; self.gv += m["gv"]; self.n += 1


def evaluar(partidos, pseudo, rho, recoger=False):
    """Walk-forward sobre una lista de partidos ya ordenada por fecha."""
    estado = EstadoLiga()
    bs, lls, aciertos, n = [], [], 0, 0
    detalle = []
    for i, m in enumerate(partidos):
        if i >= BURN_IN:
            y = resultado(m)
            p = estado.promedio_liga()
            lam, mu = xg_partido(estado.stats(m["local_id"]), estado.stats(m["visita_id"]), p, pseudo)
            probs = probabilidades(lam, mu, rho)
            bs.append(brier(probs, y)); lls.append(logloss(probs, y))
            aciertos += (max(range(3), key=lambda k: probs[k]) == y)
            n += 1
            if recoger:
                detalle.append((probs, y))
        estado.registrar(m)
    if not n:
        return None
    r = {"brier": sum(bs)/n, "logloss": sum(lls)/n, "acierto": 100*aciertos/n, "n": n}
    if recoger:
        r["detalle"] = detalle
    return r


def cargar(seasons):
    todos = []
    for s in seasons:
        todos.extend(descargar_temporada(s))
    limpios = []
    for m in todos:
        ft = m.get("score", {}).get("fullTime", {})
        if ft.get("home") is None or ft.get("away") is None:
            continue
        limpios.append({"fecha": m["utcDate"],
                        "local_id": m["homeTeam"]["id"], "visita_id": m["awayTeam"]["id"],
                        "gl": ft["home"], "gv": ft["away"]})
    limpios.sort(key=lambda m: m["fecha"])
    return limpios


def tabla_calibracion(detalle, minimo=20):
    bins = defaultdict(lambda: [0.0, 0, 0])
    for probs, y in detalle:
        for i, p in enumerate(probs):
            b = bins[min(int(p*10), 9)]
            b[0] += p; b[1] += (1 if i == y else 0); b[2] += 1
    filas = []
    for b in sorted(bins):
        suma, ac, n = bins[b]
        if n < minimo:
            continue
        pred, real = 100*suma/n, 100*ac/n
        # error estándar aproximado, para no leer ruido como si fuera señal
        se = 100 * math.sqrt(max(pred/100*(1-pred/100), 1e-9) / n)
        filas.append((f"{b*10}-{b*10+10}%", n, pred, real, real-pred, se))
    return filas


def main():
    args = [int(a) for a in sys.argv[1:]] or [2023, 2024]
    if len(args) < 2:
        sys.exit("Hacen falta al menos dos temporadas: una para ajustar y otra para validar.")
    train_s, test_s = args[:-1], args[-1:]

    train = cargar(train_s)
    test = cargar(test_s)
    print(f"\nAjuste  (train): temporadas {train_s} -> {len(train)} partidos")
    print(f"Validación (test): temporadas {test_s} -> {len(test)} partidos")
    print("Los parámetros se eligen SOLO con train. El test no se toca hasta el final.\n")

    print("=" * 74)
    print("BÚSQUEDA EN TRAIN  (LogLoss; más bajo mejor)")
    print("=" * 74)
    cab = "  pseudo |" + "".join(f"  rho={r:<6}" for r in RHOS)
    print(cab)
    print("  " + "-" * (len(cab) - 2))

    resultados = {}
    for ps in PSEUDOS:
        fila = f"  {ps:>6} |"
        for rho in RHOS:
            r = evaluar(train, ps, rho)
            resultados[(ps, rho)] = r
            fila += f"  {r['logloss']:.4f}   "
        print(fila)

    mejor = min(resultados, key=lambda k: resultados[k]["logloss"])
    actual = (6, 0.0)   # lo que hay hoy en app.py
    print()
    print(f"  Mejor en train : pseudo={mejor[0]}, rho={mejor[1]}  "
          f"(LogLoss {resultados[mejor]['logloss']:.4f})")
    print(f"  Config actual  : pseudo={actual[0]}, rho={actual[1]}  "
          f"(LogLoss {resultados[actual]['logloss']:.4f})")

    print()
    print("=" * 74)
    print("VALIDACIÓN EN TEST  (datos nunca usados para elegir)")
    print("=" * 74)
    r_act = evaluar(test, *actual, recoger=True)
    r_mej = evaluar(test, *mejor, recoger=True)
    print(f"  {'':<34}{'Brier':>9}{'LogLoss':>10}{'Acierto':>10}")
    print(f"  {'Config actual (pseudo=6, rho=0)':<34}"
          f"{r_act['brier']:>9.4f}{r_act['logloss']:>10.4f}{r_act['acierto']:>9.1f}%")
    print(f"  {f'Config nueva (pseudo={mejor[0]}, rho={mejor[1]})':<34}"
          f"{r_mej['brier']:>9.4f}{r_mej['logloss']:>10.4f}{r_mej['acierto']:>9.1f}%")

    d_ll = r_act["logloss"] - r_mej["logloss"]
    d_br = r_act["brier"] - r_mej["brier"]
    print()
    if d_ll > 0.002 and d_br > 0.001:
        print(f"  MEJORA CONFIRMADA en datos no vistos: LogLoss {d_ll:+.4f}, Brier {d_br:+.4f}.")
        print("  Merece la pena cambiar los parámetros en app.py.")
    elif d_ll < -0.002:
        print(f"  EMPEORA en test (LogLoss {d_ll:+.4f}). La ganadora del train lo era por suerte.")
        print("  NO cambies nada: el sobreajuste estaba ahí y el test lo ha cazado.")
    else:
        print(f"  Diferencia despreciable en test (LogLoss {d_ll:+.4f}).")
        print("  No hay motivo para tocar los parámetros; quédate con los actuales.")

    print()
    print("=" * 74)
    print(f"CALIBRACIÓN EN TEST con pseudo={mejor[0]}, rho={mejor[1]}")
    print("=" * 74)
    print(f"  {'Rango':<12}{'Casos':>7}{'Predicho':>11}{'Real':>9}{'Desvío':>9}{'±1 s.e.':>9}")
    for rango, n, pred, real, desv, se in tabla_calibracion(r_mej["detalle"]):
        marca = "  <- significativo" if abs(desv) > 2 * se else ""
        print(f"  {rango:<12}{n:>7}{pred:>10.1f}%{real:>8.1f}%{desv:>+9.1f}{se:>9.1f}{marca}")
    print()
    print("  Un desvío menor que 2 s.e. es ruido: no saques conclusiones de él.")
    print()


if __name__ == "__main__":
    main()
