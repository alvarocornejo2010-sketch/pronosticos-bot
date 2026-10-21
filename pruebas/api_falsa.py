"""football-data.org de mentira y determinista: la misma URL da siempre la misma
respuesta, así Flask (app.py) y el Worker ven exactamente los mismos datos.
Además de /v4/..., responde a /__stats (peticiones recibidas), /__reset,
/__limite?n=N (un 429 cada N peticiones), /__jugar?si=1 (los partidos del último
calendario pasan a estar jugados, para el registro en vivo) y
/__omitir?liga=PD&n=3&veces=1 (calendarios incompletos).
Uso: python pruebas/api_falsa.py PUERTO [limite429]"""
import hashlib, json, random, re, sys, threading
from collections import Counter
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PUERTO = int(sys.argv[1])
LIMITE = [int(sys.argv[2]) if len(sys.argv) > 2 else 0]   # >0: cada N peticiones, un 429
NOMBRES = {
 "PD": ["Real Madrid", "FC Barcelona", "Atlético de Madrid", "Athletic Club", "Villarreal", "Real Betis", "Real Sociedad", "Sevilla FC", "Valencia CF", "Celta de Vigo", "CA Osasuna", "Girona FC", "Getafe CF", "Rayo Vallecano", "RCD Mallorca", "Deportivo Alavés", "RCD Espanyol", "Elche CF", "Levante UD", "Real Oviedo"],
 "PL": ["Arsenal", "Manchester City", "Liverpool", "Chelsea", "Tottenham Hotspur", "Newcastle United", "Aston Villa", "Manchester United", "Brighton & Hove Albion", "Wolverhampton Wanderers", "Nottingham Forest", "Brentford", "Fulham", "Crystal Palace", "Everton", "Bournemouth", "West Ham United", "Leeds United", "Burnley", "Sunderland"],
 "FL1": ["Paris Saint-Germain", "Olympique de Marseille", "AS Monaco", "LOSC Lille", "OGC Nice", "Olympique Lyonnais", "RC Lens", "Stade Rennais", "RC Strasbourg", "Stade Brestois", "Toulouse FC", "FC Nantes", "AJ Auxerre", "Angers SCO", "Le Havre AC", "FC Lorient", "Paris FC", "FC Metz"],
 "BL1": ["Bayern München", "Borussia Dortmund", "Bayer Leverkusen", "RB Leipzig", "VfB Stuttgart", "Eintracht Frankfurt", "SC Freiburg", "VfL Wolfsburg", "1. FSV Mainz 05", "Borussia Mönchengladbach", "Werder Bremen", "TSG Hoffenheim", "FC Augsburg", "1. FC Union Berlin", "1. FC Heidenheim", "FC St. Pauli", "Hamburger SV", "1. FC Köln"],
 "SA": ["Inter", "AC Milan", "Juventus", "Napoli", "AS Roma", "Atalanta", "Lazio", "Fiorentina", "Bologna", "Torino", "Udinese", "Genoa", "Como", "Cagliari", "Lecce", "Parma", "Hellas Verona", "Sassuolo", "Cremonese", "Pisa"],
 "DED": ["PSV", "Feyenoord", "Ajax", "AZ Alkmaar", "FC Twente", "FC Utrecht", "Go Ahead Eagles", "NEC Nijmegen", "sc Heerenveen", "Sparta Rotterdam", "Fortuna Sittard", "PEC Zwolle", "Heracles Almelo", "NAC Breda", "FC Groningen", "Excelsior", "Telstar", "FC Volendam"],
 "PPL": ["Benfica", "Sporting CP", "FC Porto", "SC Braga", "Vitória SC", "Gil Vicente", "Famalicão", "Estoril Praia", "Casa Pia", "Moreirense", "Rio Ave", "Santa Clara", "Arouca", "Nacional", "Estrela da Amadora", "CD Tondela", "AVS", "Alverca"],
 "ELC": ["Coventry City", "Middlesbrough", "Ipswich Town", "Leicester City", "Southampton", "West Bromwich Albion", "Norwich City", "Sheffield United", "Hull City", "Millwall", "Stoke City", "Preston North End", "Bristol City", "Watford", "Derby County", "Swansea City", "Blackburn Rovers", "Queens Park Rangers", "Portsmouth", "Oxford United", "Charlton Athletic", "Wrexham", "Birmingham City", "Sheffield Wednesday"],
 "BSA": ["Flamengo", "Palmeiras", "Cruzeiro", "Mirassol", "Botafogo", "Bahia", "Fluminense", "São Paulo", "Corinthians", "Grêmio", "Vasco da Gama", "Atlético Mineiro", "Internacional", "Ceará", "Fortaleza", "Santos", "Vitória", "Red Bull Bragantino", "Juventude", "Sport Recife"],
}
OTRAS = ["Club Brugge", "Celtic", "SK Sturm Graz", "Red Bull Salzburg", "BSC Young Boys", "Sparta Praha", "Dinamo Zagreb", "Crvena Zvezda"]
sig = lambda n: re.sub(r"[^A-Z]", "", n.upper().replace("FC ", ""))[:3] or n[:3].upper()
EQ = {}
for i, (c, ns) in enumerate(NOMBRES.items(), 1):
    EQ[c] = [{"id": i * 1000 + k, "name": n, "shortName": n.replace("FC ", "") if len(n) > 14 else n,
              "tla": sig(n), "crest": f"https://crests.football-data.org/{i * 1000 + k}.png"} for k, n in enumerate(ns)]
