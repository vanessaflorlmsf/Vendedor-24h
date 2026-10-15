import crypto from "node:crypto";
const MP = "https://api.mercadopago.com";
export async function createPixPayment({ token, orderId, amountCents, description, notifyUrl }) {
 const res = await fetch(`${MP}/v1/payments`, { method:"POST", headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","X-Idempotency-Key":orderId}, body:JSON.stringify({transaction_amount:amountCents/100,description,payment_method_id:"pix",payer:{email:process.env.FALLBACK_PAYER_EMAIL},external_reference:orderId,notification_url:notifyUrl}) });
 if(!res.ok) throw new Error(`MercadoPago ${res.status}: ${await res.text()}`);
 const j=await res.json(); const pixCode=j.point_of_interaction?.transaction_data?.qr_code;
 if(!j.id||!pixCode) throw new Error("Mercado Pago não retornou ID e código Pix");
 return {paymentId:String(j.id),pixCode};
}
export async function getPayment(token,id) { const r=await fetch(`${MP}/v1/payments/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${token}`}}); if(!r.ok) throw new Error(`MercadoPago ${r.status}`); return r.json(); }
export function verifyMercadoPagoSignature({signature,requestId,dataId,secret}) {
 if(!signature||!requestId||!dataId||!secret) return false;
 const p=Object.fromEntries(signature.split(",").map(x=>{const i=x.indexOf("=");return i<0?[x.trim(),""]:[x.slice(0,i).trim(),x.slice(i+1).trim()]}));
 if(!p.ts||!p.v1) return false;
 const manifest=`id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${p.ts};`;
 const expected=crypto.createHmac("sha256",secret).update(manifest).digest();
 const actual=Buffer.from(p.v1,"hex"); return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
}
