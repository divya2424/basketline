CREATE TABLE "processed_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revoked_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_access_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"tokens_not_before" timestamp with time zone,
	"version" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "revoked_sessions_expires_idx" ON "revoked_sessions" USING btree ("expires_at");