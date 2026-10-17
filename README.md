# Entre Momentos

Web móvil para que los invitados compartan una foto y una dedicatoria en cada momento de la boda. **Una boda. Mil historias. Un recuerdo para siempre.** No requiere instalar una aplicación.

## Enlaces y accesos

- `/admin.html`: administración privada. Al iniciar sesión muestra, para cada evento, el enlace de invitados y el enlace STAFF, con botones para copiar. También permite registrar lugares y crear eventos con su propia carpeta de Google Drive.
- El enlace de invitados usa el formato `/l/{lugar}?event={evento}`. El invitado puede buscar con su nombre, apellido o ambos; si hay coincidencias, elige su nombre en la lista.
- El enlace STAFF incluye una clave aleatoria limitada a un evento. Abre directamente el panel de ese evento, sin contraseña. La administración puede renovarlo; al hacerlo, el enlace anterior deja de funcionar.
- El enlace discreto «Administración y STAFF» del final de la página inicial abre ambas opciones. Administración pide usuario y contraseña; STAFF permite seleccionar lugar y evento y comprobar el enlace STAFF de ese evento. También ofrece una vista de demostración.
- `/staff.html` sin clave muestra el selector de lugar y evento. Para acceder a datos reales, se pega el enlace STAFF que comparte Administración; el enlace directo generado por Administración sigue abriendo el evento correspondiente.

Los enlaces de eventos en preparación se pueden copiar antes del evento, pero solo funcionarán cuando el evento esté activo. La URL de Drive se captura por evento para admitir que cada boda use una carpeta distinta.

## Qué hace la plataforma

- La agenda abre la carga de fotos cinco minutos antes de cada actividad y la cierra cinco minutos antes de que termine. El servidor decide a qué actividad corresponde la foto y si participa en una dinámica.
- Cada invitado puede enviar una foto por actividad. Una foto enviada fuera del horario todavía se conserva para el álbum, pero no participa en esa dinámica.
- El navegador solo mantiene temporalmente la imagen durante la selección y vista previa. El archivo se manda a la carpeta de Drive del evento y no se guarda en la web.
- Las dedicatorias se asocian con el nombre de quien las escribió y se sincronizan a una hoja de cálculo de ese evento.
- El enlace STAFF muestra resultados de dinámicas y permite registrar la entrega de premios.

## Regla de diseño para todas las pantallas

- La experiencia prioriza el teléfono y cabe en una sola pantalla, sin desplazamiento.
- Se aprovecha el alto disponible: los elementos se distribuyen para evitar grandes espacios vacíos.
- Si hace falta espacio para la acción principal, se compactan u ocultan temporalmente elementos secundarios antes de reducir el carrusel o los controles principales.

## Configuración necesaria para operar en Cloudflare

El repositorio incluye páginas estáticas, Cloudflare Pages Functions y migraciones de esquema en `migrations/`. Para habilitar operaciones reales, el proyecto de Pages debe tener un binding D1 llamado `DB` y ejecutar en orden `0001_platform.sql`, `0002_guest_nickname.sql` y `0003_activity_description.sql`. Estas agregan las tablas principales, el apodo opcional del invitado y la descripción opcional de cada actividad. Configura también estas variables secretas en Pages:

- `ADMIN_USERNAME` y `ADMIN_PASSWORD_HASH`: acceso a administración.
- `SESSION_PEPPER`: valor secreto aleatorio para proteger sesiones y códigos de invitación.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` y `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: cuenta de servicio que crea carpetas y hojas, y carga fotos.

Las fotos que envían los invitados se guardan en la carpeta individual de Google Drive indicada para ese evento, dentro de subcarpetas por actividad. La cuenta de servicio de Google debe tener permiso para editar esa carpeta; el enlace por sí solo no concede acceso a la cuenta de servicio. Las fotografías de portada y las imágenes de referencia de actividades se guardan en un binding R2 de Cloudflare llamado `EVENT_MEDIA`, y se sirven desde `/api/media/{id}` para que cualquier persona que abra la invitación pueda verlas. Configura el binding `EVENT_MEDIA` en la sección de variables y bindings de Cloudflare Pages; R2 es necesario para esas imágenes aunque Drive ya esté conectado.

## Publicar

Conecta este repositorio con Cloudflare Pages usando la rama de producción `main`, preset `None`, comando de compilación vacío y directorio de salida `.`. Las Pages Functions atienden `/api/*`; la migración y los secretos descritos arriba son necesarios para el modo real. Sin ellos, la vista de demostración visual sirve para recorrer el diseño, pero no crea eventos ni guarda fotos.
