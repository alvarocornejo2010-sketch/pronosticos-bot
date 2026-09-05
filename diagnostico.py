"""
Diagnóstico de la API de football-data.org.

No toca la web ni Render: pregunta directamente a la API para saber por qué
la app dice "no hay partidos". Se ejecuta en tu PC.

Uso (Windows CMD):
    set FOOTBALL_DATA_TOKEN=tu_token
    python diagnostico.py
"""
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

TOKEN = os.environ.get("FOOTBALL_DATA_TOKEN")
if not TOKEN:
    sys.exit("Falta FOOTBALL_DATA_TOKEN.\n  Windows CMD:  set FOOTBALL_DATA_TOKEN=tu_token\n"
             "  PowerShell:   $env:FOOTBALL_DATA_TOKEN=\"tu_token\"")

BASE = "https://api.football-data.org/v4"
H = {"X-Auth-Token": TOKEN}
LIGA = "PD"


def pedir(ruta, params=None, pausa=6.5):
    url = f"{BASE}{ruta}"
    r = requests.get(url, headers=H, params=params, timeout=30)
    print(f"    -> HTTP {r.status_code}", end="")
    restantes = r.headers.get("X-Requests-Available-Minute")
    if restantes is not None:
        print(f"   (te quedan {restantes} requests este minuto)", end="")
    print()
    try:
        body = r.json()
    except Exception:
        print(f"    respuesta no-JSON: {r.text[:200]}")
        body = {}
    if r.status_code != 200:
        print(f"    mensaje de la API: {body.get('message') or r.text[:200]}")
    time.sleep(pausa)
    return r.status_code, body


print("=" * 70)
print("1. ¿El token sirve y tienes acceso a LaLiga?")
print("=" * 70)
cod, body = pedir(f"/competitions/{LIGA}")
if cod == 200:
    temp = body.get("currentSeason", {})
    print(f"    Competición: {body.get('name')}")
    print(f"    Temporada actual: {temp.get('startDate')} -> {temp.get('endDate')}")
    print(f"    Jornada actual segun la API: {temp.get('currentMatchday')}")
else:
    sys.exit("\n    El token no sirve o no tienes acceso a LaLiga. Todo lo demás fallará.")

print()
print("=" * 70)
print("2. Los próximos partidos de LaLiga, sin filtrar por fecha")
print("=" * 70)
print("    (si aquí no sale nada, el problema es de acceso, no de fechas)")
cod, body = pedir(f"/competitions/{LIGA}/matches", {"status": "SCHEDULED,TIMED"})
proximos = body.get("matches", [])
print(f"    Partidos futuros encontrados: {len(proximos)}")
for m in proximos[:8]:
    print(f"      {m['utcDate']}  J{m.get('matchday'):>2}  "
          f"{m['homeTeam']['name']} vs {m['awayTeam']['name']}  [{m['status']}]")

print()
print("=" * 70)
print("3. Día por día, igual que hace la app")
print("=" * 70)
hoy_utc = datetime.now(timezone.utc).date()
print(f"    Hoy en UTC (la hora de Render): {hoy_utc}")
print(f"    Hoy en Lima:                    {(datetime.now(timezone.utc) - timedelta(hours=5)).date()}")
print()
for i in range(8):
    f = (hoy_utc + timedelta(days=i)).isoformat()
    print(f"  Día {f}:")
    cod, body = pedir("/matches", {"dateFrom": f, "dateTo": f, "competitions": LIGA})
    ms = body.get("matches", [])
    print(f"    partidos: {len(ms)}")
    for m in ms:
        print(f"      {m['utcDate']}  {m['homeTeam']['name']} vs {m['awayTeam']['name']}  [{m['status']}]")

print()
print("=" * 70)
print("4. El mismo día, pero preguntando por la competición en vez de /matches")
print("=" * 70)
print("    (si aquí SÍ salen y en el paso 3 no, el problema es el endpoint global")
print("     /matches, que en el plan free a veces no acepta el filtro competitions)")
desde = hoy_utc.isoformat()
hasta = (hoy_utc + timedelta(days=7)).isoformat()
cod, body = pedir(f"/competitions/{LIGA}/matches", {"dateFrom": desde, "dateTo": hasta})
ms = body.get("matches", [])
print(f"    partidos entre {desde} y {hasta}: {len(ms)}")
for m in ms:
    print(f"      {m['utcDate']}  {m['homeTeam']['name']} vs {m['awayTeam']['name']}  [{m['status']}]")

print()
print("Pégame toda esta salida.")
