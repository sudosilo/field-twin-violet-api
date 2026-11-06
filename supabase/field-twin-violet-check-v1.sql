-- Field Twin Violet check: read-only copy of items, locations and recent history for Claude to check entries.
-- The key is filled in from the VIOLET_CHECK_KEY secret when the database workflow runs.
create or replace function public.violet_check_v1(k text) returns json
language plpgsql security definer set search_path = public as $$
begin
  if k is distinct from '__CHECK_KEY__' then raise exception 'not allowed'; end if;
  return json_build_object(
    'holders', (select coalesce(json_agg(to_jsonb(h)), '[]'::json) from violet_holders h),
    'catalog', (select coalesce(json_agg(to_jsonb(c) - 'ref_photo'), '[]'::json) from violet_catalog c),
    'events', (select coalesce(json_agg(x), '[]'::json) from (select to_jsonb(e) - 'photos' - 'extracted' as x from violet_events e order by e.created_at desc limit 800) s)
  );
end $$;
revoke all on function public.violet_check_v1(text) from public;
grant execute on function public.violet_check_v1(text) to anon, authenticated;
notify pgrst, 'reload schema';
