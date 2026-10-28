CREATE TYPE "public"."program_status" AS ENUM('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('LOWEST', 'LOW', 'MEDIUM', 'HIGH', 'HIGHEST');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('DISCUSSION', 'ON_HOLD', 'IN_PROGRESS', 'DONE', 'DEPENDENT');--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"key" varchar(10) NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"status" "program_status" DEFAULT 'PLANNED' NOT NULL,
	"task_counter" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "programs_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"program_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	CONSTRAINT "task_dependencies_pair_unique" UNIQUE("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependencies_no_self_check" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"program_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"key" varchar(24) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'DISCUSSION' NOT NULL,
	"status_before_dependent" "task_status",
	"priority" "task_priority" DEFAULT 'MEDIUM' NOT NULL,
	"assignee_id" uuid,
	"reporter_id" uuid NOT NULL,
	"start_date" date,
	"due_date" date,
	"estimate_minutes" integer,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tasks_key_unique" UNIQUE("key"),
	CONSTRAINT "tasks_program_number_unique" UNIQUE("program_id","number"),
	CONSTRAINT "tasks_date_range_check" CHECK ("tasks"."due_date" IS NULL OR "tasks"."start_date" IS NULL OR "tasks"."due_date" >= "tasks"."start_date"),
	CONSTRAINT "tasks_estimate_positive_check" CHECK ("tasks"."estimate_minutes" IS NULL OR "tasks"."estimate_minutes" > 0),
	CONSTRAINT "tasks_dependent_state_check" CHECK (("tasks"."status" = 'DEPENDENT') = ("tasks"."status_before_dependent" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_employees_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reporter_id_employees_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_dependencies_depends_on_task_id_idx" ON "task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE INDEX "tasks_program_status_idx" ON "tasks" USING btree ("program_id","status");--> statement-breakpoint
CREATE INDEX "tasks_assignee_id_idx" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "tasks_due_date_idx" ON "tasks" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "tasks_labels_idx" ON "tasks" USING gin ("labels");