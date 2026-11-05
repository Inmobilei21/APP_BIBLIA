# app-biblia — Santa Biblia con comentarios

Aplicación web para leer la **Biblia completa (Reina-Valera 1909, dominio público: 66 libros, 31.102 versículos)**
y comentar cada versículo.

## Funciones
- Cada versículo es una sección interactiva. Al pulsarlo aparecen: **Añadir comentario**, **Compartir** e **Imprimir PDF**.
- Al añadir un comentario se elige el autor (**MMF** o **LFD**); se guarda la fecha automáticamente.
- Los versículos con comentarios muestran un **punto verde** en la esquina superior derecha (con el número si hay varios).
  Al volver a pulsarlos se ven sus comentarios (se pueden editar o borrar).
- **Menú lateral**:
  1. *La Biblia*: libros (Antiguo y Nuevo Testamento) y capítulos.
  2. *Índice de comentarios*: solo los libros con comentarios, desplegables por libro → versículo → comentarios, con enlace al versículo.
- Compartir usa el menú nativo del móvil (o copia al portapapeles); Imprimir PDF genera una hoja con el versículo y sus comentarios.
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
| POST | `/api/comments` | `{book, chapter, verse, author, text}` |
| PUT | `/api/comments/:id` | `{author, text}` |
| DELETE | `/api/comments/:id` | Borrar |

## Texto bíblico
`public/data` se genera con `npm run build:bible` a partir del JSON SpaRV de
[scrollmapper/bible_databases](https://github.com/scrollmapper/bible_databases).
