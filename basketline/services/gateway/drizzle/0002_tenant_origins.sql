CREATE TABLE "tenant_origins" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"origins" text[] NOT NULL,
	"version" integer NOT NULL
);
