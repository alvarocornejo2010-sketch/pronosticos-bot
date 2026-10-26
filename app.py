import os
import sys
import hmac
import json
import time
import threading
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import numpy as np
import requests
from flask import Flask, abort, jsonify, redirect, render_template, request, send_from_directory
from scipy.stats import poisson

# La web vive en public/: el mismo archivo lo sirve el Worker de Cloudflare
# (worker/, wrangler.jsonc) como archivo estático.
app = Flask(__name__, template_folder="public")

# ==========================================
# CONFIGURACIÓN
# ==========================================
API_TOKEN = os.environ.get("FOOTBALL_DATA_TOKEN")
UPDATE_SECRET = os.environ.get("UPDATE_SECRET")  # OBLIGATORIO, sin valor por defecto

# Falla rápido y con un mensaje claro en los logs de Render si falta configurar algo,
# en vez de arrancar "a medias" y fallar de forma confusa en el primer request.
if not API_TOKEN:
    print("ERROR FATAL: falta la variable de entorno FOOTBALL_DATA_TOKEN.", file=sys.stderr)
    sys.exit(1)
if not UPDATE_SECRET or len(UPDATE_SECRET) < 12:
    print("ERROR FATAL: falta UPDATE_SECRET o es demasiado corto (mínimo 12 caracteres). "
          "Genera uno fuerte con: python -c \"import secrets; print(secrets.token_urlsafe(24))\"",
          file=sys.stderr)
    sys.exit(1)

HEADER = {"X-Auth-Token": API_TOKEN}
BASE_URL = "https://api.football-data.org/v4"

LIGAS = {
    "La Liga": "PD",
    "Premier League": "PL",
    "Ligue 1": "FL1",
    "Bundesliga": "BL1",
    "Serie A": "SA",
    "Eredivisie": "DED",
    "Primeira Liga": "PPL",
    "Championship": "ELC",
    "Brasileirão": "BSA",
    # Con estas nueve ya están todas las LIGAS del plan free. Lo que queda en él son
    # torneos: Champions (abajo, en TORNEOS), Mundial ("WC") y Eurocopa ("EC").
    # Europa League y Conference League no están en el plan free.
}

# Torneos: NO se predicen con sus propios partidos. En la Champions cada equipo
# juega 4 en casa y 4 fuera contra rivales de niveles muy distintos, y su "media
# de liga" mezcla al Bayern con el campeón de Kazajistán. Cada equipo se mide en
# SU liga nacional (fuerzas_champions) y se ajusta por el nivel de esa liga.
TORNEOS = {
    "Champions League": "CL",
}

# Nivel de cada liga frente al equipo medio de la Champions (1.00): cuánto más
# marca y cuánto menos encaja un equipo medio de esa liga en la Champions.
# Medido con afinar_champions.py sobre cuatro Champions (2022/23 a 2025/26, 628
# partidos, datos de openfootball), con validación cruzada (ver CLAUDE.md,
# "Champions"). Championship y Brasileirão no juegan la Champions; si algún día
# hiciera falta, usan FACTOR_OTRA_LIGA.
FACTOR_LIGA = {"PL": 1.25, "PD": 1.06, "FL1": 1.08, "SA": 1.01, "BL1": 1.06, "PPL": 0.86, "DED": 0.73}
# Equipos de ligas fuera del plan (Bélgica, Austria, Escocia...): sin datos de su
# liga, cuentan como un equipo medio de este nivel.
FACTOR_OTRA_LIGA = 0.87
# La fuerza en la liga nacional (la de obtener_fuerzas_liga) se eleva a este
# exponente: los grandes arrasan en su liga y su fuerza nacional tomada tal cual
# exagera. Sale 0.82 (entre 0.71 y 0.90 en los nueve ajustes de la validación):
# las fuerzas ya vienen ajustadas por rival y encogidas, así que hay que
# atenuarlas mucho menos que las de antes (0.39).
EXPONENTE_FUERZA_CHAMPIONS = 0.82
# Los goles esperados parten de la media de la Champions por este factor (local,
# visitante): con equipos que en su liga son de los mejores, el producto de
# ataque y defensa sale por encima de 1 y hay que compensarlo.
ESCALA_CHAMPIONS = (0.90, 0.89)
# Historial en la Champions: lo que cada equipo marcó y encajó en sus partidos de
# Champions de esta temporada y la anterior, frente a lo que se esperaba de un
# equipo de su nivel de liga contra esos mismos rivales. Corrige la fuerza que da
# su liga nacional, encogido hacia 1 con estos goles de pseudo-cuenta (sale
# entre 44 y 78 en los nueve ajustes de la validación): con 54, un equipo con 16
# partidos de Champions pesa algo menos de un tercio su historial, y uno sin
# partidos queda como estaba. Con la fuerza nacional de ahora, mejor medida, el
# historial aporta menos que antes. Sale de los mismos partidos que ya se bajan
# para la media de la Champions.
K_HISTORIAL_CHAMPIONS = 54
DIAS_VALIDEZ_LIGA_EQUIPO = 30   # de qué liga es cada equipo: no cambia en la temporada

# Zona horaria de referencia para decidir qué es "hoy".
# Render corre en UTC; sin esto, a partir de las 19:00 de Lima el servidor
# ya está en el día siguiente y te muestra los partidos equivocados.
_TZ_NOMBRE = os.environ.get("TZ_LOCAL", "America/Lima")
try:
    TZ = ZoneInfo(_TZ_NOMBRE)
except ZoneInfoNotFoundError:
    # Windows no incluye base de datos de zonas horarias (Linux sí, por eso en
    # Render funciona). Se arregla con  pip install tzdata , pero mientras tanto
    # caemos a un offset fijo de UTC-5, que para Perú es exacto todo el año
    # porque no aplica horario de verano.
    print(f"AVISO: no se encontró la zona '{_TZ_NOMBRE}'. Usando UTC-5 fijo. "
          "Instala el paquete tzdata para tener la zona real.", file=sys.stderr)
    TZ = timezone(timedelta(hours=-5))

# Espera mínima entre actualizaciones, en minutos. Por defecto 25: un poco menos
# que los 30 del cron, así nunca se solapan por diferencias de reloj.
# En desarrollo ponlo a 0 (variable de entorno MIN_MINUTOS_ACTUALIZACION=0) para
# poder refrescar cuando quieras. También puedes saltártelo puntualmente
# añadiendo &forzar=1 a la URL de /actualizar.
MIN_INTERVALO_ACTUALIZACION = timedelta(
    minutes=int(os.environ.get("MIN_MINUTOS_ACTUALIZACION", "25")))

# En Render el disco es efímero: se borra en cada deploy y cuando el free tier
# duerme el servicio. Si algún día contratas un disco persistente, apúntalo con
# la variable DATA_DIR y la caché sobrevivirá a los reinicios.
DATA_DIR = os.environ.get("DATA_DIR", ".")
CACHE_FILE = os.path.join(DATA_DIR, "cache.json")   # partidos y medias de cada liga, fuerzas de sus equipos
DATA_FILE = os.path.join(DATA_DIR, "data.json")     # lo que ve la página web, se va llenando poco a poco

CACHE_VERSION = 4               # subir esto invalida cachés con formato viejo
                                # (v4: listas de partidos por liga y fuerzas
                                #  ajustadas por rival; ya no hay stats por equipo)
# Cada cuánto se vuelven a pedir los partidos ya jugados de la temporada en
# curso de cada liga: de ahí sale la fuerza de TODOS sus equipos, con una sola
# petición por liga (antes eran dos por equipo, cada 3 días).
HORAS_VALIDEZ_LIGA = 12
PAUSA_ENTRE_REQUESTS = 6.5      # 10 requests/min en el plan free
MAX_DIAS_BUSQUEDA = int(os.environ.get("DIAS_ADELANTE", "7"))
                                # cuántos días hacia delante mostrar. Con el endpoint por
                                # competición esto cuesta 1 request por liga en total,
                                # así que se puede ser generoso.

# Presupuesto de peticiones a la API por cada ejecución de la actualización.
# Cuando se agota, la pasada termina dejando el resto marcado como pendiente y
# la SIGUIENTE ejecución continúa por donde se quedó. Así se pueden cubrir
# muchos días sin pelearse con el límite de 10 peticiones/minuto ni tener un
# hilo corriendo media hora.
# A 6.5s por petición, 40 peticiones son unos 4,5 minutos de reloj.
PRESUPUESTO_REQUESTS = int(os.environ.get("PRESUPUESTO_REQUESTS", "40"))

# Cuánto vale una lista de partidos antes de volver a pedirla. Un calendario a 7 días
# no cambia de un cuarto de hora a otro, y pedirlo en cada pasada era el 90% de las
# peticiones: 4 por pasada, 26 segundos de espera, y en régimen estacionario para
# descubrir que no había nada que hacer.
HORAS_VALIDEZ_FIXTURES = int(os.environ.get("HORAS_VALIDEZ_FIXTURES", "2"))

# Cuánto vale una predicción ya calculada antes de rehacerla. Mientras siga
# fresca no se recalcula, así las pasadas siguientes gastan el presupuesto en
# los partidos que aún no tienen número en vez de repetir trabajo.
HORAS_VALIDEZ_PREDICCION = 24

DIAS_SEMANA = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]

# --- Parámetros del modelo ---
# La fuerza de cada equipo (ajustar_fuerzas): un ataque y una defensa por
# equipo, con TODOS sus partidos de liga de esta temporada y la anterior (en
# casa y fuera), cada uno medido frente al rival que tuvo y pesado por su
# antigüedad. Medido con afinar_liga.py en 8 ligas y 15 temporadas de
# openfootball: los valores se eligieron mirando 2010/11 a 2020/21 (19.753
# partidos) y se juzgaron en 2021/22 a 2025/26 (14.706), que no se usaron para
# elegir. Frente al modelo de antes (últimos 20 partidos, casa y fuera por
# separado, sin mirar al rival): skill del 1X2 de +6.1% a +8.9%, mejor en las
# 9 ligas y en todas las temporadas. Detalle en CLAUDE.md ("El modelo").
FACTOR_DIARIO = 0.998           # peso de un partido de hace un día frente a uno de hoy:
                                # a los 347 días pesa la mitad. Se multiplica día a día
                                # (no con exp) para que Python y JavaScript den lo mismo.
