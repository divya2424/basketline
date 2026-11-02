-- Who created and last changed each product. For existing products, taken from
-- the audit_log rows written in the same transaction as every product change.
ALTER TABLE "products" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
UPDATE "products" p SET
  "created_by" = (SELECT a.actor_id FROM audit_log a WHERE a.subject_type = 'product' AND a.subject_id = p.id::text AND a.action = 'product.created' ORDER BY a.id LIMIT 1),
  "updated_by" = (SELECT a.actor_id FROM audit_log a WHERE a.subject_type = 'product' AND a.subject_id = p.id::text AND a.actor_id IS NOT NULL ORDER BY a.id DESC LIMIT 1);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "updated_by" SET NOT NULL;
