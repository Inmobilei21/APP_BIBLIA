# Evangelio

App para leer y comentar los libros de cabecera: **Evangelio según Lucas** (parte I) y
**Hechos de los apóstoles** (parte II). El texto lo introduce el propietario, de su propia edición.

## Funciones
- **Texto propio**: en un capítulo vacío, «Añadir el texto del capítulo»; después, «Editar capítulo» al pie.
  Cada capítulo puede tener un **nombre**. En el editor:
  - una línea que empieza por un número abre ese versículo (se admiten saltos); dentro de una línea, el número siguiente también;
  - `# Texto` → subtítulo propio (comentable);
  - `I. Texto`, `II. Texto`… → división del propio evangelio (comentable, no se marca como versículo).
  El editor avisa de huecos en la numeración y de posibles versículos unidos. Un versículo suelto se corrige con «Editar texto».
- **Comentarios**: uno por versículo, subtítulo o división, ocultos; un punto dorado indica que existe y aparece al pulsar.
  El cuadro crece al escribir; guardar no lo cierra; al cerrar se vuelve al principio del versículo.
  Los comentarios y mensajes de textos eliminados se ocultan, y al guardar el capítulo se pueden borrar.
- **Marcar aquí / Quitar marca**: cinta roja de misal; «Seguir leyendo», al principio del menú, lleva a ella.
- **Discusión**: foro por versículo (nombre, fecha y mensaje).
- **Menú lateral** (botón o deslizando a la derecha): Seguir leyendo · Libros (desplegables → capítulos) ·
  Índice de comentarios · Discusión · Novedades.
- **Novedades**: tras cada actualización se muestran los cambios; con la app abierta aparece «Actualizar».

## Ejecutar en local
```bash
npm install
npm start            # http://localhost:3000
```
Sin `DATABASE_URL`, los datos se guardan en `data/`. En Railway, con PostgreSQL enlazado, en la base de datos
(las tablas se crean solas al arrancar).

## API
| Método | Ruta | Descripción |
|---|---|---|
| GET / PUT | `/api/text/:libro/:cap` | Capítulo `{name, blocks: [{t:'v',n,text} \| {t:'h',text} \| {t:'d',text}]}`; PUT admite `purge` |
| PUT | `/api/text/:libro/:cap/:n` | Texto de un versículo `{text}` |
| GET | `/api/text-summary` | Capítulos con texto |
| GET / POST | `/api/comments` | Comentarios `{book, chapter, verse, target?, text}` (target `t0`… = subtítulo antes del versículo) |
| PUT / DELETE | `/api/comments/:id` | Editar `{text}` / borrar |
| GET / PUT / DELETE | `/api/bookmark` | Marca «Seguir leyendo» |
| GET / POST | `/api/posts` | Discusión `{book, chapter, verse, name, text}` |

Libros (`public/books.json`): Lucas = 42, Hechos = 44.

## Publicar una actualización
Añade una entrada al principio de `public/changelog.json` con un número de versión mayor.