PSEUDO_GOLES_ATAQUE = 6         # encogimiento hacia el equipo medio, en goles esperados:
PSEUDO_GOLES_DEFENSA = 8        # con pocos partidos un equipo queda cerca de 1
ATAQUE_RECIEN_LLEGADO = 0.8     # un equipo que no estaba la temporada pasada (un
                                # ascendido) parte de un ataque un 20% peor que el medio.
                                # Su defensa, como la de un equipo medio...
DEFENSA_RECIEN_LLEGADO = {"PL": 1.3}   # ...salvo en la Premier, donde el que sube de la
                                # Championship encaja mucho más (su primera temporada, un 13%
                                # más que el medio). Medido con afinar_liga.py descensos: Brier
                                # de la Premier -0.0008 en ajuste y -0.0011 en prueba (-1.6 y
                                # -1.7 se). En las demás ligas, 1.1 o 1.2 no se distinguen de 1
                                # en las temporadas de ajuste.
# Los que bajan de la liga de arriba (de la Premier a la Championship) no son
# ascendidos: son de los fuertes de su nueva liga (su primera temporada marcan un
# 12% más que el medio y encajan un 13% menos), así que parten de su propio ataque
# y defensa. En la Championship, Brier -0.0016 en ajuste y en prueba (-2.2 y -1.9
# se). Las combinaciones de ataque y defensa con la misma fuerza neta dan casi lo
# mismo; esta es la del reparto medido.
LIGA_DE_ARRIBA = {"ELC": "PL"}
ATAQUE_DESCENDIDO = 1.2
DEFENSA_DESCENDIDO = 0.85
VERSION_MODELO = 4              # subirlo al cambiar el modelo: las fuerzas guardadas se
                                # recalculan, cada ficha dice con cuál se calculó (una de
                                # otra versión se recalcula) y en Cloudflare (donde D1
                                # guarda la validación) esta se repite.
                                # 3 (oct 2026): sin los playoffs de la Championship
                                # 4 (oct 2026): los mercados de goles con ENCOGER_TOTAL
FORMATO_LISTAS = 2              # partidos_liga sin playoffs (solo_liga): las de antes se bajan otra vez
TOLERANCIA_FUERZAS = 1e-4       # el ajuste se repite hasta que nada cambia más que esto:
                                # con 1e-6 harían falta el doble de vueltas y los goles
                                # esperados (con dos decimales) salen iguales salvo algún
                                # 0.01 suelto en el borde de un redondeo
MAX_ITER_FUERZAS = 300
K_LIGA = 50                     # cuánto pesa el ancla en la media de la propia liga

# Ancla de ÚLTIMO RECURSO, solo si no se puede leer la temporada anterior de la liga.
# Antes estas dos constantes (sacadas de LaLiga) se usaban para TODAS las ligas, y
# con K_LIGA=50 pesaban el 62% del valor a 30 partidos jugados. La Bundesliga, que
# marca más, salía sistemáticamente estimada por debajo. Ahora cada liga se ancla
# en su propia temporada anterior y estas constantes casi nunca se tocan.
PRIOR_AVG_LOCAL = 1.50
PRIOR_AVG_VISITA = 1.15
DIAS_VALIDEZ_PRIOR = 30         # la temporada pasada ya no cambia: se cachea de sobra
LIMITE_GOLES = 10               # rejilla de Poisson (antes 5, que perdía hasta 6.5% de masa)

# Corrección de Dixon-Coles para los marcadores bajos (0-0, 1-0, 0-1, 1-1): con
# dos Poisson independientes salían menos empates de los que hay (24.3% frente a
# 25.4% reales en 19.753 partidos). Con -0.05 cuadran, y el 1X2 mejora poco pero
# de verdad (Brier -0.0002 y LogLoss -0.0006 en los partidos de prueba, unos -2 y
# -3 errores estándar). Era la hipótesis pendiente desde sept 2026: con LaLiga
# sola no se distinguía del ruido. Se aplica también a los mercados de goles.
RHO_EMPATES = -0.05

# Cuánto de la diferencia con la media de la liga se conserva en el TOTAL de goles
# esperados de un partido al calcular los mercados de GOLES (más/menos, ambos marcan,
# porterías a cero, por cuánto gana, marcadores). El 1X2 no lo usa. Los goles
# esperados tal cual exageran cuántos goles habrá (donde daban 27% de más de 2.5
# pasaba un 42%), pero no cómo se reparten entre los dos equipos: por eso se acerca
# el total a la media de la liga, en lineal, y el reparto queda como en el 1X2.
# Elegido en las temporadas de ajuste por la log loss del marcador exacto (0.6 de
# 0.3 a 1.0) y juzgado en las de prueba frente al modelo 3 (que acercaba cada equipo
# por separado, en escala logarítmica, con 0.5): mejor en más de 1.5, 2.5 y 3.5
# (-2.7, -6.1 y -4.3 se), en las porterías a cero (-5.4 y -6.9) y en el marcador
# (-15.3), e igual en ambos marcan (+0.2). Detalle en CLAUDE.md.
ENCOGER_TOTAL = 0.6

actualizando_ahora = False      # evita que dos actualizaciones corran a la vez


def ahora():
    return datetime.now(TZ)


def _parsear_fecha(fecha_str):
    """Lee un ISO string y le pone zona horaria si venía sin ella (cachés viejas)."""
    dt = datetime.fromisoformat(fecha_str)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt


# ==========================================
# CACHÉ
# ==========================================
def cargar_cache():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r") as f:
                cache = json.load(f)
            if cache.get("version") == CACHE_VERSION:
                return cache
            print("Caché con formato viejo, se descarta y se reconstruye.", file=sys.stderr)
        except (json.JSONDecodeError, OSError) as e:
            print(f"Caché ilegible ({e}), se reconstruye.", file=sys.stderr)
    return {"version": CACHE_VERSION, "ligas": {}, "partidos_liga": {}, "fuerzas": {}}


def guardar_cache(cache):
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2)


def esta_vigente(fecha_str, dias_validez):
    if not fecha_str:
        return False
    return ahora() - _parsear_fecha(fecha_str) < timedelta(days=dias_validez)


_requests_gastadas = 0


def reset_presupuesto():
    global _requests_gastadas
    _requests_gastadas = 0


def presupuesto_agotado():
    return _requests_gastadas >= PRESUPUESTO_REQUESTS


def get_con_pausa(url, params=None):
    global _requests_gastadas
    _requests_gastadas += 1
    resp = requests.get(url, headers=HEADER, params=params, timeout=30)
    time.sleep(PAUSA_ENTRE_REQUESTS)
    return resp


# ==========================================
# ESTADO DE LA PÁGINA (data.json)
# ==========================================
def leer_estado():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"estado": "sin_datos", "dias": [], "total": 0, "pendientes": 0,
            "ultima_actualizacion": None}


def escribir_estado(estado):
    with open(DATA_FILE, "w") as f:
        json.dump(estado, f, indent=2)


# ==========================================
# ANCLA POR LIGA (temporada anterior)
# ==========================================
# Ligas que juegan de enero a diciembre: su temporada es el año natural.
LIGAS_ANO_NATURAL = {"BSA"}


def temporada_actual(codigo_liga=None):
    """Año de inicio de la temporada en curso, como lo numera football-data.org.

    Las ligas europeas van de agosto a mayo, así que de julio en adelante ya
    cuenta el año nuevo. La temporada 2026/27 es 'season=2026'. El Brasileirão
    va de enero a diciembre: en marzo de 2027 su temporada en curso es la 2027,
    no la 2026, y la anterior terminada es la 2026.
    """
    a = ahora()
    if codigo_liga in LIGAS_ANO_NATURAL:
        return a.year
    return a.year if a.month >= 7 else a.year - 1


def goles_90(match):
    """Goles de cada equipo a los 90 minutos, (None, None) si no hay resultado.

    En una eliminatoria con prórroga o penaltis, fullTime es el resultado final
    (con la prórroga y, en la v4 de la API, también la tanda de penaltis), y el
    modelo predice los 90 minutos: ahí manda regularTime. En liga no cambia nada."""
    score = match.get("score") or {}
    if score.get("duration") in ("EXTRA_TIME", "PENALTY_SHOOTOUT"):
        rt = score.get("regularTime") or {}
        if rt.get("home") is not None and rt.get("away") is not None:
            return rt["home"], rt["away"]
    ft = score.get("fullTime") or {}
    return ft.get("home"), ft.get("away")


def historial_de_partidos(matches):
    """{id del equipo: [[rival, en casa (1/0), goles a favor, en contra], ...]} de
    los partidos terminados de un torneo: lo que hace falta para el historial."""
    hist = {}
    for m in matches:
        gl, gv = goles_90(m)
        loc, vis = (m.get("homeTeam") or {}).get("id"), (m.get("awayTeam") or {}).get("id")
        if gl is None or gv is None or loc is None or vis is None:
            continue
        hist.setdefault(str(loc), []).append([vis, 1, gl, gv])
        hist.setdefault(str(vis), []).append([loc, 0, gv, gl])
    return hist


_EPOCA = date(1970, 1, 1)


def dia_de(utc_date):
    """Número de día (desde el 1/1/1970) de una fecha de la API: para pesar cada
    partido por su antigüedad basta con el día."""
    return (date.fromisoformat(utc_date[:10]) - _EPOCA).days


