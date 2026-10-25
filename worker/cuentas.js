// Las cuentas (oct 2026): usuario y contraseña, y un correo si la persona quiere, para
// entrar con él y, el día que la web pueda mandar correos, recuperar la contraseña
// (hoy no se verifica: eso necesita el plan de pago). La cuenta guarda los equipos que
// sigues; la persona la puede descargar o borrar ella misma. Cada cuenta tiene un ID
// (idPublico, "K7P4-QX2M") que solo sirve para identificarla, no para entrar. Crear
// una cuenta pasa por Cloudflare Turnstile cuando están sus dos claves.
//
// La contraseña no llega aquí tal cual: el navegador la pasa por PBKDF2-SHA256
// (600.000 vueltas, con el usuario como sal; app.js, claveDe) y manda el resultado.
// Aquí se guarda el SHA-256 de eso con una sal al azar. Así el trabajo lento lo hace
// el navegador (los 10 ms de CPU del Worker no dan para un hash de contraseñas), y
// quien leyera la base tendría que pasar cada intento por las 600.000 vueltas. Con
// correo, el navegador manda además la misma contraseña con el correo de sal, que va
// en correos: así se entra con cualquiera de los dos sin preguntar antes cuál es el
// usuario de un correo. Cada intento se apunta antes de mirar la contraseña (intento),
// con el usuario o con el correo: diez seguidos sin acertar bloquean la cuenta 15
// minutos, aunque lleguen todos a la vez.
//
// La cuenta (cuentas) va aparte de cómo se entra (usuarios; accesos queda para una
// passkey o Google, y guarda el código de las cuentas de la primera versión, que ya no
// sirve para entrar). La sesión es una cookie HttpOnly con un token al azar; en D1
// solo va su SHA-256.

import { ajustes } from "./config.js";
import { Reloj } from "./tiempo.js";

const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // Crockford: sin I, L, O ni U
const DIAS_SESION = 180;
const MS_DIA = 86400000;
export const MAX_EQUIPOS = 60;                        // los mismos que guarda la web
const MAX_NOMBRE = 80;
const MAX_CUERPO = 8192;
const MAX_SESIONES = 20;                              // por cuenta: las más viejas se van
const MAX_FALLOS = 10;                                // contraseñas mal seguidas...
const BLOQUEO_MS = 15 * 60000;                        // ...y ese usuario espera esto
const COOKIE = "sesion";

const azar = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

async function sha256(texto) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto))));
}

// El ID de una cuenta: los 40 primeros bits de su id, en letras de Crockford
// ("K7P4-QX2M"). Sirve para identificarla (en el panel, en un aviso), no para entrar.
export function idPublico(id) {
  let n = BigInt("0x" + id.slice(0, 10)), s = "";
  for (let i = 0; i < 8; i++) { s = ALFABETO[Number(n & 31n)] + s; n >>= 5n; }
  return s.slice(0, 4) + "-" + s.slice(4);
}

// El usuario: de 3 a 24 letras sin tildes, números, punto, guion o guion bajo,
// empezando por letra o número, sin distinguir mayúsculas. null si no vale.
export function normalizarUsuario(texto) {
  const u = String(texto ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,23}$/.test(u) ? u : null;
}
const TEXTO_USUARIO = "El usuario lleva de 3 a 24 letras (sin tildes ni ñ), números, punto, guion o guion bajo, "
  + "y empieza por letra o número.";

// El correo, en minúsculas y sin espacios alrededor; null si no lo parece. Sin tildes
// ni ñ (casi ningún proveedor los da). Un usuario no lleva "@": su sal y la de un
// correo nunca coinciden.
export function normalizarCorreo(texto) {
  const c = String(texto ?? "").trim().toLowerCase();
  return c.length <= 254 && /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(c) ? c : null;
}
const TEXTO_CORREO = "Ese correo no parece bien escrito.";

