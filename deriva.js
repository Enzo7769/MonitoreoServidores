// Diferencias entre servidores ("deriva").
// Los servidores del mismo tipo deberían tener las mismas APIs. Si casi todos tienen una
// API y a uno le falta, probablemente esa API no está corriendo ahí, y como descubrir.js
// no la encontró, el monitor ni siquiera la vigila. Esto lo deja a la vista.

const PROPORCION_ESPERADA = 0.6; // una API es "esperada" si la tiene al menos el 60 % de los servidores del grupo
const MINIMO_SERVIDORES = 3;     // con menos servidores no hay base para comparar

// servidores: [{ nombre, tipo, puertos[], gateway? }]
// nombrePuerto(puerto) / nombreServicio(servicio): para mostrar nombres legibles
// Devuelve Map nombreServidor -> { faltantes: [{ puerto | servicio, nombre, cuantos, de }], extras: [...] }
function calcularDeriva(servidores, nombrePuerto, nombreServicio) {
  const resultado = new Map();
  const grupos = new Map();
  for (const s of servidores) {
    if (!grupos.has(s.tipo)) grupos.set(s.tipo, []);
    grupos.get(s.tipo).push(s);
  }

  for (const grupo of grupos.values()) {
    if (grupo.length < MINIMO_SERVIDORES) continue;
    const comparar = (elementosDe, crear) => {
      const conteo = new Map();
      for (const s of grupo) for (const e of elementosDe(s)) conteo.set(e, (conteo.get(e) || 0) + 1);
      const esperados = [...conteo].filter(([, n]) => n / grupo.length >= PROPORCION_ESPERADA).map(([e]) => e);
      for (const s of grupo) {
        const propios = new Set(elementosDe(s));
        const r = resultado.get(s.nombre) || { faltantes: [], extras: [] };
        for (const e of esperados) if (!propios.has(e)) r.faltantes.push(crear(e, conteo.get(e), grupo.length));
        for (const e of propios) if (conteo.get(e) / grupo.length < PROPORCION_ESPERADA && conteo.get(e) === 1) r.extras.push(crear(e, 1, grupo.length));
        resultado.set(s.nombre, r);
      }
    };
    comparar((s) => s.puertos, (puerto, cuantos, de) => ({ puerto, nombre: nombrePuerto(puerto), cuantos, de }));
    comparar((s) => s.gateway?.servicios || [], (servicio, cuantos, de) => ({ servicio, nombre: nombreServicio(servicio), cuantos, de }));
  }

  for (const [nombre, r] of resultado) if (!r.faltantes.length && !r.extras.length) resultado.delete(nombre);
  return resultado;
}

module.exports = { calcularDeriva };
