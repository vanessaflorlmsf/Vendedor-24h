```js
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
      req.rawBody = buf;
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
  } catch {
    res.status(503).json({
      status: "unavailable",
      database: "error",
    });
  }
});

// --- WhatsApp: verificação do webhook ---
app.get("/webhooks/whatsapp", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === process.env.WA_VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }

  res.sendStatus(403);
});

// --- WhatsApp: mensagens recebidas ---
app.post("/webhooks/whatsapp", (req, res) => {
  if (!verifySignature(req.rawBody, req.get("x-hub-signature-256"))) {
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  for (const entry of req.body.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const phoneId = v.metadata?.phone_number_id;

      for (const msg of v.messages || []) {
        const name = v.contacts?.find(
          (c) => c.wa_id === msg.from
        )?.profile?.name;

        enqueue(`${phoneId}:${msg.from}`, () =>
          handleMessage(phoneId, msg, name)
        ).catch((e) => console.error("handleMessage", e));
      }
    }
  }
});

// --- Fila simples por cliente ---
const chains = new Map();

function enqueue(key, fn) {
  const next = (chains.get(key) || Promise.resolve())
    .catch(() => {})
    .then(fn);

  chains.set(key, next);

  next.finally(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });

  return next;
}

// --- Histórico da conversa ---
async function loadHistory(conversationId) {
  const { rows } = await q(
    `select role, content
     from messages
     where conversation_id=$1
     order by created_at desc
     limit 20`,
    [conversationId]
  );

  const out = [];

  for (const m of rows.reverse()) {
    if (out.length && out.at(-1).role === m.role) {
      out.at(-1).content += "\n" + m.content;
    } else {
      out.push({
        role: m.role,
        content: m.content,
      });
    }
  }

  while (out.length && out[0].role !== "user") {
    out.shift();
  }

  return out;
}

// --- Atendimento automatizado ---
async function handleMessage(phoneId, msg, contactName) {
  const {
    rows: [tenant],
  } = await q(
    "select * from tenants where wa_phone_number_id=$1 and active",
    [phoneId]
  );

  if (!tenant) return;

  const {
    rows: [customer],
  } = await q(
    `insert into customers(tenant_id,phone,name)
     values($1,$2,$3)
     on conflict (tenant_id,phone)
     do update set name=coalesce(customers.name, excluded.name)
     returning *`,
    [tenant.id, msg.from, contactName || null]
  );

  let {
    rows: [conv],
  } = await q(
    `select * from conversations
     where tenant_id=$1
       and customer_id=$2
       and status<>'closed'
     order by updated_at desc
     limit 1`,
    [tenant.id, customer.id]
  );

  if (!conv) {
    conv = (
      await q(
        `insert into conversations(tenant_id,customer_id)
         values($1,$2)
         returning *`,
        [tenant.id, customer.id]
      )
    ).rows[0];
  }

  const text = msg.type === "text" ? msg.text?.body : null;

  const saved = await q(
    `insert into messages(
       conversation_id,role,content,wa_message_id
     )
     values($1,'user',$2,$3)
     on conflict (wa_message_id) do nothing
     returning id`,
    [
      conv.id,
      text ?? "[mensagem não textual]",
      msg.id,
    ]
  );

  if (!saved.rowCount) return;

  await q(
    "update conversations set updated_at=now() where id=$1",
    [conv.id]
  );

  if (conv.status === "human") return;

  if (!text) {
    await sendText(
      tenant,
      msg.from,
      "Por enquanto eu só consigo ler mensagens de texto 🙂 Pode me escrever o que você procura?"
    );
    return;
  }

  const history = await loadHistory(conv.id);
  const { text: reply } = await runAgent({
    tenant,
    customer,
    conversation: conv,
    history,
  });

  if (reply) {
    await sendText(tenant, msg.from, reply);

    await q(
      `insert into messages(conversation_id,role,content)
       values($1,'assistant',$2)`,
      [conv.id, reply]
    );
  }
}

// --- Mercado Pago: webhook de pagamentos ---
app.post("/webhooks/mercadopago", async (req, res) => {
  const dataId = req.body?.data?.id || req.query["data.id"];

  const valid = verifyMercadoPagoSignature({
    signature: req.get("x-signature"),
    requestId: req.get("x-request-id"),
    dataId,
    secret: process.env.MP_WEBHOOK_SECRET,
  });

  if (!valid) return res.sendStatus(401);

  res.sendStatus(200);

  try {
    if (!dataId || !req.query.tenant) return;

    const {
      rows: [t],
    } = await q(
      "select * from tenants where id=$1 and active",
      [req.query.tenant]
    );

    if (!t?.mp_access_token) return;

    const pay = await getPayment(t.mp_access_token, dataId);

    if (pay.status === "approved" && pay.external_reference) {
      const {
        rows: [o],
      } = await q(
        `select id,mp_payment_id
         from orders
         where id=$1 and tenant_id=$2`,
        [pay.external_reference, t.id]
      );

      if (o) {
        if (
          o.mp_payment_id &&
          String(o.mp_payment_id) !== String(pay.id)
        ) {
          console.error("Payment ID mismatch", o.id);
          return;
        }

        if (String(pay.external_reference) === String(o.id)) {
          await confirmPaid(o.id, pay);
        }
      }
    }
  } catch (e) {
    console.error("mercadopago webhook", e);
  }
});

// --- API administrativa ---
app.use("/api", adminRouter());

// --- Tratamento de erros ---
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({
    error: "erro interno",
  });
});

// --- Inicialização do servidor ---
app.listen(process.env.PORT || 3000, () => {
  console.log("Vendedor 24h no ar");
});
```
