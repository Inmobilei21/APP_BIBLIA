# app-biblia — Santa Biblia con comentarios

Aplicación web para leer la **Biblia completa (Reina-Valera 1909, dominio público: 66 libros, 31.102 versículos)**
y comentar cada versículo.

## Funciones
- Cada versículo es una sección interactiva. Al pulsarlo aparecen (discretos, debajo): **Añadir comentario** (o **Editar** si ya hay uno), **Compartir** y **Discusión**.
- El comentario se muestra justo debajo del texto del versículo, con un punto dorado en la esquina. Para borrarlo, se edita y se deja vacío.
- **Discusión**: un foro por versículo donde cualquiera puede escribir con su nombre (se guardan nombre y fecha).
- **Menú lateral**:
  1. *La Biblia*: libros (Antiguo y Nuevo Testamento) y capítulos.
  2. *Índice de comentarios*: solo los libros con comentarios, desplegables por libro → versículo → comentario, con enlace al versículo.
  3. *Discusión*: los versículos con conversación abierta, con enlace a cada discusión.
- Compartir usa el menú nativo del móvil (o copia al portapapeles).
- Instalable en el móvil (icono: cruz dorada sobre fondo negro).

## Ejecutar en local
```bash
npm install
npm start            # http://localhost:3000
```
Sin `DATABASE_URL`, los comentarios se guardan en `data/comments.json`.

## Despliegue (Railway)
Con un servicio PostgreSQL enlazado (`DATABASE_URL`), los comentarios se guardan en la base de datos
(la tabla se crea sola al arrancar).

## API
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/comments` | Todos los comentarios |
| POST | `/api/comments` | `{book, chapter, verse, text}` |
| PUT | `/api/comments/:id` | `{text}` |
| DELETE | `/api/comments/:id` | Borrar |
| GET | `/api/posts` | Mensajes de discusión |
| POST | `/api/posts` | `{book, chapter, verse, name, text}` |

## Texto bíblico
`public/data` se genera con `npm run build:bible` a partir del JSON SpaRV de
[scrollmapper/bible_databases](https://github.com/scrollmapper/bible_databases).
