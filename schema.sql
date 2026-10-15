create extension if not exists pgcrypto;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  specialty text not null default 'moda feminina e acessórios',
  persona_name text not null default 'Duda',
  tone text not null default 'simpático e acolhedor',
  policies text not null default '',          -- frete, prazos, trocas, desconto máximo
  pix_note text,                              -- instrução manual de pagamento (se sem Mercado Pago)
  wa_phone_number_id text unique,             -- ID do número na Meta
  wa_access_token text,                       -- criptografar em repouso em produção
  owner_phone text,                           -- WhatsApp do lojista (só números, com DDI)
  mp_access_token text,                       -- criptografar em repouso em produção
  api_key_hash text,                          -- sha256 da chave do painel
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  description text not null default '',
  stock integer check (stock >= 0),           -- null = sem limite
  image_url text,                             -- URL pública https
  active boolean not null default true
);
create index on products (tenant_id) where active;

create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  phone text not null,
  name text,
  created_at timestamptz not null default now(),
  unique (tenant_id, phone)
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  status text not null default 'bot' check (status in ('bot','human','closed')),
  updated_at timestamptz not null default now()
);
create index on conversations (tenant_id, updated_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  wa_message_id text unique,                  -- evita processar a mesma mensagem duas vezes
  created_at timestamptz not null default now()
);
create index on messages (conversation_id, created_at);

create table orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id),
  status text not null default 'pending' check (status in ('pending','paid','cancelled')),
  total_cents integer not null,
  mp_payment_id text,
  pix_code text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index on orders (tenant_id, created_at desc);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid not null references products(id),
  name text not null,
  qty integer not null check (qty > 0),
  unit_price_cents integer not null
);
