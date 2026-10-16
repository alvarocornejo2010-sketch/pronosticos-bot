// El modelo, el mismo de app.py: fuerzas de ataque y defensa encogidas hacia la
// media de la liga, Poisson independiente para el 1X2 y los mercados de goles
// con los goles esperados acercados a la media (ENCOGER_GOLES).
//
// Cada función hace las mismas operaciones y en el mismo orden que su gemela de
// Python, así que salen los mismos números. test_paridad.py lo comprueba con
// miles de casos: si cambias algo aquí, cámbialo también en app.py.

import {
  ENCOGER_GOLES, ESCALA_CHAMPIONS, EXPONENTE_FUERZA_CHAMPIONS, K_HISTORIAL_CHAMPIONS, LIMITE_GOLES,
  PSEUDO_PARTIDOS,
} from "./config.js";

// ------------------------------------------
// Redondeo como round() de Python
// ------------------------------------------
// round() de Python redondea el valor binario exacto y, en un empate exacto, al
// par. Math.round sube los empates y x*100 arrastra error, así que hace falta
// esto para que los porcentajes coincidan cifra a cifra.
const POTENCIAS = [1, 10, 100, 1000, 10000, 100000];

export function redondear(x, cifras = 0) {
  if (!Number.isFinite(x)) return x;
  const f = POTENCIAS[cifras] ?? 10 ** cifras;
  const t = x * f;
  const frac = t - Math.floor(t);
  // lejos de un empate el entero más cercano no tiene ambigüedad
  if (Math.abs(frac - 0.5) > 1e-6) return Math.round(t) / f;
  return redondearExacto(x, cifras);
}

function redondearExacto(x, cifras) {
  const a = Math.abs(x);
  // toFixed(100) da la expansión decimal exacta del double para cualquier
  // valor de esta app (sus decimales binarios terminan mucho antes)
  const s = a.toFixed(100);
  const p = s.indexOf(".");
  const entero = s.slice(0, p);
  const dec = s.slice(p + 1);
  const cabeza = dec.slice(0, cifras);
  const cola = dec.slice(cifras);
  let subir;
  if (cola[0] > "5") subir = true;
  else if (cola[0] < "5") subir = false;
  else if (/[1-9]/.test(cola.slice(1))) subir = true;
  else {
    // empate exacto: al par, como Python
    const ultima = cifras > 0 ? cabeza[cifras - 1] : entero[entero.length - 1];
    subir = Number(ultima) % 2 === 1;
  }
  let n = BigInt(entero + cabeza);
  if (subir) n += 1n;
  const r = Number(n) / 10 ** cifras;
  return x < 0 ? -r : r;
}

// Suma de floats como sum() de Python 3.12+, que compensa el error (Neumaier).
// Se puede llevar sumando de a poco (y guardar s y c entre medias): el
// resultado es el mismo que sumar la lista entera de una vez.
export class Suma {
  constructor(s = 0, c = 0) {
    this.s = s; this.c = c;
  }

  add(v) {
    const t = this.s + v;
    this.c += Math.abs(this.s) >= Math.abs(v) ? (this.s - t) + v : (v - t) + this.s;
    this.s = t;
  }

  valor() {
    return this.s + this.c;
  }
}

export function sumar(valores) {
  const s = new Suma();
  for (const v of valores) s.add(v);
  return s.valor();
}

// ------------------------------------------
// Poisson
// ------------------------------------------
const LOG_FACTORIAL = [0];
for (let k = 1; k <= 64; k++) LOG_FACTORIAL.push(LOG_FACTORIAL[k - 1] + Math.log(k));

// Como scipy.stats.poisson.pmf: exp(k·log(mu) − log(k!) − mu).
export function pmfPoisson(k, mu) {
  if (mu === 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(mu) - LOG_FACTORIAL[k] - mu);
}

// Las de 0 a limite goles de una vez (el log se calcula una sola vez; los
// valores son los mismos que pmfPoisson uno a uno).
function pmfs(mu, limite, out = new Float64Array(limite + 1)) {
  if (mu === 0) {
    out.fill(0);
    out[0] = 1;
    return out;
  }
  const lm = Math.log(mu);
  for (let k = 0; k <= limite; k++) out[k] = Math.exp(k * lm - LOG_FACTORIAL[k] - mu);
  return out;
}

// Memoria de trabajo para la rejilla de siempre (LIMITE_GOLES): las funciones
// son síncronas, así que se puede reutilizar entre llamadas sin reservar nada.
const PL = new Float64Array(LIMITE_GOLES + 1);
const PV = new Float64Array(LIMITE_GOLES + 1);
const REJILLA = new Float64Array((LIMITE_GOLES + 1) ** 2);
const pc = (v) => redondear(v * 100, 2);

