-- Campaigns and products created before tenants existed belong to the default
-- storefront tenant (VITE_TENANT_ID in frontend/.env.example), like the users created then.
DROP INDEX "campaigns_listing_idx";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "tenant_id" uuid NOT NULL DEFAULT '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01';--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "product_catalog_projection" ADD COLUMN "tenant_id" uuid NOT NULL DEFAULT '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01';--> statement-breakpoint
ALTER TABLE "product_catalog_projection" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "campaigns_listing_idx" ON "campaigns" USING btree ("tenant_id","status","created_at" DESC NULLS LAST) WHERE "campaigns"."archived_at" IS NULL;
