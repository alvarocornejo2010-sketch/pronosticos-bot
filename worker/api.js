// Cliente de football-data.org con el presupuesto de cada pasada: como mucho
// PRESUPUESTO_REQUESTS peticiones, separadas PAUSA_ENTRE_REQUESTS (10 por minuto
// en el plan free), y como mucho MAX_BYTES_PASADA de JSON leído, que es lo que
// gasta la CPU (10 ms por ejecución en el plan gratis de Workers).

// Se lanza cuando no queda presupuesto en esta pasada o la API dice que se
// pasó del límite (HTTP 429). El partido que la recibe se queda pendiente y lo
// recoge la pasada siguiente, un minuto después: no se calcula a ciegas.
// No hereda de Error a propósito: en una pasada se lanza una vez por cada
// partido que queda, y capturar la traza de cada una gastaba CPU de verdad.
export class SinPresupuesto {
  constructor(motivo) {
    this.name = "SinPresupuesto";
    this.message = motivo;
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Una respuesta "grande" (una temporada entera, ~400 KB, la Championship ~600)
// cuesta 3-4 ms de CPU solo en leerla: va como mucho una por pasada, al
// principio, y con ella la pasada ya no lee mucho más.
const UMBRAL_GRANDE = 64 * 1024;

export class ClienteAPI {
  constructor({ token, base, presupuesto, pausaMs, maxBytes, ultimaPeticion = 0, fetchFn = null }) {
    this.token = token;
    this.base = base;
    this.presupuesto = presupuesto;
    this.pausaMs = pausaMs;
    this.maxBytes = maxBytes;
    this.ultima = ultimaPeticion;
    this.fetch = fetchFn || ((...a) => fetch(...a));
    this.gastadas = 0;
    this.bytes = 0;
    this.limitada = false;   // la API respondió 429
  }

  agotado() {
    return this.limitada || this.gastadas >= this.presupuesto || this.bytes >= this.maxBytes;
  }

  // calendario=true: los calendarios se piden aunque se haya gastado el número
  // de peticiones, como en app.py (sin ellos no hay ni lista de partidos), pero
  // nunca después de un 429.
  async get(ruta, params = {}, { calendario = false, grande = false } = {}) {
    if (this.limitada) throw new SinPresupuesto("la API pidió esperar (429)");
    if (!calendario && this.agotado()) throw new SinPresupuesto("presupuesto de la pasada agotado");
    if (grande && this.bytes > UMBRAL_GRANDE) throw new SinPresupuesto("una respuesta grande por pasada");

    const espera = this.ultima + this.pausaMs - Date.now();
    if (espera > 0) await dormir(espera);

    const url = new URL(this.base + ruta);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    this.gastadas += 1;
    let resp;
    try {
      resp = await this.fetch(url.toString(), {
        headers: { "X-Auth-Token": this.token, "User-Agent": "pronosticos-bot (Cloudflare Workers)" },
        signal: AbortSignal.timeout(30000),   // como el timeout=30 de requests en app.py
      });
    } finally {
      this.ultima = Date.now();
    }
    const texto = await resp.text();
    this.bytes += texto.length;

    if (resp.status === 429) {
      this.limitada = true;
      throw new SinPresupuesto("la API pidió esperar (429)");
    }
    let cuerpo = null;
    if (resp.status === 200) {
      try {
        cuerpo = JSON.parse(texto);
      } catch {
        return { status: 502, cuerpo: null };   // 200 con un cuerpo que no es JSON: cuenta como fallo
      }
    }
    return { status: resp.status, cuerpo };
  }
}
