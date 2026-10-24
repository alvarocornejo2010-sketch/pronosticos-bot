// Todo lo que app.py guarda en disco (cache.json, data.json, validacion.json y
// validacion_cache/) vive aquí en D1, que no se borra con cada despliegue.

// El esquema se crea solo la primera vez que una consulta no encuentra su tabla,
// así una base nueva (o la local de `wrangler dev`) no necesita ningún paso a mano.
export const ESQUEMA = [
  // Lo que se baja de football-data.org, por secciones: ligas (media de la
  // temporada en curso), priors (ancla de la temporada anterior), partidos_liga
  // (los partidos de cada liga de las dos temporadas, compactos), fuerzas (las
  // de cada equipo, ajustadas con esos partidos), calendario (cuándo se bajó el
  // de cada competición) y liga_equipo (de qué liga es cada equipo de la Champions).
  `CREATE TABLE IF NOT EXISTS cache (
     seccion TEXT NOT NULL,
     clave   TEXT NOT NULL,
     valor   TEXT NOT NULL,
     PRIMARY KEY (seccion, clave))`,
  // El calendario de la ventana, un partido por fila, con su ficha (nombres,
  // hora, escudos) ya en JSON. orden desempata los que empiezan a la vez.
  `CREATE TABLE IF NOT EXISTS partidos (
     id        INTEGER PRIMARY KEY,
     liga      TEXT NOT NULL,
     utc       TEXT NOT NULL,
     fecha     TEXT NOT NULL,
     orden     INTEGER NOT NULL,
     local_id  INTEGER NOT NULL,
     visita_id INTEGER NOT NULL,
     base      TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS partidos_por_fecha ON partidos (utc)`,
  // La última predicción publicada de cada partido. No se borra cuando el
  // partido empieza: es lo que dijo la web, y el registro en vivo (registro.js)
  // la mide contra el resultado real.
  // base: los datos del partido (hora, nombres, escudos) con los que se calculó;
  // si el calendario los cambia, la ficha se rehace sin recalcular los números.
  `CREATE TABLE IF NOT EXISTS predicciones (
     id        INTEGER PRIMARY KEY,
     utc       TEXT NOT NULL,
     liga      TEXT NOT NULL,
     calculado TEXT NOT NULL,
     base      TEXT NOT NULL,
     ficha     TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS predicciones_por_fecha ON predicciones (utc)`,
  // El marcador a los 90 minutos de cada partido con predicción, ya sumado al
  // registro en vivo (contado = 0 si la predicción no era de antes de empezar).
  `CREATE TABLE IF NOT EXISTS resultados (
     id        INTEGER PRIMARY KEY,
     liga      TEXT NOT NULL,
     utc       TEXT NOT NULL,
     gl        INTEGER NOT NULL,
     gv        INTEGER NOT NULL,
     contado   INTEGER NOT NULL,
     liquidado INTEGER NOT NULL)`,
  // Documentos enteros: lo que lee la web (estado), su resumen, la validación,
  // el registro en vivo, los pedidos de /actualizar y /validar y las temporadas
  // terminadas.
  `CREATE TABLE IF NOT EXISTS documentos (
     clave       TEXT PRIMARY KEY,
     valor       TEXT NOT NULL,
     actualizado INTEGER NOT NULL)`,
  // Candado para que dos pasadas no se pisen, y hora de la última petición a la
  // API para respetar las 10 por minuto también de una pasada a la siguiente.
  `CREATE TABLE IF NOT EXISTS candado (
     nombre TEXT PRIMARY KEY,
     hasta  INTEGER NOT NULL,
     dueno  TEXT NOT NULL DEFAULT '')`,
  // Las visitas, sumadas por día de Lima (visitas.js): una fila por contador, sin
  // nada de quién es quién. WITHOUT ROWID: la clave primaria es la propia tabla y
  // cada suma escribe una fila, no dos (la fila y su índice).
  `CREATE TABLE IF NOT EXISTS visitas (
     dia   TEXT NOT NULL,
     tipo  TEXT NOT NULL,
     clave TEXT NOT NULL,
     n     INTEGER NOT NULL,
     PRIMARY KEY (dia, tipo, clave)) WITHOUT ROWID`,
  // Las cuentas (cuentas.js): la cuenta, cómo se entra en ella (accesos: hoy solo
  // "codigo", con el SHA-256 del código; mañana passkey o Google), sus sesiones (el
  // SHA-256 del token de la cookie) y los equipos que sigue. Las horas, en ms.
  `CREATE TABLE IF NOT EXISTS cuentas (
     id     TEXT PRIMARY KEY,
     creada INTEGER NOT NULL,
     vista  INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accesos (
     tipo   TEXT NOT NULL,
     clave  TEXT NOT NULL,
     cuenta TEXT NOT NULL,
     creado INTEGER NOT NULL,
     PRIMARY KEY (tipo, clave)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS accesos_por_cuenta ON accesos (cuenta)`,
  `CREATE TABLE IF NOT EXISTS sesiones (
     hash   TEXT PRIMARY KEY,
     cuenta TEXT NOT NULL,
     creada INTEGER NOT NULL,
     vista  INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS sesiones_por_cuenta ON sesiones (cuenta)`,
  `CREATE TABLE IF NOT EXISTS favoritos (
     cuenta TEXT NOT NULL,
     equipo TEXT NOT NULL,
     creado INTEGER NOT NULL,
     PRIMARY KEY (cuenta, equipo)) WITHOUT ROWID`,
];

