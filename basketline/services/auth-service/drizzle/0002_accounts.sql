-- Tenants become accounts, and users / user_login rows are visible only to their
-- own tenant (row-level security; the policy reads app.tenant_id, set per
-- transaction by withTenant() in src/db/client.ts).
CREATE TYPE "public"."account_tier" AS ENUM('free', 'pro', 'enterprise');--> statement-breakpoint
CREATE TABLE "accounts" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"tier" "account_tier" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- An account for every tenant that already has users.
INSERT INTO "accounts" ("tenant_id", "name")
SELECT DISTINCT tenant_id,
  CASE WHEN tenant_id = '5e0f3c2a-8b14-4d6f-9a27-1c3e5b7d9f01' THEN 'Default storefront' ELSE 'Tenant ' || tenant_id END
FROM "users";--> statement-breakpoint
ALTER TABLE "user_login" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "user_login" ul SET "tenant_id" = u.tenant_id FROM "users" u WHERE u.id = ul.user_id;--> statement-breakpoint
ALTER TABLE "user_login" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_login" ADD CONSTRAINT "user_login_tenant_id_accounts_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."accounts"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_accounts_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."accounts"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP INDEX "user_login_user_idx";--> statement-breakpoint
CREATE INDEX "user_login_user_idx" ON "user_login" USING btree ("tenant_id","user_id","session_start_time" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_login" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "user_login" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The service's login owns these tables, and owners skip RLS unless it is forced.
-- drizzle can't express FORCE, so it lives only here. (A later migration that
-- rewrites rows must set app.tenant_id, or run as a superuser.)
ALTER TABLE "user_login" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
