// La CPU que gasta el propio Worker en cada petición, como la cuenta Cloudflare: el
// perfilador de V8 de su isolate, por el inspector de `wrangler dev --inspector-port`.
// Medir el proceso workerd entero no sirve: con la D1 local, ese proceso corre también
// el SQLite (que en producción va en otra máquina y no cuenta para los 10 ms) y el
// depurador, y salen 20-130 ms por pasada. Hasta oct 2026 las pruebas medían además el
// proceso equivocado (el intermediario de wrangler, ~3 ms haga lo que haga el Worker).
//
// Cuenta las muestras del perfilador que no son "(idle)" (JavaScript, WebCrypto, leer el
// JSON de la API y de la D1, el recolector de basura), cada una como mucho de 0,25 ms:
// si el sistema aparta el hilo un rato, la muestra siguiente se llevaría todo el hueco.
// En local sale algo más que en producción (el propio perfilador y otra máquina).
//
// Uso: node pruebas/cpu_isolate.mjs PUERTO_INSPECTOR [URL...]
// Pide cada URL y escribe una línea JSON por petición: {url, status, ms}. Sin URL, las
// lee de la entrada, una por línea (así lo usa medir_cpu.py en cada pasada del cron).
// Desde otra prueba en Node: (await Perfilador.conectar(puerto)).medir(url).
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const INTERVALO_US = 50, TOPE_US = 250;

export class Perfilador {
  static async conectar(puerto) {
    const lista = await (await fetch(`http://127.0.0.1:${puerto}/json`)).json();
    // el inspector de wrangler solo acepta conexiones con Origin de localhost
    const ws = new WebSocket(lista[0].webSocketDebuggerUrl, { headers: { Origin: "http://localhost" } });
    await new Promise((ok, mal) => { ws.onopen = ok; ws.onerror = mal; });
    const p = new Perfilador(ws);
    await p.cdp("Profiler.enable");
    await p.cdp("Profiler.setSamplingInterval", { interval: INTERVALO_US });
    return p;
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.esperan = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.esperan.has(d.id)) { this.esperan.get(d.id)(d); this.esperan.delete(d.id); }
    };
  }

  cdp(method, params = {}) {
    return new Promise((ok) => {
      const i = ++this.id;
      this.esperan.set(i, ok);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  // Pide la URL (GET) y da { status, ms }: la CPU del isolate mientras la atendía.
  async medir(url) {
    await this.cdp("Profiler.start");
    const r = await fetch(url);
    await r.arrayBuffer();
    const { profile: p } = (await this.cdp("Profiler.stop")).result;
    const ociosos = new Set(p.nodes.filter((n) => n.callFrame.functionName === "(idle)").map((n) => n.id));
    let us = 0;
    p.samples.forEach((s, i) => { if (!ociosos.has(s)) us += Math.min(p.timeDeltas[i] || 0, TOPE_US); });
    return { status: r.status, ms: Math.round(us / 100) / 10 };
  }

  cerrar() { this.ws.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [puerto, ...urls] = process.argv.slice(2);
  const p = await Perfilador.conectar(puerto);
  const medir = async (url) => console.log(JSON.stringify({ url, ...(await p.medir(url)) }));
  if (urls.length) for (const url of urls) await medir(url);
  else for await (const linea of createInterface({ input: process.stdin })) if (linea.trim()) await medir(linea.trim());
  p.cerrar();
  process.exit(0);
}
