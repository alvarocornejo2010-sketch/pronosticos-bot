// Las cuentas, versión básica (oct 2026): sin email, sin contraseña y sin nada de
// quién es quién. Crear una cuenta da un código de acceso (16 letras y números al
// azar, 80 bits: imposible de adivinar a base de probar) que sirve para entrar desde
// otro aparato o después de borrar los datos del navegador. La cuenta guarda los
// equipos que sigues; la persona la puede descargar o borrar ella misma.
//
// Pensada para crecer sin rehacerla: la cuenta (cuentas) va aparte de cómo se entra
// (accesos, con tipo "codigo"). Una passkey o "entrar con Google" serán otro tipo de
// acceso de la misma cuenta. La sesión es una cookie HttpOnly con un token al azar;
// en D1 solo va el SHA-256 del token y el del código: quien leyera la base no podría
// entrar en ninguna cuenta.

import { ajustes } from "./config.js";
import { Reloj } from "./tiempo.js";

const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // Crockford: sin I, L, O ni U
const LARGO_CODIGO = 16;                              // 16 × 5 bits = 80 bits
const DIAS_SESION = 180;
const MS_DIA = 86400000;
export const MAX_EQUIPOS = 60;                        // los mismos que guarda la web
const MAX_NOMBRE = 80;
const MAX_CUERPO = 8192;
const MAX_SESIONES = 20;                              // por cuenta: las más viejas se van
const COOKIE = "sesion";

const azar = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

async function sha256(texto) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto))));
}

// "K7P4-QX2M-9TRB-H6WD". 256 es múltiplo de 32: cada byte da una letra sin sesgo.
export function codigoNuevo() {
  return [...azar(LARGO_CODIGO)].map((b) => ALFABETO[b & 31]).join("").match(/.{4}/g).join("-");
}

