import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { PGlite } = createRequire(process.env.PERMISSION_TEST_PACKAGE || import.meta.url)('@electric-sql/pglite');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const db = new PGlite();
let checks=0;
const ok = (value, message) => { assert.ok(value,message); checks++; };
const rows = async q => (await db.query(q)).rows;
async function denied(q) { await assert.rejects(db.exec(q), e => e.code==='42501'); checks++; }
async function role(name, uid='') { await db.exec(`reset role; select set_config('request.jwt.claim.sub','${uid}',false); set role ${name};`); }
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create function auth.role() returns text language sql stable as $$ select current_user::text $$;
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 grant usage on schema auth to anon,authenticated,service_role;
 grant execute on all functions in schema auth to anon,authenticated,service_role;`);
const A='11111111-1111-1111-1111-111111111111', B='22222222-2222-2222-2222-222222222222';
await db.exec(`create publication supabase_realtime;
create schema storage; create table storage.buckets(id text primary key,name text,public boolean);`);
if(process.env.LEGACY_DEFAULTS) await db.exec(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role; alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
if(process.env.NUMBERED) {
 const dir=path.join(root,'supabase/migrations');
 for(const name of fs.readdirSync(dir).filter(n => /^\d.*\.sql$/.test(n)).sort()) await db.exec(read('supabase/migrations/'+name));
} else await db.exec(read('supabase/migrations/run_all_migrations.sql'));
const hardening=fs.readdirSync(path.join(root,'supabase/migrations')).find(n => n.endsWith('_explicit_data_api_permissions.sql'));
await db.exec(read('supabase/migrations/'+hardening)); // upgrade is repeatable
await db.exec(`insert into auth.users(id,email) values ('${A}','a@example.invalid'),('${B}','b@example.invalid');`);
const teams=await rows('select id,team_id from profiles order by id');
const teamB=teams[1].team_id;
const invite=(await rows(`select invite_code from teams where id='${teamB}'`))[0].invite_code;
await role('authenticated',A);
ok((await rows('select * from profiles')).length===1,'profiles read does not recurse or expose other teams');
await db.exec(`insert into properties(name,address) values('A','test'); insert into items(name) values('A item');`);
const propertyA=(await rows('select id from properties'))[0].id;
await denied(`update profiles set team_id='${teamB}' where id='${A}'`);
await denied(`update profiles set role='owner' where id='${A}'`);
await db.exec(`update profiles set display_name='Changed' where id='${A}'`);
await role('authenticated',B);
ok((await rows('select * from properties')).length===0,'other team cannot read');
ok((await rows(`update properties set name='stolen' where id='${propertyA}' returning id`)).length===0,'other team cannot update');
await denied(`insert into properties(name,address,team_id) values('bad','test','${teams[0].team_id}')`);
await denied(`insert into items(name,current_property_id) values('bad ref','${propertyA}')`);
await role('anon');
for(const t of ['properties','items','profiles','teams','property_expenses','staging_payments']) await denied('select * from '+t);
await denied(`select public.join_staging_team('${invite}')`);
await role('authenticated',A);
await assert.rejects(db.exec(`select public.join_staging_team('invalid')`)); checks++;
await db.exec(`select public.join_staging_team('${invite}')`);
ok((await rows(`select team_id from profiles where id='${A}'`))[0].team_id===teamB,'valid invite changes membership');
ok((await rows('select * from properties')).length===0,'former team data no longer visible');
await role('postgres');
ok((await rows("select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity"))[0].n===0,'all app tables have RLS');

await db.close(); console.log(`${checks} PostgreSQL permission checks passed`);
