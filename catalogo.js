// Catálogo de puertos conocidos -> qué servicio corre ahí.
// Sale de los .env de cada repo y de docker-fila/docker-compose.yml.
// tipo 'ws'  = WebSocket Python: solo se valida que el puerto acepte conexión.
// health     = rutas a probar en orden (por defecto /api/health y /health).
// contrato   = ruta del contrato de health dts-health/1 (por defecto /api/health/detalle;
//              las APIs que no usan el prefijo /api lo exponen en /health/detalle).

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
  3009: { nombre: 'apiObtenerAvisoBase', contrato: '/health/detalle' },
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
  3022: { nombre: 'APITTS', contrato: '/health/detalle' },
  3023: { nombre: 'APIEstadisticas' },
  3024: { nombre: 'APIDatosMonitoreo' },
  3025: { nombre: 'APIMonitoreo' },
  // En producción apiHistorialUac corre en el 3026 (así la llaman los fronts de UAC),
  // aunque su .env local diga 3013. El WebSocketVideo desplegado es el 3085.
  3026: { nombre: 'apiHistorialUac' },
  3027: { nombre: 'WSEncolador', tipo: 'ws' },
  3028: { nombre: 'WSEstadistica', tipo: 'ws' },
  3029: { nombre: 'wssAlimentaBarra', tipo: 'ws' },
  3030: { nombre: 'APIAdapterFichaClinica' },
  3031: { nombre: 'APILlamadoCita' },
  3032: { nombre: 'APICitasUDT' },
  3033: { nombre: 'APIRestfulIngresaArchivos' },
  3085: { nombre: 'WebSocketVideo', tipo: 'ws' },
  4000: { nombre: 'APIGatewayFila', health: ['/health', '/ping'], contrato: '/health/detalle' },
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
