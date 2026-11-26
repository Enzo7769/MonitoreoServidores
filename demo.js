// Servidor de demostración: muestra cómo se ven las fallas en todas las pestañas.
// Es simulado (no hace conexiones) y sus resultados NO se guardan en MongoDB,
// así no afecta la disponibilidad, los incidentes ni los CSV reales.
// Se activa con "demo": true en servidores.json o desde la pestaña Servidores.

const diagnostico = require('./diagnostico');
const { puertos: catalogo, serviciosGateway } = require('./catalogo');

const SERVIDOR = {
  nombre: 'demo',
  host: 'demo.dts.lat',
  tipo: 'gateway',
  demo: true,
  puertos: [3000, 3002, 3010, 3016, 3021, 3022, 3023, 3027],
  gateway: { puerto: 3022, servicios: ['tickets', 'visores', 'oficinas', 'ejecutivos'] },
};

const LIMITES = { timeoutMs: 5000, lentoMs: 2000 };
const ok = (ms, detalle = 'Health OK') => ({ nivel: 'ok', detalle, ms, codigo: 200 });
const falla = (nivel, error, extra = {}) => ({ ...extra, nivel, detalle: error.titulo, error });

// Contrato de health simulado (dts-health/1). La hora de inicio es fija para que el
// monitor no crea que la API se reinicia en cada revisión.
const INICIO_DEMO = new Date(Date.now() - 3 * 86400e3).toISOString();
function contrato(servicio, { mongo = 'ok', ms = 6, commit = '45c6a2f51120', sinMongo = false } = {}) {
  return {
    servicio, version: '1.0.0', commit, rama: 'main', entorno: 'production',
    iniciado: INICIO_DEMO, uptimeSegundos: Math.round((Date.now() - Date.parse(INICIO_DEMO)) / 1000), memoriaMB: { rss: 92, heap: 41 },
    dependencias: sinMongo ? {} : {
      mongo: mongo === 'ok' ? { estado: 'ok', detalle: 'conectado', ms } : { estado: 'caido', detalle: 'desconectado', ms: null },
    },
  };
}
const okConContrato = (ms, servicio, opciones) => {
  const c = contrato(servicio, opciones);
  return { ...ok(ms, c.dependencias.mongo ? `Health OK · Mongo ${c.dependencias.mongo.ms} ms` : 'Health OK'), contrato: c };
};

// Resultado simulado de cada API directa.
function resultadoPuerto(puerto) {
  const nombre = puerto === 3022 ? 'APIGatewayFila' : catalogo[puerto]?.nombre || `Puerto ${puerto}`;
  const ctx = { ...LIMITES, nombre, host: SERVIDOR.host, puerto, ws: catalogo[puerto]?.tipo === 'ws', ruta: '/api/health/detalle' };
  switch (puerto) {
    case 3002: return falla('error', diagnostico.deRed({ code: 'ECONNREFUSED', fase: 'conexion' }, ctx));
    case 3016: return falla('error', diagnostico.deRed({ code: 'ECONNREFUSED' }, ctx));
    case 3021: { // la API responde, pero informa con el contrato que perdió MongoDB
      const c = contrato(nombre, { mongo: 'caido' });
      return falla('error', diagnostico.deContrato({ ...c, estado: 'caido' }, 503, ctx), { ms: 9, codigo: 503, contrato: c });
    }
    case 3023: return falla('aviso', diagnostico.lenta(2840, ctx), { ms: 2840, codigo: 200, contrato: contrato(nombre, { ms: 2700 }) });
    case 3010: return ok(31, 'Responde (health pide token)'); // sin contrato: como una API antigua
    case 3027: return ok(22, 'Socket.IO acepta sesiones');
    case 3022: return okConContrato(14, nombre, { sinMongo: true });
    default: return okConContrato(18 + (puerto % 7) * 4, nombre);
  }
}

// Resultado simulado de cada servicio vía gateway.
function resultadoServicio(servicio) {
  const nombre = serviciosGateway[servicio] || servicio;
  const puertoInterno = Object.entries(catalogo).find(([, d]) => d.nombre === nombre)?.[0];
  const ctx = { ...LIMITES, nombre, host: SERVIDOR.host, viaGateway: true, servicio, puertoGateway: 3022, puertoInterno };
  const cuerpoGw = '{"mensajeError":"Error al contactar el servicio","detalle":"connect ECONNREFUSED"}';
  switch (servicio) {
    case 'visores': return falla('error', diagnostico.deHttp(502, cuerpoGw, ctx), { ms: 35, codigo: 502 });
    case 'ejecutivos': return falla('error', diagnostico.deRed({ code: 'ETIMEDOUT', fase: 'respuesta' }, ctx));
    // oficinas corre un commit distinto al de los demás servidores: así se ve en "Versiones desplegadas"
    case 'oficinas': return okConContrato(52, nombre, { commit: '9f3e21ab07cd' });
    default: return okConContrato(40 + servicio.length * 3, nombre);
  }
}

// Certificado simulado que vence en 9 días, para ver el aviso de SSL.
function certificado() {
  const venceEl = Date.now() + 9 * 86400e3 + 3600e3;
  return {
    revisado: Date.now(), nivel: 'aviso', venceEl, dias: 9, emisor: 'GlobalSign nv-sa', distintos: 1,
    puertos: SERVIDOR.puertos.map((puerto) => ({ puerto, venceEl, dias: 9, valido: true, problema: null })),
    vencidos: [], porVencer: [...SERVIDOR.puertos], invalidos: [],
  };
}

// Historial simulado del mes para la pestaña SLO (no viene de MongoDB): cada API del Demo
// con un comportamiento distinto, para ver todos los estados del presupuesto de error.
//   3021 APITicket: muchas caídas -> presupuesto agotado
//   3016 apiRestfulUAC: cayó en la última hora -> consumo muy rápido
//   /visores: cae ~30 min cada día la última semana -> no le alcanza el mes
//   3023 APIEstadisticas: una caída de 40 min hace días -> gastó parte, va bien
//   el resto: sin fallas
function ciclosSlo(ventana, intervaloMs, ahora = Date.now()) {
  const claves = [...SERVIDOR.puertos.map(String), ...SERVIDOR.gateway.servicios.map((s) => `gw:${s}`)];
  const fin = Math.min(ahora, ventana.hasta);
  const ciclos = [];
  for (let t = ventana.desde, i = 0; t < fin; t += intervaloMs, i++) {
    const d = {};
    const hora = new Date(t).getUTCHours();
    const diasAtras = (fin - t) / 86400e3;
    for (const id of claves) {
      let malo = false;
      if (id === '3021') malo = i % 9 === 0;
      if (id === '3016') malo = fin - t <= 3600e3;
      if (id === 'gw:visores') malo = hora === 13 && new Date(t).getUTCMinutes() < 30 && diasAtras <= 6;
      if (id === '3023') malo = diasAtras > 5 && diasAtras <= 5 + 40 / 1440;
      d[`${SERVIDOR.nombre}|${id}`] = [malo ? 'e' : 'o', malo ? null : 20];
    }
    ciclos.push({ t, d });
  }
  return ciclos;
}

module.exports = { SERVIDOR, resultadoPuerto, resultadoServicio, certificado, ciclosSlo };
