-- Who created and last changed each campaign and association, a products copy
-- with its creators, and no processed_events (product events are applied by
-- version, so a redelivered one changes nothing). Existing rows are filled from
-- audit_log, which every campaign change writes in the same transaction.
ALTER TABLE "campaigns" RENAME COLUMN "created_at" TO "campaign_created_at";--> statement-breakpoint
ALTER TABLE "campaigns" RENAME COLUMN "updated_at" TO "campaign_updated_at";--> statement-breakpoint
ALTER TABLE "campaigns" RENAME COLUMN "created_by" TO "campaign_created_by";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "campaign_updated_by" uuid;--> statement-breakpoint
UPDATE "campaigns" c SET "campaign_updated_by" = coalesce(
  (SELECT a.actor_id FROM audit_log a WHERE a.subject_type = 'campaign' AND a.subject_id = c.id::text AND a.actor_id IS NOT NULL ORDER BY a.id DESC LIMIT 1),
  c.campaign_created_by);--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "campaign_updated_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_products" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_products" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "campaign_products" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
UPDATE "campaign_products" cp SET
  "updated_at" = cp.created_at,
  "created_by" = coalesce(
    (SELECT a.actor_id FROM audit_log a
      WHERE a.subject_type = 'campaign' AND a.subject_id = cp.campaign_id::text
        AND a.action IN ('campaign.created', 'campaign.products_added')
        AND a.details -> 'productIds' ? cp.product_id::text
        AND a.created_at <= cp.created_at AND a.actor_id IS NOT NULL
      ORDER BY a.id DESC LIMIT 1),
    (SELECT c.campaign_created_by FROM campaigns c WHERE c.id = cp.campaign_id));--> statement-breakpoint
UPDATE "campaign_products" SET "updated_by" = "created_by";--> statement-breakpoint
ALTER TABLE "campaign_products" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_products" ALTER COLUMN "updated_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_catalog_projection" RENAME TO "products";--> statement-breakpoint
ALTER TABLE "products" RENAME CONSTRAINT "product_catalog_projection_pkey" TO "products_pkey";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
DROP TABLE "processed_events";