# un escudo que no es https: la web no debe pintarlo
EQ["PD"][5]["crest"] = "http://crests.football-data.org/1005.png"
CL = [e for c, n in (("PL", 4), ("PD", 4), ("SA", 4), ("BL1", 4), ("FL1", 4), ("DED", 2), ("PPL", 2)) for e in EQ[c][:n]]
CL += [{"id": 99000 + k, "name": n, "shortName": n, "tla": sig(n), "crest": f"https://crests.football-data.org/{99000 + k}.png"}
       for k, n in enumerate(OTRAS)]
EQ["CL"] = CL
LIGA_DE = {e["id"]: c for c, eqs in EQ.items() if c != "CL" for e in eqs}
# esta temporada: tres de la Premier bajan a la Championship y tres de la Championship suben
EQ_ACTUAL = dict(EQ, PL=EQ["PL"][:17] + EQ["ELC"][21:24], ELC=EQ["ELC"][:21] + EQ["PL"][17:20])
for c in ("PL", "ELC"):
    for e in EQ_ACTUAL[c]:
        LIGA_DE[e["id"]] = c
ULTIMO_CAL = {}      # el último calendario servido de cada competición
JUGAR = [False]      # /__jugar: lo jugado de esta temporada incluye esos partidos, terminados
OMITIR = {}          # /__omitir?liga=PD&n=3&veces=1: las próximas `veces` respuestas del calendario
                     # de esa liga llegan sin sus n primeros partidos (como hizo football-data el 21 oct 2026)
FUERZA = {e["id"]: 0.6 + (int(hashlib.md5(str(e["id"]).encode()).hexdigest()[:6], 16) % 1000) / 1000 for c in EQ for e in EQ[c]}
INICIO = datetime.now(timezone.utc)
FALLA_EQUIPO = EQ["SA"][7]["id"]          # sus partidos devuelven 500: se calcula solo con el prior
CONTADOR = Counter(); TOTAL = [0]; CANDADO = threading.Lock()

# hash() de Python cambia de un proceso a otro: los id tienen que salir siempre iguales
estable = lambda *partes: int(hashlib.md5("|".join(map(str, partes)).encode()).hexdigest()[:12], 16)

def rnd_de(*partes):
    return random.Random(hashlib.sha256("|".join(map(str, partes)).encode()).hexdigest())

def goles(r, mu):
    x, p, s, u = 0, 2.718281828 ** -mu, 2.718281828 ** -mu, r.random()
    while u > s and x < 10:
        x += 1; p *= mu / x; s += p
    return x

