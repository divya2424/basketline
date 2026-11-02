CREATE TABLE "sellers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sellers_tenant_idx" ON "sellers" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seller_id" uuid;--> statement-breakpoint
-- Products from before sellers: each tenant's go to its own first-party seller (an ID fixed by the tenant).
INSERT INTO "sellers" ("id", "tenant_id", "name")
SELECT DISTINCT md5("tenant_id"::text || ':seller:first-party')::uuid, "tenant_id", 'First party' FROM "products";--> statement-breakpoint
UPDATE "products" SET "seller_id" = md5("tenant_id"::text || ':seller:first-party')::uuid WHERE "seller_id" IS NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "seller_id" SET NOT NULL;
