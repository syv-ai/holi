ALTER TABLE "tasks" DROP CONSTRAINT "tasks_area_folders_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_area_folders_id_fk" FOREIGN KEY ("area") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;