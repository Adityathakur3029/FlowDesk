CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "owner_team_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_active_name_unique" ON "teams" USING btree (lower("name")) WHERE "teams"."is_active";--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_owner_team_id_teams_id_fk" FOREIGN KEY ("owner_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employees_team_id_idx" ON "employees" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "programs_owner_team_id_idx" ON "programs" USING btree ("owner_team_id");