CREATE TABLE "deleted_tenants" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL
);
