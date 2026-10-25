"""Lanza el cron del Worker local (wrangler dev --test-scheduled) hasta que la web
está lista y la validación terminada, midiendo la CPU del Worker en cada pasada
(medir_cpu.py). Falla si alguna pasada pasa de MAX_MS (el plan gratis da 10 ms por
ejecución).
Uso: python pruebas/correr_cron.py PUERTO PUERTO_INSPECTOR MAX_PASADAS [MAX_MS]"""
import json, sys, urllib.request

from medir_cpu import Medidor

puerto, maximo = sys.argv[1], int(sys.argv[3])
max_ms = float(sys.argv[4]) if len(sys.argv) > 4 else None
medidor = Medidor(sys.argv[2])

base = f"http://127.0.0.1:{puerto}"
ticks = []
for i in range(maximo):
    _, ms = medidor.pedir(base + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*")
    e = json.load(urllib.request.urlopen(base + "/api/estado"))
    v = json.load(urllib.request.urlopen(base + "/api/validacion"))
    ticks.append(ms)
    print(i, f"cpu {ms:5.1f} ms", e.get("estado"), "total", e.get("total"), "pend", e.get("pendientes"),
          "| validación", v.get("estado"), len(v.get("ligas", {})), flush=True)
    if e.get("estado") == "listo" and v.get("estado") == "listo":
        break
else:
    sys.exit(f"tras {maximo} pasadas la web o la validación no terminaron")
print("ticks:", ticks)
print("max", max(ticks), "media", round(sum(ticks) / len(ticks), 1))
# la primera pasada compila el Worker en workerd: no cuenta para el límite
if max_ms is not None and max(ticks[1:] or [0]) > max_ms:
    sys.exit(f"una pasada gastó {max(ticks[1:])} ms de CPU (límite {max_ms})")
