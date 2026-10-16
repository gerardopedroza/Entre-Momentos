# Entre Momentos

Maqueta móvil para compartir recuerdos de boda. **Una boda. Mil historias. Un recuerdo para siempre.**

## Recorrido de invitado

1. Busca su nombre y elige su registro si hay coincidencias.
2. Ve el momento del programa y la cuenta regresiva de cinco minutos.
3. Cuando se habilita, toca **Tomar mi foto** para abrir la cámara o elegir una imagen.
4. Confirma una foto para compartir en ese momento. Las fotos adicionales son para el invitado.
5. Puede descargar la foto a su teléfono desde la pantalla final.

Desde la portada también puede abrir el programa o dejar una frase para los novios. Los mensajes de la demostración se guardan junto con el nombre en el navegador local.

La maqueta muestra una opción de vista previa para probar la cámara sin esperar la cuenta regresiva. La selección de invitado y el límite de una foto se simulan en el navegador; no constituyen una validación real entre dispositivos.

## Coordinación

El panel de coordinación permite editar los momentos, los horarios, los datos del evento y el enlace de Drive que corresponda a esa boda. Estos datos solo se guardan en el navegador usado para la demostración.

El botón de cámara utiliza la selección de imágenes del teléfono y solicita la cámara trasera cuando el navegador lo permite. Tras confirmar, el invitado puede descargar su foto manualmente al dispositivo.

## Conexiones pendientes

Esta versión no carga fotos ni mensajes a Google Drive ni crea carpetas. Pegar el enlace del fotógrafo no autoriza a la web a escribir en Drive. Para el flujo real se debe conectar una integración segura con autorización del fotógrafo y crear una carpeta por evento, una subcarpeta por actividad y guardar ahí las fotos y mensajes con el nombre del invitado. La agenda en vivo, la lista de invitados y la regla de una foto por invitado y momento también deben validarse en un servidor compartido.

## Publicar en Cloudflare Pages

Conecta este repositorio como un proyecto de Pages con:

- Rama de producción: `main`
- Framework preset: `None`
- Comando de compilación: `exit 0`
- Directorio de salida: `.`
- Directorio raíz: vacío (raíz del repositorio)

No necesita dependencias ni compilación. Cloudflare sirve `index.html` directamente.
