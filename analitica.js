// Cálculos para el dashboard a partir de los ciclos guardados en MongoDB.
// Cada ciclo: { t, d: { "servidor|id": [nivel, ms] } }
// nivel: o = ok, a = aviso, e = error, s = sin acceso (no cuenta para disponibilidad)

const CODIGO = { ok: 'o', aviso: 'a', error: 'e', sinacceso: 's' };

const nuevoAcum = () => ({ checks: 0, fallas: 0, avisos: 0, sumMs: 0, nMs: 0, maxMs: 0 });
function sumar(acum, falla, aviso, ms) {
  acum.checks++;
  if (falla) acum.fallas++;
  if (aviso) acum.avisos++;
  if (ms != null) { acum.sumMs += ms; acum.nMs++; if (ms > acum.maxMs) acum.maxMs = ms; }
}
const disponibilidad = (a) => (a.checks ? (1 - a.fallas / a.checks) * 100 : null);
const msPromedio = (a) => (a.nMs ? Math.round(a.sumMs / a.nMs) : null);

function separarClave(clave) {
  const corte = clave.indexOf('|');
  return [clave.slice(0, corte), clave.slice(corte + 1)];
}

// horas: periodo hacia atrás. servidor: si viene, se agrupa por API de ese servidor.
function calcular(ciclosTodos, { horas, servidor }, nombreApi) {
  const ahora = Date.now();
  const desde = ahora - horas * 3600e3;
  const ciclos = ciclosTodos.filter((c) => c.t >= desde);

  const bucketMs = horas <= 24 ? 3600e3 : horas <= 168 ? 6 * 3600e3 : 86400e3;
  const nBuckets = Math.ceil((horas * 3600e3) / bucketMs);

  const total = nuevoAcum();
  const grupos = new Map(); // servidor (o API si hay filtro) -> acumulado + celdas del mapa de calor
  const apis = new Map(); // "servidor|id" -> acumulado + seguimiento de incidentes
  const incidentes = [];
  const serie = [];

  for (const ciclo of ciclos) {
    const enCiclo = nuevoAcum();
    const bucket = Math.min(nBuckets - 1, Math.floor((ciclo.t - desde) / bucketMs));

    for (const [clave, [nivel, ms, tipoError]] of Object.entries(ciclo.d)) {
      const [srv, id] = separarClave(clave);
      if (servidor && srv !== servidor) continue;
      if (nivel === 's') continue;

      const falla = nivel === 'e';
      const aviso = nivel === 'a';
      sumar(total, falla, aviso, ms);
      sumar(enCiclo, falla, aviso, ms);

      const claveGrupo = servidor ? id : srv;
      if (!grupos.has(claveGrupo)) {
        grupos.set(claveGrupo, {
          ...nuevoAcum(),
          etiqueta: servidor ? nombreApi(srv, id) : srv,
          celdas: Array.from({ length: nBuckets }, nuevoAcum),
        });
      }
      const g = grupos.get(claveGrupo);
      sumar(g, falla, aviso, ms);
      sumar(g.celdas[bucket], falla, aviso, ms);

      if (!apis.has(clave)) apis.set(clave, { ...nuevoAcum(), srv, id, abierto: null });
      const api = apis.get(clave);
      sumar(api, falla, aviso, ms);
      if (falla && !api.abierto) {
        api.abierto = { inicio: ciclo.t, fin: null, servidor: srv, api: nombreApi(srv, id), tipo: tipoError || null };
        incidentes.push(api.abierto);
      } else if (!falla && api.abierto) {
        api.abierto.fin = ciclo.t;
        api.abierto = null;
      }
    }

    if (enCiclo.checks) serie.push({ t: ciclo.t, disponibilidad: disponibilidad(enCiclo), ms: msPromedio(enCiclo) });
  }

  return {
    horas,
    servidor: servidor || null,
    ciclos: ciclos.length,
    primerDato: ciclos[0]?.t ?? null,
    bucketMs,
    inicioBuckets: desde,
    kpis: {
      disponibilidad: disponibilidad(total),
      msPromedio: msPromedio(total),
      incidentes: incidentes.length,
      revisiones: total.checks,
    },
    serie,
    grupos: [...grupos.entries()]
      .map(([clave, g]) => ({
        clave,
        etiqueta: g.etiqueta,
        disponibilidad: disponibilidad(g),
        msPromedio: msPromedio(g),
        fallas: g.fallas,
        checks: g.checks,
        celdas: g.celdas.map((c) => (c.checks ? { fallas: c.fallas, checks: c.checks } : null)),
      }))
      .sort((a, b) => a.disponibilidad - b.disponibilidad || a.etiqueta.localeCompare(b.etiqueta)),
    topApis: [...apis.values()]
      .filter((a) => a.fallas > 0 || a.avisos > 0)
      .map((a) => ({
        servidor: a.srv,
        api: nombreApi(a.srv, a.id),
        fallas: a.fallas,
        avisos: a.avisos,
        disponibilidad: disponibilidad(a),
        msPromedio: msPromedio(a),
      }))
      .sort((a, b) => b.fallas - a.fallas || b.avisos - a.avisos)
      .slice(0, 10),
    incidentes: incidentes
      .map((i) => ({ ...i, duracionMs: (i.fin ?? ahora) - i.inicio, activo: i.fin == null }))
      .sort((a, b) => b.inicio - a.inicio)
      .slice(0, 50),
  };
}

