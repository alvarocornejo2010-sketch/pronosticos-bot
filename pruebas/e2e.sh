#!/usr/bin/env bash
# Prueba de punta a punta: Flask (app.py + validacion.py) y el Worker (wrangler dev,
# con su D1 local y el cron lanzado a mano) contra la API falsa, que es determinista.
# Los dos tienen que servir exactamente lo mismo en /api/estado, /api/ligas y
# /api/validacion; ninguna pasada puede morir; y, con la web llena, todas las
# predicciones caducan a la vez y la web tiene que seguir enseñando números
# (caducidad.py).
#
# Uso: bash pruebas/e2e.sh   (antes: npm ci y pip install -r requirements.txt)
# Las variables del Worker van con --var, que manda sobre .dev.vars: tu token de
# verdad, si lo tienes ahí, no se usa. Puertos: P_API (5091) y P_W (8788).
# MAX_MS: CPU máxima por pasada que se tolera (25 ms: en producción el límite es 10,
# pero aquí workerd mide también el SQLite de D1 y la máquina varía; sirve para
# cazar un salto, no para medir el límite).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
P_API=${P_API:-5091}
P_W=${P_W:-8788}
MAX_MS=${MAX_MS:-25}
TMP=$(mktemp -d)
API_PID=""

parar() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  pkill -f -- "--persist-to $TMP/d1" 2>/dev/null || true
  pkill -f -- "workerd serve.*127.0.0.1:$P_W" 2>/dev/null || true
  rm -rf "$TMP"
}
trap parar EXIT

esperar() {   # esperar URL: hasta 90 s a que responda 200
  for _ in $(seq 1 90); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)" = "200" ] && return 0
    sleep 1
  done
  echo "no responde: $1" >&2
  return 1
}

python3 "$REPO/pruebas/api_falsa.py" "$P_API" > "$TMP/api.log" 2>&1 &
API_PID=$!
esperar "http://127.0.0.1:$P_API/__stats"

echo "== Flask"
python3 "$REPO/pruebas/correr_flask.py" "$P_API" "$TMP/flask.json"
curl -s "http://127.0.0.1:$P_API/__reset" > /dev/null

echo "== Worker"
(cd "$REPO" && WRANGLER_SEND_METRICS=false npx wrangler dev --test-scheduled --port "$P_W" --ip 127.0.0.1 \
  --persist-to "$TMP/d1" \
  --var FOOTBALL_DATA_TOKEN:token_falso_de_prueba --var UPDATE_SECRET:secreto_de_prueba_123 \
  --var "API_BASE:http://127.0.0.1:$P_API/v4" --var PAUSA_ENTRE_REQUESTS:0 \
  --var MIN_MINUTOS_ACTUALIZACION:25 --var AUTO_VALIDAR:1 --var PRESUPUESTO_REQUESTS:6 \
  --var MAX_BYTES_PASADA:350000 --var MAX_CALCULOS_PASADA:40 > "$TMP/wrangler.log" 2>&1) &
esperar "http://127.0.0.1:$P_W/salud"
python3 "$REPO/pruebas/correr_cron.py" "$P_W" 600 "$MAX_MS" | tail -4

echo "== Flask contra el Worker"
python3 "$REPO/pruebas/comparar.py" "$TMP/flask.json" "http://127.0.0.1:$P_W"
muertas=$(grep -c '"muertes":[1-9]' "$TMP/wrangler.log" || true)
echo "pasadas muertas: $muertas"
[ "$muertas" = "0" ]
curl -s "http://127.0.0.1:$P_API/__stats" | python3 -c "import json,sys; print('peticiones del Worker:', json.load(sys.stdin)['total'])"

echo "== Caducidad"
python3 "$REPO/pruebas/caducidad.py" "$P_W" "$TMP/d1" | tail -3
echo "e2e: OK"
