// Hook de Stop: commitea lo que haya y pushea a main.
// El mensaje sale de .git/CLAUDE_COMMIT_MSG (lo escribe Claude antes de terminar; ver CLAUDE.md).
// Si no está, se arma uno con los archivos tocados.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const msgFile = path.join(root, ".git", "CLAUDE_COMMIT_MSG");

git("add", "-A");
const files = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);
if (files.length > 0) {
  let msg = fs.existsSync(msgFile) ? fs.readFileSync(msgFile, "utf8").trim() : "";
  if (!msg) {
    const names = files.slice(0, 4).map((f) => path.basename(f)).join(", ");
    const more = files.length > 4 ? ` y ${files.length - 4} más` : "";
    msg = `Cambios en ${names}${more}\n\n${git("diff", "--cached", "--stat").trimEnd()}`;
  }
  git("commit", "-m", msg);
}
fs.rmSync(msgFile, { force: true });
git("push", "origin", "main");
