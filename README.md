# Entre Momentos

Experiencia web responsive para compartir recuerdos de boda. Identidad: **Una boda. Mil historias. Un recuerdo para siempre.**

## Vista previa local

Cloudflare Pages sirve `index.html` desde la raíz del repositorio. Para probarlo localmente, abre `index.html` o sirve la carpeta con un servidor estático.

### Publicar en Cloudflare Pages

Conecta este repositorio de GitHub como un proyecto de Pages y usa:

- Rama de producción: `main`
- Framework preset: `None` / sin framework
- Comando de compilación: `exit 0`
- Directorio de salida: `.`
- Directorio raíz (opciones avanzadas): déjalo vacío para usar la raíz del repositorio

No necesita dependencias ni proceso de compilación. Consulta la [guía oficial de Cloudflare Pages para integración con Git](https://developers.cloudflare.com/pages/get-started/git-integration/) si necesitas los pasos de conexión.

## Estado de esta maqueta

Incluye una invitación responsive, flujo navegable del invitado, panel de coordinación por pestañas, edición de actividades, cálculo de ventanas fotográficas y un esquema de carpetas de Drive. El horario de demostración es el 15 de junio de 2026: una foto se habilita desde cinco minutos antes del inicio y se deja de aceptar cinco minutos antes del fin. El invitado debe confirmar la actividad mostrada antes de habilitar el selector de foto.

Para recorrer el demo: pulsa **Formar parte**, escribe “Ana” y elige una de las dos coincidencias, confirma la actividad y selecciona una imagen. También puedes elegir **Continuar como invitado de prueba**. Para configurar, abre **Vista de coordinación** y cambia entre las pestañas; el programa y el enlace de Drive se conservan en el navegador cuando el almacenamiento local está disponible.

El programa y el enlace de Drive se guardan en el almacenamiento local del navegador. La maqueta no crea carpetas ni carga imágenes en Drive: la cuenta del fotógrafo requiere una integración con autorización segura. Tampoco se ha conectado el programa externo de coordinación. La lista de invitados, autenticación, almacenamiento permanente, permisos y sincronización entre dispositivos requieren un backend. La búsqueda utiliza registros de demostración y el formulario no envía datos personales a ningún servidor.

## Siguiente etapa técnica

Definir el acceso de solo escritura de invitados y la cuenta destino del fotógrafo en Google Drive; conectar de manera segura el servicio de Drive para crear una carpeta de evento y una por actividad; conectar la agenda real del coordinador con actualizaciones fiables; y validar en servidor las ventanas, identidad y actividad elegida antes de recibir fotos reales.
