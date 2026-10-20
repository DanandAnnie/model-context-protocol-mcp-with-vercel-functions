-- Explicit grants and tenant authorization. Review before production use.
begin;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create or replace function private.staging_team_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select team_id from public.profiles where id = (select auth.uid())
$$;
revoke all on function private.staging_team_id() from public, anon, authenticated;
grant execute on function private.staging_team_id() to authenticated;
-- This lookup is parameterless and always bound to the current verified user.
-- It avoids the recursive profiles policy without exposing other memberships.
alter table public.properties enable row level security;
revoke all on public.properties from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='properties'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on properties; review live drift first'; end if;
end $$;
alter table public.storage_units enable row level security;
revoke all on public.storage_units from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='storage_units'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on storage_units; review live drift first'; end if;
end $$;
alter table public.items enable row level security;
revoke all on public.items from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='items'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on items; review live drift first'; end if;
end $$;
alter table public.item_images enable row level security;
revoke all on public.item_images from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='item_images'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on item_images; review live drift first'; end if;
end $$;
alter table public.staging_history enable row level security;
revoke all on public.staging_history from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='staging_history'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on staging_history; review live drift first'; end if;
end $$;
alter table public.property_expenses enable row level security;
revoke all on public.property_expenses from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='property_expenses'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on property_expenses; review live drift first'; end if;
end $$;
alter table public.staging_payments enable row level security;
revoke all on public.staging_payments from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='staging_payments'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on staging_payments; review live drift first'; end if;
end $$;
alter table public.deals enable row level security;
revoke all on public.deals from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='deals'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on deals; review live drift first'; end if;
end $$;
alter table public.deal_watches enable row level security;
revoke all on public.deal_watches from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='deal_watches'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on deal_watches; review live drift first'; end if;
end $$;
alter table public.property_rooms enable row level security;
revoke all on public.property_rooms from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='property_rooms'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on property_rooms; review live drift first'; end if;
end $$;
alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='profiles'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on profiles; review live drift first'; end if;
end $$;
alter table public.teams enable row level security;
revoke all on public.teams from public, anon, authenticated, service_role;
do $$ begin
 if exists (select 1 from pg_policies where schemaname='public' and tablename='teams'
 and policyname not in ('Allow all for authenticated','Team access','Team members can read own team','Team members can update own team','Can read own team profiles','Can update own profile','Can insert own profile','staging_read','staging_update')) then
 raise exception 'Unexpected policy on teams; review live drift first'; end if;
end $$;
do $$ declare p record; begin
 for p in select tablename,policyname from pg_policies where schemaname='public'
 and tablename = any(array['properties','storage_units','items','item_images','staging_history','property_expenses','staging_payments','deals','deal_watches','property_rooms','profiles','teams']) loop
 execute format('drop policy %I on public.%I',p.policyname,p.tablename);
 end loop;
end $$;
grant usage on schema public to authenticated;
grant select on public.teams, public.profiles to authenticated;
grant update (name) on public.teams to authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy staging_read on public.profiles for select to authenticated
 using (id=(select auth.uid()) or team_id=(select private.staging_team_id()));
create policy staging_update on public.profiles for update to authenticated
 using (id=(select auth.uid())) with check (id=(select auth.uid()));
create policy staging_read on public.teams for select to authenticated
 using (id=(select private.staging_team_id()));
create policy staging_update on public.teams for update to authenticated
 using (id=(select private.staging_team_id())) with check (id=(select private.staging_team_id()));
