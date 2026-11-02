-- Basketline reports per tenant, store and campaign, with no seller dimension:
-- seller managers go, with their logins. Every tenant's rows: the owner skips
-- RLS while it isn't forced (0002_accounts.sql), here only inside this
-- migration's transaction.
ALTER TABLE "user_login" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM "user_login" WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "role" = 'seller-manager');--> statement-breakpoint
DELETE FROM "users" WHERE "role" = 'seller-manager';--> statement-breakpoint
ALTER TABLE "user_login" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."user_role";--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('campaign-manager');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."user_role" USING "role"::"public"."user_role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "seller_id";
