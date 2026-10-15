import express from "express";
import { fileURLToPath } from "node:url";
import { q } from "./db.js";
import { verifySignature, sendText } from "./whatsapp.js";
import { runAgent } from "./agent.js";
import {
  getPayment,
  verifyMercadoPagoSignature,
} from "./payments.js";
import { confirmPaid } from "./orders.js";
import { adminRouter } from "./admin.js";
const app = express();
// --- Política de Privacidade ---
const privacyPath = fileURLToPath(
  new URL("./privacy.html", import.meta.url)
);
app.get("/privacy", (_req, res) => {
  res.sendFile(privacyPath);
});
// --- Middleware ---
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);
// --- Verificação de saúde ---
app.get("/health", async (_req, res) => {
  try {
    await q("select 1");
res.status(200).json({
      status: "ok",
      database: "ok",
    });
  } catch (error) {
    console.error("health check", error);
res.status(503).json({
      status: "unavailable",
      database: "error",
    });
  }
});
// --- WhatsApp: verificação do webhook ---
app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
if (
    mode === "subscribe" &&
    typeof process.env.WA_VERIFY_TOKEN === "string" &&
    process.env.WA_VERIFY_TOKEN.length > 0 &&
    token === process.env.WA_VERIFY_TOKEN &&
    challenge !== undefined
  ) {
    return res.status(200).send(String(challenge));
  }
return res.sendStatus(403);
});
// --- WhatsApp: mensagens recebidas ---
app.post("/webhooks/whatsapp", (req, res) => {
  const signature = req.get("x-hub-signature-256");
if (
    !req.rawBody ||
    !verifySignature(req.rawBody, signature)
  ) {
    return res.sendStatus(401);
  }
// Confirmar o recebimento antes de processar as mensagens.
  res.sendStatus(200);
for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneId = value.metadata?.phone_number_id;
      if (!phoneId) continue;
for (const msg of value.messages || []) {
        if (!msg?.from || !msg?.id) continue;
const name = value.contacts?.find(
          (contact) => contact.wa_id === msg.from
        )?.profile?.name;
const key = $DIL0:$DIL1;
enqueue(key, () =>
          handleMessage(phoneId, msg, name)
        ).catch((error) => {
          console.error("handleMessage", error);
        });
      }
    }
  }
});
// --- Fila simples por cliente ---
const chains = new Map();
function enqueue(key, fn) {
  const previous = chains.get(key) || Promise.resolve();
const next = previous
    .catch(() => {})
    .then(fn);
  chains.set(key, next);
// Limpar a fila ao terminar, tanto em sucesso quanto em erro.
  next.then(
    () => {
      if (chains.get(key) === next) {
        chains.delete(key);
      }
    },
    () => {
      if (chains.get(key) === next) {
        chains.delete(key);
      }
    }
  );
return next;
}
// --- Histórico da conversa ---
async function loadHistory(conversationId) {
  const { rows } = await q(
    `select role, content
     from messages
     where conversation_id = $1
     order by created_at desc
     limit 20`,
    [conversationId]
  );
  const history = [];
for (const message of rows.reverse()) {
    if (
      history.length > 0 &&
      history.at(-1).role === message.role
    ) {
      history.at(-1).content += "\n" + message.content;
    } else {
      history.push({
        role: message.role,
        content: message.content,
      });
    }
  }
// O histórico enviado ao agente deve começar com uma mensagem do usuário.
  while (
    history.length > 0 &&
    history[0].role !== "user"
  ) {
    history.shift();
  }
return history;
}
// --- Atendimento automatizado ---
async function handleMessage(phoneId, msg, contactName) {
  const {
    rows: [tenant],
  } = await q(
    `select *
     from tenants
     where wa_phone_number_id = $1
       and active`,
    [phoneId]
  );
// O número precisa estar cadastrado como cliente da plataforma.
  if (!tenant) {
    console.warn("Nenhum tenant ativo para o número recebido.");
    return;
  }
const {
    rows: [customer],
  } = await q(
    `insert into customers (tenant_id, phone, name)
     values ($1, $2, $3)
     on conflict (tenant_id, phone)
     do update set name = coalesce(
       customers.name,
       excluded.name
     )
     returning *`,
    [tenant.id, msg.from, contactName || null]
  );
let {
    rows: [conversation],
  } = await q(
    `select *
     from conversations
     where tenant_id = $1
       and customer_id = $2
       and status
'closed'
order by updated_at desc
limit 1`,
[tenant.id, customer.id]
);
if (!conversation) {
conversation = (
await q(
insert into conversations (tenant_id, customer_id)          values ($1, $2)          returning *,
[tenant.id, customer.id]
)
).rows[0];
}
const text =
msg.type === "text" ? msg.text?.body : null;
const saved = await q(
insert into messages (        conversation_id,        role,        content,        wa_message_id      )      values ($1, 'user', $2, $3)      on conflict (wa_message_id) do nothing      returning id,
[
conversation.id,
text ?? "[mensagem não textual]",
msg.id,
]
);
// Ignorar mensagens duplicadas enviadas novamente pelo webhook.
if (!saved.rowCount) return;
await q(
update conversations      set updated_at = now()      where id = $1,
[conversation.id]
);
// Não responder automaticamente quando o atendimento for humano.
if (conversation.status === "human") return;
if (!text) {
await sendText(
tenant,
msg.from,
"Por enquanto, consigo ler apenas mensagens de texto 🙂 Pode me escrever o que você procura?"
);
return;
}
const history = await loadHistory(conversation.id);
const { text: reply } = await runAgent({
tenant,
customer,
conversation,
history,
});
if (reply) {
await sendText(tenant, msg.from, reply);
await q(
insert into messages (          conversation_id,          role,          content        )        values ($1, 'assistant', $2),
[conversation.id, reply]
);
}
}
// --- Mercado Pago: webhook de pagamentos ---
app.post("/webhooks/mercadopago", async (req, res) => {
const dataId =
req.body?.data?.id ?? req.query["data.id"];
const valid = verifyMercadoPagoSignature({
signature: req.get("x-signature"),
requestId: req.get("x-request-id"),
dataId,
secret: process.env.MP_WEBHOOK_SECRET,
});
if (!valid) {
return res.sendStatus(401);
}
res.sendStatus(200);
try {
if (!dataId || !req.query.tenant) return;
const {
rows: [tenant],
} = await q(
select *        from tenants        where id = $1          and active,
[req.query.tenant]
);
if (!tenant?.mp_access_token) return;
const payment = await getPayment(
tenant.mp_access_token,
dataId
);
if (
payment.status !== "approved" ||
!payment.external_reference
) {
return;
}
const {
rows: [order],
} = await q(
select id, mp_payment_id        from orders        where id = $1          and tenant_id = $2,
[payment.external_reference, tenant.id]
);
if (!order) return;
if (
order.mp_payment_id &&
String(order.mp_payment_id) !== String(payment.id)
) {
console.error("Payment ID mismatch", order.id);
return;
}
if (
String(payment.external_reference) === String(order.id)
) {
await confirmPaid(order.id, payment);
}
} catch (error) {
console.error("mercadopago webhook", error);
}
});
// --- API administrativa ---
app.use("/api", adminRouter());
// --- Tratamento de erros ---
app.use((err, _req, res, _next) => {
console.error("Erro na aplicação:", err);
if (res.headersSent) return;
res.status(500).json({
error: "erro interno",
});
});
// --- Inicialização do servidor ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
console.log(Vendedor 24h no ar na porta $DIL0);
});

