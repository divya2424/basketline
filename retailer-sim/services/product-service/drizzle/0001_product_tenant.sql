-- Products created before tenants existed belong to the default storefront tenant
-- (VITE_TENANT_ID in frontend/.env.example), like the users and campaigns created then.
DROP INDEX "products_active_created_idx";--> statement-breakpoint
DROP INDEX "products_category_idx";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tenant_id" uuid NOT NULL DEFAULT '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01';--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "products_active_created_idx" ON "products" USING btree ("tenant_id","is_active","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("tenant_id","category");
