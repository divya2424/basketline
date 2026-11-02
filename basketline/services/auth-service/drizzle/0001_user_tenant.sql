-- Users created before tenants existed belong to the default storefront tenant
-- (VITE_TENANT_ID in frontend/.env.example). Usernames become unique per tenant.
DROP INDEX "users_username_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" uuid NOT NULL DEFAULT '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree ("tenant_id",lower("username"));
