"""La vigilancia, de punta a punta: /salud del Worker local ya lleno y el guion de
.github/workflows/vigilancia.yml, el mismo que corre GitHub cada 3 horas, contra él.
Con la web sana, pasa. Una pasada del cron que muere se cuenta (seguidas y en el día) y
una sola se tolera; con 2 seguidas o 3 en el día, falla. Un CSV de tiros a puerta que
lleva unas horas fallando se tolera; con más de un día, falla. Va la última de e2e.sh:
fuerza una actualización.
Uso: python pruebas/salud.py PUERTO_WORKER DIR_D1 UPDATE_SECRET"""
import glob, json, os, re, sqlite3, subprocess, sys, tempfile, textwrap, time, urllib.request
from datetime import datetime, timedelta, timezone

W, D1, SECRETO = f"http://127.0.0.1:{sys.argv[1]}", sys.argv[2], sys.argv[3]
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pedir = lambda ruta: json.load(urllib.request.urlopen(W + ruta))
cron = lambda: urllib.request.urlopen(W + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*").read()

base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
assert len(base) == 1, base
db = sqlite3.connect(base[0])

# el guion del workflow, tal cual está en el YAML
yml = open(os.path.join(REPO, ".github/workflows/vigilancia.yml"), encoding="utf-8").read()
guion = textwrap.dedent(re.search(r"python3 - <<'EOF'\n(.*?)\n\s*EOF\n", yml, re.S).group(1))


def vigilar():
    """Corre el guion contra el Worker local: (si pasó, lo que dijo)."""
    with tempfile.NamedTemporaryFile("r", suffix=".md") as resumen:
        r = subprocess.run([sys.executable, "-c", guion], capture_output=True, text=True,
                           env={**os.environ, "URL": W, "GITHUB_STEP_SUMMARY": resumen.name})
        assert resumen.read().strip(), "el guion no escribió su resumen"
    return r.returncode == 0, (r.stdout + r.stderr).strip()


# --- sana
s = pedir("/salud")
assert s["ok"] and s["estado"] == "listo" and s["total"] > 0, s
assert s["muertes"] == 0 and s["muertes_hoy"] == 0 and s["tiros"] == {"fallan": 0, "desde": None}, s
bien, dicho = vigilar()
assert bien and "pasadas muertas: 0 seguidas y 0 hoy" in dicho and "CSV de tiros que fallan: 0" in dicho, dicho
print(f"sana: /salud con todo a cero y la vigilancia pasa ({dicho})")

# --- una pasada que muere: deja el candado puesto y caduca; la siguiente lo nota
db.execute("INSERT INTO candado (nombre, hasta, dueno) VALUES ('pasada', ?, 'muerta') "
           "ON CONFLICT (nombre) DO UPDATE SET hasta = excluded.hasta, dueno = excluded.dueno",
           (int(time.time() * 1000) - 1000,))
db.commit()
pedir(f"/actualizar?token={SECRETO}&forzar=1")
cron()
s = pedir("/salud")
assert s["muertes_hoy"] == 1 and s["muertes"] in (0, 1), s
for _ in range(30):   # la forzada termina y las seguidas vuelven a 0
    if s["estado"] == "listo" and s["muertes"] == 0:
        break
    cron()
    s = pedir("/salud")
assert s["estado"] == "listo" and s["muertes"] == 0 and s["muertes_hoy"] == 1, s
bien, dicho = vigilar()
assert bien and "0 seguidas y 1 hoy" in dicho, dicho
print("una pasada muerta: se cuenta en el día, las seguidas vuelven a 0 y la vigilancia la tolera")

# --- varias: 3 en el día, o 2 seguidas
dia = db.execute("SELECT dueno FROM candado WHERE nombre = 'muertes_dia'").fetchone()[0]
assert re.fullmatch(r"\d{4}-\d\d-\d\d", dia), dia
poner = lambda nombre, n, dueno="": (db.execute(
    "UPDATE candado SET hasta = ?, dueno = ? WHERE nombre = ?", (n, dueno, nombre)), db.commit())
poner("muertes_dia", 3, dia)
bien, dicho = vigilar()
assert not bien and "el cron se queda sin tiempo de CPU" in dicho and "3 hoy" in dicho, dicho
poner("muertes_dia", 1, dia)
poner("muertes", 2)
bien, dicho = vigilar()
assert not bien and "el cron se queda sin tiempo de CPU" in dicho and "2 seguidas" in dicho, dicho
poner("muertes", 0)
poner("muertes_dia", 9, "2000-01-01")   # las de otro día no cuentan
s = pedir("/salud")
assert s["muertes_hoy"] == 0, s
assert vigilar()[0]
print("3 en el día o 2 seguidas: la vigilancia falla; las de otro día no cuentan")

# --- un CSV de tiros a puerta que falla
clave = "PL:actual"
original = db.execute("SELECT valor FROM cache WHERE seccion = 'tiros' AND clave = ?", (clave,)).fetchone()[0]
hace = lambda horas: (datetime.now(timezone.utc) - timedelta(hours=horas)).isoformat(timespec="milliseconds")


def fallando(horas):
    e = {**json.loads(original), "fallo": True, "fallando_desde": hace(horas), "actualizado": hace(1)}
    db.execute("UPDATE cache SET valor = ? WHERE seccion = 'tiros' AND clave = ?", (json.dumps(e), clave))
    db.commit()
    return e


e = fallando(3)
s = pedir("/salud")
assert s["tiros"] == {"fallan": 1, "desde": e["fallando_desde"]}, s
bien, dicho = vigilar()
assert bien and "CSV de tiros que fallan: 1, desde hace 3 h" in dicho, dicho
fallando(30)
bien, dicho = vigilar()
assert not bien and "los tiros a puerta de football-data.co.uk no se bajan" in dicho and "desde hace 30 h" in dicho, dicho
db.execute("UPDATE cache SET valor = ? WHERE seccion = 'tiros' AND clave = ?", (original, clave))
db.commit()
assert pedir("/salud")["tiros"] == {"fallan": 0, "desde": None} and vigilar()[0]
print("un CSV de tiros que falla: 3 horas se toleran; con 30, la vigilancia falla")
print("salud: OK")
