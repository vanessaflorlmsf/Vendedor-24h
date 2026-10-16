import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { q } from "./db.js";

// Cria as tabelas na primeira inicialização (só se ainda não existirem).
export async function migrate() {
  const { rows } = await q("select to_regclass('public.tenants') as t");
  if (rows[0].t) {
    console.log("Banco já possui as tabelas.");
    return;
  }
  const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));
  const sql = await readFile(schemaPath, "utf8");
  await q(sql);
  console.log("Tabelas criadas com sucesso.");
}
