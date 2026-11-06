-- Field Twin Violet count sheet: sets stock to the counts on a warehouse count sheet for one person and one location.
-- Duplicate entries of the same part (a part number typed short, or entered by its old material number) are folded
-- into the listed part first, then the difference is logged as found or missing so the totals match the sheet.
-- Every part on the NV11 list is marked as a company part for Amazon. The key comes from the VIOLET_CHECK_KEY secret.
create or replace function public.violet_set_counts_v1(k text, p_owner uuid, p_holder uuid, counts json) returns json
language plpgsql security definer set search_path = public as $$
declare
  r json; pn text; want numeric; canon violet_catalog%rowtype; have numeric; diff numeric; tail text;
  done json := '[]'::json;
begin
  if k is distinct from '__CHECK_KEY__' then raise exception 'not allowed'; end if;
  update violet_catalog set company = true, customer = 'Amazon' where owner = p_owner and part_number like '30000%';
  for r in select * from json_array_elements(counts) loop
    pn := r->>'pn'; want := (r->>'qty')::numeric;
    tail := ltrim(substr(pn, 2), '0');
    select * into canon from violet_catalog where owner = p_owner and part_number = pn order by created_at limit 1;
    if not found then continue; end if;
    update violet_events set catalog_id = canon.id where owner = p_owner and catalog_id in (
      select id from violet_catalog where owner = p_owner and id <> canon.id and (
        (part_number ~ '^30+' and ltrim(substr(part_number, 2), '0') = tail) or (canon.model <> '' and part_number = canon.model)));
    update violet_catalog set ref_photo = coalesce(violet_catalog.ref_photo, d.ref_photo) from (
      select ref_photo from violet_catalog where owner = p_owner and id <> canon.id and ref_photo is not null and (
        (part_number ~ '^30+' and ltrim(substr(part_number, 2), '0') = tail) or (canon.model <> '' and part_number = canon.model)) limit 1) d
      where violet_catalog.id = canon.id;
    delete from violet_catalog where owner = p_owner and id <> canon.id and (
      (part_number ~ '^30+' and ltrim(substr(part_number, 2), '0') = tail) or (canon.model <> '' and part_number = canon.model));
    select coalesce(sum(case when to_holder is not null then qty else 0 end), 0) - coalesce(sum(case when from_holder is not null then qty else 0 end), 0)
      into have from violet_events where owner = p_owner and catalog_id = canon.id;
    diff := want - have;
    if diff <> 0 then
      insert into violet_events (id, owner, happened_at, created_at, type, catalog_id, serial, qty, condition, from_holder, to_holder,
        locker_id, site, symptom, cause, note, vendor, customer, source)
      values (gen_random_uuid(), p_owner, now(), now(), case when diff > 0 then 'received' else 'written_off' end, canon.id, '', abs(diff), 'good',
        case when diff > 0 then null else p_holder end, case when diff > 0 then p_holder else null end, '', '', '', '',
        case when diff > 0 then 'Found during count sheet import' else 'Missing at count sheet import' end, '', 'Amazon', 'count');
    end if;
    done := (done::jsonb || jsonb_build_array(jsonb_build_object('pn', pn, 'had', have, 'now', want)))::json;
  end loop;
  return done;
end $$;
revoke all on function public.violet_set_counts_v1(text, uuid, uuid, json) from public;
grant execute on function public.violet_set_counts_v1(text, uuid, uuid, json) to anon, authenticated;
notify pgrst, 'reload schema';
