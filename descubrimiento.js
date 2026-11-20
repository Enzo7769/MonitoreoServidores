// Detección de las APIs de un servidor y lectura/escritura de servidores.json.
// Lo usan descubrir.js (línea de comandos) y monitor.js (pestaña "Servidores").

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { puertos: catalogo, puertosGateway } = require('./catalogo');
const { probarTcp, pedirAuto, leerJson, enParalelo } = require('./sondas');

const RUTA_CONFIG = path.join(__dirname, 'servidores.json');

// Tipos de servidor: cómo se llega a sus APIs.
const TIPOS = {
  directo: { nombre: 'Directo', puertoGateway: null },
  gateway: { nombre: 'Con gateway', puertoGateway: 3022 },
  proxy: { nombre: 'Con proxy', puertoGateway: 3023 },
};

function leerConfig() {
  return JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
}

// Listas en una sola línea para que el archivo sea fácil de editar a mano.
function guardarConfig(config) {
  const json = JSON.stringify(config, null, 2).replace(/\[\s*([^\[\]{}]*?)\s*\]/g, (_, items) =>
    '[' + items.split(/,\s*/).map((s) => s.trim()).filter(Boolean).join(', ') + ']'
  );
  fs.writeFileSync(RUTA_CONFIG, json + '\n');
}

function tipoDe(srv) {
  if (srv.tipo) return srv.tipo;
  if (!srv.gateway) return 'directo';
  return srv.gateway.puerto === TIPOS.proxy.puertoGateway ? 'proxy' : 'gateway';
}

// "https://Maipu.dts.lat:3022/algo" -> "maipu.dts.lat"
function normalizarHost(texto) {
  return String(texto || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/:?#]/)[0];
}

const hostValido = (host) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) && host.length <= 253;

// "maipu.dts.lat" -> "maipu"
const nombreDesdeHost = (host) => host.split('.')[0];

// El gateway responde a un servicio inexistente con la lista de servicios disponibles.
async function detectarGateway(host, candidatos) {
  for (const puerto of candidatos) {
    try {
      const r = await pedirAuto(null, host, puerto, '/__monitor_descubrir__', 5000);
      const json = leerJson(r.cuerpo);
      if (Array.isArray(json?.serviciosDisponibles)) return { puerto, servicios: json.serviciosDisponibles };
    } catch {}
  }
  return null;
}

// Escanea los puertos del catálogo y detecta el gateway.
// puertoGateway: si viene (3022 / 3023), solo se busca el gateway ahí; si no, se autodetecta.
async function descubrirServidor(host, { puertoGateway } = {}) {
  await dns.lookup(host); // lanza ENOTFOUND si el dominio no existe

  const todos = [...new Set([...Object.keys(catalogo).map(Number), ...(puertoGateway ? [puertoGateway] : [])])];
  const abiertos = [];
  const escanear = (lista, timeoutMs) => enParalelo(
    lista.map((p) => async () => {
      const r = await probarTcp(host, p, timeoutMs);
      if (r.ok) abiertos.push(p);
    }),
    40
  );
  await escanear(todos, 3000);
  // Segunda pasada a los que no respondieron, para no perder una API por un corte momentáneo.
  await escanear(todos.filter((p) => !abiertos.includes(p)), 6000);
  abiertos.sort((a, b) => a - b);

  const candidatos = puertoGateway ? [puertoGateway] : puertosGateway;
  const gateway = await detectarGateway(host, candidatos.filter((p) => abiertos.includes(p)));
  return { puertos: abiertos, gateway };
}

module.exports = {
  TIPOS, leerConfig, guardarConfig, tipoDe, normalizarHost, hostValido, nombreDesdeHost, descubrirServidor,
};
