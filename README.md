# AWS SAA Study Tracker

Extensión de Chrome para planificar el curso **AWS Certified Solutions Architect - Associate (SAA-C03)** de Adrian Cantrill.

## Instalar en Chrome

1. Abrí `chrome://extensions`.
2. Activá **Modo de desarrollador**.
3. Elegí **Cargar extensión sin empaquetar** y seleccioná esta carpeta.
4. Abrí el curso en [learn.cantrill.io](https://learn.cantrill.io/courses/1820301/lectures/41301626) y recargá la página.
5. Abrí el ícono de la extensión para ver el progreso y cambiar los días del plan.

Si actualizás los archivos de una extensión ya cargada, usá **Recargar** en `chrome://extensions` y también recargá la pestaña del curso.

## Diagnóstico

- Al tocar **Actualizar**, el popup registra la URL de la pestaña activa y si recibió respuesta del content script. Para verlo: clic derecho en el popup → **Inspeccionar** → **Console**.
- En la consola de la página del curso, filtrá por `[AWS SAA Tracker]`: registra si el script se inyectó, qué URL vio, por qué selector/ID no reconoció el curso y cuántas lecciones encontró.
- En `chrome://extensions`, abrí **service worker → Inspeccionar** para ver los snapshots recibidos y errores al guardarlos.
- El popup solicita el permiso `activeTab` al abrirlo desde el botón de la extensión para poder incluir la URL activa en el diagnóstico.

## Cómo calcula el progreso

- El catálogo inicial incluye las 25 secciones y 365 elementos del HTML compartido. Los 340 elementos con duración suman **60 h 42 min** de video.
- El plan inicial es de 90 días. La meta diaria se calcula con el tiempo de video pendiente al crear el plan; al guardar otro plazo, la extensión vuelve a calcularla con el tiempo pendiente en ese momento.
- La ventana también muestra el avance total por duración: horas de video completadas sobre el total, porcentaje, barra y tiempo pendiente.
- Se acredita una lección solo cuando la plataforma la marca como completa. No se registra progreso parcial del reproductor.
- El primer escaneo ocurre al cargar la página del curso. Abrir el popup solo muestra los datos guardados; **Actualizar** vuelve a leer el contenedor a pedido. Mientras la página está abierta, un observador detecta cambios del sidebar y actualiza el progreso automáticamente.
- Las lecciones que ya aparecen completas en el catálogo inicial se toman como progreso histórico. Si la primera lectura encuentra nuevas lecciones completadas desde ese catálogo, también las acredita en el día actual.
- Los cuestionarios y avisos sin duración aparecen en el conteo de lecciones, pero no suman minutos.
- Los datos se guardan localmente en el almacenamiento de Chrome. El confeti aparece sobre la página del curso cuando una lección completada hace que alcances la meta del día.

El script se ejecuta en las rutas `/courses/*` de `learn.cantrill.io`, pero solo procesa el curso SAA-C03 con ID `1820301`; no mezcla otros cursos ni accede a credenciales.
