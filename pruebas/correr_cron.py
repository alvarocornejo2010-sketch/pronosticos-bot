"""Lanza el cron del Worker local (wrangler dev --test-scheduled) hasta que la web
está lista y la validación terminada, midiendo la CPU de workerd en cada pasada.
Falla si alguna pasada pasa de MAX_MS (el plan gratis da 10 ms por ejecución).
Uso: python pruebas/correr_cron.py PUERTO MAX_PASADAS [MAX_MS]"""
import glob, json, subprocess, sys, urllib.request

puerto, maximo = sys.argv[1], int(sys.argv[2])
max_ms = float(sys.argv[3]) if len(sys.argv) > 3 else None
pid = next(p for p in subprocess.check_output(["pgrep", "-f", "workerd serve"]).decode().split()
           if f"127.0.0.1:{puerto}" in open(f"/proc/{p}/cmdline").read().replace("\0", " "))


def cpu_ms():
    t = 0
    for f in glob.glob(f"/proc/{pid}/task/*/schedstat"):
        try:
            t += int(open(f).read().split()[0])
        except OSError:
            pass
    return t / 1e6


base = f"http://127.0.0.1:{puerto}"
ticks = []
for i in range(maximo):
    a = cpu_ms()
    urllib.request.urlopen(base + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*").read()
    b = cpu_ms()
    e = json.load(urllib.request.urlopen(base + "/api/estado"))
    v = json.load(urllib.request.urlopen(base + "/api/validacion"))
    ticks.append(round(b - a, 1))
    print(i, f"cpu {b - a:5.1f} ms", e.get("estado"), "total", e.get("total"), "pend", e.get("pendientes"),
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
