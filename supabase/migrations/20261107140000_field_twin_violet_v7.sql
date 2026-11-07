-- Weekly inventory reports. GitHub builds one report per person every Friday morning, saves the PDF in that person's
-- folder in the violet-photos bucket, and keeps the week's totals here so later reports can show week over week trends.
CREATE TABLE IF NOT EXISTS public.violet_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner UUID NOT NULL,
  week_of DATE NOT NULL,
  path TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner, week_of)
);
ALTER TABLE public.violet_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "violet_reports owner" ON public.violet_reports;
CREATE POLICY "violet_reports owner" ON public.violet_reports FOR SELECT TO authenticated USING (owner = auth.uid());
NOTIFY pgrst, 'reload schema';