def solo_liga(matches):
    """Los partidos de la fase de liga, sin playoffs: los de ascenso de la
    Championship no son liga (afinar_liga.py tampoco los cuenta) y se colaban en
    la media, las fuerzas y la validación (557 partidos en 2025/26 en vez de 552).
    Un partido sin `stage` cuenta. Si el filtro dejara menos de la mitad (la API
    marcara la fase de otra forma), se quedan todos."""
    liga = [m for m in matches if m.get("stage") in (None, "REGULAR_SEASON")]
    return liga if 2 * len(liga) >= len(matches) else matches


def partidos_compactos(matches):
    """[[día, local, visita, goles local, goles visita], ...] de los partidos con
    resultado, por fecha: lo que necesita ajustar_fuerzas, ~25 bytes por partido
    en vez del ~1 KB de cada partido de la API."""
    out = []
    for m in sorted(matches, key=lambda m: m.get("utcDate") or ""):
        gl, gv = goles_90(m)
        loc, vis = (m.get("homeTeam") or {}).get("id"), (m.get("awayTeam") or {}).get("id")
        if gl is None or gv is None or loc is None or vis is None or not m.get("utcDate"):
            continue
        out.append([dia_de(m["utcDate"]), loc, vis, gl, gv])
    return out


def _lista_vigente(cache, clave, temporada):
    """La lista de partidos guardada de una liga, si es de esa temporada."""
    e = cache.get("partidos_liga", {}).get(clave)
    return e if e and e.get("temporada") == temporada and e.get("formato") == FORMATO_LISTAS else None


def obtener_prior_liga(codigo_liga, cache):
    """Media de goles de la temporada ANTERIOR de ESTA liga.

    Es lo que ancla la estimación mientras la temporada en curso tiene pocos
    partidos. Usar la media de otra liga (que es lo que se hacía) mete un sesgo
    del orden del 9% en ligas con ritmo goleador distinto.

    Cuesta una petición por liga y se cachea un mes: la temporada pasada ya no
    va a cambiar. De una liga se guardan además sus partidos (partidos_liga), con
    los que ajustar_fuerzas mide a cada equipo al empezar la temporada.
    """
    priors = cache.setdefault("priors", {})
    entry = priors.get(codigo_liga)
    season = temporada_actual(codigo_liga) - 1
    # la temporada también cuenta: en julio la "anterior" pasa a ser otra, y un
    # torneo guarda además su historial por equipo (ver historial_champions)
    es_torneo = codigo_liga in TORNEOS.values()
    if (entry and esta_vigente(entry.get("actualizado"), DIAS_VALIDEZ_PRIOR)
            and entry.get("temporada") == season
            and ("historial" in entry if es_torneo
                 else _lista_vigente(cache, codigo_liga + ":previa", season))):
        return entry

    respaldo = {"avg_local": PRIOR_AVG_LOCAL, "avg_visita": PRIOR_AVG_VISITA,
                "origen": "constante de respaldo", "partidos": 0, "actualizado": None}

    resp = get_con_pausa(f"{BASE_URL}/competitions/{codigo_liga}/matches",
                         {"season": season, "status": "FINISHED"})
    if resp.status_code != 200:
        print(f"Prior {codigo_liga}: temporada {season} no disponible "
              f"(HTTP {resp.status_code}). Se usa la constante de respaldo.", file=sys.stderr)
        return respaldo

    matches = resp.json().get("matches", [])
    if not es_torneo:
        matches = solo_liga(matches)
    gl = gv = n = 0
    for m in matches:
        a, b = goles_90(m)
        if a is None or b is None:
            continue
        gl += a; gv += b; n += 1

    # Con media temporada o menos no vale la pena: sería un ancla tan ruidosa
    # como el problema que intenta resolver.
    if n < 100:
        print(f"Prior {codigo_liga}: solo {n} partidos en {season}, insuficiente. "
              f"Se usa la constante de respaldo.", file=sys.stderr)
        return respaldo

    entry = {"avg_local": gl / n, "avg_visita": gv / n,
             "origen": f"temporada {season}", "partidos": n, "temporada": season,
             "actualizado": ahora().isoformat()}
    if es_torneo:
        entry["historial"] = historial_de_partidos(matches)
    else:
        cache.setdefault("partidos_liga", {})[codigo_liga + ":previa"] = {
            "temporada": season, "partidos": partidos_compactos(matches),
            "actualizado": entry["actualizado"], "formato": FORMATO_LISTAS}
    priors[codigo_liga] = entry
    return entry


# ==========================================
# PROMEDIO DE GOLES POR LIGA
# ==========================================
def obtener_promedio_liga(codigo_liga, cache):
    """Media de goles en casa y fuera de la temporada en curso, anclada en la
    anterior. De una liga guarda además sus partidos ya jugados (partidos_liga),
    de los que salen las fuerzas de todos sus equipos: una petición por liga
    cada HORAS_VALIDEZ_LIGA."""
    entry = cache["ligas"].get(codigo_liga)
    es_torneo = codigo_liga in TORNEOS.values()
    if (entry and esta_vigente(entry.get("actualizado"), HORAS_VALIDEZ_LIGA / 24)
            and ("historial" in entry if es_torneo
                 else _lista_vigente(cache, codigo_liga + ":actual", temporada_actual(codigo_liga)))):
        return entry

    prior = obtener_prior_liga(codigo_liga, cache)

    resp = get_con_pausa(f"{BASE_URL}/competitions/{codigo_liga}/matches", {"status": "FINISHED"})
    if resp.status_code != 200:
        print(f"Liga {codigo_liga}: HTTP {resp.status_code}, uso solo el prior.", file=sys.stderr)
        return {"avg_local": prior["avg_local"], "avg_visita": prior["avg_visita"],
                "partidos": 0, "prior": prior["origen"], "actualizado": None}

    matches = resp.json().get("matches", [])
    if not es_torneo:
        matches = solo_liga(matches)
    goles_local, goles_visita, partidos = 0, 0, 0
    for match in matches:
        gl, gv = goles_90(match)
        if gl is None or gv is None:
            continue
        goles_local += gl
        goles_visita += gv
        partidos += 1

    # Regularización: en la jornada 3 hay 30 partidos, no basta para fijar la media
    # de la liga. Se mezcla con el prior histórico y el prior va pesando menos
    # conforme avanza la temporada.
    promedio = {
        "avg_local": (goles_local + K_LIGA * prior["avg_local"]) / (partidos + K_LIGA),
        "avg_visita": (goles_visita + K_LIGA * prior["avg_visita"]) / (partidos + K_LIGA),
        "partidos": partidos,
        "prior": prior["origen"],
        "prior_local": round(prior["avg_local"], 3),
        "prior_visita": round(prior["avg_visita"], 3),
        "actualizado": ahora().isoformat()
    }
    if es_torneo:
        promedio["historial"] = historial_de_partidos(matches)
    else:
        cache.setdefault("partidos_liga", {})[codigo_liga + ":actual"] = {
            "temporada": temporada_actual(codigo_liga), "partidos": partidos_compactos(matches),
            "actualizado": promedio["actualizado"], "formato": FORMATO_LISTAS}
    cache["ligas"][codigo_liga] = promedio
    return promedio


# ==========================================
# FUERZAS: ataque y defensa de cada equipo, ajustados por el rival
# ==========================================
def prior_recien_llegado(codigo_liga, team_id, de_arriba):
    """(ataque, defensa) de los que parte un equipo que no estaba en la liga la
    temporada anterior: el de un descendido si viene de la liga de arriba
    (de_arriba: los equipos que la jugaron, ver LIGA_DE_ARRIBA) y si no, el de
    un ascendido de esa liga."""
    if team_id in de_arriba:
        return ATAQUE_DESCENDIDO, DEFENSA_DESCENDIDO
    return ATAQUE_RECIEN_LLEGADO, DEFENSA_RECIEN_LLEGADO.get(codigo_liga, 1.0)