const SIN_TABLA = /no such table/i;

export class Almacen {
  constructor(db) {
    this.db = db;
  }

  async consultar(fn) {
    try {
      return await fn();
    } catch (e) {
      if (!SIN_TABLA.test(String(e && e.message))) throw e;
      await this.db.batch(ESQUEMA.map((s) => this.db.prepare(s)));
      return await fn();
    }
  }

  // ---------- documentos ----------
  async leerDocs(claves) {
    const marcas = claves.map((_, i) => "?" + (i + 1)).join(",");
    const r = await this.consultar(() =>
      this.db.prepare(`SELECT clave, valor, actualizado FROM documentos WHERE clave IN (${marcas})`)
        .bind(...claves).all());
    const out = {};
    for (const f of r.results) out[f.clave] = { texto: f.valor, actualizado: f.actualizado };
    return out;
  }

  async leerDocTexto(clave) {
    const f = await this.consultar(() =>
      this.db.prepare("SELECT valor FROM documentos WHERE clave = ?1").bind(clave).first());
    return f ? f.valor : null;
  }

  async leerDoc(clave) {
    const t = await this.leerDocTexto(clave);
    return t === null ? null : JSON.parse(t);
  }

  sentenciaDoc(clave, valor, ahora = Date.now()) {
    const texto = typeof valor === "string" ? valor : JSON.stringify(valor);
    return this.db.prepare("INSERT OR REPLACE INTO documentos (clave, valor, actualizado) VALUES (?1, ?2, ?3)")
      .bind(clave, texto, ahora);
  }

  // Solo si no ha cambiado desde que se leyó: un pedido nuevo no se pierde.
  sentenciaBorrarDoc(clave, actualizado) {
    return this.db.prepare("DELETE FROM documentos WHERE clave = ?1 AND actualizado = ?2").bind(clave, actualizado);
  }

  sentenciaBorrar(clave) {
    return this.db.prepare("DELETE FROM documentos WHERE clave = ?1").bind(clave);
  }

  sentenciaBorrarPrefijo(prefijo) {
    return this.db.prepare("DELETE FROM documentos WHERE clave >= ?1 AND clave < ?2")
      .bind(prefijo, prefijo + "\uffff");
  }

  async escribir(sentencias) {
    if (!sentencias.length) return;
    await this.consultar(() => this.db.batch(sentencias));
  }

  // ---------- caché de la API ----------
  async cargarCache(secciones = null) {
    const r = await this.consultar(() => (secciones
      ? this.db.prepare(`SELECT seccion, clave, valor FROM cache WHERE seccion IN (${secciones.map((_, i) => "?" + (i + 1)).join(",")})`)
        .bind(...secciones)
      : this.db.prepare("SELECT seccion, clave, valor FROM cache")).all());
    return new Cache(r.results);
  }