// Qué se repitió, si un lote chocó con un UNIQUE (dos a la vez, o un usuario o un correo
// que ya están en otra cuenta): el lote va en una transacción, así que no queda nada a
// medias. null si el error es otro.
function repetido(e) {
  const m = String(e && e.message);
  if (!/UNIQUE/i.test(m)) return null;
  if (/usuarios\.cuenta/.test(m)) return "Tu cuenta ya tiene usuario.";
  if (/correos\.correo/.test(m)) return "Ese correo ya está en otra cuenta.";
  if (/correos\.cuenta/.test(m)) return "Tu cuenta ya tiene correo: recarga la página.";
  return "Ese usuario ya existe: elige otro.";
}

// Lo que manda el navegador en vez de la contraseña: 32 bytes en hexadecimal.
const claveValida = (c) => typeof c === "string" && /^[0-9a-f]{64}$/.test(c);
const hashClave = (sal, clave) => sha256(sal + ":" + clave);
function iguales(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
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

export async function cuerpoJson(request) {
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return null;
  if (Number(request.headers.get("Content-Length") || 0) > MAX_CUERPO) return null;
  const texto = await request.text();
  if (texto.length > MAX_CUERPO) return null;
  try {
    const v = JSON.parse(texto);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// El freno por IP (el binding FRENO de wrangler.jsonc, Rate Limiting de Workers): como
// mucho 5 por minuto desde una misma IP, contados por Cloudflare en cada uno de sus sitios.
// Sin él, un solo atacante gastaba en unos minutos el tope de intentos del día
// (MAX_INTENTOS_DIA) y nadie más podía entrar. La IP solo es la clave del contador, que
// vive un minuto en Cloudflare: aquí no se guarda. Sin el binding (o si falla) no frena:
// los topes del día siguen ahí.
export async function frenado(env, request, tipo) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!env.FRENO || !ip) return false;
  try {
    return !(await env.FRENO.limit({ key: tipo + ":" + ip })).success;
  } catch (e) {
    console.error(`freno: ${(e && e.stack) || e}`);
    return false;
  }
}
const FRENADAS = new Set(["/crear", "/entrar", "/contrasena", "/correo", "/usuario"]);

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
// Y el de los intentos de entrar (MAX_INTENTOS_DIA), aparte: probar contraseñas en
// bucle deja sin entrar a quien no tenga la sesión abierta, pero no toca las estrellas
// ni las sesiones abiertas.
class SinIntentos extends Error {}

// Un equipo más, si la cuenta existe y no ha llegado al máximo (y si ya estaba, nada).
const SUMAR_EQUIPO = `INSERT OR IGNORE INTO favoritos (cuenta, equipo, creado)
  SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM cuentas WHERE id = ?1)
    AND (SELECT count(*) FROM favoritos WHERE cuenta = ?1) < ?4`;

// Un intento más con ese usuario, si no está bloqueado, antes de mirar la contraseña:
// por muchos que lleguen a la vez, D1 los apunta de uno en uno y solo MAX_FALLOS se
// comparan antes del bloqueo. El que llega a MAX_FALLOS lo pone (y la cuenta vuelve a
// 0: pasado el bloqueo hay otros MAX_FALLOS). Acertar la deja en 0 (ACERTADO).
const INTENTO = `UPDATE usuarios SET
    fallos = CASE WHEN fallos + 1 >= ?2 THEN 0 ELSE fallos + 1 END,
    bloqueado = CASE WHEN fallos + 1 >= ?2 THEN ?3 ELSE bloqueado END
  WHERE usuario = ?1 AND bloqueado <= ?4
  RETURNING cuenta, sal, hash, bloqueado`;
const ACERTADO = "UPDATE usuarios SET fallos = 0, bloqueado = 0 WHERE usuario = ?1";
const MAL = "Usuario o contraseña incorrectos.";

export class Cuentas {
  constructor(request, env, almacen, cabeceras, ahora = Date.now()) {
    this.request = request;
    this.env = env;
    this.url = new URL(request.url);
    this.aj = ajustes(env);
    this.almacen = almacen;
    this.db = almacen.db;
    this.cabeceras = cabeceras;
    this.ahora = ahora;
    this.dia = new Reloj(this.aj.tz).local(ahora).fecha;
    this.contadores = null;   // { cuentas, escrituras_cuentas, intentos } de hoy, al primer uso
  }

  async leerContadores() {
    if (this.contadores) return this.contadores;
    const r = await this.almacen.consultar(() => this.db.prepare(
      `SELECT tipo, n FROM visitas WHERE dia = ?1 AND tipo IN ('cuentas', 'escrituras_cuentas', 'intentos')
       AND clave = ''`).bind(this.dia).all());
    this.contadores = { cuentas: 0, escrituras_cuentas: 0, intentos: 0 };
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

  // Apunta un intento con ese usuario (INTENTO) y lo cuenta en el tope del día. Da su
  // fila si se puede comparar la contraseña; si no, null (no existe) o { hasta } (está
  // bloqueado hasta entonces).
  async intento(usuario) {
    const c = await this.leerContadores();
    if (c.intentos >= this.aj.maxIntentosDia) throw new SinIntentos();
    c.intentos += 1;
    const [r] = await this.almacen.consultar(() => this.db.batch([
      this.db.prepare(INTENTO).bind(usuario, MAX_FALLOS, this.ahora + BLOQUEO_MS, this.ahora),
      this.db.prepare(`INSERT INTO visitas (dia, tipo, clave, n) VALUES (?1, 'intentos', '', 1)
        ON CONFLICT (dia, tipo, clave) DO UPDATE SET n = n + 1`).bind(this.dia),
    ]));
    if (r.results.length) return r.results[0];
    const f = await this.db.prepare("SELECT bloqueado FROM usuarios WHERE usuario = ?1").bind(usuario).first();
    return f && f.bloqueado > this.ahora ? { hasta: f.bloqueado } : null;
  }

  // La clave pública de Turnstile, si está configurado del todo (las dos claves); si
  // no, null y crear una cuenta no lo pide.
  sitioTurnstile() {
    return this.aj.turnstileSitio && this.aj.turnstileSecreto ? this.aj.turnstileSitio : null;
  }

  // Si el navegador pasó Turnstile en esta web y para crear la cuenta. Cada ficha vale
  // una vez (siteverify lo comprueba). La IP solo va a Cloudflare, para la comprobación;
  // aquí no se guarda.
  async turnstileValido(ficha) {
    if (!this.sitioTurnstile()) return true;
    if (typeof ficha !== "string" || !ficha || ficha.length > 2048) return false;
    try {
      const r = await fetch(this.aj.turnstileVerificar, { method: "POST", signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ secret: this.aj.turnstileSecreto, response: ficha,
          remoteip: this.request.headers.get("CF-Connecting-IP") || "" }) });
      const d = await r.json();
      return d.success === true && d.hostname === this.url.hostname && d.action === "crear";
    } catch { return false; }
  }

  bloqueo(hasta) {
    return this.error(`Demasiados intentos con este usuario: prueba dentro de ${
      Math.max(1, Math.ceil((hasta - this.ahora) / 60000))} min.`, 429);
  }

  // Lo que dice un intento que no acertó: el que puso el bloqueo ya lo avisa.
  fallo(f, texto, status) {
    return f.bloqueado > this.ahora ? this.bloqueo(f.bloqueado) : this.error(texto, status);
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
      `SELECT s.cuenta, s.vista, c.creada, u.usuario, e.correo FROM sesiones s JOIN cuentas c ON c.id = s.cuenta
       LEFT JOIN usuarios u ON u.cuenta = s.cuenta LEFT JOIN correos e ON e.cuenta = s.cuenta
       WHERE s.hash = ?1`).bind(hash).first());
    if (!f) return null;
    if (f.vista < this.ahora - DIAS_SESION * MS_DIA) {
      await this.guardar([this.db.prepare("DELETE FROM sesiones WHERE hash = ?1").bind(hash)]).catch(() => {});
      return null;
    }
    return { token, hash, cuenta: f.cuenta, vista: f.vista, creada: f.creada, usuario: f.usuario ?? null,
      correo: f.correo ?? null };
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

  // Lo que la web sabe de la cuenta (GET /api/cuenta, al crear y al entrar).
  async publica(cuenta, creada, usuario, correo) {
    return { id: idPublico(cuenta), usuario, correo: correo ?? null, creada: iso(creada),
      equipos: await this.equipos(cuenta) };
  }

  // Una sesión nueva en la cuenta: la cookie, y cada cuenta con sus MAX_SESIONES
  // sesiones más recientes.
  async sentenciasSesion(cuenta, token) {
    return [
      this.db.prepare("INSERT INTO sesiones (hash, cuenta, creada, vista) VALUES (?1, ?2, ?3, ?3)")
        .bind(await sha256(token), cuenta, this.ahora),
      this.db.prepare(`DELETE FROM sesiones WHERE cuenta = ?1 AND hash NOT IN
        (SELECT hash FROM sesiones WHERE cuenta = ?1 ORDER BY vista DESC LIMIT ?2)`).bind(cuenta, MAX_SESIONES),
    ];
  }

  sinSesion() {
    return this.json({ error: "Tu sesión terminó: vuelve a entrar con tu usuario y contraseña." }, 401,
      { "Set-Cookie": COOKIE_FUERA });
  }

  // GET /api/cuenta: la de esta sesión, o null. Renueva la cookie una vez al día.
  async ver() {
    const s = await this.sesion();
    if (!s) {
      return this.json({ disponible: true, cuenta: null, turnstile: this.sitioTurnstile() }, 200,
        tokenDe(this.request) ? { "Set-Cookie": COOKIE_FUERA } : {});
    }
    const cuerpo = { disponible: true, cuenta: await this.publica(s.cuenta, s.creada, s.usuario, s.correo) };
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

  // POST /api/cuenta/crear {usuario, clave, correo?, clave_correo?, turnstile?, equipos}:
  // la cuenta, su usuario (y su correo, si lo puso) y una sesión, con los equipos de ese
  // navegador. Tope de cuentas nuevas por día de Lima (MAX_CUENTAS_DIA): se cuentan las
  // creadas, no las que quedan (crear y borrar en bucle no lo esquiva), en la tabla de
  // contadores por día (visitas, tipo "cuentas"). Dos a la vez pueden pasarse en una:
  // es un tope, no una cuenta. Un usuario o un correo repetidos los para la base
  // (UNIQUE, repetido).
  async crear(body) {
    const usuario = normalizarUsuario(body.usuario);
    if (!usuario) return this.error(TEXTO_USUARIO, 400);
    if (!claveValida(body.clave)) return this.error("Falta la contraseña.", 400);
    const correo = body.correo ? normalizarCorreo(body.correo) : null;
    if (body.correo && !correo) return this.error(TEXTO_CORREO, 400);
    if (correo && !claveValida(body.clave_correo)) return this.error("Falta la contraseña del correo.", 400);
    if ((await this.leerContadores()).cuentas >= this.aj.maxCuentasDia) {
      return this.error("Hoy ya se crearon muchas cuentas. Prueba mañana; tus equipos siguen en este navegador.", 429);
    }
    if (!(await this.turnstileValido(body.turnstile))) {
      return this.error("Falta la comprobación de que no eres un robot: espera a que salga la marca y vuelve a probar.", 400);
    }
    const id = hex(azar(16)), token = base64url(azar(32)), sal = hex(azar(16));
    try {
      await this.guardar([
        this.db.prepare(`INSERT INTO visitas (dia, tipo, clave, n) VALUES (?1, 'cuentas', '', 1)
          ON CONFLICT (dia, tipo, clave) DO UPDATE SET n = n + 1`).bind(this.dia),
        this.db.prepare("INSERT INTO cuentas (id, creada, vista) VALUES (?1, ?2, ?2)").bind(id, this.ahora),
        this.db.prepare(`INSERT INTO usuarios (usuario, cuenta, sal, hash, creado, fallos, bloqueado)
          VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)`).bind(usuario, id, sal, await hashClave(sal, body.clave), this.ahora),
        ...(correo ? [await this.sentenciaCorreo(id, correo, body.clave_correo)] : []),
        ...(await this.sentenciasSesion(id, token)),
        ...this.sumarEquipos(id, body.equipos),
      ]);
    } catch (e) {
      const r = repetido(e);
      if (r) return this.error(r, 409);
      throw e;
    }
    return this.conSesion({ cuenta: await this.publica(id, this.ahora, usuario, correo) }, token);
  }

  // El correo de una cuenta, con la contraseña pasada por PBKDF2 con el correo de sal
  // (clave_correo) y su propia sal de aquí. Sin verificar: hoy no se le manda nada.
  async sentenciaCorreo(cuenta, correo, clave) {
    const sal = hex(azar(16));
    return this.db.prepare(`INSERT INTO correos (correo, cuenta, sal, hash, verificado, creado)
      VALUES (?1, ?2, ?3, ?4, 0, ?5)`).bind(correo, cuenta, sal, await hashClave(sal, clave), this.ahora);
  }

  // POST /api/cuenta/entrar {usuario | correo, clave, equipos}: una sesión nueva. Con
  // el correo, la clave es la de su sal (clave_correo al crear). Los equipos que ya
  // había en este navegador se suman a los de la cuenta. MAX_FALLOS intentos seguidos
  // sin acertar (con el usuario o con el correo: van a la misma cuenta) bloquean la
  // cuenta BLOQUEO_MS (intento).
  async entrar(body) {
    if (!claveValida(body.clave)) return this.error(MAL, 401);
    const conCorreo = body.correo !== undefined;
    const nombre = conCorreo ? normalizarCorreo(body.correo) : normalizarUsuario(body.usuario);
    if (!nombre) return this.error(MAL, 401);
    const e = conCorreo ? await this.almacen.consultar(() => this.db.prepare(
      `SELECT e.sal, e.hash, e.correo, u.usuario FROM correos e JOIN usuarios u ON u.cuenta = e.cuenta
       WHERE e.correo = ?1`).bind(nombre).first()) : null;
    const usuario = conCorreo ? (e ? e.usuario : "") : nombre;   // "": cuenta igual el intento
    const f = await this.intento(usuario);
    if (!f) return this.error(MAL, 401);
    if (f.hasta) return this.bloqueo(f.hasta);
    const { sal, hash } = conCorreo ? e : f;
    if (!iguales(await hashClave(sal, body.clave), hash)) return this.fallo(f, MAL, 401);
    const c = await this.db.prepare(
      `SELECT c.creada, e.correo FROM cuentas c LEFT JOIN correos e ON e.cuenta = c.id WHERE c.id = ?1`)
      .bind(f.cuenta).first();
    if (!c) return this.error(MAL, 401);
    const token = base64url(azar(32));
    await this.guardar([
      this.db.prepare(ACERTADO).bind(usuario),
      ...(await this.sentenciasSesion(f.cuenta, token)),
      this.db.prepare("UPDATE cuentas SET vista = ?2 WHERE id = ?1").bind(f.cuenta, this.ahora),
      ...this.sumarEquipos(f.cuenta, body.equipos),
    ]);
    return this.conSesion({ cuenta: await this.publica(f.cuenta, c.creada, usuario, c.correo) }, token);
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
    const ya = await this.almacen.consultar(() => this.db.prepare(
      "SELECT 1 FROM favoritos WHERE cuenta = ?1 AND equipo = ?2").bind(s.cuenta, nombre).first());
    if (!ya) return this.error(`Tu cuenta ya sigue a ${MAX_EQUIPOS} equipos: quita alguno antes.`, 409);
    return this.json({ ok: true });
  }

  // La contraseña actual (con el usuario de sal), como un intento de entrar: una
  // sesión robada no sirve para probar contraseñas. Da la respuesta de error, o null si
  // es la buena (y entonces la cuenta de fallos vuelve a 0, aunque lo que venga después
  // falle). 403 y no 401: 401 es "sin sesión", y la web saldría de la cuenta.
  async comprobarActual(s, actual) {
    const actualMal = "La contraseña actual no es esa.";
    if (!claveValida(actual)) return this.error(actualMal, 403);
    const f = await this.intento(s.usuario);
    if (!f) return this.error("Tu cuenta aún no tiene usuario: ponle uno primero.", 409);
    if (f.hasta) return this.bloqueo(f.hasta);
    if (!iguales(await hashClave(f.sal, actual), f.hash)) return this.fallo(f, actualMal, 403);
    await this.guardar([this.db.prepare(ACERTADO).bind(s.usuario)]);
    return null;
  }

  // POST /api/cuenta/contrasena {actual, nueva, nueva_correo?}: con la actual. Con
  // correo, la nueva también con su sal (nueva_correo), o entrar con el correo seguiría
  // pidiendo la vieja. Las demás sesiones se cierran (si alguien la sabía, deja de estar
  // dentro); la de este aparato sigue.
  async contrasena(body, s) {
    if (!s.usuario) return this.error("Tu cuenta aún no tiene usuario: ponle uno primero.", 409);
    if (!claveValida(body.nueva)) return this.error("Falta la contraseña nueva.", 400);
    if (s.correo && !claveValida(body.nueva_correo)) return this.error("Falta la contraseña nueva del correo.", 400);
    const mal = await this.comprobarActual(s, body.actual);
    if (mal) return mal;
    const sal = hex(azar(16)), salCorreo = hex(azar(16));
    await this.guardar([
      this.db.prepare("UPDATE usuarios SET sal = ?2, hash = ?3 WHERE usuario = ?1")
        .bind(s.usuario, sal, await hashClave(sal, body.nueva)),
      ...(s.correo ? [this.db.prepare("UPDATE correos SET sal = ?2, hash = ?3 WHERE cuenta = ?1")
        .bind(s.cuenta, salCorreo, await hashClave(salCorreo, body.nueva_correo))] : []),
      this.db.prepare("DELETE FROM sesiones WHERE cuenta = ?1 AND hash != ?2").bind(s.cuenta, s.hash),
    ]);
    return this.json({ ok: true });
  }

  // POST /api/cuenta/correo {correo, clave_correo, actual}: pone o cambia el correo de
  // la cuenta (correo vacío: lo quita), con la contraseña actual. El correo nuevo
  // queda sin verificar.
  async correo(body, s) {
    if (!s.usuario) return this.error("Tu cuenta aún no tiene usuario: ponle uno primero.", 409);
    const correo = body.correo ? normalizarCorreo(body.correo) : null;
    if (body.correo && !correo) return this.error(TEXTO_CORREO, 400);
    if (correo && !claveValida(body.clave_correo)) return this.error("Falta la contraseña del correo.", 400);
    const mal = await this.comprobarActual(s, body.actual);
    if (mal) return mal;
    try {
      await this.guardar([
        this.db.prepare("DELETE FROM correos WHERE cuenta = ?1").bind(s.cuenta),
        ...(correo ? [await this.sentenciaCorreo(s.cuenta, correo, body.clave_correo)] : []),
      ]);
    } catch (e) {
      const r = repetido(e);
      if (r) return this.error(r, 409);
      throw e;
    }
    return this.json({ cuenta: await this.publica(s.cuenta, s.creada, s.usuario, correo) });
  }

  // POST /api/cuenta/usuario {usuario, clave}: usuario y contraseña para una cuenta de
  // la primera versión (que se entraba con un código). El código deja de valer.
  async ponerUsuario(body, s) {
    if (s.usuario) return this.error("Tu cuenta ya tiene usuario.", 409);
    const usuario = normalizarUsuario(body.usuario);
    if (!usuario) return this.error(TEXTO_USUARIO, 400);
    if (!claveValida(body.clave)) return this.error("Falta la contraseña.", 400);
    const sal = hex(azar(16));
    try {
      await this.guardar([
        this.db.prepare(`INSERT INTO usuarios (usuario, cuenta, sal, hash, creado, fallos, bloqueado)
          VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)`).bind(usuario, s.cuenta, sal, await hashClave(sal, body.clave), this.ahora),
        this.db.prepare("DELETE FROM accesos WHERE cuenta = ?1 AND tipo = 'codigo'").bind(s.cuenta),
      ]);
    } catch (e) {
      const r = repetido(e);   // dos a la vez desde la misma cuenta: la segunda choca con usuarios_por_cuenta
      if (r) return this.error(r, 409);
      throw e;
    }
    return this.json({ cuenta: await this.publica(s.cuenta, s.creada, usuario, s.correo) });
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
    const [cuenta, correos, accesos, sesiones, equipos] = await this.almacen.consultar(() => this.db.batch([
      this.db.prepare("SELECT id, creada, vista FROM cuentas WHERE id = ?1").bind(s.cuenta),
      this.db.prepare("SELECT correo, verificado, creado FROM correos WHERE cuenta = ?1").bind(s.cuenta),
      this.db.prepare("SELECT tipo, creado FROM accesos WHERE cuenta = ?1 ORDER BY creado").bind(s.cuenta),
      this.db.prepare("SELECT hash, creada, vista FROM sesiones WHERE cuenta = ?1 ORDER BY creada").bind(s.cuenta),
      this.db.prepare("SELECT equipo, creado FROM favoritos WHERE cuenta = ?1 ORDER BY creado").bind(s.cuenta),
    ]));
    const c = cuenta.results[0];
    const datos = {
      descargado: iso(this.ahora),
      nota: "Es todo lo que la web guarda de tu cuenta. La contraseña y las sesiones van cifradas: no se pueden ver.",
      cuenta: { id: idPublico(c.id), id_interno: c.id, usuario: s.usuario, creada: iso(c.creada), ultima_vez: iso(c.vista) },
      correo: correos.results.map((e) => ({ correo: e.correo, verificado: !!e.verificado, desde: iso(e.creado) }))[0] ?? null,
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
      this.db.prepare("DELETE FROM correos WHERE cuenta = ?1").bind(s.cuenta),
      this.db.prepare("DELETE FROM usuarios WHERE cuenta = ?1").bind(s.cuenta),
      this.db.prepare("DELETE FROM cuentas WHERE id = ?1").bind(s.cuenta),
    ]);
    return this.json({ ok: true }, 200, { "Set-Cookie": COOKIE_FUERA });
  }

  async atender() {
    try {
      return await this.despachar(this.url.pathname.slice("/api/cuenta".length) || "/");
    } catch (e) {
      if (e instanceof SinIntentos) {
        return this.error("Hoy hubo demasiados intentos de entrar en la web: prueba mañana. "
          + "Si ya tenías la sesión abierta en un aparato, ahí sigues dentro.", 429);
      }
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
    if (FRENADAS.has(ruta) && await frenado(this.env, this.request, "cuenta")) {
      return this.error("Demasiados intentos desde tu conexión: espera un minuto y vuelve a probar.", 429);
    }
    if (ruta === "/crear") return this.crear(body);
    if (ruta === "/entrar") return this.entrar(body);
    const s = await this.sesion();
    if (ruta === "/salir") return this.salir(body, s);
    if (!s) return this.sinSesion();
    if (ruta === "/equipo") return this.equipo(body, s);
    if (ruta === "/contrasena") return this.contrasena(body, s);
    if (ruta === "/correo") return this.correo(body, s);
    if (ruta === "/usuario") return this.ponerUsuario(body, s);
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
  "/api/cuenta/contrasena": ["POST"],
  "/api/cuenta/correo": ["POST"],
  "/api/cuenta/usuario": ["POST"],
  "/api/cuenta/salir": ["POST"],
  "/api/cuenta/borrar": ["POST"],
};

// Para el panel de visitas: cuántas cuentas hay, cuántas se crearon esta semana
// (también las ya borradas: el contador del tope), cuántas entraron y cuántos intentos
// de entrar hubo (muchos más que entradas: alguien probando contraseñas).
export async function resumenCuentas(almacen, desde7, ahora = Date.now()) {
  const f = await almacen.consultar(() => almacen.db.prepare(
    `SELECT count(*) AS total, coalesce(sum(vista >= ?1), 0) AS activas,
       (SELECT count(DISTINCT cuenta) FROM favoritos) AS con_equipos,
       (SELECT count(*) FROM usuarios) AS con_usuario,
       (SELECT count(*) FROM correos) AS con_correo,
       (SELECT coalesce(sum(n), 0) FROM visitas WHERE tipo = 'cuentas' AND clave = '' AND dia >= ?2) AS creadas,
       (SELECT coalesce(sum(n), 0) FROM visitas WHERE tipo = 'intentos' AND clave = '' AND dia >= ?2) AS intentos
     FROM cuentas`).bind(ahora - 7 * MS_DIA, desde7).first());
  return { total: f.total, creadas: f.creadas, activas: f.activas, con_equipos: f.con_equipos,
    con_usuario: f.con_usuario, con_correo: f.con_correo, intentos: f.intentos };
}