alter table public.properties alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.properties to authenticated;
create policy "Team access" on public.properties for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()));
alter table public.storage_units alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.storage_units to authenticated;
create policy "Team access" on public.storage_units for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()));
alter table public.items alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.items to authenticated;
create policy "Team access" on public.items for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()) and (current_storage_id is null or exists (select 1 from public.storage_units p where p.id=items.current_storage_id and p.team_id=(select private.staging_team_id()))) and (current_property_id is null or exists (select 1 from public.properties p where p.id=items.current_property_id and p.team_id=(select private.staging_team_id()))));
alter table public.item_images alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.item_images to authenticated;
create policy "Team access" on public.item_images for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()) and (item_id is null or exists (select 1 from public.items p where p.id=item_images.item_id and p.team_id=(select private.staging_team_id()))));
alter table public.staging_history alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.staging_history to authenticated;
create policy "Team access" on public.staging_history for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()) and (item_id is null or exists (select 1 from public.items p where p.id=staging_history.item_id and p.team_id=(select private.staging_team_id()))) and (from_storage_id is null or exists (select 1 from public.storage_units p where p.id=staging_history.from_storage_id and p.team_id=(select private.staging_team_id()))) and (to_storage_id is null or exists (select 1 from public.storage_units p where p.id=staging_history.to_storage_id and p.team_id=(select private.staging_team_id()))) and (from_property_id is null or exists (select 1 from public.properties p where p.id=staging_history.from_property_id and p.team_id=(select private.staging_team_id()))) and (to_property_id is null or exists (select 1 from public.properties p where p.id=staging_history.to_property_id and p.team_id=(select private.staging_team_id()))));
alter table public.property_expenses alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.property_expenses to authenticated;
create policy "Team access" on public.property_expenses for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()) and (property_id is null or exists (select 1 from public.properties p where p.id=property_expenses.property_id and p.team_id=(select private.staging_team_id()))));
alter table public.staging_payments alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.staging_payments to authenticated;
create policy "Team access" on public.staging_payments for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()) and (property_id is null or exists (select 1 from public.properties p where p.id=staging_payments.property_id and p.team_id=(select private.staging_team_id()))));
alter table public.deals alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.deals to authenticated;
create policy "Team access" on public.deals for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()));
alter table public.deal_watches alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.deal_watches to authenticated;
create policy "Team access" on public.deal_watches for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()));
alter table public.property_rooms alter column team_id set default private.staging_team_id();
grant select, insert, update, delete on public.property_rooms to authenticated;
create policy "Team access" on public.property_rooms for all to authenticated
 using (team_id=(select private.staging_team_id())) with check (team_id=(select private.staging_team_id()) and (property_id is null or exists (select 1 from public.properties p where p.id=property_rooms.property_id and p.team_id=(select private.staging_team_id()))));
-- Signup is the only profile-creation path. Users cannot set role/team_id.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare new_team_id uuid;
begin
 insert into public.teams(name) values (coalesce(split_part(new.email,'@',1),'My Team') || ' Team') returning id into new_team_id;
 insert into public.profiles(id,email,display_name,team_id,role)
 values(new.id,new.email,coalesce(new.raw_user_meta_data->>'display_name',split_part(new.email,'@',1)),new_team_id,'owner');
 return new;
end $$;
revoke all on function public.handle_new_user() from public,anon,authenticated,service_role;
alter function public.update_updated_at() set search_path = '';
revoke all on function public.update_updated_at() from public,anon,authenticated,service_role;
-- A long random invite is a membership capability. Existing codes are not rotated here.
alter table public.teams alter column invite_code set default replace(gen_random_uuid()::text,'-','');
create or replace function private.join_staging_team(invite text)
returns void language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
 select id into target from public.teams where invite_code=lower(trim(invite));
 if target is null then raise exception 'Invalid invite code' using errcode='22023'; end if;
 update public.profiles set team_id=target, role='member' where id=auth.uid();
 if not found then raise exception 'Profile missing' using errcode='42501'; end if;
end $$;
revoke all on function private.join_staging_team(text) from public,anon,authenticated;
grant execute on function private.join_staging_team(text) to authenticated;
create or replace function public.join_staging_team(invite text)
returns void language sql security invoker set search_path = '' as $$
 select private.join_staging_team(invite)
$$;
revoke all on function public.join_staging_team(text) from public,anon,authenticated,service_role;
grant execute on function public.join_staging_team(text) to authenticated;
commit;
