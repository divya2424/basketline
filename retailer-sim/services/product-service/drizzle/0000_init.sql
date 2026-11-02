CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"image" text,
	"category" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "products_price_check" CHECK ("products"."price" > 0)
);
--> statement-breakpoint
CREATE INDEX "products_active_created_idx" ON "products" USING btree ("is_active","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category");