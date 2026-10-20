ALTER TABLE "programs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_created_at_idx" ON "tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tasks_completed_at_idx" ON "tasks" USING btree ("completed_at");--> statement-breakpoint
-- Hand-added backfill (spec 09): the last write is the best available finish time, and the checks below need it
UPDATE "programs" SET "completed_at" = "updated_at" WHERE "status" = 'COMPLETED';--> statement-breakpoint
UPDATE "programs" SET "cancelled_at" = "updated_at" WHERE "status" = 'CANCELLED';--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_completed_state_check" CHECK (("programs"."status" = 'COMPLETED') = ("programs"."completed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_cancelled_state_check" CHECK (("programs"."status" = 'CANCELLED') = ("programs"."cancelled_at" IS NOT NULL));