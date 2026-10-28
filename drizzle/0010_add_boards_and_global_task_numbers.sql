CREATE SEQUENCE "public"."task_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
-- Hand-added (spec 10): continue from the highest existing number so existing keys never collide with new ones
SELECT setval('"public"."task_number_seq"', coalesce((SELECT max("number") FROM "tasks"), 0) + 1, false);--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"key" varchar(10) NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	CONSTRAINT "boards_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ALTER COLUMN "program_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "program_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comment_mentions" ALTER COLUMN "program_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "program_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD COLUMN "board_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "board_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD COLUMN "board_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "board_id" uuid;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_board_status_idx" ON "tasks" USING btree ("board_id","status");--> statement-breakpoint
ALTER TABLE "programs" DROP COLUMN "task_counter";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_board_number_unique" UNIQUE("board_id","number");--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_single_parent_check" CHECK (num_nonnulls("task_dependencies"."program_id", "task_dependencies"."board_id") = 1);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_single_parent_check" CHECK (num_nonnulls("tasks"."program_id", "tasks"."board_id") = 1);--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_single_parent_check" CHECK (num_nonnulls("comment_mentions"."program_id", "comment_mentions"."board_id") = 1);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_single_parent_check" CHECK (num_nonnulls("comments"."program_id", "comments"."board_id") = 1);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_board_task_check" CHECK ("comments"."board_id" IS NULL OR "comments"."task_id" IS NOT NULL);