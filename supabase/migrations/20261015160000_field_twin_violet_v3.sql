-- Field Twin Violet v3: every table, column, policy, and the photo bucket again, safe to run on any state
CREATE TABLE IF NOT EXISTS public.violet_holders (
     id UUID PRIMARY KEY,
     owner UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'other',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );

CREATE TABLE IF NOT EXISTS public.violet_catalog (
     id UUID PRIMARY KEY,
     owner UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL DEFAULT 'part',
     name TEXT NOT NULL DEFAULT '',
     part_number TEXT NOT NULL DEFAULT '',
     manufacturer TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL DEFAULT '',
     unit TEXT NOT NULL DEFAULT 'each',
     ref_photo TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );

CREATE TABLE IF NOT EXISTS public.violet_events (
     id UUID PRIMARY KEY,
     owner UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
     happened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     type TEXT NOT NULL,
     catalog_id UUID NOT NULL REFERENCES public.violet_catalog(id) ON DELETE CASCADE,
     serial TEXT NOT NULL DEFAULT '',
     qty NUMERIC NOT NULL DEFAULT 1,
     condition TEXT NOT NULL DEFAULT 'good',
     from_holder UUID REFERENCES public.violet_holders(id) ON DELETE SET NULL,
     to_holder UUID REFERENCES public.violet_holders(id) ON DELETE SET NULL,
     locker_id TEXT NOT NULL DEFAULT '',
     site TEXT NOT NULL DEFAULT '',
     symptom TEXT NOT NULL DEFAULT '',
     cause TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     extracted JSONB,
     photos TEXT[] NOT NULL DEFAULT '{}'
   );

CREATE INDEX IF NOT EXISTS violet_events_owner_time ON public.violet_events (owner, happened_at);

CREATE INDEX IF NOT EXISTS violet_events_serial ON public.violet_events (serial) WHERE serial <> '';

ALTER TABLE public.violet_holders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "violet_holders owner" ON public.violet_holders;

CREATE POLICY "violet_holders owner" ON public.violet_holders FOR ALL TO authenticated
       USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());

ALTER TABLE public.violet_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "violet_catalog owner" ON public.violet_catalog;

CREATE POLICY "violet_catalog owner" ON public.violet_catalog FOR ALL TO authenticated
       USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());

ALTER TABLE public.violet_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "violet_events owner" ON public.violet_events;

CREATE POLICY "violet_events owner" ON public.violet_events FOR ALL TO authenticated
       USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());

DO $$ BEGIN
  INSERT INTO storage.buckets (id, name, public) VALUES ('violet-photos', 'violet-photos', false) ON CONFLICT (id) DO NOTHING;
EXCEPTION WHEN others THEN RAISE NOTICE 'violet photo bucket skipped: %', SQLERRM;
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "violet photos owner" ON storage.objects;
  CREATE POLICY "violet photos owner" ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'violet-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'violet-photos' AND (storage.foldername(name))[1] = auth.uid()::text);
EXCEPTION WHEN others THEN RAISE NOTICE 'violet photo policy skipped: %', SQLERRM;
END $$;

ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT '';
ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS min_qty NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE public.violet_events ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT '';
