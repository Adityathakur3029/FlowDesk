CREATE TYPE "public"."task_type" AS ENUM('PRE', 'TASK', 'POST', 'BUG', 'ISSUE');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "type" "task_type" DEFAULT 'TASK' NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_program_type_idx" ON "tasks" USING btree ("program_id","type");