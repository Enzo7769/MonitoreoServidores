// Agente del monitor para tótems (newUDT, app Flutter de escritorio).
//
// El tótem no es una página web, así que no puede cargar rum.js. Este agente corre en el
// mismo equipo y lo observa desde afuera, SIN modificar la app:
//   - lee el log de la app (error.log) y manda al monitor cada ERROR y WARNING (RUT enmascarados)
//   - revisa que la app esté corriendo (newudt.exe)
//   - revisa que el servicio de impresión responda (solo abre y cierra la conexión TCP: no imprime)
//   - manda un latido cada 60 s: si el equipo se apaga o pierde la red, el monitor lo ve
//
// Usa el mismo protocolo que rum.js (POST /api/beacon), con tipo "totem".
//
// Uso:  node agente-totem.js --monitor https://test.dts.lat:8091 [opciones]
//   --monitor URL      puerto público del monitor (rum.puerto). Obligatorio.
//   --config RUTA      config.json de la app (de ahí saca idUDT, la URL de la impresora y el servidor)
//   --log RUTA         log de la app (por defecto: Documentos\logs\error.log del usuario)
//   --proceso NOMBRE   ejecutable de la app (por defecto newudt.exe)
//   --nombre TEXTO     nombre fijo en el monitor (si no, se le pone en la pestaña Pantallas)
//   --token TEXTO      solo si el monitor tiene "rum.token"
//   --latido SEG       segundos entre latidos (60)
// Sin dependencias: Node 18 o superior.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.monitor) {
  console.error('Falta --monitor (ej.: --monitor https://test.dts.lat:8091)');
  process.exit(1);
}

const DESTINO = `${args.monitor.replace(/\/$/, '')}/api/beacon`;
const LOG = args.log || path.join(os.homedir(), 'Documents', 'logs', 'error.log');
const PROCESO = (args.proceso || 'newudt.exe').toLowerCase();
const LATIDO_MS = Math.max(15, Number(args.latido) || 60) * 1000;
const LEER_LOG_MS = 15000;
const RELEER_AL_INICIO_MS = 15 * 60e3; // al arrancar, se informa lo que pasó en los últimos 15 min
const inicio = Date.now();

// ---- Configuración de la app (opcional) ----
let configApp = {};
if (args.config) {
  try { configApp = JSON.parse(fs.readFileSync(args.config, 'utf8')); } catch (e) { console.error(`No se pudo leer ${args.config}: ${e.message}`); }
}
const urls = configApp['urls-api'] || {};
const impresora = (() => {
  try {
    const u = new URL(String(urls.WSImpresora || 'ws://localhost:3005/').replace(/^(?!\w+:\/\/)/, 'ws://'));
    return { host: u.hostname, puerto: Number(u.port) || 80 };
  } catch { return { host: 'localhost', puerto: 3005 }; }
})();
// La página "virtual" del tótem apunta al servidor de sus APIs: así el monitor lo agrupa bajo ese servidor.
const pagina = (() => {
  try { return `${new URL(urls['UDT-tramites']).origin}/newudt`; } catch { return 'app://newudt'; }
})();

// ---- Identidad del equipo (se guarda junto al agente) ----
const RUTA_ID = path.join(__dirname, 'agente-totem.id');
let id;
try { id = fs.readFileSync(RUTA_ID, 'utf8').trim(); } catch {}
if (!/^[a-z0-9-]{8,64}$/i.test(id || '')) {
  id = crypto.randomUUID();
  try { fs.writeFileSync(RUTA_ID, id); } catch {}
}

const enmascarar = (t) => String(t).replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]\b/g, '[rut]').replace(/\b\d{7,}\b/g, '[n]');

async function enviar(k, extra = {}) {
  const m = {
    v: 1, k, id, tipo: 'totem', nombre: args.nombre || '', token: args.token || '',
    ids: { ...(configApp.idUDT != null ? { idUDT: String(configApp.idUDT) } : {}), equipo: os.hostname() },
    pagina, ua: `agente-totem · ${os.hostname()} · ${os.type()} ${os.release()}`,
    co: componentes(), abierta: Date.now() - inicio, ...extra,
  };
  try {
    const r = await fetch(DESTINO, { method: 'POST', body: JSON.stringify(m), headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(10000) });
    if (r.status >= 400) console.error(`El monitor rechazó el reporte "${k}": HTTP ${r.status}`);
  } catch (e) {
    console.error(`No se pudo reportar al monitor (${k}): ${e.cause?.code || e.message}`);
  }
}

// ---- Componentes: la app y el servicio de impresión ----
const estado = {
  app: { n: `Aplicación ${PROCESO}`, ok: false, desde: inicio, e: 'sin revisar todavía' },
  impresora: { n: `Servicio de impresión :${impresora.puerto}`, ok: false, desde: inicio, e: 'sin revisar todavía' },
};
const componentes = () => Object.values(estado).map((c) => ({ n: c.n, ok: c.ok, h: Date.now() - c.desde, e: c.ok ? '' : c.e }));

