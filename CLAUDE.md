# Pega y Cobra

## Commits

Un hook de Stop (`.claude/hooks/commit-push.cjs`) commitea y pushea a `main` al terminar cada turno.
No commitees a mano. Antes de terminar un turno en el que tocaste archivos, escribí el mensaje del
commit en `.git/CLAUDE_COMMIT_MSG`: una primera línea corta (hasta ~70 caracteres, en castellano,
que diga qué cambió) y, si hace falta, una línea en blanco y dos o tres renglones de detalle. El hook
lo usa y lo borra; si el archivo no está, arma un mensaje genérico con los archivos tocados.