// ------------------------------------------
// Goles esperados
// ------------------------------------------
// Media regularizada: con n=0 devuelve el prior, y con muchos partidos converge al dato real.
export function encoger(total, n, prior, k = PSEUDO_PARTIDOS) {
  return (total + k * prior) / (n + k);
}

export function calcularXgPartido(statsLocal, statsVisita, promedioLiga) {
  const avgL = promedioLiga.avg_local;
  const avgV = promedioLiga.avg_visita;

  // Los goles que ENCAJA un equipo en casa son goles de visitante -> prior avg_v,
  // y los que encaja fuera son goles de local -> prior avg_l.
  const forLocal = encoger(statsLocal.gf_local, statsLocal.n_local, avgL);
  const againstLocal = encoger(statsLocal.gc_local, statsLocal.n_local, avgV);
  const forVisita = encoger(statsVisita.gf_visita, statsVisita.n_visita, avgV);
  const againstVisita = encoger(statsVisita.gc_visita, statsVisita.n_visita, avgL);

  // cada término se divide entre la media de SU MISMO tipo de gol
  const ataqueLocal = forLocal / avgL;
  const defensaVisita = againstVisita / avgL;
  const ataqueVisita = forVisita / avgV;
  const defensaLocal = againstLocal / avgV;

  const xgLocal = ataqueLocal * defensaVisita * avgL;
  const xgVisita = ataqueVisita * defensaLocal * avgV;
  return [redondear(xgLocal, 2), redondear(xgVisita, 2)];
}

// ------------------------------------------
// 1X2 y doble oportunidad
// ------------------------------------------
export function calcularPoisson(gla, gvi, limite = LIMITE_GOLES) {
  const reutilizar = limite === LIMITE_GOLES;
  const pl = reutilizar ? pmfs(gla, limite, PL) : pmfs(gla, limite);
  const pv = reutilizar ? pmfs(gvi, limite, PV) : pmfs(gvi, limite);
  let local = 0, empate = 0, visita = 0;
  for (let gl = 0; gl <= limite; gl++) {
    const pGl = pl[gl];
    for (let gv = 0; gv <= limite; gv++) {
      const prob = pGl * pv[gv];
      if (gl > gv) local += prob;
      else if (gl === gv) empate += prob;
      else visita += prob;
    }
  }
  // la rejilla es finita: se normaliza para que 1 + X + 2 sume exactamente 100
  const total = local + empate + visita;
  local /= total; empate /= total; visita /= total;
  return {
    prob_local: redondear(local * 100, 2),
    prob_empate: redondear(empate * 100, 2),
    prob_visita: redondear(visita * 100, 2),
    prob_1x: redondear((local + empate) * 100, 2),
    prob_x2: redondear((empate + visita) * 100, 2),
    prob_12: redondear((local + visita) * 100, 2),
  };
}

// ------------------------------------------
// Mercados de goles
// ------------------------------------------

// Más/menos, ambos marcan, porterías a cero y marcadores, todos de una misma
// rejilla de marcadores con los goles esperados acercados a la media de la liga.
export function mercadosDeGoles(xgLocal, xgVisita, promedioLiga, limite = LIMITE_GOLES) {
  const avgL = promedioLiga.avg_local;
  const avgV = promedioLiga.avg_visita;
  const gla = avgL * (xgLocal / avgL) ** ENCOGER_GOLES;
  const gvi = avgV * (xgVisita / avgV) ** ENCOGER_GOLES;

  const n = limite + 1;
  const reutilizar = limite === LIMITE_GOLES;   // la rejilla de siempre: sin reservar memoria
  const pl = reutilizar ? pmfs(gla, limite, PL) : pmfs(gla, limite);
  const pv = reutilizar ? pmfs(gvi, limite, PV) : pmfs(gvi, limite);
  const rejilla = reutilizar ? REJILLA : new Float64Array(n * n);
  let suma = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = pl[i] * pv[j];
      rejilla[i * n + j] = v;
      suma += v;
    }
  }
  for (let k = 0; k < rejilla.length; k++) rejilla[k] /= suma;

  let mas15 = 0, mas25 = 0, mas35 = 0, ambos = 0, ceroLocal = 0, ceroVisita = 0;
  const reparto = [0, 0, 0, 0, 0, 0];
  // los tres marcadores más probables, sin ordenar la rejilla entera
  let a = -1, b = -1, c = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      const v = rejilla[k];
      const total = i + j;
      reparto[total < 5 ? total : 5] += v;
      if (total > 1.5) mas15 += v;
      if (total > 2.5) mas25 += v;
      if (total > 3.5) mas35 += v;
      if (i >= 1 && j >= 1) ambos += v;
      if (j === 0) ceroLocal += v;    // portería a cero del local: el visitante no marca
      if (i === 0) ceroVisita += v;
      if (a < 0 || v >= rejilla[a]) { c = b; b = a; a = k; }
      else if (b < 0 || v >= rejilla[b]) { c = b; b = k; }
      else if (c < 0 || v >= rejilla[c]) { c = k; }
    }
  }

  return {
    goles_total: redondear(gla + gvi, 2),
    prob_mas_15: pc(mas15),
    prob_mas_25: pc(mas25),
    prob_mas_35: pc(mas35),
    prob_ambos: pc(ambos),
    prob_cero_local: pc(ceroLocal),
    prob_cero_visita: pc(ceroVisita),
    goles_reparto: reparto.map(pc),
    marcadores: [a, b, c].map((k) => [Math.floor(k / n), k % n, pc(rejilla[k])]),
  };
}

