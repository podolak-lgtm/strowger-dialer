-- Owner, 5 Nov: "create the NSR workspace and move the campaign and numbers over".
-- The workspace that holds everything today becomes National Solar Resolutions,
-- a billed client; the owner (the first admin) moves to a fresh, empty
-- platform workspace. Nothing else moves, so numbers, people, campaigns,
-- carrier ids and settings stay exactly where they are. Runs once: only when
-- there is a platform tenant and no 'crossbar-platform' tenant yet.
DO $$
DECLARE
  old_id TEXT;
  new_id TEXT := 'tnt_crossbar_platform';
  owner_id TEXT;
BEGIN
  SELECT id INTO old_id FROM "Tenant" WHERE "isPlatform" = true ORDER BY "createdAt" ASC LIMIT 1;
  IF old_id IS NULL OR EXISTS (SELECT 1 FROM "Tenant" WHERE slug = 'crossbar-platform') THEN
    RETURN;
  END IF;
  SELECT id INTO owner_id FROM "User" WHERE "tenantId" = old_id AND 'ADMIN' = ANY(roles) ORDER BY "createdAt" ASC LIMIT 1;

  INSERT INTO "Tenant" (id, slug, name, settings, "isPlatform", "createdAt", "updatedAt")
  VALUES (new_id, 'crossbar-platform', 'Crossbar (platform)', '{}', true, NOW(), NOW());

  UPDATE "Tenant" SET "isPlatform" = false, name = 'National Solar Resolutions', "updatedAt" = NOW() WHERE id = old_id;

  IF owner_id IS NOT NULL THEN
    UPDATE "User" SET "tenantId" = new_id WHERE id = owner_id;
  END IF;

  INSERT INTO "BillingAccount" (id, "tenantId", "createdAt", "updatedAt")
  VALUES ('ba_' || old_id, old_id, NOW(), NOW())
  ON CONFLICT ("tenantId") DO NOTHING;
END $$;
