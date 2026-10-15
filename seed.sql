-- Exemplo: uma loja de teste. Gere a chave do painel com: openssl rand -hex 24
-- e grave o hash:  select encode(digest('SUA_CHAVE','sha256'),'hex');
insert into tenants (name, specialty, policies, wa_phone_number_id, owner_phone, api_key_hash)
values ('Loja Modelo','moda feminina e acessórios',
 'Frete grátis acima de R$ 250. Entrega em 3 a 7 dias úteis. Troca em até 7 dias. Desconto máximo de 5% no Pix.',
 'COLE_O_PHONE_NUMBER_ID', '5585999999999', encode(digest('TROQUE_ESTA_CHAVE','sha256'),'hex'));

insert into products (tenant_id, name, price_cents, description, stock)
select id, 'Vestido Floral Midi', 18990, 'Viscose leve, tamanhos P ao GG, cores azul e rosa', 10 from tenants limit 1;
