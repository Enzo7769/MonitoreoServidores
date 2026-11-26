// SLO y presupuesto de error ("error budget"), al estilo del libro de SRE de Google.
//
// - SLO: objetivo de disponibilidad por API (ej. 99,5 %) en una ventana (mes calendario).
// - Presupuesto de error: la caída permitida por ese objetivo. Con 99,5 % en un mes de 30 días
//   son 3 h 36 min. Cada falla lo va gastando.
// - Burn rate: a qué velocidad se gasta. 1 = justo se agota al final de la ventana;
//   14,4 = se agotaría en ~2 días. Se mide en ventanas de 1 h, 6 h y 3 días.
//
// Las revisiones guardadas en MongoDB son muestras cada ~15 min. Cada muestra "pesa" el tiempo
// hasta la siguiente (con tope de 2 intervalos, para no inventar datos si el monitor estuvo apagado).
// "s" (sin acceso) y "m" (mantención) no cuentan: no son ni tiempo bueno ni malo.

const HORA = 3600e3;
const DIA = 24 * HORA;

// Umbrales de burn rate (adaptados de las alertas multiventana de Google a muestras de 15 min).
const UMBRALES = {
  critica: { ventana: 1 * HORA, burn: 14.4, texto: 'Se gasta muy rápido: a este ritmo se agota en ~2 días' },
  alta: { ventana: 6 * HORA, burn: 6, texto: 'Se gasta rápido: a este ritmo se agota en ~5 días' },
  lenta: { ventana: 3 * DIA, burn: 1, texto: 'A este ritmo se agota antes de que termine el mes' },
};

// ---- Ventana: mes calendario en la zona horaria del monitor ----------------

// Diferencia (ms) entre la hora local de "zona" y UTC en el instante t.
function desfaseZona(t, zona) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const comoUtc = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute, +partes.second);
  return comoUtc - Math.floor(t / 1000) * 1000;
}

// Instante UTC de la medianoche local del día 1 de (año, mes) en "zona".
function inicioMesLocal(anio, mes, zona) {
  const aprox = Date.UTC(anio, mes - 1, 1);
  let t = aprox - desfaseZona(aprox, zona);
  t = aprox - desfaseZona(t, zona); // segunda pasada por si cambia el horario de verano ese día
  return t;
}

// "2026-11" -> { desde, hasta, etiqueta }. Sin mes: el mes actual.
function ventanaMes(mesTexto, zona, ahora = Date.now()) {
  let anio, mes;
  if (/^\d{4}-\d{2}$/.test(mesTexto || '')) {
    [anio, mes] = mesTexto.split('-').map(Number);
  } else {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit' }).format(new Date(ahora)).split('-');
    [anio, mes] = p.map(Number);
  }
  const desde = inicioMesLocal(anio, mes, zona);
  const hasta = mes === 12 ? inicioMesLocal(anio + 1, 1, zona) : inicioMesLocal(anio, mes + 1, zona);
  const etiqueta = new Date(desde + 12 * HORA).toLocaleDateString('es-CL', { timeZone: zona, month: 'long', year: 'numeric' });
  return { mes: `${anio}-${String(mes).padStart(2, '0')}`, desde, hasta, etiqueta };
}

// ---- Cálculo -----------------------------------------------------------------

const nuevo = () => ({ observado: 0, malo: 0 });
function acumular(a, dur, malo) { a.observado += dur; if (malo) a.malo += dur; }
const fraccionMala = (a) => (a.observado ? a.malo / a.observado : 0);

