"""Comprobaciones de la migración a /standings.

No es un test de la API: no toca la red. Verifica las dos cosas que la migración
podía romper en silencio.

  1. El parseo de standings reconstruye exactamente las sumas por equipo y las
     medias de liga que antes se calculaban partido a partido.
  2. calcular_xg_partido devuelve los MISMOS números que antes con los mismos
     datos de entrada, y el prior de temporada anterior (apagado por defecto)
     no altera nada mientras siga apagado.

Uso:  python test_migracion.py
"""
import os

os.environ.setdefault("FOOTBALL_DATA_TOKEN", "test")
os.environ.setdefault("UPDATE_SECRET", "test-secret-larguito")

import app  # noqa: E402

fallos = []


def check(nombre, cond, detalle=""):
    print(f"{'OK  ' if cond else 'FALLA'}  {nombre}{'  ' + detalle if detalle else ''}")
    if not cond:
        fallos.append(nombre)


# ------------------------------------------------------------------
# Liga de juguete: 4 equipos, todos contra todos ida y vuelta (12 partidos).
# Se calculan las sumas a mano y se comprueba que el parseo las reproduce.
# ------------------------------------------------------------------
# Resultados inventados, formato (local, visitante, goles_local, goles_visita)
PARTIDOS = [
    (1, 2, 3, 0), (1, 3, 2, 2), (1, 4, 1, 0),
    (2, 1, 1, 1), (2, 3, 0, 2), (2, 4, 2, 1),
    (3, 1, 0, 1), (3, 2, 4, 0), (3, 4, 2, 2),
    (4, 1, 1, 3), (4, 2, 0, 0), (4, 3, 1, 1),
]

esperado = {str(i): dict(gf_local=0, gc_local=0, n_local=0,
                         gf_visita=0, gc_visita=0, n_visita=0) for i in range(1, 5)}
for loc, vis, gl, gv in PARTIDOS:
    e = esperado[str(loc)]
    e["gf_local"] += gl; e["gc_local"] += gv; e["n_local"] += 1
    e = esperado[str(vis)]
    e["gf_visita"] += gv; e["gc_visita"] += gl; e["n_visita"] += 1


def fila(tid, gf, ga, n, pos=None, pts=None, forma=None):
    return {"team": {"id": tid}, "goalsFor": gf, "goalsAgainst": ga,
            "playedGames": n, "position": pos, "points": pts, "form": forma}


body = {"standings": [
    {"type": "HOME", "table": [
        fila(i, esperado[str(i)]["gf_local"], esperado[str(i)]["gc_local"],
             esperado[str(i)]["n_local"]) for i in range(1, 5)]},
    {"type": "AWAY", "table": [
        fila(i, esperado[str(i)]["gf_visita"], esperado[str(i)]["gc_visita"],
             esperado[str(i)]["n_visita"]) for i in range(1, 5)]},
    {"type": "TOTAL", "table": [
        fila(i, 0, 0, 6, pos=i, pts=10 - i, forma="W,D,L,W,W") for i in range(1, 5)]},
]}

parsed = app._parsear_standings(body)

for tid, esp in esperado.items():
    got = parsed["equipos"][tid]
    check(f"equipo {tid}: sumas por lado",
          all(got[k] == v for k, v in esp.items()),
          f"{ {k: got[k] for k in esp} }")

check("la tabla TOTAL aporta posición, puntos y forma",
      parsed["equipos"]["1"]["pos"] == 1
      and parsed["equipos"]["1"]["pts"] == 9
      and parsed["equipos"]["1"]["forma"] == "W,D,L,W,W")

# Las medias de liga que salen de standings deben coincidir con contarlas a mano.
gl = sum(p[2] for p in PARTIDOS)
gv = sum(p[3] for p in PARTIDOS)
n = len(PARTIDOS)
esp_local = (gl + app.K_LIGA * app.PRIOR_AVG_LOCAL) / (n + app.K_LIGA)
esp_visita = (gv + app.K_LIGA * app.PRIOR_AVG_VISITA) / (n + app.K_LIGA)
check("media de local reconstruida desde la tabla HOME",
      abs(parsed["avg_local"] - esp_local) < 1e-12, f"{parsed['avg_local']:.6f}")
