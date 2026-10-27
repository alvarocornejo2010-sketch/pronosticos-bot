"""La limpieza del día (worker/limpieza.js), contra el Worker local ya lleno: en un
minuto libre del cron borra las sesiones de más de 180 días sin usarse y los calendarios
de más de 120 sin pedirse, deja los demás, apunta lo que hizo en el documento limpieza y
no se repite hasta el día siguiente.
Uso: python pruebas/limpieza.py PUERTO_WORKER DIR_D1"""
import glob, json, sqlite3, sys, time, urllib.request

W, D1 = f"http://127.0.0.1:{sys.argv[1]}", sys.argv[2]
cron = lambda: urllib.request.urlopen(W + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*").read()
DIA = 86400000

base = [f for f in glob.glob(D1 + "/**/*.sqlite", recursive=True) if "D1DatabaseObject" in f and "metadata" not in f]
assert len(base) == 1, base
db = sqlite3.connect(base[0])
ahora = int(time.time() * 1000)
sesiones = {"limpieza-vieja": ahora - 181 * DIA, "limpieza-viva": ahora - 179 * DIA}
calendarios = {"limpiezavieja": ahora - 121 * DIA, "limpiezaviva": ahora - 119 * DIA}
for h, vista in sesiones.items():
    db.execute("INSERT OR REPLACE INTO sesiones (hash, cuenta, creada, vista) VALUES (?, 'limpieza', ?, ?)", (h, vista, vista))
for c, visto in calendarios.items():
    db.execute("INSERT OR REPLACE INTO calendarios (clave, equipos, creado, visto) VALUES (?, '[]', ?, ?)", (c, visto, visto))
# como si no se hubiera hecho nunca: toca en el siguiente minuto libre
db.execute("DELETE FROM documentos WHERE clave = 'limpieza'")
db.commit()

doc = lambda: db.execute("SELECT valor, actualizado FROM documentos WHERE clave = 'limpieza'").fetchone()
for minuto in range(40):
    cron()
    if doc():
        break
assert doc(), "la limpieza no se hizo en 40 minutos del cron"
valor, cuando = doc()
hecho = json.loads(valor)
quedan = lambda tabla, col, claves: {f[0] for f in db.execute(
    f"SELECT {col} FROM {tabla} WHERE {col} IN ({','.join('?' * len(claves))})", list(claves))}
assert quedan("sesiones", "hash", sesiones) == {"limpieza-viva"}, quedan("sesiones", "hash", sesiones)
assert quedan("calendarios", "clave", calendarios) == {"limpiezaviva"}, quedan("calendarios", "clave", calendarios)
assert hecho["sesiones"] >= 1 and hecho["calendarios"] >= 1 and "error" not in hecho, hecho
print(f"limpieza: en el minuto libre {minuto + 1} del cron, {hecho['sesiones']} sesión de más de 180 días"
      f" y {hecho['calendarios']} calendario de más de 120 fuera; las demás se quedan")

for _ in range(5):
    cron()
assert doc()[1] == cuando, "la limpieza se repitió antes de un día"
print("no se repite hasta el día siguiente")

db.execute("DELETE FROM sesiones WHERE hash = 'limpieza-viva'")
db.execute("DELETE FROM calendarios WHERE clave = 'limpiezaviva'")
db.commit()
print("limpieza: OK")
