CREATE TYPE "public"."invite_status" AS ENUM('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TABLE "employee_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"email_id" varchar(255) NOT NULL,
	"role" "employee_role" NOT NULL,
	"status" "invite_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"employee_id" uuid
);
--> statement-breakpoint
ALTER TABLE "employee_invites" ADD CONSTRAINT "employee_invites_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_invites_pending_email_unique" ON "employee_invites" USING btree ("email_id") WHERE "employee_invites"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "employee_invites_email_id_idx" ON "employee_invites" USING btree ("email_id");