// ciclos: [{ t, d: { "servidor|id": [nivel, ms, tipo?] } }] ordenados por t
// opciones: { ventana: {desde, hasta}, ahora, intervaloMs, objetivoDe(srv,id), nombreDe(srv,id) }
function calcular(ciclos, { ventana, ahora = Date.now(), intervaloMs, objetivoDe, nombreDe }) {
  const finMedicion = Math.min(ahora, ventana.hasta);
  const duracionVentana = ventana.hasta - ventana.desde;
  const transcurrido = Math.max(0, finMedicion - ventana.desde);
  // Revisiones en que fallaron a la vez la mayoría de los servidores (60 % o más, al menos 3) y una
  // parte importante de todas las APIs (20 % o más): que máquinas distintas caigan juntas es casi
  // imposible, así que lo probable es que fallara la red del propio monitor. No se cobran al
  // presupuesto de ninguna API (quedan como "sin datos").
  const servidorDe = (k) => k.slice(0, k.indexOf('|'));
  const ciclosExcluidos = [];
  const dentro = ciclos.filter((c) => {
    if (c.t < ventana.desde || c.t >= ventana.hasta) return false;
    const vigentes = Object.entries(c.d).filter(([, [n]]) => n !== 's' && n !== 'm');
    const malas = vigentes.filter(([, [n]]) => n === 'e');
    const servidoresTotales = new Set(vigentes.map(([k]) => servidorDe(k))).size;
    const servidoresConFalla = new Set(malas.map(([k]) => servidorDe(k))).size;
    if (vigentes.length >= 10 && servidoresConFalla >= 3
      && servidoresConFalla / servidoresTotales >= 0.6 && malas.length / vigentes.length >= 0.2) {
      ciclosExcluidos.push({ t: c.t, caidas: malas.length, total: vigentes.length, servidores: servidoresConFalla, deServidores: servidoresTotales });
      return false;
    }
    return true;
  });
  const topeMuestra = 2 * intervaloMs;

  const apis = new Map();
  for (let i = 0; i < dentro.length; i++) {
    const c = dentro[i];
    const siguiente = i + 1 < dentro.length ? dentro[i + 1].t : Math.min(finMedicion, c.t + intervaloMs);
    const dur = Math.max(0, Math.min(siguiente - c.t, topeMuestra));
    if (!dur) continue;
    const dia = Math.floor((c.t - ventana.desde) / DIA);
    for (const [clave, [nivel]] of Object.entries(c.d)) {
      if (nivel === 's' || nivel === 'm') continue;
      if (!apis.has(clave)) apis.set(clave, { total: nuevo(), h1: nuevo(), h6: nuevo(), d3: nuevo(), dias: new Map(), ultimoMalo: false });
      const a = apis.get(clave);
      const malo = nivel === 'e';
      acumular(a.total, dur, malo);
      const edad = finMedicion - c.t;
      if (edad <= UMBRALES.critica.ventana) acumular(a.h1, dur, malo);
      if (edad <= UMBRALES.alta.ventana) acumular(a.h6, dur, malo);
      if (edad <= UMBRALES.lenta.ventana) acumular(a.d3, dur, malo);
      if (!a.dias.has(dia)) a.dias.set(dia, nuevo());
      acumular(a.dias.get(dia), dur, malo);
      a.ultimoMalo = malo;
    }
  }

  const filas = [];
  for (const [clave, a] of apis) {
    const corte = clave.indexOf('|');
    const servidor = clave.slice(0, corte);
    const id = clave.slice(corte + 1);
    const objetivo = objetivoDe(servidor, id);
    const permitidoFraccion = 1 - objetivo / 100;
    const permitidoMs = permitidoFraccion * duracionVentana;
    const consumidoMs = a.total.malo;
    const burn = (acc) => (permitidoFraccion > 0 ? fraccionMala(acc) / permitidoFraccion : 0);
    const burnRate = { h1: burn(a.h1), h6: burn(a.h6), d3: burn(a.d3) };
    const consumidoPct = permitidoMs ? (consumidoMs / permitidoMs) * 100 : 0;
    // Proyección a fin de mes al ritmo de lo que va (solo con al menos 1 día de datos).
    const proyeccionPct = a.total.observado >= DIA ? (fraccionMala(a.total) * duracionVentana / permitidoMs) * 100 : null;

    let alerta = null;
    if (consumidoMs >= permitidoMs && permitidoMs > 0) alerta = 'agotado';
    else if (burnRate.h1 >= UMBRALES.critica.burn && a.ultimoMalo) alerta = 'critica';
    else if (burnRate.h6 >= UMBRALES.alta.burn && burnRate.h1 >= 1) alerta = 'alta';
    else if (burnRate.d3 >= UMBRALES.lenta.burn && proyeccionPct != null && proyeccionPct > 100) alerta = 'lenta';

    const estado = alerta === 'agotado' ? 'agotado' : alerta ? 'riesgo' : 'ok';
    filas.push({
      servidor, id, nombre: nombreDe(servidor, id), objetivo,
      disponibilidad: a.total.observado ? (1 - fraccionMala(a.total)) * 100 : null,
      permitidoMs, consumidoMs, restanteMs: permitidoMs - consumidoMs, consumidoPct, proyeccionPct,
      burnRate, alerta, estado,
      observadoMs: a.total.observado,
      diario: [...a.dias].sort((x, y) => x[0] - y[0]).map(([dia, d]) => ({ dia, maloMs: d.malo, observadoMs: d.observado })),
    });
  }

  // Resumen por servidor (tiempo ponderado de todas sus APIs).
  const porServidor = new Map();
  for (const f of filas) {
    if (!porServidor.has(f.servidor)) porServidor.set(f.servidor, { servidor: f.servidor, observadoMs: 0, maloMs: 0, apis: 0, enRiesgo: 0, agotadas: 0 });
    const s = porServidor.get(f.servidor);
    s.observadoMs += f.observadoMs; s.maloMs += f.consumidoMs; s.apis++;
    if (f.estado === 'riesgo') s.enRiesgo++;
    if (f.estado === 'agotado') s.agotadas++;
  }

  const orden = { agotado: 0, riesgo: 1, ok: 2 };
  return {
    ventana: { ...ventana, transcurridoPct: (transcurrido / duracionVentana) * 100, quedanMs: Math.max(0, ventana.hasta - finMedicion) },
    datosDesde: dentro[0]?.t ?? null,
    ciclosExcluidos,
    coberturaPct: transcurrido ? Math.min(100, ((dentro.length ? finMedicion - dentro[0].t : 0) / transcurrido) * 100) : 0,
    umbrales: Object.fromEntries(Object.entries(UMBRALES).map(([k, u]) => [k, { burn: u.burn, ventanaHoras: u.ventana / HORA, texto: u.texto }])),
    apis: filas.sort((a, b) => orden[a.estado] - orden[b.estado] || b.consumidoPct - a.consumidoPct || a.servidor.localeCompare(b.servidor)),
    servidores: [...porServidor.values()].map((s) => ({ ...s, disponibilidad: s.observadoMs ? (1 - s.maloMs / s.observadoMs) * 100 : null })),
  };
}

