CREATE TYPE "public"."employee_role" AS ENUM('ADMIN', 'MANAGER', 'MEMBER');--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"email_id" varchar(255) NOT NULL,
	"name" varchar(150) NOT NULL,
	"role" "employee_role" DEFAULT 'MEMBER' NOT NULL,
	CONSTRAINT "employees_email_id_unique" UNIQUE("email_id")
);