def ajustar_fuerzas(previa, actual, media, inicio=None, codigo_liga=None, de_arriba=()):
    """Ataque y defensa de todos los equipos de una liga.

    previa y actual son las listas de partidos_compactos de la temporada
    anterior y la actual (lo jugado hasta hoy); media, la de obtener_promedio_liga.
    Los goles esperados de un partido son media x ataque propio x defensa rival,
    y cada fuerza se elige para que cuadren con lo que pasó:

        ataque = (goles marcados + k·a0) / (goles que habría marcado un equipo
                  medio contra esas mismas defensas + k)

    y lo mismo con la defensa. Como cada una depende de las de los rivales, se
    repite hasta que no cambian (TOLERANCIA_FUERZAS). Cada partido pesa
    FACTOR_DIARIO^días (días contados hasta el último partido de la lista), y
    k (PSEUDO_GOLES_*) son goles esperados de un equipo de prior: con pocos
    partidos, la fuerza queda cerca de a0, que es 1 o, para un equipo que no
    estaba la temporada anterior, lo que diga prior_recien_llegado (de_arriba:
    los equipos de la temporada anterior de la liga de arriba).

    Mismas operaciones y en el mismo orden que ajustarFuerzas en
    worker/modelo.js: test_paridad.py comprueba que dan lo mismo. inicio (unas
    fuerzas anteriores) solo acelera la convergencia; lo usa validacion.py.

    Devuelve {"equipos": {id: [ataque, defensa, partidos]}, "con_previa",
    "codigo", "de_arriba", "dia", "iteraciones"}; los equipos sin ningún
    partido no salen (fuerza_equipo).
    """
    todos = list(previa) + list(actual)
    con_previa = len(previa) > 0
    de_arriba = list(dict.fromkeys(de_arriba))
    if not todos:
        return {"equipos": {}, "con_previa": con_previa, "codigo": codigo_liga, "de_arriba": de_arriba,
                "dia": None, "iteraciones": 0}
    ref = max(p[0] for p in todos)
    ids, idx = [], {}
    for p in todos:
        for t in (p[1], p[2]):
            if t not in idx:
                idx[t] = len(ids)
                ids.append(t)
    T = len(ids)
    previos = set()
    for p in previa:
        previos.add(p[1]); previos.add(p[2])
    arriba = set(de_arriba)
    a0, d0 = [], []
    for t in ids:
        a, d = (prior_recien_llegado(codigo_liga, t, arriba) if con_previa and t not in previos
                else (1.0, 1.0))
        a0.append(a)
        d0.append(d)
    # pesos por antigüedad, multiplicando día a día: el mismo double en los dos lenguajes
    pesos = [1.0]
    for _ in range(ref - min(p[0] for p in todos)):
        pesos.append(pesos[-1] * FACTOR_DIARIO)
    ml, mv = media["avg_local"], media["avg_visita"]
    k_at, k_de = PSEUDO_GOLES_ATAQUE, PSEUDO_GOLES_DEFENSA
    num_at = [k_at * a for a in a0]
    num_de = [k_de * d for d in d0]
    jugados = [0] * T
    # peso total de cada cruce (i en casa contra j): lo único que hace falta de
    # cada partido en las vueltas del ajuste, que así cuestan T² y no lo que
    # tenga la lista (24 equipos: 576 cruces frente a ~1.100 partidos)
    cruce = [[0.0] * T for _ in range(T)]
    for d, loc, vis, gl, gv in todos:
        i, j, w = idx[loc], idx[vis], pesos[ref - d]
        num_at[i] += w * gl
        num_at[j] += w * gv
        num_de[i] += w * gv
        num_de[j] += w * gl
        jugados[i] += 1
        jugados[j] += 1
        cruce[i][j] += w
    # lo que pesa la defensa de j en los goles esperados de i (en casa, media
    # local; fuera, media visitante), y el ataque de j en los que encaja i
    pesa_de = [[ml * cruce[i][j] + mv * cruce[j][i] for j in range(T)] for i in range(T)]
    pesa_at = [[mv * cruce[i][j] + ml * cruce[j][i] for j in range(T)] for i in range(T)]
    ataque = list(a0)
    defensa = list(d0)
    if inicio:
        for x, t in enumerate(ids):
            e = inicio.get(str(t))
            if e:
                ataque[x], defensa[x] = e[0], e[1]
    it = 0
    while it < MAX_ITER_FUERZAS:
        it += 1
        nuevo_at = [0.0] * T
        for i in range(T):
            fila, den = pesa_de[i], float(k_at)
            for j in range(T):
                den += fila[j] * defensa[j]
            nuevo_at[i] = num_at[i] / den
        nueva_de = [0.0] * T
        for i in range(T):
            fila, den = pesa_at[i], float(k_de)
            for j in range(T):
                den += fila[j] * nuevo_at[j]
            nueva_de[i] = num_de[i] / den
        cambio = 0.0
        for x in range(T):
            cambio = max(cambio, abs(nuevo_at[x] - ataque[x]), abs(nueva_de[x] - defensa[x]))
        ataque, defensa = nuevo_at, nueva_de
        if cambio < TOLERANCIA_FUERZAS:
            break
    return {"equipos": {str(t): [ataque[x], defensa[x], jugados[x]] for x, t in enumerate(ids)},
            "con_previa": con_previa, "codigo": codigo_liga, "de_arriba": de_arriba,
            "dia": ref, "iteraciones": it}


def fuerza_equipo(fuerzas, team_id):
    """Ataque, defensa y partidos de un equipo. Uno sin partidos todavía (un
    ascendido o un descendido antes de debutar) parte de la fuerza de un recién
    llegado."""
    e = fuerzas["equipos"].get(str(team_id))
    if e:
        return {"ataque": e[0], "defensa": e[1], "partidos": e[2]}
    if not fuerzas["con_previa"]:
        return {"ataque": 1.0, "defensa": 1.0, "partidos": 0}
    a, d = prior_recien_llegado(fuerzas.get("codigo"), team_id, fuerzas.get("de_arriba", ()))
    return {"ataque": a, "defensa": d, "partidos": 0}


def equipos_de_partidos(partidos):
    """Los equipos de una lista de partidos_compactos, en orden de aparición."""
    return list(dict.fromkeys(t for p in partidos for t in (p[1], p[2])))


def obtener_fuerzas_liga(codigo_liga, cache):
    """Las fuerzas de todos los equipos de una liga, con los partidos que ya
    bajaron obtener_prior_liga y obtener_promedio_liga (y, en una liga con
    LIGA_DE_ARRIBA, la temporada anterior de la de arriba, que esa liga ya baja
    para sus propios partidos). No pide nada más: se recalculan solo cuando
    cambia alguna lista."""
    promedio = obtener_promedio_liga(codigo_liga, cache)
    season = temporada_actual(codigo_liga)
    previa = _lista_vigente(cache, codigo_liga + ":previa", season - 1) or {}
    actual = _lista_vigente(cache, codigo_liga + ":actual", season) or {}
    version = (f"{VERSION_MODELO}|{previa.get('actualizado')}|{actual.get('actualizado')}"
               f"|{promedio.get('actualizado')}")
    arriba = {}
    if codigo_liga in LIGA_DE_ARRIBA:
        sup = LIGA_DE_ARRIBA[codigo_liga]
        obtener_prior_liga(sup, cache)
        arriba = _lista_vigente(cache, sup + ":previa", temporada_actual(sup) - 1) or {}
        version += f"|{arriba.get('actualizado')}"
    guardadas = cache.setdefault("fuerzas", {}).get(codigo_liga)
    if guardadas and guardadas.get("version") == version:
        return guardadas
    fuerzas = ajustar_fuerzas(previa.get("partidos", []), actual.get("partidos", []), promedio,
                              codigo_liga=codigo_liga,
                              de_arriba=equipos_de_partidos(arriba.get("partidos", [])))
    fuerzas["version"] = version
    cache["fuerzas"][codigo_liga] = fuerzas
    return fuerzas


def calcular_xg_partido(local, visita, promedio_liga):
    """Goles esperados: media de la liga x ataque propio x defensa del rival
    (local y visita son lo que da fuerza_equipo)."""
    xg_local = promedio_liga["avg_local"] * local["ataque"] * visita["defensa"]
    xg_visita = promedio_liga["avg_visita"] * visita["ataque"] * local["defensa"]
    return round(xg_local, 2), round(xg_visita, 2)


def _tau(gl, gv, la, lv):
    """Corrección de Dixon-Coles (RHO_EMPATES) para un marcador: solo toca 0-0,
    1-0, 0-1 y 1-1."""
    if gl == 0 and gv == 0:
        return 1 - la * lv * RHO_EMPATES
    if gl == 0 and gv == 1:
        return 1 + la * RHO_EMPATES
    if gl == 1 and gv == 0:
        return 1 + lv * RHO_EMPATES
    if gl == 1 and gv == 1:
        return 1 - RHO_EMPATES
    return 1.0


def calcular_poisson(gla, gvi, limite=LIMITE_GOLES):
    pl, pe, pv = 0.0, 0.0, 0.0
    for gl in range(limite + 1):
        p_gl = poisson.pmf(gl, gla)
        for gv in range(limite + 1):
            prob = p_gl * poisson.pmf(gv, gvi)
            if gl <= 1 and gv <= 1:
                prob = prob * _tau(gl, gv, gla, gvi)
            if gl > gv: pl += prob
            elif gl == gv: pe += prob
            else: pv += prob

    # La rejilla es finita, así que siempre falta un poco de masa. Se normaliza
    # para que 1 + X + 2 sume exactamente 100 y las dobles cuadren.
    total = pl + pe + pv
    pl, pe, pv = pl / total, pe / total, pv / total

    # Nombres con prefijo "prob_" para que NUNCA choquen con las claves
    # "local"/"visita" que ya usamos para los nombres de los equipos.
    # float() a propósito: scipy devuelve np.float64 y eso se propaga hasta el JSON,
    # donde revienta al serializar (y las comparaciones acaban dando np.bool_).
    return {
        "prob_local": round(float(pl) * 100, 2),
        "prob_empate": round(float(pe) * 100, 2),
        "prob_visita": round(float(pv) * 100, 2),
        "prob_1x": round(float(pl + pe) * 100, 2),
        "prob_x2": round(float(pe + pv) * 100, 2),
        "prob_12": round(float(pl + pv) * 100, 2),
    }


EMPATE_MARCADORES = 1e-9


def _tres_mejores(flat, n):
    """Los tres marcadores más probables de la rejilla (aplanada, n×n), como
    mercadosDeGoles en el Worker. Con los goles esperados en una proporción exacta
    (1.0 y 2.0, 0.5 y 2.0...) hay marcadores con la misma probabilidad, que Python y
    JavaScript calculan con una diferencia en el último bit: por debajo de
    EMPATE_MARCADORES (relativo) cuentan como empate, y en un empate va primero el
    que deja al visitante con menos goles (el 1-0 antes que el 0-1)."""
    a = b = c = -1
    for j in range(n):
        for i in range(n):
            k = i * n + j
            v = flat[k]
            if a < 0 or v > flat[a] * (1 + EMPATE_MARCADORES):
                a, b, c = k, a, b
            elif b < 0 or v > flat[b] * (1 + EMPATE_MARCADORES):
                b, c = k, b
            elif c < 0 or v > flat[c] * (1 + EMPATE_MARCADORES):
                c = k
    return a, b, c


