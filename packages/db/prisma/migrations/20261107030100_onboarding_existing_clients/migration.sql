-- Onboarding wizard: workspaces that existed before it are already set up, so
-- they get no "Finish setup" banner and no first-visit redirect to /welcome
-- (their admins can still open it from Settings).
UPDATE "Tenant"
SET "onboarding" = jsonb_build_object('finishedAt', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'existingBeforeWizard', true, 'steps', '{}'::jsonb, 'meta', '{}'::jsonb)
WHERE "onboarding" IS NULL;