  sentenciasCache(cache) {
    const out = [];
    for (const [seccion, clave, valor] of cache.sacarSucias()) {
      out.push(this.db.prepare("INSERT OR REPLACE INTO cache (seccion, clave, valor) VALUES (?1, ?2, ?3)")
        .bind(seccion, clave, JSON.stringify(valor)));
    }
    return out;
  }

  // ---------- calendario y predicciones ----------
  // Los de una liga menos los de la lista (los que faltaron en la última descarga
  // y se conservan una más).
  sentenciaBorrarPartidosSalvo(liga, ids) {
    return this.db.prepare("DELETE FROM partidos WHERE liga = ?1 AND id NOT IN (SELECT value FROM json_each(?2))")
      .bind(liga, JSON.stringify(ids));
  }

  // Los partidos de una liga en la tabla que aún no han empezado.
  async partidosPorJugar(liga, desdeUtc) {
    const r = await this.consultar(() => this.db.prepare(
      "SELECT id, utc FROM partidos WHERE liga = ?1 AND utc > ?2").bind(liga, desdeUtc).all());
    return r.results;
  }

  sentenciaPartido(f) {
    return this.db.prepare(
      `INSERT OR REPLACE INTO partidos (id, liga, utc, fecha, orden, local_id, visita_id, base)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(f.id, f.liga, f.utc, f.fecha, f.orden, f.local_id, f.visita_id, f.base);
  }

  // Los partidos que aún no han empezado, en el orden de la web, con su última
  // predicción si la hay. Los JSON vienen como texto: casi siempre se pegan tal cual.
  async ventana(desdeUtc) {
    const r = await this.consultar(() => this.db.prepare(
      `SELECT p.id, p.liga, p.fecha, p.local_id, p.visita_id, p.base,
              q.calculado, q.base AS base_pred, q.ficha
       FROM partidos p LEFT JOIN predicciones q ON q.id = p.id
       WHERE p.utc > ?1
       ORDER BY p.fecha, p.utc, p.orden`).bind(desdeUtc).all());
    return r.results;
  }

  // La primera liga (en el orden de LIGAS) en cuyo calendario sale el equipo.
  async ligaDeEquipo(teamId, codigos) {
    const marcas = codigos.map((_, i) => "?" + (i + 2)).join(",");
    const f = await this.consultar(() => this.db.prepare(
      `SELECT liga FROM partidos WHERE (local_id = ?1 OR visita_id = ?1) AND liga IN (${marcas})
       ORDER BY orden LIMIT 1`).bind(teamId, ...codigos).first());
    return f ? f.liga : null;
  }

  sentenciaPrediccion(ficha, json, base) {
    return this.db.prepare(
      "INSERT OR REPLACE INTO predicciones (id, utc, liga, calculado, base, ficha) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(ficha.id, ficha.utcDate, ficha.liga_codigo, ficha.calculado, base, json);
  }

  // ---------- registro en vivo ----------
  // Las predicciones de esas competiciones entre dos fechas que aún no tienen resultado.
  async pendientesDeResultado(ligas, desdeUtc, hastaUtc) {
    const marcas = ligas.map((_, i) => "?" + (i + 3)).join(",");
    const r = await this.consultar(() => this.db.prepare(
      `SELECT p.id, p.liga, p.utc, p.ficha
       FROM predicciones p LEFT JOIN resultados r ON r.id = p.id
       WHERE p.utc > ?1 AND p.utc < ?2 AND r.id IS NULL AND p.liga IN (${marcas})`)
      .bind(desdeUtc, hastaUtc, ...ligas).all());
    return r.results;
  }

  // Las competiciones con predicciones entre dos fechas sin resultado, con la hora
  // del primero de esos partidos, de más antigua a más nueva.
  async ligasConPendientes(desdeUtc, hastaUtc) {
    const r = await this.consultar(() => this.db.prepare(
      `SELECT p.liga AS liga, min(p.utc) AS primera
       FROM predicciones p LEFT JOIN resultados r ON r.id = p.id
       WHERE p.utc > ?1 AND p.utc < ?2 AND r.id IS NULL
       GROUP BY p.liga ORDER BY primera`).bind(desdeUtc, hastaUtc).all());
    return r.results;
  }

  sentenciaResultado(id, liga, utc, gl, gv, contado, ahora = Date.now()) {
    return this.db.prepare(
      `INSERT OR IGNORE INTO resultados (id, liga, utc, gl, gv, contado, liquidado)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(id, liga, utc, gl, gv, contado ? 1 : 0, ahora);
  }

  // ---------- candado ----------
  async tomarCandado(dueno, duracionMs, ahora = Date.now()) {
    const r = await this.consultar(() => this.db.prepare(
      `INSERT INTO candado (nombre, hasta, dueno) VALUES ('pasada', ?1, ?2)
       ON CONFLICT (nombre) DO UPDATE SET hasta = excluded.hasta, dueno = excluded.dueno
       WHERE candado.hasta < ?3`).bind(ahora + duracionMs, dueno, ahora).run());
    return r.meta.changes > 0;
  }

  sentenciaSoltarCandado(dueno) {
    return this.db.prepare("UPDATE candado SET hasta = 0 WHERE nombre = 'pasada' AND dueno = ?1").bind(dueno);
  }

  // Antes de tomar el candado: cuándo caduca el de la pasada anterior (0 si la
  // soltó al terminar), cuántas seguidas han muerto sin soltarlo y la hora de
  // la última petición a la API.
  async leerCandados() {
    const r = await this.consultar(() =>
      this.db.prepare("SELECT nombre, hasta FROM candado WHERE nombre IN ('pasada', 'muertes', 'api')").all());
    const out = { pasada: 0, muertes: 0, api: 0 };
    for (const f of r.results) out[f.nombre] = f.hasta;
    return out;
  }

  sentenciaMuertes(n) {
    return this.db.prepare(
      `INSERT INTO candado (nombre, hasta, dueno) VALUES ('muertes', ?1, '')
       ON CONFLICT (nombre) DO UPDATE SET hasta = excluded.hasta`).bind(n);
  }

  sentenciaUltimaPeticion(ms) {
    return this.db.prepare(
      `INSERT INTO candado (nombre, hasta, dueno) VALUES ('api', ?1, '')
       ON CONFLICT (nombre) DO UPDATE SET hasta = excluded.hasta`).bind(ms);
  }
}

// La caché de app.py (un diccionario de secciones) con memoria de qué cambió,
// para escribir en D1 solo las filas nuevas. Cada fila se lee (JSON.parse) la
// primera vez que se usa: una pasada toca unas decenas de las cientos que hay.
export class Cache {
  constructor(filas = []) {
    this.crudas = {};
    this.datos = {};
    this.sucias = new Map();
    for (const f of filas) (this.crudas[f.seccion] ??= {})[f.clave] = f.valor;
  }

  // La sección entera, leída (para /api/ligas).
  seccion(nombre) {
    const crudas = this.crudas[nombre] || {};
    for (const clave of Object.keys(crudas)) this.get(nombre, clave);
    return (this.datos[nombre] ??= {});
  }

  get(seccion, clave) {
    const datos = (this.datos[seccion] ??= {});
    if (clave in datos) return datos[clave];
    const cruda = this.crudas[seccion] && this.crudas[seccion][clave];
    if (cruda === undefined) return undefined;
    return (datos[clave] = JSON.parse(cruda));
  }

  poner(seccion, clave, valor) {
    (this.datos[seccion] ??= {})[clave] = valor;
    this.sucias.set(seccion + "\u0000" + clave, [seccion, clave]);
  }

  sacarSucias() {
    const out = [];
    for (const [seccion, clave] of this.sucias.values()) out.push([seccion, clave, this.datos[seccion][clave]]);
    this.sucias.clear();
    return out;
  }
}
