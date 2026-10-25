"""La CPU del Worker local en cada petición, como la cuenta Cloudflare, para compararla
con los 10 ms del plan gratis: pide la URL a través de cpu_isolate.mjs, que la mide con
el perfilador de V8 del isolate (por el inspector de `wrangler dev --inspector-port`).
Ver allí por qué no vale medir el proceso workerd."""
import json, os, subprocess


class Medidor:
    def __init__(self, puerto_inspector):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cpu_isolate.mjs")
        self.proceso = subprocess.Popen(["node", script, str(puerto_inspector)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True, bufsize=1)

    def pedir(self, url):
        """(status, ms de CPU del Worker) de un GET a esa URL."""
        self.proceso.stdin.write(url + "\n")
        self.proceso.stdin.flush()
        linea = self.proceso.stdout.readline()
        if not linea:
            raise SystemExit(f"cpu_isolate.mjs terminó sin medir {url}")
        d = json.loads(linea)
        return d["status"], d["ms"]

    def cerrar(self):
        self.proceso.stdin.close()
        self.proceso.wait(timeout=10)
