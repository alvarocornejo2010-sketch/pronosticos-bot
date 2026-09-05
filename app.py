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
    # Ligas comentadas temporalmente mientras se prueba con un nicho más chico.
    # Descoméntalas cuando quieras volver a las 5 ligas:
    # "Premier League": "PL",
    # "Ligue 1": "FL1",
    # "Bundesliga": "BL1",
    # "Champions League": "CL",
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

CACHE_VERSION = 2               # subir esto invalida cachés con formato viejo
DIAS_VALIDEZ_EQUIPO = 3
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
PRIOR_AVG_LOCAL = 1.50          # medias históricas de LaLiga, usadas solo como ancla
PRIOR_AVG_VISITA = 1.15
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
# PROMEDIO DE GOLES POR LIGA
# ==========================================
def obtener_promedio_liga(codigo_liga, cache):
    entry = cache["ligas"].get(codigo_liga)
    if entry and esta_vigente(entry.get("actualizado"), DIAS_VALIDEZ_LIGA):
        return entry

    resp = get_con_pausa(f"{BASE_URL}/competitions/{codigo_liga}/matches", {"status": "FINISHED"})
    if resp.status_code != 200:
        print(f"Liga {codigo_liga}: HTTP {resp.status_code}, uso solo el prior.", file=sys.stderr)
        return {"avg_local": PRIOR_AVG_LOCAL, "avg_visita": PRIOR_AVG_VISITA,
                "partidos": 0, "actualizado": None}

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
        "avg_local": (goles_local + K_LIGA * PRIOR_AVG_LOCAL) / (partidos + K_LIGA),
        "avg_visita": (goles_visita + K_LIGA * PRIOR_AVG_VISITA) / (partidos + K_LIGA),
        "partidos": partidos,
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
    return {
        "prob_local": round(pl * 100, 2),
        "prob_empate": round(pe * 100, 2),
        "prob_visita": round(pv * 100, 2),
        "prob_1x": round((pl + pe) * 100, 2),
        "prob_x2": round((pe + pv) * 100, 2),
        "prob_12": round((pl + pv) * 100, 2),
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


def obtener_fixtures():
    """Todos los partidos por jugar en la ventana, agrupados por día local.

    IMPORTANTE: usa /competitions/{codigo}/matches y NO el endpoint global
    /v4/matches. En el plan free de football-data.org el global responde
    HTTP 200 con una lista VACÍA en vez de dar un 403, así que parece que
    simplemente no hay partidos.

    Cuesta 1 petición por liga para TODA la ventana, así que ampliar los días
    que se muestran es gratis; lo que cuesta son las stats de cada equipo.
    """
    hoy = ahora().date()
    hasta = hoy + timedelta(days=MAX_DIAS_BUSQUEDA)
    debug = []
    por_fecha = defaultdict(list)

    for nombre_liga, codigo in LIGAS.items():
        resp = get_con_pausa(f"{BASE_URL}/competitions/{codigo}/matches", {
            "dateFrom": hoy.isoformat(),
            "dateTo": hasta.isoformat(),
            # solo lo que aún no se ha jugado: es una web de pronósticos,
            # no tiene sentido "predecir" un partido que ya terminó
            "status": "SCHEDULED,TIMED",
        })
        body = resp.json() if resp.status_code == 200 else {}
        matches = body.get("matches", [])

        for m in matches:
            # el endpoint por competición no repite el bloque "competition" en
            # cada partido, así que se lo inyectamos: el resto del pipeline lo usa
            m["competition"] = {"code": codigo, "name": nombre_liga}
            # la fecha viene en UTC; la pasamos a hora local para que "hoy"
            # signifique lo mismo para ti que para el servidor
            m["_fecha_local"] = datetime.fromisoformat(
                m["utcDate"].replace("Z", "+00:00")).astimezone(TZ)
            por_fecha[m["_fecha_local"].date()].append(m)

        debug.append({
            "liga": codigo,
            "rango_consultado": f"{hoy} a {hasta}",
            "http_status": resp.status_code,
            "cantidad_encontrada": len(matches),
            "mensaje_api": body.get("message"),
            "hora_servidor_local": ahora().isoformat(),
        })

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


def correr_actualizacion():
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
        por_fecha, debug = obtener_fixtures()

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
    ultima = estado_actual.get("ultima_actualizacion")
    if ultima and not forzar:
        transcurrido = ahora() - _parsear_fecha(ultima)
        if transcurrido < MIN_INTERVALO_ACTUALIZACION:
            faltan = MIN_INTERVALO_ACTUALIZACION - transcurrido
            return jsonify({
                "mensaje": f"actualización reciente hace {int(transcurrido.total_seconds()/60)} min. "
                           f"Espera {int(faltan.total_seconds()/60)} min más para evitar gastar cuota de más."
            })

    # corre en un hilo aparte para responder rápido al cron y no colgar la request
    threading.Thread(target=correr_actualizacion, daemon=True).start()
    return jsonify({"mensaje": "actualización iniciada"})


if __name__ == "__main__":
    app.run(debug=False)
