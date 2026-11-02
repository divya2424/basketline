ALTER TABLE "accounts" ADD COLUMN "allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "origins_version" integer DEFAULT 0 NOT NULL;