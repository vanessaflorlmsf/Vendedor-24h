import { pool, q } from "./db.js";
import { sendText } from "./whatsapp.js";

export const brl = (c) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Preço e estoque vêm SEMPRE do banco, nunca do que o modelo ou o cliente disseram.
export async function createOrder(tenant, customer, items) {
  if (!Array.isArray(items) || !items.length) throw new Error("Pedido vazio");
  const { rows: prods } = await q(
    "select * from products where tenant_id=$1 and active and id = any($2::uuid[])",
    [tenant.id, items.map((i) => i.product_id)]
  );
  const lines = items.map((it) => {
    const p = prods.find((x) => x.id === it.product_id);
    const qty = Math.floor(Number(it.quantity));
    if (!p) throw new Error("Produto não encontrado");
    if (!(qty > 0) || qty > 20) throw new Error("Quantidade inválida");
    if (p.stock !== null && p.stock < qty) throw new Error(`Estoque insuficiente de ${p.name} (restam ${p.stock})`);
    return { p, qty };
  });
  const total = lines.reduce((s, l) => s + l.p.price_cents * l.qty, 0);
  const c = await pool.connect();
  try {
    await c.query("begin");
    const { rows: [order] } = await c.query(
      "insert into orders(tenant_id,customer_id,total_cents) values($1,$2,$3) returning *",
      [tenant.id, customer.id, total]
    );
    for (const { p, qty } of lines)
      await c.query(
        "insert into order_items(order_id,product_id,name,qty,unit_price_cents) values($1,$2,$3,$4,$5)",
        [order.id, p.id, p.name, qty, p.price_cents]
      );
    await c.query("commit");
    return { order, lines };
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

// Idempotente: só age se o pedido ainda estiver pendente.
export async function confirmPaid(orderId, payment) {
  const c = await pool.connect();
  let order;
  try {
    await c.query("begin");
    const { rows: [o] } = await c.query("select * from orders where id=$1 for update", [orderId]);
    if (!o || o.status !== "pending") { await c.query("rollback"); return; }
    if (payment && (String(payment.external_reference) !== String(o.id) ||
      Number(payment.transaction_amount) !== Number(o.total_cents) / 100 || payment.currency_id !== "BRL" ||
      (o.mp_payment_id && String(o.mp_payment_id) !== String(payment.id)))) {
      await c.query("rollback"); throw new Error("Pagamento não corresponde ao pedido");
    }
    const { rows: items } = await c.query("select * from order_items where order_id=$1", [orderId]);
    for (const it of items) {
      const upd = await c.query("update products set stock=stock-$1 where id=$2 and stock is not null and stock >= $1", [it.qty, it.product_id]);
      if (!upd.rowCount) {
        const { rows: [p] } = await c.query("select stock from products where id=$1 for update", [it.product_id]);
        if (!p || p.stock !== null) { await c.query("rollback"); throw new Error(`Estoque insuficiente para confirmar pedido ${o.id}`); }
      }
    }
    await c.query("update orders set status='paid', paid_at=now() where id=$1", [orderId]);
    await c.query("commit");
    order = o;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  const { rows: [t] } = await q("select * from tenants where id=$1", [order.tenant_id]);
  const { rows: [cu] } = await q("select * from customers where id=$1", [order.customer_id]);
  const num = order.id.slice(0, 8);
  await sendText(t, cu.phone, `Pagamento confirmado! ✅ Pedido #${num} de ${brl(order.total_cents)}. Já vamos separar o seu pedido.`);
  // Aviso ao lojista: fora da janela de 24h da Meta exige modelo de mensagem aprovado.
  if (t.owner_phone) await sendText(t, t.owner_phone, `💰 Pedido pago #${num} (${brl(order.total_cents)}) do cliente ${cu.phone}.`).catch(() => {});
}