// Lo que escribe la persona: sin guiones ni espacios, en mayúsculas, y las letras
// que se confunden con números (O, I, L) como esos números. null si no es un código.
export function normalizarCodigo(texto) {
  const c = String(texto ?? "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return c.length === LARGO_CODIGO && [...c].every((ch) => ALFABETO.includes(ch)) ? c : null;
}

function tokenDe(request) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)sesion=([A-Za-z0-9_-]{43})(?:;|$)/);
  return m ? m[1] : null;
}
const cookie = (token, segundos) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${segundos}; HttpOnly; Secure; SameSite=Lax`;
const COOKIE_FUERA = cookie("", 0);

// Solo la propia web (también /api/contar, en visitas.js): con Referrer-Policy:
// no-referrer el navegador manda Origin "null" y Sec-Fetch-Site "same-origin"
// (Chromium manda el Origin de verdad). Aquí además la cookie es SameSite=Lax y el
// cuerpo, JSON: desde otra web tampoco llegaría la sesión.
export function mismoSitio(request, url) {
  const sitio = request.headers.get("Sec-Fetch-Site");
  if (sitio && sitio !== "same-origin") return false;
  const desde = request.headers.get("Origin");
  return !desde || desde === "null" || desde === url.origin;
}

async function cuerpoJson(request) {
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return null;
  if (Number(request.headers.get("Content-Length") || 0) > MAX_CUERPO) return null;
  const texto = await request.text();
  if (texto.length > MAX_CUERPO) return null;
  try {
    const v = JSON.parse(texto);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// Nombres de equipo tal como los guarda la web (los de football-data): texto, sin
// repetir, hasta MAX_EQUIPOS. Solo los ve su dueño, y la web los escapa al pintarlos.
export function limpiarEquipos(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set();
  for (const x of lista) {
    const n = typeof x === "string" ? x.trim() : "";
    if (n && n.length <= MAX_NOMBRE) vistos.add(n);
    if (vistos.size >= MAX_EQUIPOS) break;
  }
  return [...vistos];
}

// El tope del día de lo que escriben las cuentas (MAX_ESCRITURAS_CUENTAS_DIA): sin él,
// una sola cuenta podría poner y quitar estrellas en bucle hasta gastar las 100.000
// escrituras diarias de D1, y el cron dejaría de guardar predicciones.
class SinPresupuesto extends Error {}

// Un equipo más, si la cuenta existe y no ha llegado al máximo (y si ya estaba, nada).
const SUMAR_EQUIPO = `INSERT OR IGNORE INTO favoritos (cuenta, equipo, creado)
  SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM cuentas WHERE id = ?1)
    AND (SELECT count(*) FROM favoritos WHERE cuenta = ?1) < ?4`;

export class Cuentas {
  constructor(request, env, almacen, cabeceras, ahora = Date.now()) {
    this.request = request;
    this.url = new URL(request.url);
    this.aj = ajustes(env);
    this.almacen = almacen;
    this.db = almacen.db;
    this.cabeceras = cabeceras;
    this.ahora = ahora;
    this.dia = new Reloj(this.aj.tz).local(ahora).fecha;
    this.contadores = null;   // { cuentas, escrituras_cuentas } de hoy, al primer uso
  }

  async leerContadores() {
    if (this.contadores) return this.contadores;
    const r = await this.almacen.consultar(() => this.db.prepare(
      `SELECT tipo, n FROM visitas WHERE dia = ?1 AND tipo IN ('cuentas', 'escrituras_cuentas') AND clave = ''`)
      .bind(this.dia).all());
    this.contadores = { cuentas: 0, escrituras_cuentas: 0 };
    for (const f of r.results) this.contadores[f.tipo] = f.n;
    return this.contadores;
  }

  // Escribe, si cabe en el tope del día, y lo apunta. Cada sentencia cuenta por dos
  // filas (la tabla y su índice): por lo alto.
  async guardar(sentencias) {
    const c = await this.leerContadores();
    const gasto = sentencias.length * 2;
    if (c.escrituras_cuentas + gasto > this.aj.maxEscriturasCuentasDia) throw new SinPresupuesto();
    c.escrituras_cuentas += gasto;
    await this.almacen.escribir([...sentencias,
      this.db.prepare(`INSERT INTO visitas (dia, tipo, clave, n) VALUES (?1, 'escrituras_cuentas', '', ?2)
        ON CONFLICT (dia, tipo, clave) DO UPDATE SET n = n + excluded.n`).bind(this.dia, gasto)]);
  }

  json(obj, status = 200, extra = {}) {
    return new Response(JSON.stringify(obj), { status,
      headers: { ...this.cabeceras, "Content-Type": "application/json; charset=utf-8", ...extra } });
  }
  error(texto, status) { return this.json({ error: texto }, status); }
  conSesion(obj, token) {
    return this.json(obj, 200, { "Set-Cookie": cookie(token, DIAS_SESION * 86400) });
  }

  // La sesión de la cookie, si existe y no ha caducado (180 días sin usarse).
  async sesion() {
    const token = tokenDe(this.request);
    if (!token) return null;
    const hash = await sha256(token);
    const f = await this.almacen.consultar(() => this.db.prepare(
      `SELECT s.cuenta, s.vista, c.creada FROM sesiones s JOIN cuentas c ON c.id = s.cuenta
       WHERE s.hash = ?1`).bind(hash).first());
    if (!f) return null;
    if (f.vista < this.ahora - DIAS_SESION * MS_DIA) {
      await this.guardar([this.db.prepare("DELETE FROM sesiones WHERE hash = ?1").bind(hash)]).catch(() => {});
      return null;
    }
    return { token, hash, cuenta: f.cuenta, vista: f.vista, creada: f.creada };
  }

  async equipos(cuenta) {
    const r = await this.almacen.consultar(() => this.db.prepare(
      "SELECT equipo FROM favoritos WHERE cuenta = ?1 ORDER BY creado, equipo").bind(cuenta).all());
    return r.results.map((f) => f.equipo);
  }

  sumarEquipos(cuenta, lista) {
    return limpiarEquipos(lista).map((n, i) =>
      this.db.prepare(SUMAR_EQUIPO).bind(cuenta, n, this.ahora + i, MAX_EQUIPOS));
  }

  sinSesion() {
    return this.json({ error: "Tu sesión terminó: vuelve a entrar con tu código." }, 401,
      { "Set-Cookie": COOKIE_FUERA });
  }

  // GET /api/cuenta: la de esta sesión, o null. Renueva la cookie una vez al día.
  async ver() {
    const s = await this.sesion();
    if (!s) {
      return this.json({ disponible: true, cuenta: null }, 200,
        tokenDe(this.request) ? { "Set-Cookie": COOKIE_FUERA } : {});
    }
    const equipos = await this.equipos(s.cuenta);
    const cuerpo = { disponible: true, cuenta: { creada: iso(s.creada), equipos } };
    if (this.ahora - s.vista < MS_DIA) return this.json(cuerpo);
    try {
      await this.guardar([
        this.db.prepare("UPDATE sesiones SET vista = ?2 WHERE hash = ?1").bind(s.hash, this.ahora),
        this.db.prepare("UPDATE cuentas SET vista = ?2 WHERE id = ?1").bind(s.cuenta, this.ahora),
      ]);
    } catch (e) {
      if (e instanceof SinPresupuesto) return this.json(cuerpo);   // se renueva otro día
      throw e;
    }
    return this.conSesion(cuerpo, s.token);
  }

  // POST /api/cuenta/crear {equipos}: la cuenta, su código (se enseña una vez) y una
  // sesión. Tope de cuentas nuevas por día de Lima (MAX_CUENTAS_DIA): cada una son
  // unas cuantas escrituras. Se cuentan las creadas, no las que quedan (crear y
  // borrar en bucle no lo esquiva), en la tabla de contadores por día (visitas,
  // tipo "cuentas"). Dos a la vez pueden pasarse en una: es un tope, no una cuenta.
  async crear(body) {
    if ((await this.leerContadores()).cuentas >= this.aj.maxCuentasDia) {
      return this.error("Hoy ya se crearon muchas cuentas. Prueba mañana; tus equipos siguen en este navegador.", 429);
    }
    const id = hex(azar(16)), codigo = codigoNuevo(), token = base64url(azar(32));
    const [clave, sesion] = await Promise.all([sha256(normalizarCodigo(codigo)), sha256(token)]);
    await this.guardar([
      this.db.prepare(`INSERT INTO visitas (dia, tipo, clave, n) VALUES (?1, 'cuentas', '', 1)
        ON CONFLICT (dia, tipo, clave) DO UPDATE SET n = n + 1`).bind(this.dia),
      this.db.prepare("INSERT INTO cuentas (id, creada, vista) VALUES (?1, ?2, ?2)").bind(id, this.ahora),
      this.db.prepare("INSERT INTO accesos (tipo, clave, cuenta, creado) VALUES ('codigo', ?1, ?2, ?3)")
        .bind(clave, id, this.ahora),
      this.db.prepare("INSERT INTO sesiones (hash, cuenta, creada, vista) VALUES (?1, ?2, ?3, ?3)")
        .bind(sesion, id, this.ahora),
      ...this.sumarEquipos(id, body.equipos),
    ]);
    return this.conSesion({ codigo, cuenta: { creada: iso(this.ahora), equipos: await this.equipos(id) } }, token);
  }

  // POST /api/cuenta/entrar {codigo, equipos}: una sesión nueva en la cuenta de ese
  // código. Los equipos que ya había en este navegador se suman a los de la cuenta.
  // Cada cuenta guarda sus MAX_SESIONES sesiones más recientes.
  async entrar(body) {
    const c = normalizarCodigo(body.codigo);
    if (!c) return this.error("El código tiene 16 letras y números, como K7P4-QX2M-9TRB-H6WD.", 400);
    const clave = await sha256(c);
    const f = await this.almacen.consultar(() => this.db.prepare(
      `SELECT a.cuenta, c.creada FROM accesos a JOIN cuentas c ON c.id = a.cuenta
       WHERE a.tipo = 'codigo' AND a.clave = ?1`).bind(clave).first());
    if (!f) return this.error("Ese código no es de ninguna cuenta. Revisa que esté bien escrito.", 401);
    const token = base64url(azar(32));
    await this.guardar([
      this.db.prepare("INSERT INTO sesiones (hash, cuenta, creada, vista) VALUES (?1, ?2, ?3, ?3)")
        .bind(await sha256(token), f.cuenta, this.ahora),
      this.db.prepare(`DELETE FROM sesiones WHERE cuenta = ?1 AND hash NOT IN
        (SELECT hash FROM sesiones WHERE cuenta = ?1 ORDER BY vista DESC LIMIT ?2)`).bind(f.cuenta, MAX_SESIONES),
      this.db.prepare("UPDATE cuentas SET vista = ?2 WHERE id = ?1").bind(f.cuenta, this.ahora),
      ...this.sumarEquipos(f.cuenta, body.equipos),
    ]);
    return this.conSesion({ cuenta: { creada: iso(f.creada), equipos: await this.equipos(f.cuenta) } }, token);
  }

  // POST /api/cuenta/equipo {equipo, seguir}: la estrella de un equipo.
  async equipo(body, s) {
    const [nombre] = limpiarEquipos([body.equipo]);
    if (!nombre || typeof body.seguir !== "boolean") return this.error("Falta el equipo.", 400);
    if (!body.seguir) {
      await this.guardar([
        this.db.prepare("DELETE FROM favoritos WHERE cuenta = ?1 AND equipo = ?2").bind(s.cuenta, nombre)]);
      return this.json({ ok: true });
    }
    await this.guardar([this.db.prepare(SUMAR_EQUIPO).bind(s.cuenta, nombre, this.ahora, MAX_EQUIPOS)]);
    const ya = await this.db.prepare("SELECT 1 FROM favoritos WHERE cuenta = ?1 AND equipo = ?2")
      .bind(s.cuenta, nombre).first();
    if (!ya) return this.error(`Tu cuenta ya sigue a ${MAX_EQUIPOS} equipos: quita alguno antes.`, 409);
    return this.json({ ok: true });
  }

  // POST /api/cuenta/codigo: un código nuevo (se enseña una vez); el de antes deja de valer.
  async codigo(s) {
    const codigo = codigoNuevo();
    await this.guardar([
      this.db.prepare("DELETE FROM accesos WHERE cuenta = ?1 AND tipo = 'codigo'").bind(s.cuenta),
      this.db.prepare("INSERT INTO accesos (tipo, clave, cuenta, creado) VALUES ('codigo', ?1, ?2, ?3)")
        .bind(await sha256(normalizarCodigo(codigo)), s.cuenta, this.ahora),
    ]);
    return this.json({ codigo });
  }

  // POST /api/cuenta/salir {todas}: cierra la sesión de este aparato, o las de todos.
  async salir(body, s) {
    if (s) {
      await this.guardar([body.todas
        ? this.db.prepare("DELETE FROM sesiones WHERE cuenta = ?1").bind(s.cuenta)
        : this.db.prepare("DELETE FROM sesiones WHERE hash = ?1").bind(s.hash)]);
    }
    return this.json({ ok: true }, 200, { "Set-Cookie": COOKIE_FUERA });
  }

  // GET /api/cuenta/datos: todo lo que hay guardado de la cuenta, para descargarlo.
  async datos(s) {
    const [cuenta, accesos, sesiones, equipos] = await this.almacen.consultar(() => this.db.batch([
      this.db.prepare("SELECT id, creada, vista FROM cuentas WHERE id = ?1").bind(s.cuenta),
      this.db.prepare("SELECT tipo, creado FROM accesos WHERE cuenta = ?1 ORDER BY creado").bind(s.cuenta),
      this.db.prepare("SELECT hash, creada, vista FROM sesiones WHERE cuenta = ?1 ORDER BY creada").bind(s.cuenta),
      this.db.prepare("SELECT equipo, creado FROM favoritos WHERE cuenta = ?1 ORDER BY creado").bind(s.cuenta),
    ]));
    const c = cuenta.results[0];
    const datos = {
      descargado: iso(this.ahora),
      nota: "Es todo lo que la web guarda de tu cuenta. El código y las sesiones van cifrados (SHA-256): no se pueden ver.",
      cuenta: { id: c.id, creada: iso(c.creada), ultima_vez: iso(c.vista) },
      accesos: accesos.results.map((a) => ({ tipo: a.tipo, creado: iso(a.creado) })),
      sesiones: sesiones.results.map((x) => ({ creada: iso(x.creada), ultima_vez: iso(x.vista),
        este_aparato: x.hash === s.hash })),
      equipos: equipos.results.map((e) => ({ equipo: e.equipo, desde: iso(e.creado) })),
    };
    return new Response(JSON.stringify(datos, null, 2), { headers: { ...this.cabeceras,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="pronosticos-mi-cuenta.json"' } });
  }

  // POST /api/cuenta/borrar: la cuenta entera, ya (sin papelera). D1 guarda copias de
  // los últimos 7 días (Time Travel): pasado eso, no queda nada. No mira el tope del
  // día: borrar la cuenta tiene que funcionar siempre (y solo se borra una vez).
  async borrar(s) {
    await this.almacen.escribir([
      this.db.prepare("DELETE FROM favoritos WHERE cuenta = ?1").bind(s.cuenta),
      this.db.prepare("DELETE FROM sesiones WHERE cuenta = ?1").bind(s.cuenta),
      this.db.prepare("DELETE FROM accesos WHERE cuenta = ?1").bind(s.cuenta),
      this.db.prepare("DELETE FROM cuentas WHERE id = ?1").bind(s.cuenta),
    ]);
    return this.json({ ok: true }, 200, { "Set-Cookie": COOKIE_FUERA });
  }

  async atender() {
    try {
      return await this.despachar(this.url.pathname.slice("/api/cuenta".length) || "/");
    } catch (e) {
      if (!(e instanceof SinPresupuesto)) throw e;
      return this.error("Hoy la web ya guardó muchos cambios de cuentas: prueba mañana. "
        + "Tus equipos siguen en este navegador.", 429);
    }
  }

  // Cada ruta, por su nombre: una que no esté aquí da 404 (nunca cae en otra).
  async despachar(ruta) {
    if (this.request.method === "GET" || this.request.method === "HEAD") {
      if (ruta === "/") return this.ver();
      if (ruta !== "/datos") return this.error("No existe.", 404);
      const s = await this.sesion();
      return s ? this.datos(s) : this.sinSesion();
    }
    if (!mismoSitio(this.request, this.url)) return this.error("Solo desde la propia web.", 403);
    const body = await cuerpoJson(this.request);
    if (!body) return this.error("Petición mal formada.", 400);
    if (ruta === "/crear") return this.crear(body);
    if (ruta === "/entrar") return this.entrar(body);
    const s = await this.sesion();
    if (ruta === "/salir") return this.salir(body, s);
    if (!s) return this.sinSesion();
    if (ruta === "/equipo") return this.equipo(body, s);
    if (ruta === "/codigo") return this.codigo(s);
    if (ruta === "/borrar") return this.borrar(s);
    return this.error("No existe.", 404);
  }
}

// Las rutas y sus métodos (index.js).
export const RUTAS_CUENTA = {
  "/api/cuenta": ["GET", "HEAD"],
  "/api/cuenta/datos": ["GET", "HEAD"],
  "/api/cuenta/crear": ["POST"],
  "/api/cuenta/entrar": ["POST"],
  "/api/cuenta/equipo": ["POST"],
  "/api/cuenta/codigo": ["POST"],
  "/api/cuenta/salir": ["POST"],
  "/api/cuenta/borrar": ["POST"],
};

// Para el panel de visitas: cuántas cuentas hay, cuántas se crearon esta semana
// (también las ya borradas: el contador del tope) y cuántas entraron.
export async function resumenCuentas(almacen, desde7, ahora = Date.now()) {
  const f = await almacen.consultar(() => almacen.db.prepare(
    `SELECT count(*) AS total, coalesce(sum(vista >= ?1), 0) AS activas,
       (SELECT count(DISTINCT cuenta) FROM favoritos) AS con_equipos,
       (SELECT coalesce(sum(n), 0) FROM visitas WHERE tipo = 'cuentas' AND clave = '' AND dia >= ?2) AS creadas
     FROM cuentas`).bind(ahora - 7 * MS_DIA, desde7).first());
  return { total: f.total, creadas: f.creadas, activas: f.activas, con_equipos: f.con_equipos };
}
