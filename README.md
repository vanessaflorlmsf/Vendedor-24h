# Vendedor 24h — Backend (WhatsApp + Claude + Pix)

Vendedor virtual que atende clientes no WhatsApp 24h por dia, como especialista no ramo do lojista:
conversa, mostra produtos e fotos, tira dúvidas, respeita estoque, gera cobrança Pix e transfere
para uma pessoa quando necessário. **Multi-lojista desde o início** (tabela `tenants`).

> Este código é um ponto de partida (MVP) escrito sem acesso à internet e **não foi executado
> contra as APIs reais**. As APIs da Meta, do Mercado Pago e da Anthropic mudam: antes de usar,
> confira endpoints, campos, versões e preços na documentação oficial de cada uma.

## 1. Arquitetura

```
Cliente (WhatsApp) → Meta Cloud API → POST /webhooks/whatsapp
                                          │ verifica assinatura, responde 200 rápido
                                          ▼
                    fila por cliente → carrega histórico → Claude (com ferramentas)
                                          │  search_products · show_product_photo
                                          │  create_order · handoff_to_human
                                          ▼
              resposta → Meta Cloud API → Cliente
Mercado Pago → POST /webhooks/mercadopago → confirma pagamento → baixa estoque → avisa cliente e lojista
Painel (futuro) → /api/* (x-api-key)
```

Princípios de segurança do design:
- **Preço e estoque vêm do banco**, nunca do texto do modelo ou do cliente (`orders.js`).
- O modelo só age por ferramentas validadas no servidor. Instruções do cliente não alteram preços.
- Webhooks: assinatura da Meta (HMAC) e confirmação do pagamento consultando a API do Mercado Pago.
- Mensagens duplicadas ignoradas (`messages.wa_message_id` único). Confirmação de pagamento idempotente.

## 2. Estrutura

| Arquivo | Função |
|---|---|
| `schema.sql` / `seed.sql` | Tabelas (lojistas, produtos, clientes, conversas, mensagens, pedidos) e exemplo |
| `src/index.js` | Servidor, webhooks, fila por cliente, fluxo da mensagem |
| `src/agent.js` | Prompt do vendedor, ferramentas e laço de chamadas ao Claude |
| `src/whatsapp.js` | Envio de texto/imagem e verificação de assinatura |
| `src/payments.js` | Pix no Mercado Pago |
| `src/orders.js` | Criação de pedido, baixa de estoque, confirmação de pagamento |
| `src/admin.js` | API do painel: produtos, pedidos, conversas, devolver ao robô |

## 3. Como colocar no ar (passo a passo)

1. **Banco:** crie um PostgreSQL (Supabase, Neon, Railway…) e rode `schema.sql`.
2. **Meta:** em developers.facebook.com crie um app tipo Business, adicione o produto WhatsApp,
   cadastre/verifique o número e gere um token **permanente** (usuário do sistema).
   Anote `phone_number_id`, o token e o *App Secret*.
3. **Webhook na Meta:** URL `https://SEU_DOMINIO/webhooks/whatsapp`, token de verificação igual a
   `WA_VERIFY_TOKEN`; assine o campo `messages`.
4. **Mercado Pago (opcional):** crie uma aplicação, pegue o *access token* do lojista e configure `MP_WEBHOOK_SECRET` com o segredo de assinatura dos webhooks.
   Sem ele, o pedido é criado e o lojista é avisado para combinar o pagamento (`pix_note`).
5. **Variáveis:** copie `.env.example` para `.env` e preencha.
6. **Lojista:** edite `seed.sql` (phone_number_id, telefone do dono, chave do painel) e rode.
   Gere a chave com `openssl rand -hex 24`.
7. **Rodar:** `npm install` e `npm start`. Hospede em Railway, Render, Fly.io, AWS ou similar,
   sempre com HTTPS.
8. **Testar:** mande mensagem ao número; cadastre produtos via API:
   ```
   curl -X POST $PUBLIC_URL/api/products -H "x-api-key: SUA_CHAVE" -H "content-type: application/json" \
     -d '{"name":"Bolsa Tiracolo","price_cents":12990,"description":"Couro sintético","stock":5,"image_url":"https://..."}'
   ```

## 4. Pontos que o desenvolvedor precisa tratar antes de vender para terceiros

- **Janela de 24h do WhatsApp:** respostas livres só dentro de 24h após a mensagem do cliente.
  Avisos ao lojista ou mensagens ativas exigem **modelos aprovados** (template). Hoje os avisos ao
  lojista só funcionam se ele também tiver falado com o número nas últimas 24h.
- **Criptografia:** `wa_access_token` e `mp_access_token` devem ficar criptografados em repouso.
- **Autenticação do painel:** a chave por lojista é só do MVP; use login real na fase 3.
- **Fila e escala:** a fila em memória serve para 1 instância; use Redis/BullMQ para várias.
- **Limites e custo:** limite mensagens por cliente (anti-abuso) e acompanhe o custo da API do Claude por conversa.
- **Mercado Pago:** o WhatsApp não informa e-mail do cliente; confirme se o `FALLBACK_PAYER_EMAIL`
  é aceito para Pix e valide também a assinatura (`x-signature`) do webhook.
- **LGPD:** política de privacidade, termo para lojistas, base legal para guardar telefones e
  conversas, e rotina de exclusão sob pedido.
- **Mensagens não textuais:** áudio, imagem e localização hoje recebem uma resposta pedindo texto.
- **Reserva de estoque:** o estoque só baixa no pagamento. Para lojas com alta concorrência,
  adicione reserva temporária ao criar o pedido e cancelamento de pedidos pendentes antigos.
- **Testes:** escreva testes de conversa (roteiros de clientes difíceis, tentativas de manipulação,
  pedidos com estoque insuficiente) antes do lançamento.

## 5. Roteiro

1. **Base (feito neste repositório):** WhatsApp + Claude + catálogo + estoque + Pix + transferência para humano.
2. **Vendas:** frete por CEP, cupons, recuperação de pedidos pendentes, modelos de mensagem para avisos.
3. **Multi-lojista:** cadastro e login, onboarding do número, painel web (a interface criada no Claude
   serve de referência visual), planos e cobrança de assinatura.
4. **Evolução:** relatórios, integração com Instagram/Shopify/planilhas, áudio (transcrição), avaliação de qualidade das conversas.


## Railway — implantação inicial
1. Envie este projeto a um repositório GitHub privado de sua propriedade.
2. No Railway, crie um projeto, adicione PostgreSQL e conecte um serviço Node.js ao repositório.
3. Configure `DATABASE_URL` como referência à variável `DATABASE_URL` do serviço PostgreSQL.
4. Configure `ANTHROPIC_API_KEY`, `META_APP_SECRET`, `WA_VERIFY_TOKEN`, `MP_WEBHOOK_SECRET`, `FALLBACK_PAYER_EMAIL`, `PUBLIC_URL` e `CLAUDE_MODEL`. Nunca publique `.env`.
5. Gere um domínio público HTTPS e configure `PUBLIC_URL` com esse endereço.
6. Defina o Healthcheck Path como `/health`; o app escuta a variável `PORT` do Railway.
7. Rode `schema.sql` no banco novo. Em banco já existente, compare o esquema antes de alterar tabelas.

**Atenção:** ainda faltam criptografia dos tokens no banco, limitação de requisições, templates de WhatsApp, alertas operacionais e testes integrados. Não use com pagamentos reais antes de resolver esses itens e validar os testes críticos.