// ------------------------------------------
// Champions
// ------------------------------------------
// Ataque y defensa de un equipo en su liga nacional, relativos a la media de esa
// liga y atenuados. La parte de fuerzas_champions de app.py que no pide nada.
export function fuerzasDesdeLiga(stats, promedio, enCasa) {
  const avgL = promedio.avg_local;
  const avgV = promedio.avg_visita;
  let ataque, defensa, n;
  if (enCasa) {
    ataque = encoger(stats.gf_local, stats.n_local, avgL) / avgL;
    defensa = encoger(stats.gc_local, stats.n_local, avgV) / avgV;
    n = stats.n_local;
  } else {
    ataque = encoger(stats.gf_visita, stats.n_visita, avgV) / avgV;
    defensa = encoger(stats.gc_visita, stats.n_visita, avgL) / avgL;
    n = stats.n_visita;
  }
  const b = EXPONENTE_FUERZA_CHAMPIONS;
  return { ataque: ataque ** b, defensa: defensa ** b, muestra: n };
}

// Historial en la Champions (historial_champions en app.py): lo que un equipo
// marcó y encajó en sus partidos de Champions de esta temporada y la anterior,
// y lo que se esperaba de él: la media de la Champions de esa temporada por la
// escala, por su nivel de liga y entre el del rival (al revés para lo encajado).
// entradas: [la de esta temporada, la de la anterior], con avg_local, avg_visita
// e historial; factorDe(rival): el nivel de la liga del rival.
export function sumarHistorial(entradas, teamId, factor, factorDe) {
  let gf = 0, gc = 0, esperadoF = 0, esperadoC = 0, n = 0;
  for (const entrada of entradas) {
    if (!entrada) continue;
    const muL = entrada.avg_local, muV = entrada.avg_visita;
    for (const [rival, enCasa, aFavor, enContra] of (entrada.historial || {})[String(teamId)] || []) {
      const fRival = factorDe(rival);
      if (enCasa) {
        esperadoF += muL * ESCALA_CHAMPIONS[0] * factor / fRival;
        esperadoC += muV * ESCALA_CHAMPIONS[1] * fRival / factor;
      } else {
        esperadoF += muV * ESCALA_CHAMPIONS[1] * factor / fRival;
        esperadoC += muL * ESCALA_CHAMPIONS[0] * fRival / factor;
      }
      gf += aFavor;
      gc += enContra;
      n += 1;
    }
  }
  return { partidos: n, gf, gc, esperado_f: esperadoF, esperado_c: esperadoC };
}

// [ataque, defensa] que aporta el historial: goles frente a lo esperado,
// encogidos hacia 1 con k goles de pseudo-cuenta. Sin partidos, [1, 1].
export function multiplicadoresHistorial(h, k = K_HISTORIAL_CHAMPIONS) {
  return [(h.gf + k) / (h.esperado_f + k), (h.gc + k) / (h.esperado_c + k)];
}

// Goles esperados de un partido de Champions: ataque de uno por defensa del
// otro por la media de la Champions, el nivel de cada liga y el historial.
export function calcularXgChampions(local, visita, promedioCl) {
  const xgLocal = promedioCl.avg_local * ESCALA_CHAMPIONS[0]
    * local.ataque * visita.defensa * local.factor / visita.factor
    * local.ataque_cl * visita.defensa_cl;
  const xgVisita = promedioCl.avg_visita * ESCALA_CHAMPIONS[1]
    * visita.ataque * local.defensa * visita.factor / local.factor
    * visita.ataque_cl * local.defensa_cl;
  return [redondear(xgLocal, 2), redondear(xgVisita, 2)];
}
