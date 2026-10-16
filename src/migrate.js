import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { q } from "./db.js";

// Cria as tabelas na primeira inicialização (só se ainda não existirem).
export async function migrate() {
  const { rows } = await q("select to_regclass('public.tenants') as t");
  if (rows[0].t) {
    console.log("Banco já possui as tabelas.");
  } else {
    const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));
    const sql = await readFile(schemaPath, "utf8");
    await q(sql);
    console.log("Tabelas criadas com sucesso.");
  }
  await seedTenant();
}

// Cadastra (ou atualiza) a loja a partir de variáveis de ambiente SEED_*.
// Só roda se SEED_WA_PHONE_ID e SEED_API_KEY estiverem definidas.
async function seedTenant() {
  const {
    SEED_STORE_NAME,
    SEED_SPECIALTY,
    SEED_POLICIES,
    SEED_WA_PHONE_ID,
    SEED_WA_TOKEN,
    SEED_OWNER_PHONE,
    SEED_API_KEY,
  } = process.env;

  if (!SEED_WA_PHONE_ID || !SEED_API_KEY) return;

  await q(
    `insert into tenants
       (name, specialty, policies, wa_phone_number_id, wa_access_token,
        owner_phone, api_key_hash)
     values ($1, $2, $3, $4, $5, $6, encode(digest($7, 'sha256'), 'hex'))
     on conflict (wa_phone_number_id) do update set
       name = excluded.name,
       specialty = excluded.specialty,
       policies = excluded.policies,
       wa_access_token = excluded.wa_access_token,
       owner_phone = excluded.owner_phone,
       api_key_hash = excluded.api_key_hash`,
    [
      SEED_STORE_NAME || "Minha Loja",
      SEED_SPECIALTY || "moda feminina e acessórios",
      SEED_POLICIES || "",
      SEED_WA_PHONE_ID,
      SEED_WA_TOKEN || null,
      SEED_OWNER_PHONE || null,
      SEED_API_KEY,
    ]
  );
  console.log("Loja cadastrada/atualizada a partir das variáveis SEED_*.");
}
