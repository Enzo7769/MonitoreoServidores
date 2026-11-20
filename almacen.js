// Guarda y lee el historial de revisiones en MongoDB.
//
// Base "monitorAPIs" (configurable), colección "revisiones": un documento por ciclo
//   { t: Date, d: { "servidor|id": [nivel, ms] } }
// Un índice TTL borra solo los documentos más antiguos que `retencionDias`.
//
// Si Mongo no responde al guardar, el ciclo queda en logs/pendientes.jsonl y se
// sube en el siguiente intento, así no se pierden datos por una caída de Mongo.

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const RUTA_PENDIENTES = path.join(__dirname, 'logs', 'pendientes.jsonl');

let cliente = null;
let coleccion = null;
let incidentes = null; // colección "incidentes": uno por falla agrupada, con inicio y fin exactos

async function conectar({ mongoUri, mongoDb = 'monitorAPIs', retencionDias = 30 }) {
  cliente = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
  await cliente.connect();
  coleccion = cliente.db(mongoDb).collection('revisiones');

  // TTL: si cambió la retención, se actualiza el índice existente.
  const segundos = retencionDias * 86400;
  const indices = await coleccion.indexes().catch(() => []);
  const ttl = indices.find((i) => i.name === 't_ttl');
  if (!ttl) {
    await coleccion.createIndex({ t: 1 }, { name: 't_ttl', expireAfterSeconds: segundos });
  } else if (ttl.expireAfterSeconds !== segundos) {
    await cliente.db(mongoDb).command({ collMod: 'revisiones', index: { name: 't_ttl', expireAfterSeconds: segundos } });
  }

  incidentes = cliente.db(mongoDb).collection('incidentes');
  await incidentes.createIndex({ inicio: -1 });
  await incidentes.createIndex({ estado: 1 });
  // Los incidentes resueltos se guardan un año (los activos no tienen "fin" y no expiran).
  await incidentes.createIndex({ fin: 1 }, { name: 'fin_ttl', expireAfterSeconds: 365 * 86400 });

  await subirPendientes();
}

// ---- Incidentes ----------------------------------------------------------------

const aDocumento = (inc) => {
  const { id, persistir, ...resto } = inc;
  return { ...resto, inicio: new Date(inc.inicio), fin: inc.fin ? new Date(inc.fin) : null, actualizado: new Date(inc.actualizado) };
};
const desdeDocumento = (doc) => ({
  ...doc, id: doc._id, inicio: doc.inicio.getTime(), fin: doc.fin ? doc.fin.getTime() : null, actualizado: doc.actualizado?.getTime(),
});

async function guardarIncidente(inc) {
  if (!incidentes) return;
  await incidentes.updateOne({ _id: inc.id }, { $set: aDocumento(inc) }, { upsert: true });
}

async function incidentesActivos() {
  if (!incidentes) return [];
  return (await incidentes.find({ estado: 'activo' }).toArray()).map(desdeDocumento);
}

// Incidentes que se cruzan con el periodo [desde, ahora]: empezaron después o siguen/terminaron después.
async function leerIncidentes(desde, { servidor } = {}) {
  if (!incidentes) return null;
  const filtro = { $or: [{ inicio: { $gte: new Date(desde) } }, { fin: { $gte: new Date(desde) } }, { estado: 'activo' }] };
  if (servidor) filtro.servidor = servidor;
  return (await incidentes.find(filtro).sort({ inicio: -1 }).limit(500).toArray()).map(desdeDocumento);
}

async function subirPendientes() {
  if (!fs.existsSync(RUTA_PENDIENTES)) return;
  const docs = fs.readFileSync(RUTA_PENDIENTES, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { const c = JSON.parse(l); return { t: new Date(c.t), d: c.d }; } catch { return null; } })
    .filter(Boolean);
  if (docs.length) await coleccion.insertMany(docs, { ordered: false });
  fs.unlinkSync(RUTA_PENDIENTES);
  if (docs.length) console.log(`Subidos ${docs.length} ciclos pendientes a MongoDB`);
}

async function guardarCiclo(t, d) {
  try {
    if (!coleccion) throw new Error('sin conexión a MongoDB');
    await subirPendientes();
    await coleccion.insertOne({ t: new Date(t), d });
  } catch (e) {
    console.error(`No se pudo guardar en MongoDB (${e.message}); queda en ${RUTA_PENDIENTES}`);
    fs.mkdirSync(path.dirname(RUTA_PENDIENTES), { recursive: true });
    fs.appendFileSync(RUTA_PENDIENTES, JSON.stringify({ t, d }) + '\n');
  }
}

// Devuelve [{ t (ms), d }] entre desde y hasta, ordenados por fecha.
async function leerCiclos(desde, hasta = Date.now()) {
  if (!coleccion) return [];
  const docs = await coleccion
    .find({ t: { $gte: new Date(desde), $lte: new Date(hasta) } }, { projection: { _id: 0, t: 1, d: 1 } })
    .sort({ t: 1 })
    .toArray();
  return docs.map((doc) => ({ t: doc.t.getTime(), d: doc.d }));
}

const conectado = () => !!coleccion;

async function cerrar() {
  if (cliente) await cliente.close();
}

module.exports = {
  conectar, guardarCiclo, leerCiclos, conectado, cerrar, guardarIncidente, incidentesActivos, leerIncidentes,
};
