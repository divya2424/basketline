ALTER TYPE "public"."user_role" ADD VALUE 'seller-manager';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "seller_id" uuid;