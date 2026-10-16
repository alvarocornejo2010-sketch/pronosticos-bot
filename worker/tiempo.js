// Fechas en la zona horaria de referencia (America/Lima por defecto), para que
// "hoy" signifique lo mismo que en app.py: Cloudflare corre en UTC y a partir de
// las 19:00 de Lima ya sería mañana.

const UTC_MENOS_5 = -300;   // minutos. Perú no tiene horario de verano.

// Zonas sin horario de verano: su desfase es fijo y no hace falta Intl, que en
// un isolate recién creado cuesta milisegundos de CPU solo en arrancar.
const FIJAS = { "America/Lima": UTC_MENOS_5, UTC: 0, "Etc/UTC": 0 };

// Para las demás, un formateador de Intl por zona, que vive lo que el isolate.
const ZONAS = new Map();

function zona(tz) {
  if (!ZONAS.has(tz)) {
    let formato = null;
    if (tz in FIJAS) {
      ZONAS.set(tz, { formato: null, fijo: FIJAS[tz], memo: null });
      return ZONAS.get(tz);
    }
    try {
      formato = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      formato.format(0);
    } catch {
      // como app.py sin tzdata: UTC-5 fijo, que para Perú es exacto todo el año
      console.warn(`No se encontró la zona '${tz}'. Usando UTC-5 fijo.`);
      formato = null;
    }
    ZONAS.set(tz, { formato, fijo: UTC_MENOS_5, memo: new Map() });
  }
  return ZONAS.get(tz);
}

export class Reloj {
  constructor(tz) {
    const z = zona(tz);
    this.formato = z.formato;
    this.fijo = z.fijo;
    this.memo = z.memo;
  }

  // Minutos que la zona lleva de diferencia con UTC en ese instante. Se guarda
  // por hora: crear las partes con Intl es lo caro, y los cambios de horario
  // caen en hora en punto.
  desfase(ms) {
    if (!this.formato) return this.fijo;
    const hora = Math.floor(ms / 3600000);
    let d = this.memo.get(hora);
    if (d === undefined) {
      const p = {};
      for (const x of this.formato.formatToParts(hora * 3600000)) p[x.type] = x.value;
      const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      d = Math.round((local - hora * 3600000) / 60000);
      this.memo.set(hora, d);
    }
    return d;
  }

  // Fecha (AAAA-MM-DD), hora (HH:MM), año y mes locales de un instante.
  local(ms) {
    const iso = new Date(ms + this.desfase(ms) * 60000).toISOString();
    return { fecha: iso.slice(0, 10), hora: iso.slice(11, 16), anio: +iso.slice(0, 4), mes: +iso.slice(5, 7) };
  }

  // Como datetime.now(TZ).isoformat(): hora local con su desfase.
  iso(ms) {
    const d = this.desfase(ms);
    const base = new Date(ms + d * 60000).toISOString().slice(0, 23);
    const a = Math.abs(d);
    return base + (d < 0 ? "-" : "+") + dos(Math.floor(a / 60)) + ":" + dos(a % 60);
  }
}

const dos = (n) => String(n).padStart(2, "0");

export function sumarDias(fecha, n) {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

// Días de a hasta b (fechas AAAA-MM-DD).
export function diasEntre(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// Como date.weekday() de Python: lunes = 0.
export function diaSemana(fecha) {
  return (new Date(fecha + "T00:00:00Z").getUTCDay() + 6) % 7;
}