// Incidente (o null) para una API cuyo presupuesto está en riesgo o agotado.
function incidenteSlo(f) {
  if (!f.alerta) return null;
  const restante = f.restanteMs > 0 ? `Quedan ${duracionTexto(f.restanteMs)} de ${duracionTexto(f.permitidoMs)} de caída permitida.` : `Se pasó por ${duracionTexto(-f.restanteMs)}.`;
  const textos = {
    agotado: ['SLO incumplido: presupuesto agotado', `${f.nombre} ya gastó todo su presupuesto de error del mes (objetivo ${f.objetivo} %). ${restante}`],
    critica: ['SLO en riesgo: consumo muy rápido', `${f.nombre} está gastando su presupuesto de error ${f.burnRate.h1.toFixed(1)} veces más rápido de lo sostenible (última hora). ${restante}`],
    alta: ['SLO en riesgo: consumo rápido', `${f.nombre} gasta su presupuesto ${f.burnRate.h6.toFixed(1)} veces más rápido de lo sostenible (últimas 6 h). ${restante}`],
    lenta: ['SLO en riesgo: no alcanza el mes', `Al ritmo de los últimos 3 días, ${f.nombre} terminaría el mes con ${Math.round(f.proyeccionPct)} % del presupuesto gastado. ${restante}`],
  };
  const [titulo, causa] = textos[f.alerta];
  return {
    alcance: 'slo', nivel: f.alerta === 'lenta' ? 'aviso' : 'error', titulo: `${titulo} · ${f.nombre}`, tipo: titulo, causa,
    sugerencia: 'Revisa los incidentes de esta API en el Dashboard: el problema no es una caída puntual, sino que se repite.',
    apis: [f.nombre],
  };
}

function duracionTexto(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// Informe SLA en CSV (Excel en español: ";" y coma decimal).
function aCsv(resultado) {
  const num = (v, d = 3) => (v == null ? '' : v.toFixed(d).replace('.', ','));
  const filas = [['Mes', 'Servidor', 'API', 'Objetivo %', 'Disponibilidad %', 'Cumple', 'Caida permitida (min)', 'Caida real (min)', 'Presupuesto usado %', 'Estado'].join(';')];
  for (const f of resultado.apis) {
    filas.push([
      resultado.ventana.mes, f.servidor, f.nombre, num(f.objetivo, 2), num(f.disponibilidad),
      f.disponibilidad == null ? '' : f.disponibilidad >= f.objetivo ? 'Si' : 'No',
      Math.round(f.permitidoMs / 60000), Math.round(f.consumidoMs / 60000), num(f.consumidoPct, 1),
      { ok: 'Cumpliendo', riesgo: 'En riesgo', agotado: 'Incumplido' }[f.estado],
    ].join(';'));
  }
  return '﻿' + filas.join('\r\n') + '\r\n';
}

module.exports = { calcular, ventanaMes, incidenteSlo, duracionTexto, aCsv, UMBRALES };
