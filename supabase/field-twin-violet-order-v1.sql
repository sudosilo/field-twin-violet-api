-- Field Twin Violet: logs an order for a person from outside the app, the same row the Order tab saves.
-- The key comes from the VIOLET_CHECK_KEY secret.
create or replace function public.violet_add_order_v1(k text, o json) returns uuid
language plpgsql security definer set search_path = public as $$
declare r violet_orders%rowtype;
begin
  if k is distinct from '__CHECK_KEY__' then raise exception 'not allowed'; end if;
  r := json_populate_record(null::violet_orders, o);
  r.id := coalesce(r.id, gen_random_uuid());
  r.created_at := coalesce(r.created_at, now());
  r.ordered_at := coalesce(r.ordered_at, now());
  insert into violet_orders select (r).*;
  return r.id;
end $$;
revoke all on function public.violet_add_order_v1(text, json) from public;
grant execute on function public.violet_add_order_v1(text, json) to anon, authenticated;
notify pgrst, 'reload schema';
