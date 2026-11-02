CREATE TABLE "stores" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"sealed_api_key" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
