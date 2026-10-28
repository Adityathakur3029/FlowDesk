ALTER TABLE "employees" ADD COLUMN "google_sub" varchar(255);--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_google_sub_unique" UNIQUE("google_sub");