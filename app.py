import os
import sys
import hmac
import json
import time
import threading
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests
from flask import Flask, jsonify, render_template, request
from scipy.stats import poisson

app = Flask(__name__)

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
    # Serie A ("SA") y Eredivisie ("DED") también entran en el plan free si las quieres.

    # "Champions League": "CL",  <- NO la actives sin cambiar el modelo antes.
    #
    # El modelo calcula la fuerza de un equipo con sus partidos EN ESA MISMA
    # competición. En una liga doméstica son ~19 en casa y ~19 fuera; en Champions
    # son 4 y 4. Con esa muestra el encogimiento manda casi por completo y todos los
    # partidos saldrían parecidos.
    #
    # Y peor: la "media de la liga" en Champions no significa nada. Mezcla al Bayern
    # con el campeón de Kazajistán, así que dividir entre esa media no mide fuerza
    # relativa, que es justo lo que el modelo necesita.
    #
    # Para hacerla bien habría que coger las stats de cada equipo de SU liga
    # doméstica y normalizarlas entre ligas. Es un proyecto aparte, no un
    # descomentar.
}

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
CACHE_FILE = os.path.join(DATA_DIR, "cache.json")   # sumas crudas por equipo y medias de liga
DATA_FILE = os.path.join(DATA_DIR, "data.json")     # lo que ve la página web, se va llenando poco a poco

CACHE_VERSION = 3               # subir esto invalida cachés con formato viejo
                                # (v3: priors por liga; las medias de v2 se
                                #  calcularon con el prior español para todas)
DIAS_VALIDEZ_EQUIPO = int(os.environ.get("DIAS_VALIDEZ_EQUIPO", "3"))
DIAS_VALIDEZ_LIGA = 7
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
VENTANA_DIAS = 400              # cuántos días atrás mirar para las stats de un equipo.
                                # Más de un año a propósito: al inicio de temporada
                                # arrastra datos de la anterior en vez de quedarse a ciegas.
MAX_PARTIDOS_EQUIPO = 20        # se usan los N más recientes dentro de esa ventana
PSEUDO_PARTIDOS = 6             # regularización: cuánto pesa la media de liga frente a los
                                # datos propios del equipo. Con 8-10 partidos por lado, sin
                                # esto un par de goleadas te descuadran toda la fuerza.
K_LIGA = 50                     # mismo truco para la media de la propia liga

# Ancla de ÚLTIMO RECURSO, solo si no se puede leer la temporada anterior de la liga.
# Antes estas dos constantes (sacadas de LaLiga) se usaban para TODAS las ligas, y
# con K_LIGA=50 pesaban el 62% del valor a 30 partidos jugados. La Bundesliga, que
# marca más, salía sistemáticamente estimada por debajo. Ahora cada liga se ancla
# en su propia temporada anterior y estas constantes casi nunca se tocan.
PRIOR_AVG_LOCAL = 1.50
PRIOR_AVG_VISITA = 1.15
DIAS_VALIDEZ_PRIOR = 30         # la temporada pasada ya no cambia: se cachea de sobra
LIMITE_GOLES = 10               # rejilla de Poisson (antes 5, que perdía hasta 6.5% de masa)

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
    return {"version": CACHE_VERSION, "ligas": {}, "equipos": {}}


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
def temporada_actual():
    """Año de inicio de la temporada en curso, como lo numera football-data.org.

    Las ligas europeas van de agosto a mayo, así que de julio en adelante ya
    cuenta el año nuevo. La temporada 2026/27 es 'season=2026'.
    """
    a = ahora()
    return a.year if a.month >= 7 else a.year - 1


def obtener_prior_liga(codigo_liga, cache):
    """Media de goles de la temporada ANTERIOR de ESTA liga.

    Es lo que ancla la estimación mientras la temporada en curso tiene pocos
    partidos. Usar la media de otra liga (que es lo que se hacía) mete un sesgo
    del orden del 9% en ligas con ritmo goleador distinto.

    Cuesta una petición por liga y se cachea un mes: la temporada pasada ya no
    va a cambiar.
    """
    priors = cache.setdefault("priors", {})
    entry = priors.get(codigo_liga)
    if entry and esta_vigente(entry.get("actualizado"), DIAS_VALIDEZ_PRIOR):
        return entry

    respaldo = {"avg_local": PRIOR_AVG_LOCAL, "avg_visita": PRIOR_AVG_VISITA,
                "origen": "constante de respaldo", "partidos": 0, "actualizado": None}

    season = temporada_actual() - 1
    resp = get_con_pausa(f"{BASE_URL}/competitions/{codigo_liga}/matches",
                         {"season": season, "status": "FINISHED"})
    if resp.status_code != 200:
        print(f"Prior {codigo_liga}: temporada {season} no disponible "
              f"(HTTP {resp.status_code}). Se usa la constante de respaldo.", file=sys.stderr)
        return respaldo

    gl = gv = n = 0
    for m in resp.json().get("matches", []):
        ft = m.get("score", {}).get("fullTime", {})
        if ft.get("home") is None or ft.get("away") is None:
            continue
        gl += ft["home"]; gv += ft["away"]; n += 1

    # Con media temporada o menos no vale la pena: sería un ancla tan ruidosa
    # como el problema que intenta resolver.
    if n < 100:
        print(f"Prior {codigo_liga}: solo {n} partidos en {season}, insuficiente. "
              f"Se usa la constante de respaldo.", file=sys.stderr)
        return respaldo

    entry = {"avg_local": gl / n, "avg_visita": gv / n,
             "origen": f"temporada {season}", "partidos": n,
             "actualizado": ahora().isoformat()}
    priors[codigo_liga] = entry
    return entry


