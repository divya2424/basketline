-- Basketline's users are dashboard users only (campaign and seller managers): a
-- retailer's shoppers are the retailer's, vouched for with shopper tokens. The
-- self-registered and demo shoppers (standard-user) go, with their logins.
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
-- Every tenant's rows: the owner skips RLS while it isn't forced (0002_accounts.sql),
-- here only inside this migration's transaction.
ALTER TABLE "user_login" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM "user_login" WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "role" = 'standard-user');--> statement-breakpoint
DELETE FROM "users" WHERE "role" = 'standard-user';--> statement-breakpoint
ALTER TABLE "user_login" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."user_role";--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('campaign-manager', 'seller-manager');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."user_role" USING "role"::"public"."user_role";