def mercados_de_goles(xg_local, xg_visita, promedio_liga, limite=LIMITE_GOLES):
    """Más/menos, ambos marcan, porterías a cero, por cuánto gana y marcadores
    más probables.

    Salen todos de una misma rejilla de marcadores, así que no se contradicen
    entre sí. Esa rejilla usa los goles esperados con su total acercado a la media
    de la liga (ENCOGER_TOTAL) y el reparto entre los dos equipos del 1X2, con la
    misma corrección de los marcadores bajos (RHO_EMPATES). Con dos equipos medios
    el acercamiento no cambia nada, así que la base "equipo medio" de la
    validación es la misma rejilla.
    """
    total_liga = promedio_liga["avg_local"] + promedio_liga["avg_visita"]
    total_xg = xg_local + xg_visita
    escala = (total_liga + ENCOGER_TOTAL * (total_xg - total_liga)) / total_xg if total_xg > 0 else 1.0
    gla = xg_local * escala
    gvi = xg_visita * escala

    goles = np.arange(limite + 1)
    rejilla = np.outer(poisson.pmf(goles, gla), poisson.pmf(goles, gvi))
    for i in (0, 1):
        for j in (0, 1):
            rejilla[i, j] = rejilla[i, j] * _tau(i, j, gla, gvi)
    rejilla /= rejilla.sum()    # misma normalización que calcular_poisson
    total = np.add.outer(goles, goles)
    dif = np.subtract.outer(goles, goles)
    reparto = [rejilla[total == k].sum() for k in range(5)] + [rejilla[total >= 5].sum()]
    mejores = _tres_mejores(rejilla.ravel(), limite + 1)

    pc = lambda v: round(float(v) * 100, 2)    # float(): np.float64 no va al JSON
    return {
        "goles_total": round(float(gla + gvi), 2),
        # "menos de" es el complemento: la web lo calcula como 100 - esto
        "prob_mas_15": pc(rejilla[total > 1.5].sum()),
        "prob_mas_25": pc(rejilla[total > 2.5].sum()),
        "prob_mas_35": pc(rejilla[total > 3.5].sum()),
        "prob_ambos": pc(rejilla[1:, 1:].sum()),
        # portería a cero del local = el visitante no marca, y al revés
        "prob_cero_local": pc(rejilla[:, 0].sum()),
        "prob_cero_visita": pc(rejilla[0, :].sum()),
        # gana por 2 goles o más, y gana sin que el otro marque
        "prob_gana2_local": pc(rejilla[dif >= 2].sum()),
        "prob_gana2_visita": pc(rejilla[dif <= -2].sum()),
        "prob_gana_cero_local": pc(rejilla[1:, 0].sum()),
        "prob_gana_cero_visita": pc(rejilla[0, 1:].sum()),
        # goles totales del partido: 0, 1, 2, 3, 4 y 5 o más
        "goles_reparto": [pc(v) for v in reparto],
        # los tres marcadores más probables: [goles local, goles visitante, %]
        "marcadores": [[int(k // (limite + 1)), int(k % (limite + 1)), pc(rejilla.flat[k])]
                       for k in mejores],
    }


# ==========================================
# CHAMPIONS: la fuerza de cada equipo, medida en su liga nacional
# ==========================================
def liga_domestica(team_id, cache):
    """Código de la liga del plan en la que juega un equipo, o None si juega en
    otra (Bélgica, Austria...). Primero se busca gratis en los calendarios de
    liga ya descargados; si no sale, una petición a /teams/{id}, que trae las
    competiciones que disputa. Se guarda un mes: no cambia en la temporada."""
    mapa = cache.setdefault("liga_equipo", {})
    entrada = mapa.get(str(team_id))
    # un fallo se recuerda un día: si /teams/{id} no responde, no se reintenta en
    # cada pasada de 5 minutos
    dias = 1 if entrada and entrada.get("fallo") else DIAS_VALIDEZ_LIGA_EQUIPO
    if entrada and esta_vigente(entrada.get("actualizado"), dias):
        return entrada["liga"]

    liga = None
    for codigo in LIGAS.values():
        for m in cache.get("fixtures", {}).get(codigo, {}).get("matches", []):
            if team_id in ((m.get("homeTeam") or {}).get("id"), (m.get("awayTeam") or {}).get("id")):
                liga = codigo
                break
        if liga:
            break
    if liga is None:
        resp = get_con_pausa(f"{BASE_URL}/teams/{team_id}")
        if resp.status_code != 200:
            print(f"Equipo {team_id}: HTTP {resp.status_code} al buscar su liga, cuenta como otra liga.",
                  file=sys.stderr)
            mapa[str(team_id)] = {"liga": None, "fallo": True, "actualizado": ahora().isoformat()}
            return None
        codigos = [c.get("code") for c in resp.json().get("runningCompetitions", [])]
        liga = next((c for c in LIGAS.values() if c in codigos), None)
    mapa[str(team_id)] = {"liga": liga, "actualizado": ahora().isoformat()}
    return liga


def historial_champions(team_id, factor, cache, codigo="CL"):
    """Lo que un equipo marcó y encajó en sus partidos de Champions de esta
    temporada y la anterior, y lo que se esperaba de él en esos partidos: la
    media de la Champions de esa temporada por ESCALA_CHAMPIONS, por su nivel de
    liga y entre el del rival (al revés para lo encajado). Los partidos los
    bajaron ya obtener_promedio_liga y obtener_prior_liga; solo puede costar
    alguna petición la liga de un rival que aún no esté en la caché."""
    gf = gc = esperado_f = esperado_c = 0.0
    n = 0
    for entrada in (cache.get("ligas", {}).get(codigo), cache.get("priors", {}).get(codigo)):
        if not entrada:
            continue
        mu_l, mu_v = entrada["avg_local"], entrada["avg_visita"]
        for rival, en_casa, a_favor, en_contra in entrada.get("historial", {}).get(str(team_id), []):
            f_rival = FACTOR_LIGA.get(liga_domestica(rival, cache), FACTOR_OTRA_LIGA)
            if en_casa:
                esperado_f += mu_l * ESCALA_CHAMPIONS[0] * factor / f_rival
                esperado_c += mu_v * ESCALA_CHAMPIONS[1] * f_rival / factor
            else:
                esperado_f += mu_v * ESCALA_CHAMPIONS[1] * factor / f_rival
                esperado_c += mu_l * ESCALA_CHAMPIONS[0] * f_rival / factor
            gf += a_favor
            gc += en_contra
            n += 1
    return {"partidos": n, "gf": gf, "gc": gc, "esperado_f": esperado_f, "esperado_c": esperado_c}


def multiplicadores_historial(h, k=K_HISTORIAL_CHAMPIONS):
    """(ataque, defensa) que aporta el historial de Champions: goles marcados y
    encajados frente a lo esperado, encogidos hacia 1 con k goles de
    pseudo-cuenta. Sin partidos, (1, 1): el equipo queda con su liga."""
    return (h["gf"] + k) / (h["esperado_f"] + k), (h["gc"] + k) / (h["esperado_c"] + k)


def fuerzas_champions(team_id, cache):
    """Ataque y defensa de un equipo para un partido de Champions: su fuerza en
    su liga nacional (la misma de sus partidos de liga, obtener_fuerzas_liga),
    atenuada con EXPONENTE_FUERZA_CHAMPIONS, el nivel de su liga y su historial
    en la Champions (historial_champions). Un equipo de otra liga cuenta como un
    equipo medio de FACTOR_OTRA_LIGA, corregido por su historial."""
    liga = liga_domestica(team_id, cache)
    factor = FACTOR_LIGA.get(liga, FACTOR_OTRA_LIGA)
    h = historial_champions(team_id, factor, cache)
    ataque_cl, defensa_cl = multiplicadores_historial(h)
    historial = {"partidos_cl": h["partidos"], "ataque_cl": ataque_cl, "defensa_cl": defensa_cl}
    if liga is None:
        return {"liga": None, "nombre_liga": None, "factor": FACTOR_OTRA_LIGA,
                "ataque": 1.0, "defensa": 1.0, "muestra": 0, **historial}
    f = fuerza_equipo(obtener_fuerzas_liga(liga, cache), team_id)
    b = EXPONENTE_FUERZA_CHAMPIONS
    nombre = next((k for k, v in LIGAS.items() if v == liga), liga)
    return {"liga": liga, "nombre_liga": nombre, "factor": factor,
            "ataque": f["ataque"] ** b, "defensa": f["defensa"] ** b, "muestra": f["partidos"], **historial}


def calcular_xg_champions(local, visita, promedio_cl):
    """Goles esperados de un partido de Champions. Misma forma que
    calcular_xg_partido (ataque de uno por defensa del otro por la media), con
    la media de la Champions, el nivel de cada liga (el ataque se multiplica por
    el nivel propio y se divide por el del rival) y el historial de cada uno en
    la Champions."""
    xg_local = (promedio_cl["avg_local"] * ESCALA_CHAMPIONS[0]
                * local["ataque"] * visita["defensa"] * local["factor"] / visita["factor"]
                * local["ataque_cl"] * visita["defensa_cl"])
    xg_visita = (promedio_cl["avg_visita"] * ESCALA_CHAMPIONS[1]
                 * visita["ataque"] * local["defensa"] * visita["factor"] / local["factor"]
                 * visita["ataque_cl"] * local["defensa_cl"])
    return round(xg_local, 2), round(xg_visita, 2)


# ==========================================
# BUSCAR EL PRIMER DÍA CON PARTIDOS (hoy, luego mañana, etc.)
# ==========================================
def etiqueta_de_dia(fecha, hoy):
    """'Hoy', 'Mañana', o el día de la semana con la fecha."""
    dias = (fecha - hoy).days
    if dias == 0:
        return "Hoy"
    if dias == 1:
        return "Mañana"
    return DIAS_SEMANA[fecha.weekday()].capitalize()


def obtener_fixtures(cache, forzar=False):
    """Todos los partidos por jugar en la ventana, agrupados por día local.

    IMPORTANTE: usa /competitions/{codigo}/matches y NO el endpoint global
    /v4/matches. En el plan free el global responde HTTP 200 con lista VACÍA en vez
    de dar un 403, así que parece que simplemente no hay partidos.

    La lista se cachea HORAS_VALIDEZ_FIXTURES. Los partidos que ya empezaron se
    descartan al leer, no al pedir, así que la caché no hace que se muestren partidos
    viejos. La caché se invalida sola cuando cambia el día, porque el rango de fechas
    forma parte de la clave.
    """
    hoy = ahora().date()
    hasta = hoy + timedelta(days=MAX_DIAS_BUSQUEDA)
    rango = f"{hoy}/{hasta}"
    guardadas = cache.setdefault("fixtures", {})

    debug = []
    por_fecha = defaultdict(list)
    ahora_utc = datetime.now(timezone.utc)

    for nombre_liga, codigo in {**LIGAS, **TORNEOS}.items():
        entrada = guardadas.get(codigo)
        vigente = (entrada and not forzar
                   and entrada.get("rango") == rango
                   and entrada.get("actualizado")
                   and ahora() - _parsear_fecha(entrada["actualizado"])
                       < timedelta(hours=HORAS_VALIDEZ_FIXTURES))

        if vigente:
            matches = entrada["matches"]
            edad = int((ahora() - _parsear_fecha(entrada["actualizado"])).total_seconds() / 60)
            info = {"liga": codigo, "origen": f"caché ({edad} min)", "http_status": None}
        else:
            resp = get_con_pausa(f"{BASE_URL}/competitions/{codigo}/matches", {
                "dateFrom": hoy.isoformat(),
                "dateTo": hasta.isoformat(),
                # solo lo que aún no se ha jugado: es una web de pronósticos
                "status": "SCHEDULED,TIMED",
            })
            body = resp.json() if resp.status_code == 200 else {}
            matches = body.get("matches", [])
            info = {"liga": codigo, "origen": "API", "http_status": resp.status_code,
                    "mensaje_api": body.get("message")}
            if resp.status_code == 200:
                guardadas[codigo] = {"matches": matches, "rango": rango,
                                     "actualizado": ahora().isoformat()}
            elif entrada and entrada.get("rango") == rango:
                # la API falló pero teníamos algo del mismo rango: mejor eso que nada
                matches = entrada["matches"]
                info["origen"] = "caché (la API falló)"

        vivos = 0
        for m in matches:
            if not (m.get("homeTeam") or {}).get("id") or not (m.get("awayTeam") or {}).get("id"):
                continue   # eliminatoria con un cruce todavía sin decidir
            dt = datetime.fromisoformat(m["utcDate"].replace("Z", "+00:00"))
            if dt <= ahora_utc:
                continue   # ya empezó: fuera, aunque la caché aún lo traiga
            p = dict(m)
            # el endpoint por competición no repite el bloque "competition" en cada
            # partido, así que se lo inyectamos: el resto del pipeline lo usa
            p["competition"] = {"code": codigo, "name": nombre_liga}
            # la fecha viene en UTC; a hora local para que "hoy" signifique lo mismo
            p["_fecha_local"] = dt.astimezone(TZ)
            por_fecha[p["_fecha_local"].date()].append(p)
            vivos += 1

        info.update({"rango_consultado": rango, "en_lista": len(matches),
                     "por_jugar": vivos, "hora_servidor_local": ahora().isoformat()})
        debug.append(info)

    for fecha in por_fecha:
        por_fecha[fecha].sort(key=lambda m: m["utcDate"])
    return por_fecha, debug


# ==========================================
# PIPELINE COMPLETO (corre en un hilo de fondo)
# ==========================================
def _predicciones_previas(estado):
    """Predicciones ya calculadas en pasadas anteriores, indexadas por id de partido."""
    previas = {}
    for dia in estado.get("dias", []):
        for p in dia.get("partidos", []):
            if p.get("id") is not None and p.get("prob_local") is not None:
                previas[p["id"]] = p
    return previas


def _sigue_fresca(partido):
    calculado = partido.get("calculado")
    if not calculado or partido.get("version_modelo") != VERSION_MODELO:
        return False
    return ahora() - _parsear_fecha(calculado) < timedelta(hours=HORAS_VALIDEZ_PREDICCION)


def _escudo(equipo):
    """URL del escudo solo si es https: va a parar a un <img src> en la web, y lo
    que manda la API externa no se pinta sin filtrar."""
    url = equipo.get("crest") or ""
    return url if url.startswith("https://") else None


def _ficha_base(match):
    """Los datos del partido que se conocen sin gastar ni una petición."""
    local, visita = match["homeTeam"], match["awayTeam"]
    return {
        "id": match["id"],
        "local": local["name"],
        "visita": visita["name"],
        # el id de cada equipo: la web de Cloudflare enlaza con su página (#/equipo/86)
        "local_id": local["id"],
        "visita_id": visita["id"],
        # nombre corto, abreviatura de tres letras y escudo: vienen ya en la misma
        # respuesta del calendario, así que no cuestan peticiones. Con .get() porque
        # la web funciona igual si algún equipo no los trae.
        "local_corto": local.get("shortName"),
        "visita_corto": visita.get("shortName"),
        "local_sigla": local.get("tla"),
        "visita_sigla": visita.get("tla"),
        "local_escudo": _escudo(local),
        "visita_escudo": _escudo(visita),
        "liga": match["competition"]["name"],
        # código estable ("PD", "PL"...) para que la web pueda agrupar por liga
        # sin depender del nombre, que puede venir escrito de formas distintas
        "liga_codigo": match["competition"]["code"],
        "hora": match["_fecha_local"].strftime("%H:%M"),
        "utcDate": match["utcDate"],
    }


def _construir_estado(por_fecha, calculadas, estado_texto, debug=None):
    """Arma el JSON que consume la web: días en orden, partidos en orden de hora."""
    hoy = ahora().date()
    dias = []
    pendientes = 0
    total = 0
    for fecha in sorted(por_fecha):
        partidos = []
        for m in por_fecha[fecha]:
            total += 1
            ficha = calculadas.get(m["id"])
            if ficha is None:
                # todavía sin calcular: se muestra igualmente, con los datos que
                # ya tenemos, para que se vea el calendario completo desde el principio
                ficha = dict(_ficha_base(m), pendiente=True)
                pendientes += 1
            partidos.append(ficha)
        dias.append({
            "fecha": fecha.isoformat(),
            "etiqueta": etiqueta_de_dia(fecha, hoy),
            "partidos": partidos,
        })

    estado = {
        "estado": estado_texto,
        "dias": dias,
        "total": total,
        "pendientes": pendientes,
        "requests_gastadas": _requests_gastadas,
        "ultima_actualizacion": ahora().isoformat(),
    }
    if debug is not None:
        estado["debug_busqueda"] = debug
    return estado


def correr_actualizacion(forzar=False):
    """Calcula las predicciones de la ventana completa, poco a poco.

    Cada ejecución gasta como mucho PRESUPUESTO_REQUESTS peticiones. Lo que no
    da tiempo a calcular queda marcado como pendiente y lo recoge la siguiente
    ejecución, que empieza por los partidos más cercanos. Las predicciones ya
    hechas se conservan mientras sigan frescas, así el presupuesto se gasta en
    lo que falta y no en rehacer lo mismo.
    """
    global actualizando_ahora
    if actualizando_ahora:
        return  # ya hay una actualización en curso, no dupliques
    actualizando_ahora = True
    reset_presupuesto()

    try:
        cache = cargar_cache()
        por_fecha, debug = obtener_fixtures(cache, forzar=forzar)
        guardar_cache(cache)   # que la lista recién pedida no se pierda
                               # si la pasada se corta a la mitad

        if not por_fecha:
            escribir_estado({
                "estado": "sin_partidos",
                "dias": [],
                "total": 0,
                "pendientes": 0,
                "ultima_actualizacion": ahora().isoformat(),
                "debug_busqueda": debug,
            })
            return

        # Arrancamos de lo que ya había calculado y sigue siendo válido.
        previas = _predicciones_previas(leer_estado())
        calculadas = {}
        for fecha in por_fecha:
            for m in por_fecha[fecha]:
                anterior = previas.get(m["id"])
                if anterior and _sigue_fresca(anterior):
                    calculadas[m["id"]] = anterior

        # Se pinta ya el calendario entero: los partidos sin número salen como
        # pendientes en vez de no aparecer.
        escribir_estado(_construir_estado(por_fecha, calculadas, "actualizando", debug))

        # Orden cronológico: lo más cercano primero, que es lo que interesa antes.
        cola = [m for fecha in sorted(por_fecha) for m in por_fecha[fecha]
                if m["id"] not in calculadas]

        agotado = False
        for match in cola:
            # Un partido de una liga ya bajada no gasta peticiones, así que se
            # calcula igual aunque quede poco presupuesto. Solo paramos cuando de
            # verdad se agotó.
            if presupuesto_agotado():
                agotado = True
                break

            local_id = match["homeTeam"]["id"]
            visita_id = match["awayTeam"]["id"]
            codigo_liga = match["competition"]["code"]

            promedio_liga = obtener_promedio_liga(codigo_liga, cache)
            extra = {}
            if codigo_liga in TORNEOS.values():
                f_local = fuerzas_champions(local_id, cache)
                f_visita = fuerzas_champions(visita_id, cache)
                xg_local, xg_visita = calcular_xg_champions(f_local, f_visita, promedio_liga)
                muestra_local, muestra_visita = f_local["muestra"], f_visita["muestra"]
                # de qué liga sale cada equipo, con qué nivel y qué dice su historial
                # en la Champions: la web lo explica
                extra["champions"] = {lado: {"liga": f["liga"], "nombre_liga": f["nombre_liga"],
                                             "factor": f["factor"], "partidos_cl": f["partidos_cl"],
                                             "ataque_cl": round(f["ataque_cl"], 2),
                                             "defensa_cl": round(f["defensa_cl"], 2)}
                                      for lado, f in (("local", f_local), ("visita", f_visita))}
            else:
                fuerzas = obtener_fuerzas_liga(codigo_liga, cache)
                f_local = fuerza_equipo(fuerzas, local_id)
                f_visita = fuerza_equipo(fuerzas, visita_id)
                xg_local, xg_visita = calcular_xg_partido(f_local, f_visita, promedio_liga)
                muestra_local, muestra_visita = f_local["partidos"], f_visita["partidos"]
            probs = calcular_poisson(xg_local, xg_visita)
            goles = mercados_de_goles(xg_local, xg_visita, promedio_liga)

            calculadas[match["id"]] = dict(
                _ficha_base(match),
                xg_local=xg_local, xg_visita=xg_visita,
                # la media de goles de la liga con la que se calculó: la base "equipo
                # medio" del registro en vivo del Worker
                media_local=round(promedio_liga["avg_local"], 3),
                media_visita=round(promedio_liga["avg_visita"], 3),
                version_modelo=VERSION_MODELO,
                # cuántos partidos de liga (esta temporada y la anterior) hay detrás
                # de cada equipo: si son pocos, la predicción está dominada por el
                # prior y conviene saberlo
                muestra_local=muestra_local,
                muestra_visita=muestra_visita,
                calculado=ahora().isoformat(),
                pendiente=False,
                **probs, **goles, **extra
            )

            # se escribe el progreso DESPUÉS de cada partido -> la web los va
            # rellenando de uno en uno en vez de todos de golpe al final
            escribir_estado(_construir_estado(por_fecha, calculadas, "actualizando", debug))
            guardar_cache(cache)

        guardar_cache(cache)
        # "parcial" = quedan partidos sin calcular y hay que esperar a la siguiente
        # pasada del cron. "listo" = la ventana entera tiene número.
        final = _construir_estado(por_fecha, calculadas,
                                  "parcial" if agotado else "listo", debug)
        escribir_estado(final)

    except Exception as e:
        print(f"Error en la actualización: {e}", file=sys.stderr)
        estado = leer_estado()
        estado["estado"] = "error"
        estado["error"] = str(e)
        escribir_estado(estado)
    finally:
        actualizando_ahora = False


# ==========================================
# RUTAS WEB
# ==========================================
# Mudanza a Cloudflare: con REDIRIGIR_A=https://... en Render → Environment, la
# app manda cada petición a la misma ruta en la dirección nueva y el planificador
# no arranca, así Render deja de gastar la cuota de la API que ahora usa el
# Worker (es el mismo token: entre los dos se pasarían de 10 por minuto).
# 302 y no 301: si hubiera que volver atrás, los navegadores no lo recuerdan.
REDIRIGIR_A = os.environ.get("REDIRIGIR_A", "").rstrip("/")


@app.before_request
def redirigir_a_cloudflare():
    if REDIRIGIR_A:
        consulta = request.query_string.decode()
        return redirect(REDIRIGIR_A + request.path + ("?" + consulta if consulta else ""), code=302)


# Lo que la web puede cargar (Content-Security-Policy). El JavaScript va en
# public/app.js y no en línea, así que basta script-src 'self': si un nombre de
# equipo con <script> o un onerror= se colara por un fallo de escapado, el
# navegador no lo ejecutaría. De fuera, solo Cloudflare Turnstile (al crear una
# cuenta, que en Render no sale). Las mismas cabeceras van en public/_headers para
# Cloudflare (test_paridad.py comprueba que coinciden).
CSP_WEB = ("default-src 'none'; script-src 'self' https://challenges.cloudflare.com; "
           "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
           "font-src https://fonts.gstatic.com; "
           "img-src 'self' data: https://crests.football-data.org; "
           "connect-src 'self'; manifest-src 'self'; worker-src 'self'; "
           "frame-src https://challenges.cloudflare.com; "
           "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
# El JSON no carga nada.
CSP_API = "default-src 'none'; frame-ancestors 'none'"


@app.after_request
def agregar_headers_seguridad(response):
    # Básicos y sin costo: evitan que el navegador "adivine" tipos de contenido
    # o que la página se incruste en un iframe ajeno (clickjacking).
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    # sw.js lleva la de la web: su connect-src 'self' es lo que le deja pedir la página
    web = response.mimetype == "text/html" or request.path == "/sw.js"
    response.headers["Content-Security-Policy"] = CSP_WEB if web else CSP_API
    # Solo por HTTPS (Render ya redirige el HTTP; esto evita hasta el primer salto).
    response.headers["Strict-Transport-Security"] = "max-age=31536000"
    # Esto es un panel en vivo: cachear el HTML solo consigue que después de un
    # deploy sigas viendo la interfaz anterior hasta que hagas Ctrl+F5. Y el JSON
    # de /api/estado cambia cada pocos segundos, así que cachearlo es peor aún.
    response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/partido/<int:id_partido>")
def partido(id_partido):
    """El enlace para compartir un partido: la misma web, que abre ese partido.
    La tarjeta con sus números (Open Graph) solo la pone Cloudflare
    (worker/compartir.js); aquí sale la de siempre."""
    return render_template("index.html")


@app.route("/privacidad")
def privacidad():
    """La política de privacidad: una página estática de public/ (en Cloudflare la
    sirven los archivos estáticos, sin pasar por el Worker)."""
    return send_from_directory(app.template_folder, "privacidad.html", mimetype="text/html")


@app.route("/app.js")
def app_js():
    return send_from_directory(app.template_folder, "app.js", mimetype="text/javascript")


# Los demás archivos de public/ que pide la web: instalarla como app (manifiesto,
# service worker e iconos) y la imagen para compartir. Lista cerrada: nada más de
# public/ se sirve por esta ruta.
ARCHIVOS_WEB = {
    "manifest.webmanifest": "application/manifest+json",
    "sw.js": "text/javascript",
    "imagen.js": "text/javascript",
    "icono-192.png": "image/png",
    "icono-512.png": "image/png",
    "icono-maskable-512.png": "image/png",
    "apple-touch-icon.png": "image/png",
    "insignia-96.png": "image/png",
    "og.png": "image/png",
}


@app.route("/<nombre>")
def archivo_web(nombre):
    if nombre not in ARCHIVOS_WEB:
        abort(404)
    return send_from_directory(app.template_folder, nombre, mimetype=ARCHIVOS_WEB[nombre])


def token_valido():
    """El ?token= de /actualizar y /validar contra UPDATE_SECRET.

    hmac.compare_digest en vez de == : compara en tiempo constante, así nadie
    puede adivinar el token midiendo milisegundos de respuesta. En bytes: con
    str, un carácter no ASCII en el token hacía saltar un error 500."""
    return hmac.compare_digest(request.args.get("token", "").encode(), UPDATE_SECRET.encode())


def _condicional(resp):
    """ETag y 304, como el Worker: la web pregunta cada minuto y casi siempre no
    cambió nada."""
    resp.add_etag()
    return resp.make_conditional(request)


@app.route("/api/estado")
def api_estado():
    return _condicional(jsonify(leer_estado()))


@app.route("/actualizar")
def actualizar():
    """cron-job.org le pega a esta ruta cada cierto tiempo."""
    if not token_valido():
        return jsonify({"error": "token inválido"}), 403

    if actualizando_ahora:
        return jsonify({"mensaje": "ya hay una actualización en curso"})

    # &forzar=1 salta la espera. Sigue exigiendo el token, así que no lo puede
    # usar cualquiera; es solo para desarrollar sin esperar.
    forzar = request.args.get("forzar") in ("1", "true", "si")

    estado_actual = leer_estado()

    # Si la pasada anterior se quedó a medias, continuar NO es rehacer trabajo:
    # son partidos que aún no tienen número. La espera existe para no gastar cuota
    # repitiendo lo mismo, así que no debe frenar esto. Con varias ligas la ventana
    # no cabe en una sola pasada y sin esto tardaría horas en llenarse.
    quedan_pendientes = (estado_actual.get("estado") == "parcial"
                         and estado_actual.get("pendientes", 0) > 0)

    ultima = estado_actual.get("ultima_actualizacion")
    if ultima and not forzar and not quedan_pendientes:
        transcurrido = ahora() - _parsear_fecha(ultima)
        if transcurrido < MIN_INTERVALO_ACTUALIZACION:
            faltan = MIN_INTERVALO_ACTUALIZACION - transcurrido
            return jsonify({
                "mensaje": f"actualización reciente hace {int(transcurrido.total_seconds()/60)} min. "
                           f"Espera {int(faltan.total_seconds()/60)} min más para evitar gastar cuota de más."
            })

    # corre en un hilo aparte para responder rápido al cron y no colgar la request
    threading.Thread(target=correr_actualizacion, kwargs={"forzar": forzar},
                     daemon=True).start()
    return jsonify({"mensaje": "actualización iniciada"})


@app.route("/api/validacion")
def api_validacion():
    """Resultado del backtest del modelo desplegado, liga por liga."""
    import validacion
    return _condicional(jsonify(validacion.leer_resultado()))


@app.route("/api/tabla/<codigo>")
def api_tabla(codigo):
    """La tabla y la proyección de la temporada solo existen en Cloudflare
    (worker/tablas.js): el cron las baja en sus minutos libres y las guarda en D1."""
    return jsonify({"estado": "no_disponible", "liga": codigo,
                    "nota": "La tabla y la proyección funcionan en la versión de Cloudflare."})


@app.route("/equipo/<int:id_equipo>")
def equipo(id_equipo):
    """La página de un equipo para compartir: la misma web, que la abre. Su tarjeta
    (Open Graph) solo la pone Cloudflare (worker/equipos.js)."""
    return render_template("index.html")


@app.route("/api/equipo/<int:id_equipo>")
def api_equipo(id_equipo):
    """La página de cada equipo (su tabla, su fuerza y lo que dijo la web de sus
    últimos partidos) solo existe en Cloudflare (worker/equipos.js): necesita las
    tablas y el registro en vivo, que guarda D1."""
    return jsonify({"estado": "no_disponible", "id": id_equipo,
                    "nota": "La página de cada equipo funciona en la versión de Cloudflare."})


@app.route("/api/calendario", methods=["POST"])
def api_calendario():
    """El calendario de Mis equipos (.ics) solo existe en Cloudflare
    (worker/calendario.js): guarda cada calendario en D1. La web no lo ofrece aquí."""
    return jsonify({"disponible": False}), 404


@app.route("/api/avisos")
def api_avisos():
    """Los avisos de Mis equipos solo existen en Cloudflare (worker/avisos.js): los
    manda su cron. Aquí la web ni ofrece activarlos."""
    return jsonify({"disponible": False})


@app.route("/api/registro")
def api_registro():
    """El registro en vivo (lo publicado contra lo que pasó) solo existe en
    Cloudflare: necesita guardar las predicciones durante meses, y el disco de
    Render se borra en cada deploy."""
    return jsonify({"estado": "no_disponible", "partidos": 0,
                    "nota": "El registro en vivo funciona en la versión de Cloudflare: aquí el disco "
                            "se borra en cada despliegue."})


@app.route("/api/contar", methods=["POST"])
def api_contar():
    """La web avisa aquí de cada visita (public/app.js). Contarlas necesita una base
    que no se borre, así que solo se cuentan en Cloudflare (worker/visitas.js)."""
    return "", 204


@app.route("/api/cuenta")
def api_cuenta():
    """Las cuentas guardan los equipos de cada uno en una base que no se borre: solo
    existen en Cloudflare (worker/cuentas.js). La web, al ver esto, no las enseña."""
    return jsonify({"disponible": False, "cuenta": None})


@app.route("/validar")
def validar():
    """Lanza el backtest. Mismo token que /actualizar.

    Cuesta 2 peticiones por liga y solo la primera vez: las temporadas terminadas
    no cambian, así que quedan cacheadas en disco.
    """
    if not token_valido():
        return jsonify({"error": "token inválido"}), 403

    import validacion
    if validacion.validando_ahora:
        return jsonify({"mensaje": "ya hay una validación en curso"})
    if actualizando_ahora:
        return jsonify({"mensaje": "hay una actualización en curso; prueba en un minuto"})

    season = request.args.get("temporada", type=int)
    threading.Thread(target=validacion.correr_validacion, kwargs={"season": season},
                     daemon=True).start()
    return jsonify({"mensaje": "validación iniciada",
                    "consulta": "/api/validacion"})


@app.route("/api/ligas")
def api_ligas():
    """Qué ancla y qué media está usando cada liga. Sirve para comprobar de un
    vistazo que cada una va con sus propios números y no con los de otra."""
    cache = cargar_cache()
    salida = {}
    for nombre, codigo in {**LIGAS, **TORNEOS}.items():
        p = cache.get("priors", {}).get(codigo)
        m = cache.get("ligas", {}).get(codigo)
        salida[codigo] = {
            "nombre": nombre,
            "ancla": (p or {}).get("origen", "sin calcular"),
            "ancla_local": round((p or {}).get("avg_local", 0), 3) or None,
            "ancla_visita": round((p or {}).get("avg_visita", 0), 3) or None,
            "ancla_partidos": (p or {}).get("partidos"),
            "media_usada_local": round((m or {}).get("avg_local", 0), 3) or None,
            "media_usada_visita": round((m or {}).get("avg_visita", 0), 3) or None,
            "partidos_esta_temporada": (m or {}).get("partidos"),
        }
    return jsonify(salida)


@app.route("/salud")
def salud():
    """Endpoint barato para el keep-alive y para mirar el estado de un vistazo."""
    e = leer_estado()
    return jsonify({
        "ok": True,
        "estado": e.get("estado"),
        "total": e.get("total"),
        "pendientes": e.get("pendientes"),
        "ultima_actualizacion": e.get("ultima_actualizacion"),
        "hora": ahora().isoformat(),
    })


# ==========================================
# PLANIFICADOR INTERNO
# ==========================================
# Sustituye a cron-job.org: la app se programa sus propias actualizaciones.
#
# El obstáculo: Render free duerme el servicio tras 15 minutos SIN PETICIONES
# ENTRANTES. Un hilo de fondo no cuenta como tráfico, así que un simple
# temporizador se moriría con el contenedor. La solución es que la app se pida a
# sí misma por HTTP cada pocos minutos; Render publica su propia URL en la
# variable RENDER_EXTERNAL_URL, así que no hay que configurar nada.

EN_RENDER = bool(os.environ.get("RENDER_EXTERNAL_URL"))
URL_PROPIA = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")

# En local viene desactivado por defecto: al importar app.py para el backtest o
# para una prueba no queremos que se ponga a gastar cuota de la API por su cuenta.
AUTO_ACTUALIZAR = os.environ.get(
    "AUTO_ACTUALIZAR", "1" if EN_RENDER else "0").lower() not in ("0", "false", "no") and not REDIRIGIR_A

SEGUNDOS_KEEPALIVE = int(os.environ.get("SEGUNDOS_KEEPALIVE", "540"))   # 9 min < 15 de Render
SEGUNDOS_TICK = int(os.environ.get("SEGUNDOS_TICK", "300"))            # cada cuánto se revisa

# La validación del modelo se lanza sola la primera vez, cuando el calendario ya
# está al día. Son 8 peticiones una sola vez, y evita que dependa de que alguien
# se acuerde de abrir una URL. Se puede apagar con AUTO_VALIDAR=0.
AUTO_VALIDAR = os.environ.get("AUTO_VALIDAR", "1").lower() not in ("0", "false", "no")
MAX_INTENTOS_VALIDACION = 3

_planificador_arrancado = False


def _toca_actualizar():
    """¿Hay algo que hacer ahora mismo?"""
    e = leer_estado()
    estado = e.get("estado")

    if estado in (None, "sin_datos", "error"):
        return True, "no hay datos todavía"

    # Continuar una pasada a medias no es rehacer trabajo: son partidos que aún
    # no tienen número. No debe esperar a que pase el intervalo completo.
    if estado == "parcial" and e.get("pendientes", 0) > 0:
        return True, f"quedan {e['pendientes']} partidos por calcular"

    ultima = e.get("ultima_actualizacion")
    if not ultima:
        return True, "sin marca de tiempo"

    transcurrido = ahora() - _parsear_fecha(ultima)
    if transcurrido >= MIN_INTERVALO_ACTUALIZACION:
        return True, f"última hace {int(transcurrido.total_seconds()/60)} min"
    return False, ""


def _toca_validar():
    """¿Merece la pena lanzar la validación ahora?

    Solo si nunca se ha hecho (o falló pocas veces) y el calendario ya está al día:
    llenar la web es más urgente que medir el modelo, y las dos cosas compiten por
    las mismas 10 peticiones por minuto.
    """
    if not AUTO_VALIDAR:
        return False, ""
    import validacion
    if validacion.validando_ahora:
        return False, ""
    if leer_estado().get("estado") != "listo":
        return False, ""

    r = validacion.leer_resultado()
    estado = r.get("estado")
    if estado == "sin_ejecutar":
        return True, "nunca se ha ejecutado"
    # una validación de otro modelo no mide el que se publica (en Render el disco
    # se borra en cada deploy y casi nunca pasa; en Cloudflare, D1 la guarda)
    if estado in ("listo", "error") and r.get("version_modelo", 1) != VERSION_MODELO:
        return True, "modelo nuevo"
    intentos = r.get("intentos", 0)
    if estado == "error" and intentos < MAX_INTENTOS_VALIDACION:
        return True, f"reintento {intentos + 1} de {MAX_INTENTOS_VALIDACION} tras un error"
    return False, ""


def _bucle_keepalive():
    """Se pide a sí misma para que Render no duerma el servicio."""
    if not URL_PROPIA:
        print("Sin RENDER_EXTERNAL_URL: keep-alive desactivado.", file=sys.stderr)
        return
    while True:
        time.sleep(SEGUNDOS_KEEPALIVE)
        try:
            requests.get(f"{URL_PROPIA}/salud", timeout=15)
        except requests.RequestException as e:
            # que falle un ping no es grave; el siguiente lo intenta otra vez
            print(f"keep-alive falló: {e}", file=sys.stderr)


def _bucle_actualizacion():
    time.sleep(20)   # deja que el servidor termine de levantarse
    while True:
        try:
            toca, motivo = _toca_actualizar()
            if toca:
                print(f"Planificador: actualizando ({motivo})", file=sys.stderr)
                correr_actualizacion()
            else:
                tocav, motivov = _toca_validar()
                if tocav:
                    print(f"Planificador: validando el modelo ({motivov})", file=sys.stderr)
                    import validacion
                    validacion.correr_validacion()
        except Exception as e:
            # pase lo que pase, el bucle no se muere: si se muere, la web se
            # queda congelada para siempre y no hay quien la despierte
            print(f"Planificador: error no esperado: {e}", file=sys.stderr)
        time.sleep(SEGUNDOS_TICK)


def arrancar_planificador():
    global _planificador_arrancado
    if _planificador_arrancado or not AUTO_ACTUALIZAR:
        return
    _planificador_arrancado = True
    threading.Thread(target=_bucle_keepalive, daemon=True, name="keepalive").start()
    threading.Thread(target=_bucle_actualizacion, daemon=True, name="actualizador").start()
    print(f"Planificador arrancado. Keep-alive cada {SEGUNDOS_KEEPALIVE}s, "
          f"revisión cada {SEGUNDOS_TICK}s. URL propia: {URL_PROPIA or '(ninguna)'}",
          file=sys.stderr)


# Se arranca al importar el módulo, que es lo que hace gunicorn con `gunicorn app:app`.
# Con un solo worker (el de por defecto) hay exactamente un planificador. Si algún día
# escalas a varios workers, pon AUTO_ACTUALIZAR=0 en todos menos uno, o volverás a
# tener varias actualizaciones pisándose.
arrancar_planificador()


if __name__ == "__main__":
    app.run(debug=False)
