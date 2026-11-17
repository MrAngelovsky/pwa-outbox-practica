const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => console.log('[SW] Registrado con scope:', reg.scope))
    .catch((err) => console.error('[SW] Error al registrar:', err));

  // Mitad receptora del puente sw.js -> app.js
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });
}

// Indicador de red
function actualizarIndicadorRed() {
  const badge = document.getElementById('badge-red');
  if (navigator.onLine) {
    badge.textContent = 'En Línea';
    badge.className = 'badge online';
  } else {
    badge.textContent = 'Sin Conexión';
    badge.className = 'badge offline';
  }
}

// READ: dibujar la cola de IndexedDB en pantalla
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      const lista = document.getElementById('lista-outbox');
      lista.innerHTML = '';

      if (registros.length === 0) {
        const vacio = document.createElement('li');
        vacio.textContent = 'La bandeja está vacía.';
        lista.appendChild(vacio);
        return;
      }

      registros.forEach((item) => {
        const li = document.createElement('li');

        const info = document.createElement('div');
        const titulo = document.createElement('strong');
        titulo.textContent = item.titulo;
        const hora = document.createElement('div');
        hora.className = 'hora';
        hora.textContent = new Date(item.fechaCreacion).toLocaleTimeString();
        info.appendChild(titulo);
        info.appendChild(hora);

        const estado = document.createElement('span');
        estado.className = `estado ${item.estado}`;
        estado.textContent = item.estado;

        li.appendChild(info);
        li.appendChild(estado);
        lista.appendChild(li);
      });
    })
    .catch((error) => console.error('[UI] Error al leer IndexedDB:', error));
}

// CREATE: envío resiliente con fallback a IndexedDB (Patrón Outbox)
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datosFormulario)
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      // Con red: bitácora local como 'sincronizado'
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => {
          // Si el navegador soporta Background Sync, delegamos el reenvío al SW
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            return navigator.serviceWorker.ready
              .then((registro) => {
                console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
                return registro.sync.register('sync-reportes');
              })
              .catch((err) => console.warn('[Outbox] No se pudo registrar el sync:', err));
          }
        });
    })
    .then(() => renderizarColaOutbox());
}

// 
// UPDATE: reenvío desde la UI para navegadores sin SyncManager
function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio);
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => console.error('[Outbox] Error durante la sincronización masiva:', error));
}

// Eventos de red
window.addEventListener('online', () => {
  actualizarIndicadorRed();
  // Degradación elegante: Solo sincronizar desde UI si el navegador NO soporta Background Sync (ej. Safari/iOS)
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

// Formulario
document.getElementById('form-incidencia').addEventListener('submit', (e) => {
  e.preventDefault();

  const form = e.target;
  const datosFormulario = {
    titulo: document.getElementById('titulo').value.trim(),
    descripcion: document.getElementById('descripcion').value.trim()
  };

  procesarEnvioReporte(datosFormulario)
    .then(() => form.reset())
    .catch((error) => console.error('[UI] Error al procesar el reporte:', error));
});

// DELETE: purgar registros ya sincronizados
document.getElementById('btn-purgar').addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(sincronizados.map((item) => eliminarRegistro(item.id)));
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => console.error('[UI] Error al purgar:', error));
});

// Carga inicial: rescata de IndexedDB lo que quedó guardado
actualizarIndicadorRed();
renderizarColaOutbox();