// ---- Resumen diario (CSV) ----------------------------------------------------

// "YYYY-MM-DD" de un instante en la zona horaria indicada.
function fechaLocal(t, zona) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

// Una fila por servidor + API para el día `fecha` (YYYY-MM-DD, hora local de `zona`).
// Los ciclos deben cubrir ese día (se filtran aquí por fecha local).
function resumenDiario(ciclosTodos, fecha, zona, intervaloSegundos, nombreApi) {
  const apis = new Map();
  for (const ciclo of ciclosTodos) {
    if (fechaLocal(ciclo.t, zona) !== fecha) continue;
    for (const [clave, [nivel, ms, tipoError]] of Object.entries(ciclo.d)) {
      if (nivel === 's') continue;
      if (!apis.has(clave)) apis.set(clave, { ...nuevoAcum(), incidentes: 0, enFalla: false, ultimoError: null });
      const a = apis.get(clave);
      const falla = nivel === 'e';
      sumar(a, falla, nivel === 'a', ms);
      if (tipoError) a.ultimoError = tipoError;
      if (falla && !a.enFalla) a.incidentes++;
      a.enFalla = falla;
    }
  }
  return [...apis.entries()]
    .map(([clave, a]) => {
      const [srv, id] = separarClave(clave);
      return {
        fecha,
        servidor: srv.charAt(0).toUpperCase() + srv.slice(1),
        api: nombreApi(srv, id),
        revisiones: a.checks,
        ok: a.checks - a.fallas - a.avisos,
        avisos: a.avisos,
        fallas: a.fallas,
        disponibilidad: disponibilidad(a),
        msPromedio: msPromedio(a),
        msMaximo: a.nMs ? a.maxMs : null,
        incidentes: a.incidentes,
        minutosCaida: Math.round((a.fallas * intervaloSegundos) / 60),
        ultimoError: a.ultimoError,
      };
    })
    .sort((x, y) => x.servidor.localeCompare(y.servidor) || x.api.localeCompare(y.api));
}

// CSV para Excel en español: separador ";", coma decimal y BOM UTF-8.
function aCsv(filas) {
  const columnas = [
    ['fecha', 'Fecha'], ['servidor', 'Servidor'], ['api', 'API'], ['revisiones', 'Revisiones'], ['ok', 'OK'],
    ['avisos', 'Avisos'], ['fallas', 'Fallas'], ['disponibilidad', 'Disponibilidad %'], ['msPromedio', 'Resp. promedio ms'],
    ['msMaximo', 'Resp. maxima ms'], ['incidentes', 'Incidentes'], ['minutosCaida', 'Minutos caida (aprox.)'],
    ['ultimoError', 'Ultimo error del dia'],
  ];
  const celda = (v) => {
    if (v == null) return '';
    if (typeof v === 'number') return String(Number.isInteger(v) ? v : v.toFixed(2)).replace('.', ',');
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [columnas.map(([, t]) => t).join(';'), ...filas.map((f) => columnas.map(([k]) => celda(f[k])).join(';'))];
  return '﻿' + lineas.join('\r\n') + '\r\n';
}

module.exports = { CODIGO, calcular, resumenDiario, aCsv, fechaLocal };