function marcar(c, ok, error) {
  if (c.ok !== ok) { c.ok = ok; c.desde = Date.now(); }
  c.e = error || '';
}

function appCorriendo() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `IMAGENAME eq ${PROCESO}`, '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, out) =>
        resolve(!err && out.toLowerCase().includes(`"${PROCESO}"`)));
    } else {
      execFile('pgrep', ['-if', PROCESO.replace(/\.exe$/, '')], (err) => resolve(!err));
    }
  });
}

function impresoraResponde() {
  return new Promise((resolve) => {
    const s = net.connect({ host: impresora.host, port: impresora.puerto });
    const fin = (ok, e) => { s.destroy(); resolve({ ok, e }); };
    s.setTimeout(3000, () => fin(false, 'no responde en 3 s'));
    s.once('connect', () => fin(true));
    s.once('error', (e) => fin(false, e.code === 'ECONNREFUSED' ? `nada escucha en ${impresora.host}:${impresora.puerto} (servicio detenido)` : e.code || e.message));
  });
}

async function revisarComponentes() {
  const corriendo = await appCorriendo();
  marcar(estado.app, corriendo, corriendo ? '' : 'la aplicación no está abierta');
  const imp = await impresoraResponde();
  marcar(estado.impresora, imp.ok, imp.e);
}

// ---- Log de la app ----
// Formato de LoggerService: [2026-11-26 17:17:35.256] [ERROR  ] mensaje   (hora en UTC)
const LINEA = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(\w+)\s*\] (.*)$/;
let posicion = null;

function leerNuevas() {
  let tam;
  try { tam = fs.statSync(LOG).size; } catch { return []; }
  if (posicion === null) posicion = Math.max(0, tam - 256 * 1024); // primera vez: el final del archivo
  if (tam < posicion) posicion = 0; // el log se rotó
  if (tam === posicion) return [];
  const fd = fs.openSync(LOG, 'r');
  const buf = Buffer.alloc(tam - posicion);
  fs.readSync(fd, buf, 0, buf.length, posicion);
  fs.closeSync(fd);
  const texto = buf.toString('utf8');
  const corte = texto.lastIndexOf('\n') + 1; // una línea a medio escribir se lee la próxima vez
  posicion += Buffer.byteLength(texto.slice(0, corte), 'utf8');
  return texto.slice(0, corte).split(/\r?\n/).map((l) => LINEA.exec(l)).filter(Boolean)
    .map(([, fecha, nivel, msg]) => ({ t: Date.parse(fecha.replace(' ', 'T') + 'Z'), nivel: nivel.toLowerCase(), msg }));
}

async function procesarLog(primeraVez = false) {
  const ahora = Date.now();
  const entradas = leerNuevas().filter((x) => !primeraVez || ahora - x.t < RELEER_AL_INICIO_MS);
  if (entradas.some((x) => /aplicaci[oó]n udt iniciando/i.test(x.msg) && ahora - x.t < LEER_LOG_MS * 2)) {
    await enviar('hola', { carga: {} }); // la app se acaba de abrir (o reiniciar)
  }
  // Un reporte por mensaje distinto, con cuántas veces se repitió y hace cuánto fue la última.
  const grupos = new Map();
  for (const x of entradas.filter((e) => e.nivel === 'error' || e.nivel === 'warning')) {
    const msg = enmascarar(x.msg).slice(0, 300);
    const g = grupos.get(msg) || { msg, nivel: x.nivel, n: 0, t: 0 };
    g.n += 1;
    g.t = Math.max(g.t, x.t);
    grupos.set(msg, g);
  }
  for (const g of [...grupos.values()].sort((a, b) => b.t - a.t).slice(0, 8)) {
    await enviar('error', { e: { m: g.msg, src: path.basename(LOG), nv: g.nivel, n: g.n, h: Math.max(0, ahora - g.t) } });
  }
  if (grupos.size) console.log(`${new Date().toLocaleTimeString('es-CL')}  ${[...grupos.values()].reduce((s, g) => s + g.n, 0)} errores/avisos nuevos del log reportados`);
}

// ---- Ciclo ----
(async () => {
  console.log(`Agente de tótem → ${DESTINO}`);
  console.log(`  log: ${LOG}${fs.existsSync(LOG) ? '' : ' (todavía no existe)'}`);
  console.log(`  app: ${PROCESO} · impresora: ${impresora.host}:${impresora.puerto} · servidor: ${pagina}`);
  await revisarComponentes();
  await enviar('hola', { carga: {} });
  await procesarLog(true);
  setInterval(() => procesarLog().catch((e) => console.error('Error leyendo el log:', e.message)), LEER_LOG_MS);
  setInterval(async () => {
    await revisarComponentes().catch(() => {});
    await enviar('latido');
  }, LATIDO_MS);
})();
