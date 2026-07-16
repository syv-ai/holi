CREATE TABLE "reminder_deliveries" (
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_deliveries_vault_id_user_id_pk" PRIMARY KEY("vault_id","user_id")
);
--> statement-breakpoint
DROP INDEX "reminders_pending_idx";--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "fired_at" timestamp with time zone;--> statement-breakpoint
--> Backfill: an already-fired reminder must not read as pending after the swap, or the
--> evaluator re-fires the whole history on next boot. `fire_at` (its scheduled instant)
--> is the truest value available — the real fire time was never recorded, which is the
--> gap this migration closes. Safe against a catch-up flood: reminder_deliveries starts
--> empty, and a first-ever connect takes seen_at = now() and returns no backlog.
UPDATE "reminders" SET "fired_at" = "fire_at" WHERE "fired";--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_pending_idx" ON "reminders" USING btree ("fire_at") WHERE "reminders"."fired_at" is null;