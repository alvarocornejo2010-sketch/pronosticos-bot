// Las métricas de validacion.py (Brier, LogLoss, acierto y calibración del 1X2 y
// de los mercados de goles), con las sumas compensadas de sum() de Python. Las
// usan la validación (validacion.js) y el registro en vivo (registro.js), y se
// pueden guardar a medias (toJSON) y seguir sumando después.

import { Suma, redondear } from "./modelo.js";

// ==========================================
// MÉTRICAS
// ==========================================
// Las sumas van con Suma (compensada, como sum() de Python): llevarlas de paso
// en paso da lo mismo que sumar la lista entera al final, y no hay que guardar
// la lista.
export const resultado = (m) => (m.gl > m.gv ? 0 : m.gl === m.gv ? 1 : 2);
const tramo = (v) => Math.min(Math.trunc(v * 10), 9);

export function brier(p, y) {
  const s = new Suma();
  for (let i = 0; i < 3; i++) s.add((p[i] - (i === y ? 1 : 0)) ** 2);
  return s.valor();
}

const logloss = (p, y) => -Math.log(Math.max(p[y], 1e-15));

const suma = (g) => (g ? new Suma(g[0], g[1]) : new Suma());
const guardarSuma = (s) => [s.s, s.c];

export class Acumulador {
  constructor(g = null) {
    this.b = suma(g && g.b); this.l = suma(g && g.l);
    this.aciertos = g ? g.aciertos : 0;
    this.n = g ? g.n : 0;
    this.bins = new Map(g ? g.bins : []);
  }

  add(p, y) {
    this.b.add(brier(p, y)); this.l.add(logloss(p, y));
    let mejor = 0;
    for (let i = 1; i < 3; i++) if (p[i] > p[mejor]) mejor = i;
    this.aciertos += mejor === y ? 1 : 0;
    this.n += 1;
    for (let i = 0; i < 3; i++) {
      const k = tramo(p[i]);
      const b = this.bins.get(k) ?? [0.0, 0, 0];
      b[0] += p[i]; b[1] += i === y ? 1 : 0; b[2] += 1;
      this.bins.set(k, b);
    }
  }

  resumen() {
    if (!this.n) return null;
    return { brier: redondear(this.b.valor() / this.n, 4), logloss: redondear(this.l.valor() / this.n, 4),
      acierto: redondear(100 * this.aciertos / this.n, 1), n: this.n };
  }

  calibracion(minimo = 25) {
    return calibracion(this.bins, minimo);
  }

  toJSON() {
    return { b: guardarSuma(this.b), l: guardarSuma(this.l), aciertos: this.aciertos, n: this.n, bins: [...this.bins] };
  }
}

// Lo mismo para un mercado de sí o no (más de 2.5, ambos marcan), con la media
// predicha y la frecuencia real.
export class Binario {
  constructor(g = null) {
    this.b = suma(g && g.b); this.l = suma(g && g.l);
    this.aciertos = g ? g.aciertos : 0;
    this.n = g ? g.n : 0;
    this.sumaP = g ? g.sumaP : 0.0;
    this.si = g ? g.si : 0;
    this.bins = new Map(g ? g.bins : []);
  }

  add(p, y) {
    this.b.add((p - y) ** 2);
    this.l.add(-Math.log(Math.max(y ? p : 1 - p, 1e-15)));
    this.aciertos += (p >= 0.5) === Boolean(y) ? 1 : 0;
    this.n += 1; this.sumaP += p; this.si += y;
    const k = tramo(p);
    const b = this.bins.get(k) ?? [0.0, 0, 0];
    b[0] += p; b[1] += y; b[2] += 1;
    this.bins.set(k, b);
  }

  resumen() {
    if (!this.n) return null;
    return { brier: redondear(this.b.valor() / this.n, 4), logloss: redondear(this.l.valor() / this.n, 4),
      acierto: redondear(100 * this.aciertos / this.n, 1),
      predicho: redondear(100 * this.sumaP / this.n, 1), real: redondear(100 * this.si / this.n, 1), n: this.n };
  }

  calibracion(minimo = 25) {
    return calibracion(this.bins, minimo);
  }

  toJSON() {
    return { b: guardarSuma(this.b), l: guardarSuma(this.l), aciertos: this.aciertos, n: this.n,
      sumaP: this.sumaP, si: this.si, bins: [...this.bins] };
  }
}

export function calibracion(bins, minimo) {
  const filas = [];
  for (const b of [...bins.keys()].sort((x, y) => x - y)) {
    const [total, ac, n] = bins.get(b);
    if (n < minimo) continue;
    const pred = 100 * total / n, real = 100 * ac / n;
    const se = 100 * Math.sqrt(Math.max(pred / 100 * (1 - pred / 100), 1e-9) / n);
    filas.push({ rango: `${b * 10}-${b * 10 + 10}%`, casos: n, predicho: redondear(pred, 1),
      real: redondear(real, 1), desvio: redondear(real - pred, 1), se: redondear(se, 1),
      significativo: Math.abs(real - pred) > 2 * se });
  }
  return filas;
}

// Mercados de goles que se validan además del 1X2: clave de mercadosDeGoles y
// qué cuenta como "sí" con el marcador real.
export const MERCADOS = {
  mas_25: ["prob_mas_25", (m) => m.gl + m.gv > 2.5],
  ambos: ["prob_ambos", (m) => m.gl > 0 && m.gv > 0],
};

export function resumenMercado(modelo, base) {
  const m = modelo.resumen(), b = base.resumen();
  const skill = redondear(100 * (1 - m.brier / b.brier), 1);
  return { modelo: m, base_equipo_medio: b, skill_score: skill,
    aporta_valor: skill > 0 && m.logloss < b.logloss, calibracion: modelo.calibracion() };
}
