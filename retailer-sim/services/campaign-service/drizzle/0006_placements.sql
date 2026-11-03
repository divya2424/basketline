CREATE TABLE "placements" (
	"tenant_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"position" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placements_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "placement" varchar(64) DEFAULT 'spotlight' NOT NULL;--> statement-breakpoint
-- The default placements (src/services/placement.service.ts) for every tenant that already has a store or campaigns; their campaigns are in Spotlight (the column's default).
INSERT INTO "placements" ("tenant_id", "key", "name", "position")
SELECT "tenants"."tenant_id", "defaults"."key", "defaults"."name", "defaults"."position"
FROM (SELECT "tenant_id" FROM "stores" UNION SELECT "tenant_id" FROM "campaigns") AS "tenants"
CROSS JOIN (VALUES ('spotlight', 'Spotlight', 1), ('top_rated', 'Top rated', 2), ('customer_picks', 'Customer picks', 3), ('deals', 'Deals', 4)) AS "defaults" ("key", "name", "position")
ON CONFLICT DO NOTHING;