# ==========================================
# PROMEDIO DE GOLES POR LIGA
# ==========================================
def obtener_promedio_liga(codigo_liga, cache):
    entry = cache["ligas"].get(codigo_liga)
    if entry and esta_vigente(entry.get("actualizado"), DIAS_VALIDEZ_LIGA):
        return entry

    prior = obtener_prior_liga(codigo_liga, cache)

    resp = get_con_pausa(f"{BASE_URL}/competitions/{codigo_liga}/matches", {"status": "FINISHED"})
    if resp.status_code != 200:
        print(f"Liga {codigo_liga}: HTTP {resp.status_code}, uso solo el prior.", file=sys.stderr)
        return {"avg_local": prior["avg_local"], "avg_visita": prior["avg_visita"],
                "partidos": 0, "prior": prior["origen"], "actualizado": None}

    body = resp.json()
    goles_local, goles_visita, partidos = 0, 0, 0
    for match in body.get("matches", []):
        score = match.get("score", {}).get("fullTime", {})
        gl, gv = score.get("home"), score.get("away")
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
    cache["ligas"][codigo_liga] = promedio
    return promedio


# ==========================================
# STATS POR EQUIPO (sumas crudas, sin normalizar)
# ==========================================
STATS_VACIAS = {"gf_local": 0, "gc_local": 0, "n_local": 0,
                "gf_visita": 0, "gc_visita": 0, "n_visita": 0, "actualizado": None}


def obtener_stats_equipo(team_id, codigo_liga, cache):
    """Devuelve goles marcados/encajados y partidos jugados, separados por local y visitante.

    Se guardan SUMAS CRUDAS a propósito: la normalización y el encogimiento hacia
    la media de liga se hacen luego en calcular_xg_partido. Así, si cambia la media
    de la liga, no hay que invalidar la caché de todos los equipos.
    """
    key = f"{team_id}:{codigo_liga}"
    entry = cache["equipos"].get(key)
    if entry and esta_vigente(entry.get("actualizado"), DIAS_VALIDEZ_EQUIPO):
        return entry

    hasta = ahora().date()
    desde = hasta - timedelta(days=VENTANA_DIAS)
    resp = get_con_pausa(f"{BASE_URL}/teams/{team_id}/matches", {
        "status": "FINISHED",
        "competitions": codigo_liga,   # sin esto se colaban Copa del Rey, Champions y amistosos
        "dateFrom": desde.isoformat(),
        "dateTo": hasta.isoformat(),
    })
    if resp.status_code != 200:
        print(f"Equipo {team_id}: HTTP {resp.status_code}, se usa solo el prior de liga.", file=sys.stderr)
        return dict(STATS_VACIAS)

    matches = resp.json().get("matches", [])
    # La API no garantiza el orden, así que ordenamos aquí y nos quedamos con los
    # N más recientes. Antes, 'limit=20' podía estar devolviendo los más ANTIGUOS.
    matches.sort(key=lambda m: m.get("utcDate", ""))
    matches = matches[-MAX_PARTIDOS_EQUIPO:]

    s = {"gf_local": 0, "gc_local": 0, "n_local": 0,
         "gf_visita": 0, "gc_visita": 0, "n_visita": 0}

    for match in matches:
        score = match.get("score", {}).get("fullTime", {})
        gl, gv = score.get("home"), score.get("away")
        if gl is None or gv is None:
            continue
        if match.get("homeTeam", {}).get("id") == team_id:
            s["gf_local"] += gl; s["gc_local"] += gv; s["n_local"] += 1
        else:
            s["gf_visita"] += gv; s["gc_visita"] += gl; s["n_visita"] += 1

    s["actualizado"] = ahora().isoformat()
    # Se cachea aunque venga con pocos partidos: el encogimiento ya se encarga
    # de que un equipo con 2 partidos no dispare la predicción.
    cache["equipos"][key] = s
    return s


def _encoger(total, n, prior, k=PSEUDO_PARTIDOS):
    """Media regularizada: con n=0 devuelve el prior, y con muchos partidos converge al dato real."""
    return (total + k * prior) / (n + k)