check("media de visitante reconstruida desde la tabla HOME",
      abs(parsed["avg_visita"] - esp_visita) < 1e-12, f"{parsed['avg_visita']:.6f}")
check("el recuento de partidos cuadra", parsed["partidos"] == n)

# ------------------------------------------------------------------
# El modelo no debe haber cambiado.
# ------------------------------------------------------------------
# Test de coherencia del informe: dos equipos exactamente medios tienen que
# producir xG = medias de liga. Es el que destapó el bug del normalizador.
liga = {"avg_local": 1.55, "avg_visita": 1.20}
medio_l = {"gf_local": 15.5, "gc_local": 12.0, "n_local": 10,
           "gf_visita": 0, "gc_visita": 0, "n_visita": 0}
medio_v = {"gf_local": 0, "gc_local": 0, "n_local": 0,
           "gf_visita": 12.0, "gc_visita": 15.5, "n_visita": 10}
xg = app.calcular_xg_partido(medio_l, medio_v, liga)
check("equipos medios -> xG = medias de liga", xg == (1.55, 1.20), str(xg))

probs = app.calcular_poisson(*xg)
check("1 + X + 2 suma 100",
      abs(probs["prob_local"] + probs["prob_empate"] + probs["prob_visita"] - 100) < 0.01,
      str(round(probs["prob_local"] + probs["prob_empate"] + probs["prob_visita"], 4)))
check("las dobles cuadran con las simples",
      abs(probs["prob_1x"] - (probs["prob_local"] + probs["prob_empate"])) < 0.02
      and abs(probs["prob_x2"] - (probs["prob_empate"] + probs["prob_visita"])) < 0.02
      and abs(probs["prob_12"] - (probs["prob_local"] + probs["prob_visita"])) < 0.02)

# Un equipo sin partidos debe caer limpiamente en la media de liga, no reventar.
vacio = dict(app.STATS_VACIAS)
xg_vacio = app.calcular_xg_partido(vacio, vacio, liga)
check("equipo sin datos -> media de liga, sin excepción", xg_vacio == (1.55, 1.20), str(xg_vacio))

# Con el flag apagado, pasar una temporada previa no debe cambiar NADA.
previa = {"disponible": True, "avg_local": 1.40, "avg_visita": 1.10,
          "equipos": {"1": {"gf_local": 30, "n_local": 19, "gc_local": 10,
                            "gf_visita": 20, "n_visita": 19, "gc_visita": 25}}}
xg_flag_off = app.calcular_xg_partido(medio_l, medio_v, liga,
                                      previa=previa, id_local="1", id_visita="1")
check("USAR_PRIOR_PREVIA apagado -> predicciones idénticas",
      app.USAR_PRIOR_PREVIA is False and xg_flag_off == xg, str(xg_flag_off))

# Y encendido, sí debe moverlas (si no, la plumbing estaría muerta).
app.USAR_PRIOR_PREVIA = True
xg_flag_on = app.calcular_xg_partido(medio_l, medio_v, liga,
                                     previa=previa, id_local="1", id_visita="1")
check("USAR_PRIOR_PREVIA encendido -> el prior tiene efecto", xg_flag_on != xg, str(xg_flag_on))
app.USAR_PRIOR_PREVIA = False

# ------------------------------------------------------------------
# Robustez del parseo ante respuestas incompletas de la API.
# ------------------------------------------------------------------
vacio_body = app._parsear_standings({})
check("standings vacío -> cae a los priors, sin excepción",
      vacio_body["partidos"] == 0
      and abs(vacio_body["avg_local"] - app.PRIOR_AVG_LOCAL) < 1e-12)

sin_forma = app._parsear_standings({"standings": [
    {"type": "TOTAL", "table": [fila(7, 0, 0, 0, pos=1, pts=0, forma=None)]}]})
check("form a null no revienta", sin_forma["equipos"]["7"]["forma"] is None)

nulos = app._parsear_standings({"standings": [
    {"type": "HOME", "table": [{"team": {"id": 9}, "goalsFor": None,
                                "goalsAgainst": None, "playedGames": None}]}]})
check("campos a null se tratan como cero", nulos["equipos"]["9"]["gf_local"] == 0)

print()
if fallos:
    print(f"{len(fallos)} comprobacion(es) fallidas: {', '.join(fallos)}")
    raise SystemExit(1)
print("Todo correcto.")
