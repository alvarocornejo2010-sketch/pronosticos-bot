import os
import sys
import hmac
import json
import time
import threading
from datetime import datetime, timedelta

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
    "Premier League": "PL",
    "La Liga": "PD",
    "Ligue 1": "FL1",
    "Bundesliga": "BL1",
    "Champions League": "CL",
}

MIN_INTERVALO_ACTUALIZACION = timedelta(minutes=45)  # protege tu cuota si el cron se configura mal

CACHE_FILE = "cache.json"       # promedios de liga/equipo (igual que antes)
DATA_FILE = "data.json"         # lo que ve la página web, se va llenando poco a poco
DIAS_VALIDEZ_EQUIPO = 3
DIAS_VALIDEZ_LIGA = 7
PAUSA_ENTRE_REQUESTS = 6.5      # 10 requests/min en el plan free
MAX_DIAS_BUSQUEDA = 3           # si no hay partidos hoy, prueba hasta 3 días adelante

actualizando_ahora = False      # evita que dos actualizaciones corran a la vez

# ==========================================
# CACHÉ DE PROMEDIOS
# ==========================================
def cargar_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    return {"ligas": {}, "equipos": {}}

def guardar_cache(cache):
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2)

def esta_vigente(fecha_str, dias_validez):
    if not fecha_str:
        return False
    return datetime.now() - datetime.fromisoformat(fecha_str) < timedelta(days=dias_validez)

def get_con_pausa(url, params=None):
    resp = requests.get(url, headers=HEADER, params=params)
    time.sleep(PAUSA_ENTRE_REQUESTS)
    return resp

# ==========================================
# ESTADO DE LA PÁGINA (data.json)
# ==========================================
def leer_estado():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    return {"estado": "sin_datos", "dia_mostrado": None, "partidos": [], "ultima_actualizacion": None}

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

    if partidos == 0:
        return {"avg_local": 1.4, "avg_visita": 1.1, "actualizado": None}

    promedio = {
        "avg_local": goles_local / partidos,
        "avg_visita": goles_visita / partidos,
        "actualizado": datetime.now().isoformat()
    }
    cache["ligas"][codigo_liga] = promedio
    return promedio

# ==========================================
# PROMEDIO DE GOLES POR EQUIPO
# ==========================================
def obtener_stats_equipo(team_id, cache):
    key = str(team_id)
    entry = cache["equipos"].get(key)
    if entry and esta_vigente(entry.get("actualizado"), DIAS_VALIDEZ_EQUIPO):
        return entry

    resp = get_con_pausa(f"{BASE_URL}/teams/{team_id}/matches", {"status": "FINISHED", "limit": 20})
    body = resp.json()

    for_local, for_visita, against_local, against_visita = 0, 0, 0, 0
    n_local, n_visita = 0, 0

    for match in body.get("matches", []):
        score = match.get("score", {}).get("fullTime", {})
        gl, gv = score.get("home"), score.get("away")
        if gl is None or gv is None:
            continue
        if match.get("homeTeam", {}).get("id") == team_id:
            for_local += gl; against_local += gv; n_local += 1
        else:
            for_visita += gv; against_visita += gl; n_visita += 1

    if n_local == 0 or n_visita == 0:
        return {"for_local": 1.3, "for_visita": 1.3, "against_local": 1.3, "against_visita": 1.3, "actualizado": None}

    stats = {
        "for_local": for_local / n_local,
        "for_visita": for_visita / n_visita,
        "against_local": against_local / n_local,
        "against_visita": against_visita / n_visita,
        "actualizado": datetime.now().isoformat()
    }
    cache["equipos"][key] = stats
    return stats

def calcular_xg_partido(stats_local, stats_visita, promedio_liga):
    xg_local = (stats_local["for_local"] / promedio_liga["avg_local"]) * \
               (stats_visita["against_visita"] / promedio_liga["avg_visita"]) * promedio_liga["avg_local"]
    xg_visita = (stats_visita["for_visita"] / promedio_liga["avg_visita"]) * \
                (stats_local["against_local"] / promedio_liga["avg_local"]) * promedio_liga["avg_visita"]
    return round(xg_local, 2), round(xg_visita, 2)