def calcular_xg_partido(stats_local, stats_visita, promedio_liga):
    avg_l = promedio_liga["avg_local"]
    avg_v = promedio_liga["avg_visita"]

    # Tasas por partido, encogidas hacia la media de liga del lado que corresponde.
    # Ojo: los goles que ENCAJA un equipo en casa son goles de visitante -> prior avg_v,
    # y los que encaja fuera son goles de local -> prior avg_l.
    for_local      = _encoger(stats_local["gf_local"],  stats_local["n_local"],  avg_l)
    against_local  = _encoger(stats_local["gc_local"],  stats_local["n_local"],  avg_v)
    for_visita     = _encoger(stats_visita["gf_visita"], stats_visita["n_visita"], avg_v)
    against_visita = _encoger(stats_visita["gc_visita"], stats_visita["n_visita"], avg_l)

    # Fuerzas relativas. Cada término se divide entre la media de SU MISMO tipo de gol.
    # (El bug anterior dividía la defensa del visitante entre avg_visita, cuando los
    #  goles que encaja fuera son goles de local: eso inflaba al local ~29% siempre.)
    ataque_local   = for_local / avg_l
    defensa_visita = against_visita / avg_l
    ataque_visita  = for_visita / avg_v
    defensa_local  = against_local / avg_v

    xg_local  = ataque_local  * defensa_visita * avg_l
    xg_visita = ataque_visita * defensa_local  * avg_v
    return round(xg_local, 2), round(xg_visita, 2)


def calcular_poisson(gla, gvi, limite=LIMITE_GOLES):
    pl, pe, pv = 0.0, 0.0, 0.0
    for gl in range(limite + 1):
        p_gl = poisson.pmf(gl, gla)
        for gv in range(limite + 1):
            prob = p_gl * poisson.pmf(gv, gvi)
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

    for nombre_liga, codigo in LIGAS.items():
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
    if not calculado:
        return False
    return ahora() - _parsear_fecha(calculado) < timedelta(hours=HORAS_VALIDEZ_PREDICCION)


def _ficha_base(match):
    """Los datos del partido que se conocen sin gastar ni una petición."""
    return {
        "id": match["id"],
        "local": match["homeTeam"]["name"],
        "visita": match["awayTeam"]["name"],
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
            # Un partido cuyos dos equipos ya están en caché no gasta peticiones,
            # así que se calcula igual aunque quede poco presupuesto. Solo paramos
            # cuando de verdad se agotó.
            if presupuesto_agotado():
                agotado = True
                break

            local_id = match["homeTeam"]["id"]
            visita_id = match["awayTeam"]["id"]
            codigo_liga = match["competition"]["code"]

            promedio_liga = obtener_promedio_liga(codigo_liga, cache)
            stats_local = obtener_stats_equipo(local_id, codigo_liga, cache)
            stats_visita = obtener_stats_equipo(visita_id, codigo_liga, cache)
            xg_local, xg_visita = calcular_xg_partido(stats_local, stats_visita, promedio_liga)
            probs = calcular_poisson(xg_local, xg_visita)

            calculadas[match["id"]] = dict(
                _ficha_base(match),
                xg_local=xg_local, xg_visita=xg_visita,
                # cuántos partidos reales hay detrás de cada lado: si son pocos,
                # la predicción está dominada por la media de liga y conviene saberlo
                muestra_local=stats_local["n_local"],
                muestra_visita=stats_visita["n_visita"],
                calculado=ahora().isoformat(),
                pendiente=False,
                **probs
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
@app.after_request
def agregar_headers_seguridad(response):
    # Básicos y sin costo: evitan que el navegador "adivine" tipos de contenido
    # o que la página se incruste en un iframe ajeno (clickjacking).
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    # Esto es un panel en vivo: cachear el HTML solo consigue que después de un
    # deploy sigas viendo la interfaz anterior hasta que hagas Ctrl+F5. Y el JSON
    # de /api/estado cambia cada pocos segundos, así que cachearlo es peor aún.
    response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/estado")
def api_estado():
    return jsonify(leer_estado())


@app.route("/actualizar")
def actualizar():
    """cron-job.org le pega a esta ruta cada cierto tiempo."""
    token_recibido = request.args.get("token", "")
    # hmac.compare_digest en vez de == : compara en tiempo constante,
    # así nadie puede adivinar el token midiendo milisegundos de respuesta.
    if not hmac.compare_digest(token_recibido, UPDATE_SECRET):
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
    return jsonify(validacion.leer_resultado())


@app.route("/validar")
def validar():
    """Lanza el backtest. Mismo token que /actualizar.

    Cuesta 2 peticiones por liga y solo la primera vez: las temporadas terminadas
    no cambian, así que quedan cacheadas en disco.
    """
    if not hmac.compare_digest(request.args.get("token", ""), UPDATE_SECRET):
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
    for nombre, codigo in LIGAS.items():
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
    "AUTO_ACTUALIZAR", "1" if EN_RENDER else "0").lower() not in ("0", "false", "no")

SEGUNDOS_KEEPALIVE = int(os.environ.get("SEGUNDOS_KEEPALIVE", "540"))   # 9 min < 15 de Render
SEGUNDOS_TICK = int(os.environ.get("SEGUNDOS_TICK", "300"))            # cada cuánto se revisa

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
