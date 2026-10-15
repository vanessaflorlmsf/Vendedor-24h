import express from "express";
import crypto from "node:crypto";
import { q } from "./db.js";

const ah = (f) => (req, res, next) => f(req, res, next).catch(next);

// MVP: chave por lojista no cabeçalho x-api-key. Na fase 3 troque por login (Supabase Auth, Clerk, etc.).
export function adminRouter() {
  const r = express.Router();
  r.use(ah(async (req, res, next) => {
    const key = req.get("x-api-key");
    if (!key) return res.sendStatus(401);
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const { rows: [t] } = await q("select * from tenants where api_key_hash=$1 and active", [hash]);
    if (!t) return res.sendStatus(401);
    req.tenant = t; next();
  }));

  r.get("/products", ah(async (req, res) =>
    res.json((await q("select * from products where tenant_id=$1 order by name", [req.tenant.id])).rows)));

  r.post("/products", ah(async (req, res) => {
    const { name, price_cents, description = "", stock = null, image_url = null } = req.body;
    if (!name || !Number.isInteger(price_cents)) return res.status(400).json({ error: "name e price_cents obrigatórios" });
    const { rows: [p] } = await q(
      "insert into products(tenant_id,name,price_cents,description,stock,image_url) values($1,$2,$3,$4,$5,$6) returning *",
      [req.tenant.id, name, price_cents, description, stock, image_url]);
    res.status(201).json(p);
  }));

  r.patch("/products/:id", ah(async (req, res) => {
    const allowed = ["name", "price_cents", "description", "stock", "image_url", "active"];
    const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!keys.length) return res.status(400).json({ error: "nada para atualizar" });
    const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(",");
    const { rows: [p] } = await q(`update products set ${sets} where id=$1 and tenant_id=$2 returning *`,
      [req.params.id, req.tenant.id, ...keys.map((k) => req.body[k])]);
    p ? res.json(p) : res.sendStatus(404);
  }));

  r.get("/orders", ah(async (req, res) => res.json((await q(
    `select o.*, c.phone, (select json_agg(json_build_object('name',name,'qty',qty,'unit_price_cents',unit_price_cents))
       from order_items where order_id=o.id) as items
     from orders o join customers c on c.id=o.customer_id where o.tenant_id=$1 order by o.created_at desc limit 200`,
    [req.tenant.id])).rows)));

  r.get("/conversations", ah(async (req, res) => res.json((await q(
    `select v.id, v.status, v.updated_at, c.phone, c.name from conversations v join customers c on c.id=v.customer_id
     where v.tenant_id=$1 order by v.updated_at desc limit 100`, [req.tenant.id])).rows)));

  r.get("/conversations/:id/messages", ah(async (req, res) => res.json((await q(
    `select m.role, m.content, m.created_at from messages m join conversations v on v.id=m.conversation_id
     where v.id=$1 and v.tenant_id=$2 order by m.created_at`, [req.params.id, req.tenant.id])).rows)));

  // Devolve a conversa para o robô depois que a pessoa da loja terminou.
  r.post("/conversations/:id/resume", ah(async (req, res) => {
    await q("update conversations set status='bot' where id=$1 and tenant_id=$2", [req.params.id, req.tenant.id]);
    res.sendStatus(204);
  }));
  return r;
}