def partido(r, c, mid, h, a, when, terminado):
    d = {"area": {"id": 2224, "name": "Spain", "code": "ESP", "flag": "https://crests.football-data.org/760.svg"},
         "competition": {"id": 2014, "name": "Competición " + c, "code": c, "type": "LEAGUE", "emblem": f"https://crests.football-data.org/{c}.png"},
         "season": {"id": 1504, "startDate": "2025-08-15", "endDate": "2026-05-24", "currentMatchday": 9, "winner": None},
         "id": mid, "utcDate": when.strftime("%Y-%m-%dT%H:%M:%SZ"), "status": "FINISHED" if terminado else "TIMED",
         "matchday": 1 + mid % 38, "stage": "REGULAR_SEASON", "group": None, "lastUpdated": "2026-10-01T00:20:47Z",
         "homeTeam": h, "awayTeam": a,
         "score": {"winner": None, "duration": "REGULAR", "fullTime": {"home": None, "away": None}, "halfTime": {"home": None, "away": None}},
         "odds": {"msg": "Activate Odds-Package in User-Panel to retrieve odds."},
         "referees": [{"id": 11050 + mid % 50, "name": "Árbitro de Prueba", "type": "REFEREE", "nationality": "Spain"}]}
    if terminado:
        gl = goles(r, 1.45 * FUERZA.get(h["id"], 1) / FUERZA.get(a["id"], 1))
        gv = goles(r, 1.1 * FUERZA.get(a["id"], 1) / FUERZA.get(h["id"], 1))
        d["score"]["fullTime"] = {"home": gl, "away": gv}
        d["score"]["halfTime"] = {"home": gl // 2, "away": gv // 2}
        d["score"]["winner"] = "HOME_TEAM" if gl > gv else "AWAY_TEAM" if gv > gl else "DRAW"
        # eliminatorias de Champions: prórroga y penaltis, con fullTime sumándolo todo (como la v4)
        if c == "CL" and mid % 5 == 0:
            pl, pv = (4, 3) if mid % 2 else (2, 4)
            d["score"].update(duration="PENALTY_SHOOTOUT", regularTime={"home": gl, "away": gv},
                              extraTime={"home": 0, "away": 0}, penalties={"home": pl, "away": pv},
                              fullTime={"home": gl + pl, "away": gv + pv})
        elif c == "CL" and mid % 7 == 0:
            d["score"].update(duration="EXTRA_TIME", regularTime={"home": gl, "away": gv},
                              extraTime={"home": 1, "away": 0}, fullTime={"home": gl + 1, "away": gv})
    return d

def temporada(c, n_partidos, semilla, fin):
    r = rnd_de("temporada", c, semilla)
    eq = EQ_ACTUAL[c] if semilla == "actual" else EQ[c]
    out = []
    for k in range(n_partidos):
        h, a = r.sample(eq, 2)
        out.append(partido(r, c, 10_000_000 + estable(c, semilla, k) % 1_000_000, h, a, fin - timedelta(days=n_partidos - k, hours=r.randint(0, 5)), True))
    return out

def responder(ruta, q):
    m = re.fullmatch(r"/v4/competitions/(\w+)/matches", ruta)
    if m:
        c = m.group(1)
        if c not in EQ: return 404, {"message": "no existe"}
        if "dateFrom" in q:
            r = rnd_de("calendario", c, q["dateFrom"])
            hoy = datetime.fromisoformat(q["dateFrom"]).replace(tzinfo=timezone.utc)
            out = []
            if c == "CL":
                eqs = list(EQ["CL"]); r.shuffle(eqs)
                for k in range(0, len(eqs) - 1, 2):
                    d = 4 if k < len(eqs) // 2 else 5
                    t = hoy + timedelta(days=d, hours=17 + (k % 4), minutes=45 if k % 4 else 0)
                    out.append({"id": 700000 + k, "utcDate": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "status": "TIMED",
                                "homeTeam": eqs[k], "awayTeam": eqs[k + 1], "stage": "LEAGUE_STAGE"})
                out.append({"id": 799999, "utcDate": (hoy + timedelta(days=6)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                            "homeTeam": {"id": None, "name": None}, "awayTeam": {"id": None, "name": None}})
                ULTIMO_CAL[c] = out
                return 200, {"matches": out}
            mid = 0
            for d in range(0, 8):
                for _ in range(3 if c == "ELC" else 2):
                    h, a = r.sample(EQ_ACTUAL[c], 2); mid += 1
                    t = hoy + timedelta(days=d, hours=r.randint(12, 23), minutes=r.choice([0, 15, 30, 45]))
                    if t <= INICIO + timedelta(hours=2): continue
                    out.append(partido(r, c, 500000 + 1000 * list(EQ).index(c) + mid, h, a, t, False))
            ULTIMO_CAL[c] = out
            n, veces = OMITIR.get(c, (0, 0))
            if veces > 0:
                OMITIR[c] = (n, veces - 1)
                out = out[n:]
            return 200, {"matches": out}
        if "season" in q:
            s = int(q["season"])
            if c == "BSA" and s == 2025: return 403, {"message": "The resource you are looking for is restricted."}
            n = {"BL1": 306, "FL1": 306, "DED": 306, "PPL": 306, "ELC": 552, "CL": 189}.get(c, 380)
            return 200, {"matches": temporada(c, n, s, datetime(s + 1, 5, 25, tzinfo=timezone.utc))}
        n = {"CL": 54, "ELC": 130}.get(c, 80)
        jugado = temporada(c, n, "actual", INICIO - timedelta(days=1))
        if JUGAR[0]:
            # los del último calendario, ya terminados (mismos id), con un marcador de verdad
            for m in ULTIMO_CAL.get(c, []):
                if not (m.get("homeTeam") or {}).get("id"):
                    continue
                r = rnd_de("jugado", m["id"])
                jugado.append(partido(r, c, m["id"], m["homeTeam"], m["awayTeam"],
                                      datetime.strptime(m["utcDate"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc), True))
        return 200, {"matches": jugado}
    m = re.fullmatch(r"/v4/teams/(\d+)/matches", ruta)
    if m:
        tid = int(m.group(1)); c = q.get("competitions", "PD")
        if tid == FALLA_EQUIPO: return 500, {"message": "error interno de prueba"}
        r = rnd_de("equipo", tid, c)
        eq = EQ.get(c, [])
        yo = next((e for e in eq if e["id"] == tid), None)
        if yo is None: return 200, {"matches": []}
        out = []
        for k in range(r.randint(3, 45)):
            otro = r.choice([e for e in eq if e["id"] != tid])
            h, a = (yo, otro) if k % 2 else (otro, yo)
            out.append(partido(r, c, 20_000_000 + tid * 100 + k, h, a, INICIO - timedelta(days=r.randint(1, 390)), True))
        return 200, {"matches": out}
    m = re.fullmatch(r"/v4/teams/(\d+)", ruta)
    if m:
        tid = int(m.group(1))
        comp = [{"code": LIGA_DE[tid], "type": "LEAGUE"}] if tid in LIGA_DE else [{"code": "BJL", "type": "LEAGUE"}]
        return 200, {"id": tid, "squad": [{"id": k, "name": f"Jugador {k}", "position": "Midfield"} for k in range(28)],
                     "runningCompetitions": comp + [{"code": "CL", "type": "CUP"}]}
    return 404, {"message": "ruta desconocida"}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/__stats":
            cuerpo = json.dumps({"total": TOTAL[0], "por_tipo": CONTADOR}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(cuerpo); return
        if u.path == "/__limite":
            LIMITE[0] = int(q.get("n", "0"))
            self.send_response(200); self.end_headers(); return
        if u.path == "/__jugar":
            JUGAR[0] = q.get("si", "1") == "1"
            self.send_response(200); self.end_headers(); return
        if u.path == "/__omitir":
            OMITIR[q["liga"]] = (int(q.get("n", "3")), int(q.get("veces", "1")))
            self.send_response(200); self.end_headers(); return
        if u.path == "/__reset":
            with CANDADO: CONTADOR.clear(); TOTAL[0] = 0
            self.send_response(200); self.end_headers(); return
        with CANDADO:
            TOTAL[0] += 1
            tipo = re.sub(r"\d+", "N", u.path) + ("?season" if "season" in q else "?fechas" if "dateFrom" in q else "")
            CONTADOR[tipo] += 1
            n = TOTAL[0]
        if self.headers.get("X-Auth-Token") is None:
            st, d = 403, {"message": "falta el token"}
        elif LIMITE[0] and n % LIMITE[0] == 0:
            st, d = 429, {"message": "You reached your request limit. Wait 30 seconds."}
        else:
            st, d = responder(u.path, q)
        cuerpo = json.dumps(d).encode()
        self.send_response(st); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(cuerpo)

ThreadingHTTPServer(("127.0.0.1", PUERTO), H).serve_forever()
