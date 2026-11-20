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

// Resultado simulado de cada API directa.
function resultadoPuerto(puerto) {
  const nombre = puerto === 3022 ? 'APIGatewayFila' : catalogo[puerto]?.nombre || `Puerto ${puerto}`;
  const ctx = { ...LIMITES, nombre, host: SERVIDOR.host, puerto, ws: catalogo[puerto]?.tipo === 'ws', ruta: '/api/health' };
  switch (puerto) {
    case 3002: return falla('error', diagnostico.deRed({ code: 'ECONNREFUSED', fase: 'conexion' }, ctx));
    case 3016: return falla('error', diagnostico.deRed({ code: 'ECONNREFUSED' }, ctx));
    case 3021: return falla('error', diagnostico.deHttp(500, '{"message":"MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017"}', ctx), { ms: 48, codigo: 500 });
    case 3023: return falla('aviso', diagnostico.lenta(2840, ctx), { ms: 2840, codigo: 200 });
    case 3010: return ok(31, 'Responde (health pide token)');
    case 3027: return ok(22, 'WebSocket acepta conexiones');
    default: return ok(18 + (puerto % 7) * 4);
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
    default: return ok(40 + servicio.length * 3);
  }
}

module.exports = { SERVIDOR, resultadoPuerto, resultadoServicio };
