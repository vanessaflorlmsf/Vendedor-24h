import crypto from "node:crypto";

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v21.0"}`;

// Confere que a requisição veio mesmo da Meta (HMAC do corpo bruto).
export function verifySignature(rawBody, header) {
  if (!header || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function post(tenant, payload) {
  const res = await fetch(`${GRAPH}/${tenant.wa_phone_number_id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tenant.wa_access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${await res.text()}`);
}

export const sendText = (tenant, to, body) => post(tenant, { to, type: "text", text: { body, preview_url: false } });
export const sendImage = (tenant, to, link, caption) => post(tenant, { to, type: "image", image: { link, caption } });
