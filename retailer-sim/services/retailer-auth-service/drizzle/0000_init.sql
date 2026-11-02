CREATE TYPE "public"."user_role" AS ENUM('customer', 'staff');--> statement-breakpoint
CREATE TABLE "stores" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"tier" varchar(20) NOT NULL,
	"sealed_api_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"username" varchar(100) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_stores_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."stores"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree ("tenant_id",lower("username"));--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");