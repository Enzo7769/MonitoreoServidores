// Incidentes agrupados por causa raíz.
//
// Después de cada revisión, monitor.js arma los "grupos de falla" (por ejemplo
// "Torax: servidor sin respuesta" o "Torax: MongoDB no disponible (5 APIs)") y se los
// pasa a evaluar(). Este módulo abre, actualiza y cierra los incidentes, los guarda en
// MongoDB (colección "incidentes") y emite eventos para las alertas:
//   'abierto' (incidente), 'resuelto' (incidente), 'actualizado' (incidente)

const EventEmitter = require('events');

class Incidentes extends EventEmitter {
  constructor(almacen) {
    super();
    this.almacen = almacen;
    this.activos = new Map(); // clave del grupo -> incidente
  }

  // Al arrancar, retoma los incidentes que quedaron abiertos (para no duplicarlos).
  async cargar() {
    for (const inc of await this.almacen.incidentesActivos()) {
      if (!this.activos.has(inc.clave)) this.activos.set(inc.clave, inc);
    }
  }

  // grupos: Map clave -> { servidor, alcance, nivel, titulo, tipo, causa, sugerencia, apis[], persistir }
  // Las llamadas se encolan: las revisiones y el chequeo de pantallas (cada 30 s) no se pisan.
  evaluar(grupos, ahora = Date.now()) {
    const turno = (this.cola || Promise.resolve()).then(() => this.evaluarAhora(grupos, ahora));
    this.cola = turno.catch(() => {});
    return turno;
  }

  async evaluarAhora(grupos, ahora) {
    const cambios = [];

    for (const [clave, g] of grupos) {
      const actual = this.activos.get(clave);
      if (!actual) {
        const inc = { id: `${clave}|${ahora}`, clave, ...g, inicio: ahora, fin: null, estado: 'activo', actualizado: ahora };
        this.activos.set(clave, inc);
        cambios.push(['abierto', inc]);
      } else if (actual.titulo !== g.titulo || actual.nivel !== g.nivel || actual.apis.join() !== g.apis.join() || actual.tipo !== g.tipo) {
        Object.assign(actual, g, { actualizado: ahora });
        cambios.push(['actualizado', actual]);
      }
    }

    for (const [clave, inc] of this.activos) {
      if (grupos.has(clave)) continue;
      this.activos.delete(clave);
      Object.assign(inc, { fin: ahora, estado: 'resuelto', actualizado: ahora });
      cambios.push(['resuelto', inc]);
    }

    for (const [evento, inc] of cambios) {
      if (inc.persistir !== false) await this.almacen.guardarIncidente(inc).catch(() => {});
      this.emit(evento, inc);
    }
    return cambios;
  }

  lista() {
    return [...this.activos.values()].sort((a, b) => (a.nivel === 'error' ? 0 : 1) - (b.nivel === 'error' ? 0 : 1) || a.inicio - b.inicio);
  }
}

module.exports = Incidentes;