def calcular_poisson(gla, gvi, limite=5):
    pl, pe, pv = 0, 0, 0
    for gl in range(limite + 1):
        for gv in range(limite + 1):
            prob = poisson.pmf(gl, gla) * poisson.pmf(gv, gvi)
            if gl > gv: pl += prob
            elif gl == gv: pe += prob
            else: pv += prob
    # Nombres con prefijo "prob_" para que NUNCA choquen con las claves
    # "local"/"visita" que ya usamos para los nombres de los equipos.
    return {
        "prob_local": round(pl * 100, 2),
        "prob_empate": round(pe * 100, 2),
        "prob_visita": round(pv * 100, 2),
        "prob_1x": round((pl + pe) * 100, 2)
    }

# ==========================================
# BUSCAR EL PRIMER DÍA CON PARTIDOS (hoy, luego mañana, etc.)
# ==========================================
def buscar_dia_con_partidos():
    debug_por_dia = []  # para poder ver exactamente qué devolvió la API cada día revisado
    for dias in range(MAX_DIAS_BUSQUEDA + 1):
        fecha = (datetime.now() + timedelta(days=dias)).strftime("%Y-%m-%d")
        resp = get_con_pausa(f"{BASE_URL}/matches", {
            "dateFrom": fecha, "dateTo": fecha, "competitions": ",".join(LIGAS.values())
        })
        body = resp.json()
        matches = body.get("matches", [])
        debug_por_dia.append({
            "fecha_consultada": fecha,
            "http_status": resp.status_code,
            "cantidad_encontrada": len(matches),
            "mensaje_api": body.get("message"),  # si la API rechazó algo, aparece aquí
            "hora_servidor_utc": datetime.now().isoformat()
        })
        if matches:
            return fecha, dias, matches, debug_por_dia
    return None, None, [], debug_por_dia

# ==========================================
# PIPELINE COMPLETO (corre en un hilo de fondo)
# ==========================================
def correr_actualizacion():
    global actualizando_ahora
    if actualizando_ahora:
        return  # ya hay una actualización en curso, no dupliques
    actualizando_ahora = True

    try:
        cache = cargar_cache()
        fecha, dias_adelante, matches, debug_busqueda = buscar_dia_con_partidos()

        if not matches:
            escribir_estado({
                "estado": "sin_partidos",
                "dia_mostrado": None,
                "partidos": [],
                "ultima_actualizacion": datetime.now().isoformat(),
                "debug_busqueda": debug_busqueda  # que día se reviso, cuantos partidos crudos vinieron, etc.
            })
            return

        etiqueta_dia = "Hoy" if dias_adelante == 0 else ("Mañana" if dias_adelante == 1 else f"En {dias_adelante} días")

        # arranca con la lista vacía y estado "actualizando" para que la web lo muestre en vivo
        escribir_estado({
            "estado": "actualizando",
            "dia_mostrado": f"{etiqueta_dia} ({fecha})",
            "partidos": [],
            "ultima_actualizacion": datetime.now().isoformat()
        })

        partidos_procesados = []
        for match in matches:
            local, visita = match["homeTeam"]["name"], match["awayTeam"]["name"]
            local_id, visita_id = match["homeTeam"]["id"], match["awayTeam"]["id"]
            codigo_liga, nombre_liga = match["competition"]["code"], match["competition"]["name"]

            promedio_liga = obtener_promedio_liga(codigo_liga, cache)
            stats_local = obtener_stats_equipo(local_id, cache)
            stats_visita = obtener_stats_equipo(visita_id, cache)
            xg_local, xg_visita = calcular_xg_partido(stats_local, stats_visita, promedio_liga)
            probs = calcular_poisson(xg_local, xg_visita)

            partidos_procesados.append({
                "local": local, "visita": visita, "liga": nombre_liga,
                "xg_local": xg_local, "xg_visita": xg_visita, **probs
            })

            # escribe el progreso DESPUÉS de cada partido -> esto es lo que hace
            # que la web los vaya mostrando "poco a poco" en vez de todos de golpe
            escribir_estado({
                "estado": "actualizando",
                "dia_mostrado": f"{etiqueta_dia} ({fecha})",
                "partidos": partidos_procesados,
                "ultima_actualizacion": datetime.now().isoformat()
            })
            guardar_cache(cache)

        escribir_estado({
            "estado": "listo",
            "dia_mostrado": f"{etiqueta_dia} ({fecha})",
            "partidos": partidos_procesados,
            "ultima_actualizacion": datetime.now().isoformat()
        })

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

    estado_actual = leer_estado()
    ultima = estado_actual.get("ultima_actualizacion")
    if ultima:
        transcurrido = datetime.now() - datetime.fromisoformat(ultima)
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
