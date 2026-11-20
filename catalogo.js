// Catálogo de puertos conocidos -> qué servicio corre ahí.
// Sale de los .env de cada repo y de docker-fila/docker-compose.yml.
// tipo 'ws'  = WebSocket Python: solo se valida que el puerto acepte conexión.
// health     = rutas a probar en orden (por defecto /api/health y /health).

const puertos = {
  3000: { nombre: 'apiRESTfulTramites' },
  3001: { nombre: 'apiRESTfulUDT' },
  3002: { nombre: 'WSNumeroAtencion', tipo: 'ws' },
  3003: { nombre: 'apiRESTfulOficinas' },
  3004: { nombre: 'apiRESTfulSectores' },
  3005: { nombre: 'apiRESTfulVisores' },
  3006: { nombre: 'APICreacionAgenda' },
  3007: { nombre: 'apiRESTfulAsignacionMedico' },
  3008: { nombre: 'apiTextoBarra' },
  3009: { nombre: 'apiObtenerAvisoBase' },
  3010: { nombre: 'APIConsultaCita' },
  3011: { nombre: 'APIRestfulEstadosEjecutivos' },
  3012: { nombre: 'apiTipoCierres' },
  3013: { nombre: 'apiHistorialUac' },
  3014: { nombre: 'apiUsuariosFila' },
  3015: { nombre: 'apiRestfulEjecutivos' },
  3016: { nombre: 'apiRestfulUAC' },
  3017: { nombre: 'apiRestfulPais' },
  3018: { nombre: 'apiRESTfulSincronizacion' },
  3019: { nombre: 'apiRESTfulPromociones' },
  3020: { nombre: 'APITramites' },
  3021: { nombre: 'APITicket' },
  3022: { nombre: 'APITTS' },
  3023: { nombre: 'APIEstadisticas' },
  3024: { nombre: 'APIDatosMonitoreo' },
  3025: { nombre: 'APIMonitoreo' },
  3026: { nombre: 'WebSocketVideo', tipo: 'ws' },
  3027: { nombre: 'WSEncolador', tipo: 'ws' },
  3028: { nombre: 'WSEstadistica', tipo: 'ws' },
  3029: { nombre: 'wssAlimentaBarra', tipo: 'ws' },
  3030: { nombre: 'APIAdapterFichaClinica' },
  3031: { nombre: 'APILlamadoCita' },
  3032: { nombre: 'APICitasUDT' },
  3033: { nombre: 'APIRestfulIngresaArchivos' },
  3085: { nombre: 'WS Video (visor)', tipo: 'ws' },
  4000: { nombre: 'APIGatewayFila', health: ['/health', '/ping'] },
};

// Puertos donde puede estar APIGatewayFila (descubrir.js lo detecta solo).
const puertosGateway = [3022, 4000];

// Servicio del gateway (APIGatewayFila/config/apis.js) -> API real detrás.
const serviciosGateway = {
  login: 'apiUsuariosFila',
  oficinas: 'apiRESTfulOficinas',
  uacs: 'apiRestfulUAC',
  tramites: 'apiRESTfulTramites',
  estadisticas: 'APIEstadisticas',
  sectores: 'apiRESTfulSectores',
  promociones: 'apiRESTfulPromociones',
  agendas: 'APICreacionAgenda',
  tramite: 'APITramites',
  paises: 'apiRestfulPais',
  ejecutivos: 'apiRestfulEjecutivos',
  visores: 'apiRESTfulVisores',
  udts: 'apiRESTfulUDT',
  estadosEjecutivos: 'APIRestfulEstadosEjecutivos',
  asignacionMedico: 'apiRESTfulAsignacionMedico',
  tickets: 'APITicket',
  monitoreo: 'APIMonitoreo',
  fichaClinica: 'APIAdapterFichaClinica',
  historialUac: 'apiHistorialUac',
};

module.exports = { puertos, puertosGateway, serviciosGateway };
