-- Each association's tenant: its campaign's (a campaign only uses its own tenant's products).
ALTER TABLE "campaign_products" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "campaign_products" cp SET "tenant_id" = c.tenant_id FROM "campaigns" c WHERE c.id = cp.campaign_id;--> statement-breakpoint
ALTER TABLE "campaign_products" ALTER COLUMN "tenant_id" SET NOT NULL;
